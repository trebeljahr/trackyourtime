/**
 * The offline queue, Raycast's copy.
 *
 * Same durable FIFO and same op contract as the web app and the browser
 * extension — `@starter/core` owns both — so a start queued here is a row any
 * of them could describe. What is host-specific is underneath it: the store is
 * Raycast's encrypted `LocalStorage`, and there is no long-lived process to
 * hold a "pending" number in memory. Every command is its own process, so each
 * one reads the queue from storage and each one flushes it.
 *
 * Why Raycast needs this at all: the extension is the surface people reach for
 * without thinking — a hotkey, a menu bar item — which means it is the surface
 * used on a train, on a plane and in a basement. Before this, a stop pressed
 * with no signal raised a red toast and the time was simply gone.
 */
import {
  ApiError,
  createOfflineQueue,
  decodeOfflineMutation,
  describeQueuedMutation,
  isForeignTo,
  isPermanentRejection,
  isQueuedOn,
  isReplayableBy,
  isTransportFailure as isTransportFailureCore,
  OFFLINE_QUEUE_STORAGE_KEY,
  replayOfflineMutation,
  StaleQueuedStopError,
  type FlushResult,
  type OfflineOp,
  type OfflinePayloadMap,
  type OfflineQueue,
  type OfflineReplayMutators,
  type QueuedMutation,
  type QueuedMutationSummary,
  type ReplayIdMap,
  type StoredOfflinePayload,
} from "@starter/core";
import { NotSignedInError } from "./errors.js";
import { getStoredUserId } from "./auth.js";
import { raycastStorage } from "./storage.js";
import { apiUrl } from "./preferences.js";

let queue: OfflineQueue | null = null;

/**
 * Memoised per process, which on Raycast means per command launch. There is
 * no shared runtime for two commands to disagree through — the store is the
 * only channel between them, and `createOfflineQueue` serialises its own
 * read-modify-write, so two commands racing lose nothing worse than one
 * enqueue landing before the other.
 */
export const getOfflineQueue = (): OfflineQueue => {
  queue ??= createOfflineQueue({
    storage: raycastStorage,
    key: OFFLINE_QUEUE_STORAGE_KEY,
  });
  return queue;
};

// ── which server a row belongs to ─────────────────────────────────────

/*
 * The API URL is a preference, and a person can point it at another server —
 * the hosted one, their own — at any time. The queue outlives that for the
 * reason it outlives a sign-out: its rows are time no server has seen. So
 * every row carries the server it was queued against, and only rows for the
 * server in use now are replayed, counted as ours or cancelled; the rest wait
 * for the preference to point back, or for a deliberate discard.
 *
 * Rows from before the stamp are claimed for the server in use the first time
 * this build touches the queue. That is where they were made — a preference
 * cannot change between the old build's last run and the new one's first.
 */
let claimed: Promise<unknown> | null = null;

const ready = (): Promise<unknown> => {
  claimed ??= getOfflineQueue().adoptUnserved(apiUrl());
  return claimed;
};

const isOnThisServer = (row: QueuedMutation): boolean =>
  isQueuedOn(row, apiUrl(), apiUrl());

/** Not this session's to send: another server's row, or another account's. */
const isElsewhere = (row: QueuedMutation, owner: string | null): boolean =>
  !isOnThisServer(row) || isForeignTo(row, owner);

/**
 * Claim the unowned rows queued against the server in use for `userId` — and
 * only those: an account here could not have made a row for another server.
 */
export async function adoptUnownedHere(userId: string): Promise<number> {
  await ready();
  return getOfflineQueue().adoptUnowned(userId, isOnThisServer);
}

// ── classification ───────────────────────────────────────────────────

/**
 * True when the mutation never reached the server, so keeping it is safe.
 *
 * Core decides what counts as "no answer came back"; what this adds is the one
 * failure Raycast raises before a request exists. `NotSignedInError` would
 * otherwise look exactly like a dead network and file work against nobody.
 */
export const isTransportFailure = (error: unknown): boolean =>
  isTransportFailureCore(error) && !(error instanceof NotSignedInError);

/**
 * True when the server refused because it does not believe we are signed in.
 *
 * Not a transport failure — the request arrived and was answered — but it must
 * not drop the row either. A session that expired while a laptop was shut has
 * a whole day of tracked time behind it, and deleting that one 401 at a time
 * is the worst outcome available. The flush stops and everything keeps its
 * place until there is a session to replay it with.
 */
export const isAuthRefusal = (error: unknown): boolean =>
  error instanceof ApiError &&
  (error.httpStatus === 401 ||
    error.httpStatus === 403 ||
    error.code === "UNAUTHORIZED" ||
    error.code === "FORBIDDEN");

// ── writing ──────────────────────────────────────────────────────────

/**
 * Append a mutation that could not reach the server.
 *
 * Stamped with the account that queued it, for the same reason the phone
 * stamps its rows: the queue outlives a sign-out on purpose, so without an
 * owner the next account to pair this Mac would replay the previous one's
 * starts and stops into its own workspace. A session stored by a build that
 * predates the stamp has no user id, and its rows are adopted by the first
 * account that can claim them.
 */
export async function enqueueOffline<K extends OfflineOp>(
  op: K,
  input: OfflinePayloadMap[K],
  tempId?: string,
): Promise<void> {
  const payload: StoredOfflinePayload = tempId ? { input, tempId } : { input };
  await ready();
  await getOfflineQueue().enqueue(
    op,
    payload,
    (await getStoredUserId()) ?? undefined,
    apiUrl(),
  );
}

