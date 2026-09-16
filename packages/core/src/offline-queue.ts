import { ApiError } from "./api-client.js";
import { createId } from "./ids.js";
import { sameServerOrigin } from "./server-origin.js";
import type { KeyValueStorage } from "./storage.js";

export type QueuedMutation = {
  id: string;
  op: string;
  payload: unknown;
  createdAt: string;
  /**
   * The account this row was queued under.
   *
   * Optional, and it has to stay optional: rows written by a build that
   * predates ownership stamping decode without it, and one of those rows is
   * time the user tracked that no server has ever seen. `undefined` means
   * "nobody has claimed this yet" — see `adoptUnowned`.
   *
   * A raw user id rather than a hash of one. The check this field exists for
   * is an equality test that decides whose workspace a start is written into,
   * and a short non-cryptographic hash would make that test probabilistic:
   * one collision reintroduces exactly the cross-account replay the stamp is
   * here to prevent. The value never leaves the device, and it sits beside a
   * session token in the same store.
   */
  owner?: string;
  /**
   * The server origin this row was queued against.
   *
   * A client can be pointed at a different server, and a queued start replayed
   * into the wrong one is tracked time filed on a server the person has left
   * — or, worse, one where the same email belongs to someone else. So a row
   * replays only against the origin it was made for. Optional for the same
   * reason `owner` is: rows from before the stamp decode without it, and they
   * were all made against the build's default server — see `isQueuedOn`.
   */
  server?: string;
  /**
   * The workspace this row was queued in.
   *
   * A person can belong to several workspaces and switch between them while a
   * row waits, and a replay addresses whichever workspace the client points
   * at NOW unless the row names one. So a start queued in A and replayed
   * after a switch to B would be filed in B — time billed to the wrong client
   * with nothing on screen to say so. The stamp is sent as the request's
   * explicit `workspaceId` on replay (`replayOfflineMutation`), which the
   * server resolves before anything else.
   *
   * Optional forever, like `owner`: rows from before the stamp decode without
   * it, and the first workspace a client resolves adopts them
   * (`adoptUnstampedWorkspace`).
   */
  workspaceId?: string;
  /**
   * Why a replay put this row aside instead of sending or dropping it, and
   * when. Written only for holds that can end on their own — the server gained
   * the procedure — so a flush knows when to ask again (`holdBlocksReplay` in
   * `offline-ops.ts`). A row this build cannot decode is never stamped: that
   * hold is recomputed on every read, which is what releases it the moment a
   * newer build that understands it is installed.
   *
   * Optional forever, like every other stamp.
   */
  hold?: QueuedHold;
};

/**
 * Why a queued row is held: kept, counted, described, never replayed and
 * never deleted until the condition may have changed or a person discards it.
 *
 * A union on purpose, and meant to grow — a server that is too old for a
 * row's API level is the next reason. Every client switches on it to choose
 * the words, so a new member is a type error everywhere it needs a sentence.
 *
 * - `unknown-op`: this build cannot decode the row. A newer build wrote it,
 *   or the queue itself is in a newer format (`QUEUE_FORMAT_VERSION`).
 * - `unknown-procedure`: the server answered that it has no such procedure —
 *   a newer client replaying against an older self-hosted server.
 */
export type HoldReason = "unknown-op" | "unknown-procedure";

export type QueuedHold = {
  reason: HoldReason;
  /** When the hold was last confirmed — the clock a retry is measured from. */
  at: string;
};

/**
 * What a flush runner may answer instead of resolving (sent, drop the row) or
 * throwing (stop, keep this row and everything behind it).
 */
export type FlushVerdict = { hold: HoldReason };

/**
 * The format `createOfflineQueue` writes: `{ v, data: rows }`, the same
 * envelope as `versioned-storage.ts`. Not read through `decodeVersioned`,
 * whose answer to a newer version is a miss: here that would be an empty
 * queue, overwritten by the next enqueue. See docs/versioning.md, rule 4.
 */
export const QUEUE_FORMAT_VERSION = 1;

/**
 * Where an unreadable stored queue is copied before the queue is reset. The
 * timestamp keeps a second corruption from overwriting the first copy.
 */
export const corruptQueueKey = (key: string, at: number): string =>
  `${key}.corrupt.${at}`;

/**
 * Raised by a write to a queue stored in a format newer than this build knows.
 * Writing would replace rows this build cannot even read with rows a newer
 * build would then misread — so nothing is written, and the caller hears so.
 */
export class OfflineQueueLockedError extends Error {
  readonly version: number;

