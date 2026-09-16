import type { TimeEntry } from "./types.js";

// ── Client → Server ──────────────────────────────────────────────────
//
// There is no client → server message. A socket is a one-way feed of the
// sync events for the person it authenticated as: the server places it in
// that person's own room at the upgrade and nowhere else, so there is nothing
// for a client to ask for. The starter's room-join, chat and action messages
// were removed because a join named its room in client input — any signed-in
// user could subscribe to anybody else's events. The server ignores any frame
// a client sends, an old client's join included, and keeps the socket open.

// ── Server → Client ──────────────────────────────────────────────────

export type ServerToClientMessage =
  | {
      type: "tt:sync";
      event: SyncEvent;
      originId?: string;
      /**
       * The workspace the event happened in. A person's room receives every
       * workspace they belong to, so a client showing workspace A must be
       * able to tell that an `entry.upserted` belongs to B and not patch it
       * into A's lists. Optional: `publishToUser` events are about the person
       * (their own preferences, a device) and belong to no workspace.
       */
      workspaceId?: string;
    };

// ── trackyourtime realtime sync ──────────────────────────────────────────
//
// Every mutation broadcasts a SyncEvent into the owner's own room
// ("user:<ownerId>"). The mutation's `originId` (a per-tab uuid) is echoed
// on the envelope so the originating client can ignore its own echo.

export type SyncEvent =
  | { kind: "entry.upserted"; entry: TimeEntry }
  | { kind: "entry.deleted"; id: string }
  | { kind: "timer.started"; entry: TimeEntry }
  | { kind: "timer.stopped"; entry: TimeEntry }
  | {
      kind: "catalog.changed";
      scope: "client" | "project" | "task" | "tag";
      /**
       * Set when the change rewrote time entries too — a cascading delete
       * detaches every entry that pointed at the removed project or task, so
       * the entry caches are stale even though no entry event was published.
       */
      entriesTouched?: boolean;
    }
  /**
   * The pinned quick starts changed — added, removed or reordered.
   *
   * Its own kind rather than a `catalog.changed` scope: a favorite is not a
   * catalog document (Client -> Project -> Task), and folding it in would make
   * every client refetch the whole catalog and every report to learn that a
   * chip moved one slot to the left.
   */
  | { kind: "favorites.changed" }
  /**
   * An invoice was created, had its status changed, or was deleted. The id is
   * enough — clients refetch rather than trusting a broadcast snapshot, since
   * an invoice carries money and must never be rendered from stale gossip.
   */
  | { kind: "invoice.changed"; id: string }
  | { kind: "settings.changed" }
  /**
   * A bulk import landed or was undone. One event for the whole batch, not one
   * per entry: an import writes thousands of rows at once, and a client that
   * received thousands of `entry.upserted` events would spend the import
   * re-rendering instead of showing the result. Every cache is stale after
   * this, so clients invalidate rather than patch.
   */
  | { kind: "data.imported"; batchId: string; undone: boolean }
  /**
   * An API token or a webhook subscription was created, changed or revoked.
   *
   * Carries no id and no payload: both lists are short, both are read only on
   * a settings screen, and a token's plaintext exists exactly once — putting
   * any part of one on a broadcast that every device in the workspace
   * receives is a shape worth not having at all.
   */
  | { kind: "integrations.changed"; scope: "api-token" | "webhook" }
  /**
   * Who is in a workspace, or what they may do there, changed.
   *
   * Published to every member AND, for `removed`/`left`/`joined`, to the
   * person concerned directly — a removed person is no longer a member, so
   * the workspace fan-out cannot reach them, and their clients still have to
   * drop the workspace from the switcher and stop sending requests into it.
   * Carries no member data: clients refetch, because what a recipient may
   * see of the member list is decided per request.
   */
  | {
      kind: "membership.changed";
      workspaceId: string;
      reason:
        | "joined"
        | "role"
        | "visibility"
        | "removed"
        | "left"
        | "transferred"
        | "invitation";
    };

