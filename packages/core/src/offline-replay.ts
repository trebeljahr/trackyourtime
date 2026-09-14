/**
 * How a decoded queue row is turned back into a real API call, and what has to
 * be repaired once it lands.
 *
 * Shared rather than client-local because the repair is identical everywhere a
 * queue is replayed — a start's temp id has to be renamed on the idle watcher,
 * and an id-less stop has to be either targeted or refused — and getting it
 * wrong in one client corrupts entries the other clients then have to look at.
 * Nothing here binds an API: the caller supplies one call per op, so the web
 * app can pass tRPC mutations and Raycast can pass its bearer client.
 */
import { noteReplayedServerId } from "./offline-ops.js";
import type {
  OfflineMutation,
  OfflineOp,
  OfflinePayloadMap,
} from "./offline-ops.js";
import type { IdleWatcher } from "./idle.js";

/**
 * What a replayed call is handed: the queued input, plus the workspace the row
 * was queued in when it carries one.
 */
export type ReplayInput<K extends OfflineOp> = OfflinePayloadMap[K] & {
  workspaceId?: string;
};

/** One call per queued op. The caller binds these to its own API. */
export type OfflineReplayMutators = {
  [K in OfflineOp]: (input: ReplayInput<K>) => Promise<unknown>;
};

/**
 * `input` addressed to the workspace the row was queued in.
 *
 * Explicit, and set over anything already there, because every client also
 * injects its CURRENT workspace into requests that name none (the web app's
 * tRPC link, `createApiClient`'s `workspaceId` getter). Those injections only
 * fill a gap; a row that says where it was made must never leave one for them
 * to fill — that gap is exactly how a start queued in workspace A would land
 * in B after a switch. An unstamped (legacy) row is sent as it always was.
 */
const inWorkspace = <K extends OfflineOp>(
  mutation: { workspaceId?: string },
  input: OfflinePayloadMap[K]
): ReplayInput<K> =>
  mutation.workspaceId === undefined
    ? input
    : { ...input, workspaceId: mutation.workspaceId };

/**
 * How old an id-less `entries.stop` may be before it is refused.
 *
 * The queue used to live in `localStorage` on a device that is rarely off, so
 * a row that could not be replayed evaporated. On a phone it survives an OS
 * kill indefinitely, which turns "stop whatever is running" from a shortcut
 * into a hazard: a stop queued on Monday, replayed on Friday, closes a timer
 * started on Thursday at Monday's timestamp — on another device, belonging to
 * a completely different piece of work.
 *
 * A day is long enough to cover a weekend of no signal for a stop that really
 * does belong to the start ahead of it in the queue, and short enough that a
 * row this old is better surfaced than guessed at.
 */
export const STALE_STOP_MS = 24 * 60 * 60 * 1000;

/**
 * A queued stop that names no entry and is too old to guess for. Thrown
 * rather than returned so it travels the same path as a server refusal: the
 * row is dropped, and the caller tells the user rather than silently ending
 * whatever happens to be running now.
 */
export class StaleQueuedStopError extends Error {
  readonly queuedAt: string;

  constructor(queuedAt: string) {
    super("Queued stop is too old to apply to an unidentified entry");
    this.name = "StaleQueuedStopError";
    this.queuedAt = queuedAt;
  }
}

/**
 * Temp id → the real id its `entries.start` was given on replay.
 *
 * Held for the length of one flush. A start and the stop that ends it are
 * queued as a pair, and the pair only becomes targetable once the start has
 * actually landed — which is a few milliseconds earlier, in the same loop.
 */
export type ReplayIdMap = Map<string, string>;

/** The id of the entry a replayed start produced, read defensively. */
const replayedId = (result: unknown): string | null => {
  if (typeof result !== "object" || result === null) return null;
  const { id } = result as { id?: unknown };
  return typeof id === "string" && id.length > 0 ? id : null;
};

/**
 * Give a queued stop the entry it means, when that is knowable.
 *
 * A stop is enqueued with its `id` whenever the timer it ends already had a
 * real one. It is enqueued without one only for a timer that was itself
 * started offline, whose id at that moment is a temp id the server has never
 * seen — and the replayed start is what mints the real one, just above.
 */
const targetedStopInput = (
  mutation: Extract<OfflineMutation, { op: "entries.stop" }>,
  resolved: ReplayIdMap,
  queuedAt: string
): OfflinePayloadMap["entries.stop"] => {
  if (mutation.input.id) return mutation.input;

  const realId = mutation.tempId ? resolved.get(mutation.tempId) : undefined;
  if (realId) return { ...mutation.input, id: realId };

  if (Date.now() - Date.parse(queuedAt) > STALE_STOP_MS) {
    throw new StaleQueuedStopError(queuedAt);
  }

  // Recent and unidentifiable: the server's own "stop whatever is running"
  // is still the best available answer, and it is what shipped before.
  return mutation.input;
};

/**
 * Replay one queued mutation against the server.
 *
 * Rejections are the caller's problem — `flush` classifies them into "still
 * offline, keep the queue in order" and "the server refused it, drop it" — so
 * nothing is caught here.
 */
export const replayOfflineMutation = async (
  mutators: OfflineReplayMutators,
  watcher: Pick<IdleWatcher, "noteServerId">,
  mutation: OfflineMutation,
  context: { createdAt: string; resolved: ReplayIdMap } = {
    createdAt: new Date().toISOString(),
    resolved: new Map(),
  }
): Promise<void> => {
  switch (mutation.op) {
    case "entries.start": {
      // The result is not discarded, unlike every other op below: a start made
      // while offline was claimed on the watcher against its temp id, and the
      // real id only exists now. Without the rename the ownership check in
      // `observe` fails against the named entry and idle detection silently
      // never fires again for it.
      const entry = await mutators["entries.start"](
        inWorkspace<"entries.start">(mutation, mutation.input)
      );
      noteReplayedServerId(watcher, mutation, entry);
      const realId = replayedId(entry);
      if (mutation.tempId && realId) context.resolved.set(mutation.tempId, realId);
      return;
    }
    case "entries.stop":
      await mutators["entries.stop"](
        inWorkspace<"entries.stop">(
          mutation,
          targetedStopInput(mutation, context.resolved, context.createdAt)
        )
      );
      return;
    case "entries.create":
      await mutators["entries.create"](
        inWorkspace<"entries.create">(mutation, mutation.input)
      );
      return;
    case "entries.update":
      await mutators["entries.update"](
        inWorkspace<"entries.update">(mutation, mutation.input)
      );
      return;
    case "entries.remove":
      await mutators["entries.remove"](
        inWorkspace<"entries.remove">(mutation, mutation.input)
      );
      return;
    case "entries.discard":
      await mutators["entries.discard"](
        inWorkspace<"entries.discard">(mutation, mutation.input)
      );
      return;
  }
};