  constructor(version: number) {
    super(`Offline queue is stored in format v${version}, newer than this build`);
    this.name = "OfflineQueueLockedError";
    this.version = version;
  }
}

export type OfflineQueue = {
  enqueue(
    op: string,
    payload: unknown,
    owner?: string,
    server?: string,
    workspaceId?: string
  ): Promise<QueuedMutation>;
  list(): Promise<QueuedMutation[]>;
  size(): Promise<number>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  /**
   * Stamp every row that carries no owner with `owner`, and report how many
   * were claimed. The first account to sign in after an upgrade adopts the
   * rows the old build left behind — they are almost certainly its own, and
   * the alternative to claiming them is either stranding them forever or
   * letting the account after next replay them.
   */
  adoptUnowned(
    owner: string,
    where?: (mutation: QueuedMutation) => boolean
  ): Promise<number>;
  /**
   * Stamp every row that names no server with `server`, and report how many.
   *
   * For a client whose build default is not where its old rows went — Raycast,
   * whose server has always been a preference — the honest owner of an
   * unstamped row is the server in use when this build first ran, so it
   * claims them once, eagerly, before the preference can change.
   */
  adoptUnserved(server: string): Promise<number>;
  /**
   * Stamp every row that names no workspace with `workspaceId`, and report how
   * many. Same semantics as `adoptUnowned`: the first workspace a client
   * resolves after an upgrade claims the rows the old build left behind,
   * because that is where they would have replayed anyway — and claiming them
   * once, eagerly, keeps a later switch from carrying them along.
   */
  adoptUnstampedWorkspace(
    workspaceId: string,
    where?: (mutation: QueuedMutation) => boolean
  ): Promise<number>;
  /**
   * Run `runner` over the queue in order, dropping each mutation as it
   * succeeds. Stops at the first failure and leaves that mutation (and
   * everything after it) queued, so ordering is never broken by a retry.
   *
   * `options.filter` decides which rows are the runner's business. A row it
   * rejects is neither run nor dropped: it keeps its place in the queue and
   * is counted in `skipped`. That is what lets one device hold another
   * account's queued work without either replaying it or destroying it.
   *
   * A runner that answers a `FlushVerdict` holds its row: kept in place,
   * stamped with the hold, counted in `skipped` and `held`, and the flush
   * carries on. Whatever shares its chain (`options.chainOf`) is held with it.
   */
  flush(
    runner: (mutation: QueuedMutation) => Promise<void | FlushVerdict>,
    options?: FlushOptions
  ): Promise<FlushResult>;
};

export type FlushOptions = {
  /** Rows this predicate rejects stay queued, untouched and unreplayed. */
  filter?: (mutation: QueuedMutation) => boolean;
  /**
   * Rows that must stand or fall together — a start and the stop that ends it
   * share a temp id. Once one row of a chain is not run (filtered, or held),
   * no later row of that chain is run either: a stop replayed without its
   * start would end whatever happens to be running on the server.
   */
  chainOf?: (mutation: QueuedMutation) => string | undefined;
};

export type FlushResult = {
  flushed: number;
  remaining: number;
  /**
   * Rows the flush left in place without stopping: filtered, held, or chained
   * to one of those. They are part of `remaining`, and nothing a flush does
   * will send them, so they are never "ahead of" a new mutation.
   */
  skipped: number;
  /** Of `skipped`, the rows this flush held (a verdict, or its chain). */
  held: number;
  /** The mutation that failed, if the flush stopped early. */
  failed?: QueuedMutation;
  error?: unknown;
};

/**
 * Holds that are written onto a row. `unknown-op` is not among them: it is a
 * fact about the build reading the row, recomputed on every read, and a stored
 * copy would outlive the upgrade that ends it.
 */
const STORED_HOLD_REASONS: readonly string[] = ["unknown-procedure"];

const readHold = (value: unknown): QueuedHold | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { reason, at } = value as { reason?: unknown; at?: unknown };
  if (typeof reason !== "string" || !STORED_HOLD_REASONS.includes(reason)) return undefined;
  if (typeof at !== "string") return undefined;
  return { reason: reason as HoldReason, at };
};

const isQueuedMutation = (value: unknown): value is QueuedMutation => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.op === "string" &&
    typeof record.createdAt === "string"
  );
};

/**
 * An `owner` that is not a string is no owner at all. Anything else would let
 * a corrupt or hand-edited row compare equal to nothing and sit in the queue
 * forever, or — worse — compare equal to whatever `undefined` is treated as.
 */
