/**
 * Errors this client raises before any request exists.
 *
 * Its own module so the offline queue can classify a failure without importing
 * the API surface that imports the queue back.
 */

/** Thrown when no token is stored — the caller should offer to sign in. */
export class NotSignedInError extends Error {
  constructor() {
    super("Not signed in to tracktime");
    this.name = "NotSignedInError";
  }
}

/**
 * Thrown when an edit names an entry that only exists in this Mac's offline
 * queue.
 *
 * The queued `entries.start` or `entries.create` still carries every field it
 * was written with, so nothing is lost — the edit just has to wait until the
 * entry is real and has an id the server would recognise. Refusing loudly is
 * the alternative to sending an update for a temp id, which the server refuses
 * permanently and the queue therefore drops: the edit would vanish with no
 * error anywhere.
 */
export class StillSyncingError extends Error {
  constructor() {
    super("This entry has not synced yet — it can be edited once it has");
    this.name = "StillSyncingError";
  }
}