/**
 * Every sync event kind this build knows, as a value.
 *
 * A server can be NEWER than the client reading its socket (a store client
 * talking to a freshly upgraded self-hosted server lags nothing, but a desktop
 * build or a tab left open does), so a frame can carry a kind that is not in
 * {@link SyncEvent} at all. Ignoring it leaves screens stale with nothing to
 * say why; every client instead treats an unknown kind — and an unknown scope
 * below — as "something changed, refetch". The mapped type fails `tsc` when a
 * kind is added to the union and not here.
 */
const SYNC_EVENT_KIND_SET: { readonly [K in SyncEvent["kind"]]: true } = {
  "entry.upserted": true,
  "entry.deleted": true,
  "timer.started": true,
  "timer.stopped": true,
  "catalog.changed": true,
  "favorites.changed": true,
  "invoice.changed": true,
  "settings.changed": true,
  "data.imported": true,
  "integrations.changed": true,
  "membership.changed": true,
};

export const SYNC_EVENT_KINDS = Object.keys(SYNC_EVENT_KIND_SET) as readonly SyncEvent["kind"][];

/** True for a kind this build has a case for; false for one a newer server added. */
export const isKnownSyncEventKind = (kind: string): kind is SyncEvent["kind"] =>
  Object.prototype.hasOwnProperty.call(SYNC_EVENT_KIND_SET, kind);

export type CatalogChangeScope = Extract<SyncEvent, { kind: "catalog.changed" }>["scope"];
export type IntegrationChangeScope = Extract<SyncEvent, { kind: "integrations.changed" }>["scope"];

const CATALOG_SCOPE_SET: { readonly [S in CatalogChangeScope]: true } = {
  client: true,
  project: true,
  task: true,
  tag: true,
};
const INTEGRATION_SCOPE_SET: { readonly [S in IntegrationChangeScope]: true } = {
  "api-token": true,
  webhook: true,
};

/** A scope a newer server added reads as unknown — refetch everything it could touch. */
export const isKnownCatalogScope = (scope: string): scope is CatalogChangeScope =>
  Object.prototype.hasOwnProperty.call(CATALOG_SCOPE_SET, scope);
export const isKnownIntegrationScope = (scope: string): scope is IntegrationChangeScope =>
  Object.prototype.hasOwnProperty.call(INTEGRATION_SCOPE_SET, scope);

/** Room name every sync event for a given owner is published to. */
export const userRoomId = (ownerId: string): string => `user:${ownerId}`;

/**
 * Narrowing helper for the sync envelope.
 *
 * Checks the payload, not only the tag. Frames arrive over a socket from a
 * server that may be a different version than the client — older, newer, or
 * mid-deploy — so `type: "tt:sync"` alone is a claim, not a guarantee. An
 * envelope with no `event` used to narrow cleanly here and then hand
 * `undefined` to every consumer, each of which switches on `event.kind`.
 */
export const isSyncMessage = (
  message: ServerToClientMessage
): message is Extract<ServerToClientMessage, { type: "tt:sync" }> => {
  if (message.type !== "tt:sync") return false;
  const { event } = message as { event?: unknown };
  return (
    typeof event === "object" &&
    event !== null &&
    typeof (event as { kind?: unknown }).kind === "string"
  );
};

/**
 * Close code for a socket the server dropped because its session is gone —
 * signed out from Settings → Devices, expired, or deleted outright.
 *
 * In the application range (4000-4999) and deliberately echoing HTTP 401, so
 * a client can tell "you were signed out" from "the network died". It lives
 * here, in the protocol, rather than beside either end of it: the server
 * writes the number and every client reads it, and a client that reconnects
 * forever because the two disagreed by one digit is a silent failure on the
 * device, not a build error anywhere.
 */
export const SESSION_REVOKED_CLOSE_CODE = 4401;