const normalize = (mutation: QueuedMutation): QueuedMutation => {
  const owner =
    typeof mutation.owner === "string" && mutation.owner.length > 0
      ? mutation.owner
      : undefined;
  const server =
    typeof mutation.server === "string" && mutation.server.length > 0
      ? mutation.server
      : undefined;
  const workspaceId =
    typeof mutation.workspaceId === "string" && mutation.workspaceId.length > 0
      ? mutation.workspaceId
      : undefined;
  const hold = mutation.hold === undefined ? undefined : readHold(mutation.hold);
  if (
    owner === mutation.owner &&
    server === mutation.server &&
    workspaceId === mutation.workspaceId &&
    hold === mutation.hold
  ) {
    return mutation;
  }
  const normalized: QueuedMutation = { ...mutation, owner, server };
  // Only written when present, so a row that never had the field reads back
  // exactly as it was stored.
  if (workspaceId === undefined) delete normalized.workspaceId;
  else normalized.workspaceId = workspaceId;
  // A hold this build does not recognise is no hold: the replay decides again.
  if (hold === undefined) delete normalized.hold;
  else normalized.hold = hold;
  return normalized;
};

/**
 * True when `owner` may replay `mutation`.
 *
 * Unowned rows are replayable by whoever is signed in, which is the same
 * decision `adoptUnowned` makes eagerly — the two must agree, or a row could
 * be adopted by one account and replayed by another. Nobody replays anything
 * while signed out.
 */
export const isReplayableBy = (
  mutation: Pick<QueuedMutation, "owner">,
  owner: string | null
): boolean => {
  if (owner === null) return false;
  return mutation.owner === undefined || mutation.owner === owner;
};

/**
 * True when `mutation` demonstrably belongs to somebody else.
 *
 * The negation of `isReplayableBy` in every case but one: an unowned row is
 * not foreign to a caller who does not know who it is yet. Replaying such a
 * row is a decision that must wait for an account (`isReplayableBy` refuses
 * it); merely reading or cancelling it is not.
 */
export const isForeignTo = (
  mutation: Pick<QueuedMutation, "owner">,
  owner: string | null
): boolean => mutation.owner !== undefined && mutation.owner !== owner;

/**
 * True when `mutation` was queued against `server`.
 *
 * `legacyServer` answers for rows written before the server stamp existed.
 * Every one of those was made against the client's built-in default — no
 * client could be pointed anywhere else yet — so that is the server they
 * belong to, whichever one the client uses today. Comparing against the
 * CURRENT server instead would hand them to whichever server the person
 * switched to first.
 */
export const isQueuedOn = (
  mutation: Pick<QueuedMutation, "server">,
  server: string,
  legacyServer: string
): boolean => sameServerOrigin(mutation.server ?? legacyServer, server);

/**
 * True when a row may be replayed by someone whose memberships are
 * `memberWorkspaceIds`.
 *
 * A stamped row replays only into a workspace the person still belongs to. A
 * row for a workspace they have left or been removed from must not be sent at
 * all: the server would refuse it (NOT_FOUND), the flush would drop it as a
 * permanent refusal, and a day of tracked time would vanish with a toast. It
 * must not be retargeted either — that is the cross-workspace replay the stamp
 * exists to prevent. So it is held: kept, counted, and described until the
 * person discards it deliberately.
 *
 * An unstamped row is replayable, the same decision `isReplayableBy` makes for
 * an unowned one — and the same decision `adoptUnstampedWorkspace` makes
 * eagerly. Clients adopt before they flush, so in practice only a row that
 * slipped in between the two reaches this unstamped.
 */
export const isReplayableIn = (
  mutation: Pick<QueuedMutation, "workspaceId">,
  memberWorkspaceIds: ReadonlySet<string>
): boolean =>
  mutation.workspaceId === undefined ||
  memberWorkspaceIds.has(mutation.workspaceId);

/**
 * True when a row demonstrably belongs to a workspace the person is not in.
 *
 * The negation of `isReplayableIn` for every stamped row; an unstamped row is
 * never foreign, because it names no workspace to be foreign to.
 */
export const isForeignWorkspace = (
  mutation: Pick<QueuedMutation, "workspaceId">,
  memberWorkspaceIds: ReadonlySet<string>
): boolean =>
  mutation.workspaceId !== undefined &&
  !memberWorkspaceIds.has(mutation.workspaceId);