export type PendingCounts = {
  /** Rows this account can replay. */
  mine: number;
  /** Rows queued by a different account or for another server — kept, never replayed. */
  foreign: number;
};

/**
 * How much is waiting, split by whether this session may send it.
 *
 * `getStoredUserId()` is a storage read rather than a session check, so a null
 * here means genuinely signed out rather than "still resolving" — which is why
 * this can call a stamped row foreign without qualification. Unowned rows are
 * counted as ours: nobody has claimed them and the next sign-in adopts them.
 */
export async function pendingCounts(): Promise<PendingCounts> {
  await ready();
  const rows = await getOfflineQueue().list();
  const owner = await getStoredUserId();
  const foreign = rows.filter((row) => isElsewhere(row, owner)).length;
  return { mine: rows.length - foreign, foreign };
}

/**
 * What another account left queued on this Mac, for a human to look at.
 *
 * Kept and never replayed, both deliberately — which on its own makes these
 * rows immortal, and a count nobody can act on is a scold. `discardForeign` is
 * the way out, and it has to name what it destroys: nobody can approve
 * deleting "3 changes", and anybody can decide about two entries called
 * "Invoicing" from 21 August.
 */
export async function listForeign(): Promise<QueuedMutationSummary[]> {
  await ready();
  const owner = await getStoredUserId();
  const rows = await getOfflineQueue().list();
  return rows
    .filter((row) => isElsewhere(row, owner))
    .map(describeQueuedMutation);
}

/**
 * Delete the rows queued by another account, and only those.
 *
 * The one deletion path for unsynced time here, and it exists only behind an
 * explicit confirmation that names what is going. Nothing calls it on a timer,
 * on a sign-out or on an age threshold: a silent drop is what this whole
 * mechanism was built to avoid, and putting one behind a clock does not make
 * it less silent.
 */
export async function discardForeign(): Promise<number> {
  await ready();
  const owner = await getStoredUserId();
  const offline = getOfflineQueue();
  const theirs = (await offline.list()).filter((row) =>
    isElsewhere(row, owner),
  );
  for (const row of theirs) await offline.remove(row.id);
  return theirs.length;
}

/**
 * Drop everything queued for a locally invented entry.
 *
 * Used when the user deletes an entry that only ever existed in the queue —
 * replaying its create would resurrect it a minute later.
 */
export async function cancelQueuedForTemp(tempId: string): Promise<boolean> {
  const offline = getOfflineQueue();
  const owner = await getStoredUserId();
  const rows = await offline.list();
  let removed = false;

  for (const row of rows) {
    // Never reach into another account's rows, even to cancel. An unowned row
    // is fair game: it is one this install queued before it knew the account.
    if (isElsewhere(row, owner)) continue;
    if (decodeOfflineMutation(row)?.tempId !== tempId) continue;
    await offline.remove(row.id);
    removed = true;
  }

  return removed;
}

// ── replay ───────────────────────────────────────────────────────────

/**
 * Raycast runs no idle watcher, so there is no ownership claim to rename when
 * a queued start finally lands. The replay still asks for one, because on the
 * web and the phone forgetting the rename silently kills idle detection for
 * the rest of that entry's life — so the parameter is required and this is the
 * explicit "nothing to rename here" answer rather than an optional argument
 * every caller could forget.
 */
const NO_IDLE_WATCHER = { noteServerId: (): void => undefined };

export type FlushReport = FlushResult & {
  /** Rows dropped because the server can never accept them. */
  refused: number;
  /** Id-less stops too old to guess an entry for. */
  stale: number;
  /** Temp id → the real id its replayed start was given. */
  resolved: ReplayIdMap;
};

/**
 * Replay everything queued, in the order it was performed, and report what
 * happened.
 *
 * Stops at the first failure and leaves that row and everything behind it
 * queued — the queue's own contract — so a start is never replayed after the
 * stop that ended it. Two classes of failure are exceptions, and both are
 * dropped rather than allowed to wedge the queue forever: a permanent refusal
 * (the server has moved on — the runaway guard capping the entry a queued stop
 * meant to close is exactly this), and a stop that names no entry and is too
 * old to guess one for.
 */
export async function flushOffline(
  mutators: OfflineReplayMutators,
): Promise<FlushReport> {
  await ready();
  const offline = getOfflineQueue();
  const owner = await getStoredUserId();
  const resolved: ReplayIdMap = new Map();
  let refused = 0;
  let stale = 0;

  const result = await offline.flush(
    async (row) => {
      const decoded = decodeOfflineMutation(row);
      // A row written by an older build cannot be replayed against today's
      // schema. Resolving drops it rather than wedging everything behind it.
      if (decoded === null) return;
      try {
        await replayOfflineMutation(mutators, NO_IDLE_WATCHER, decoded, {
          createdAt: row.createdAt,
          resolved,
        });
      } catch (error) {
        if (error instanceof StaleQueuedStopError) {
          stale += 1;
          return;
        }
        if (isPermanentRejection(error)) {
          refused += 1;
          return;
        }
        throw error;
      }
    },
    { filter: (row) => isReplayableBy(row, owner) && isOnThisServer(row) },
  );

  return { ...result, refused, stale, resolved };
}
