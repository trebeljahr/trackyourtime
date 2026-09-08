/**
 * The web client's binding for the shared offline replay.
 *
 * The runner moved to `@starter/core` when Raycast grew a queue of its own:
 * the temp-id rename and the stale-stop refusal are decisions about the queue
 * contract, not about React, and two clients replaying the same rows by
 * different rules is how one of them writes entries the other cannot explain.
 * This file stays so the hook and its tests keep one import path.
 */
export {
  replayOfflineMutation,
  StaleQueuedStopError,
  STALE_STOP_MS,
} from "@starter/core";

export type { OfflineReplayMutators, ReplayIdMap } from "@starter/core";