/**
 * True when a permanent refusal of a stamped row must NOT drop it.
 *
 * A NOT_FOUND on a row addressed to a workspace reads the same whether the
 * entry is gone or the person was removed from the workspace — and a flush
 * checks memberships once, before it starts, so a removal landing while it
 * runs is only visible as that NOT_FOUND. The row is kept (the flush stops at
 * it, and the next flush holds it by `isReplayableIn`) unless `stillMember`
 * confirms the workspace is still a membership. A failed confirmation keeps it
 * too: not knowing is no licence to delete somebody's tracked time.
 *
 * `stillMember` must not touch the queue — the flush calling this holds it.
 */
export const refusalKeepsRow = async (
  error: unknown,
  row: { workspaceId?: string },
  stillMember: (workspaceId: string) => Promise<boolean>
): Promise<boolean> => {
  if (row.workspaceId === undefined) return false;
  if (!(error instanceof ApiError)) return false;
  if (error.httpStatus !== 404 && error.code !== "NOT_FOUND") return false;
  return !(await stillMember(row.workspaceId).catch(() => false));
};

/**
 * The pure half of `OfflineQueue.adoptUnstampedWorkspace`: `rows` with every
 * unstamped row (that `where` accepts) stamped with `workspaceId`. Rows that
 * already name a workspace are returned untouched — adoption never moves a
 * row from one workspace to another.
 */
export const adoptUnstampedWorkspace = (
  rows: readonly QueuedMutation[],
  workspaceId: string,
  where?: (mutation: QueuedMutation) => boolean
): QueuedMutation[] =>
  rows.map((row) =>
    row.workspaceId === undefined && (where === undefined || where(row))
      ? { ...row, workspaceId }
      : row
  );

/**
 * Durable FIFO of mutations made while offline or during a failed request.
 *
 * The queue is the reason start/stop works with the network fully off: the
 * optimistic cache update stands, the mutation waits here, and the flush on
 * reconnect replays it in the order the user performed it.
 */
