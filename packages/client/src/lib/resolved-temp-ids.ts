/**
 * Which server id each temp id of this tab turned into.
 *
 * A start shows its entry under a temp id (`createTempId` in core) until the
 * server answers, and the answer names the same entry with its real id. Code
 * that keys "is this the same timer" on the id — the tracker bar adopting the
 * running entry's fields — would otherwise read that rename as a new timer
 * and throw away whatever was typed in between.
 *
 * Written from the two places a temp id is resolved: a start's `onSuccess`
 * and the offline replay's `resolvedTempId` verdict. Per tab and in memory:
 * a temp id never outlives the document that invented it, except through the
 * running mirror, and that one is resolved by a replay in the same document.
 */
import { isTempId } from "@starter/core";

/**
 * Enough for every start a tab makes between two renders, many times over;
 * the oldest is forgotten first, so a long-lived tab does not grow forever.
 */
const LIMIT = 64;

const resolved = new Map<string, string>();

export const noteResolvedTempId = (tempId: string, serverId: string): void => {
  if (!isTempId(tempId) || tempId === serverId) return;
  resolved.delete(tempId);
  resolved.set(tempId, serverId);
  if (resolved.size > LIMIT) {
    const oldest = resolved.keys().next().value;
    if (oldest !== undefined) resolved.delete(oldest);
  }
};

/**
 * True when `next` is the entry `previous` named: the same id, or the server
 * id a temp `previous` was resolved to. A temp id that has not been resolved
 * is never the same entry as some other id — that is a different timer, such
 * as one started on another device.
 */
export const isSameEntry = (
  previous: string | null,
  next: string | null
): boolean => {
  if (previous === next) return true;
  if (previous === null || next === null || !isTempId(previous)) return false;
  return resolved.get(previous) === next;
};

export const __resetResolvedTempIdsForTests = (): void => {
  resolved.clear();
};