export const createOfflineQueue = ({
  storage,
  key = "trackyourtime.offline-queue",
}: {
  storage: KeyValueStorage;
  key?: string;
}): OfflineQueue => {
  /**
   * Set when the stored queue is in a format newer than this build — a
   * downgrade, or a newer client sharing the store. Its rows are listed as
   * held `unknown-op` and nothing is ever written back over them.
   */
  let lockedVersion: number | null = null;

  const readRows = (parsed: unknown): unknown[] | null => {
    // The format before the envelope: a bare array, still read as v1.
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed !== "object" || parsed === null) return null;
    const { v, data } = parsed as { v?: unknown; data?: unknown };
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return null;
    if (!Array.isArray(data)) return null;
    return data;
  };

  const read = async (): Promise<QueuedMutation[]> => {
    const raw = await storage.getItem(key);
    lockedVersion = null;
    if (!raw) return [];
    let parsed: unknown;
    let rows: unknown[] | null = null;
    try {
      parsed = JSON.parse(raw);
      rows = readRows(parsed);
    } catch {
      rows = null;
    }

    if (rows === null) {
      // Unreadable. Resetting is still right — a wedged queue would stop every
      // future offline mutation — but the raw value is somebody's tracked time
      // in a shape we failed to read, so it is copied aside first rather than
      // overwritten by the next enqueue.
      const copy = corruptQueueKey(key, Date.now());
      await storage.setItem(copy, raw);
      await storage.removeItem(key);
      console.warn(
        `[offline-queue] unreadable queue under "${key}" copied to "${copy}" and reset`
      );
      return [];
    }

    const version =
      Array.isArray(parsed) ? 1 : (parsed as { v: number }).v;
    const mutations = rows.filter(isQueuedMutation).map(normalize);
    if (version > QUEUE_FORMAT_VERSION) {
      lockedVersion = version;
      return mutations.map((row) => ({
        ...row,
        hold: { reason: "unknown-op", at: row.createdAt },
      }));
    }
    return mutations;
  };

  const write = async (mutations: QueuedMutation[]): Promise<void> => {
    if (lockedVersion !== null) throw new OfflineQueueLockedError(lockedVersion);
    if (mutations.length === 0) {
      await storage.removeItem(key);
      return;
    }
    await storage.setItem(
      key,
      JSON.stringify({ v: QUEUE_FORMAT_VERSION, data: mutations })
    );
  };

  /**
   * Housekeeping writes — adoption, a sign-out's clear — on a locked queue do
   * nothing rather than fail: refusing them must not break a sign-out, and
   * skipping them loses nothing that is this build's to keep.
   */
  const bestEffort = async (task: () => Promise<number>): Promise<number> => {
    try {
      return await task();
    } catch (error) {
      if (error instanceof OfflineQueueLockedError) return 0;
      throw error;
    }
  };

  // Serialize access so two concurrent enqueues can't clobber each other
  // through the read-modify-write window.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  return {
    enqueue: (op, payload, owner, server, workspaceId) =>
      serial(async () => {
        const mutation: QueuedMutation = {
          id: createId(),
          op,
          payload,
          createdAt: new Date().toISOString(),
          owner,
          server,
          ...(workspaceId ? { workspaceId } : {}),
        };
        const mutations = await read();
        mutations.push(mutation);
        await write(mutations);
        return mutation;
      }),

    list: () => serial(read),

    size: () => serial(async () => (await read()).length),

    remove: (id) =>
      serial(async () => {
        const mutations = await read();
        await write(mutations.filter((m) => m.id !== id));
      }),

    clear: () =>
      serial(async () => {
        await read();
        await bestEffort(async () => {
          await write([]);
          return 0;
        });
      }),

    adoptUnowned: (owner, where) =>
      serial(() => bestEffort(async () => {
        const mutations = await read();
        // `where` keeps an account from claiming rows it could never have
        // made: an account on one server adopting a row queued against another.
        const claimable = (m: QueuedMutation): boolean =>
          m.owner === undefined && (where === undefined || where(m));
        const unowned = mutations.filter(claimable);
        if (unowned.length === 0) return 0;
        await write(mutations.map((m) => (claimable(m) ? { ...m, owner } : m)));
        return unowned.length;
      })),

    adoptUnserved: (server) =>
      serial(() => bestEffort(async () => {
        const mutations = await read();
        const unserved = mutations.filter((m) => m.server === undefined);
        if (unserved.length === 0) return 0;
        await write(
          mutations.map((m) => (m.server === undefined ? { ...m, server } : m))
        );
        return unserved.length;
      })),

    adoptUnstampedWorkspace: (workspaceId, where) =>
      serial(() => bestEffort(async () => {
        const mutations = await read();
        const next = adoptUnstampedWorkspace(mutations, workspaceId, where);
        const adopted = next.filter(
          (row, index) => row !== mutations[index]
        ).length;
        if (adopted === 0) return 0;
        await write(next);
        return adopted;
      })),

    flush: (runner, options) =>
      serial(async () => {
        const mutations = await read();
        const locked = lockedVersion !== null;
        const wanted = options?.filter ?? (() => true);
        const chainOf = options?.chainOf ?? (() => undefined);
        // Rows left in place, in order, so they can be written back ahead of
        // whatever is still unprocessed when a flush stops early.
        const kept: QueuedMutation[] = [];
        // Chains with a row that was not run, and whether that row was held:
        // nothing later in them may run.
        const stranded = new Map<string, boolean>();
        let flushed = 0;
        let held = 0;
        let changed = false;

        const leave = (mutation: QueuedMutation, asHeld: boolean): void => {
          kept.push(mutation);
          const link = chainOf(mutation);
          if (link !== undefined && !stranded.get(link)) stranded.set(link, asHeld);
        };

        for (const [index, mutation] of mutations.entries()) {
          if (locked || !wanted(mutation)) {
            leave(mutation, false);
            continue;
          }
          const link = chainOf(mutation);
          if (link !== undefined && stranded.has(link)) {
            const heldChain = stranded.get(link) === true;
            leave(mutation, heldChain);
            if (heldChain) held += 1;
            continue;
          }
          let verdict: void | FlushVerdict;
          try {
            verdict = await runner(mutation);
          } catch (error) {
            const remaining = [...kept, ...mutations.slice(index)];
            if (!locked && (changed || flushed > 0)) await write(remaining);
            return {
              flushed,
              skipped: kept.length,
              held,
              remaining: remaining.length,
              failed: mutation,
              error,
            };
          }
          if (verdict !== undefined && verdict !== null && "hold" in verdict) {
            held += 1;
            if (!STORED_HOLD_REASONS.includes(verdict.hold)) {
              leave(mutation, true);
              continue;
            }
            leave(
              {
                ...mutation,
                hold: { reason: verdict.hold, at: new Date().toISOString() },
              },
              true
            );
            changed = true;
            continue;
          }
          flushed += 1;
          changed = true;
        }

        if (!locked && changed) await write(kept);
        return {
          flushed,
          skipped: kept.length,
          held,
          remaining: kept.length,
        };
      }),
  };
};
