/**
 * The op/payload contract for entry mutations that were queued offline.
 *
 * `offline-queue.ts` stores opaque rows; this module is what gives those rows
 * meaning. It lives in core rather than the web client because every client
 * that can mutate entries — the web app, the extension's service worker, the
 * Raycast client — must agree on the op names and payload shapes, or one of
 * them writes rows another cannot replay. Everything here is pure: no window,
 * no React, no tRPC. The replay runner that actually calls the API stays with
 * whichever client owns the API binding.
 */

import { createId } from "./ids.js";
import type { IdleWatcher } from "./idle.js";
import type { QueuedMutation } from "./offline-queue.js";
import type { EntrySource } from "@starter/shared";

export const OFFLINE_QUEUE_STORAGE_KEY = "trackyourtime.offline-queue";

/**
 * Where the last account to own the queue is remembered.
 *
 * Beside the queue, in the same store and with the same durability, because
 * it is what a row is stamped with when a mutation is made before the session
 * has resolved — a cold offline launch on a phone, which is the launch the
 * queue exists for. Losing it would put those rows back to unowned, i.e.
 * claimable by the next account to sign in.
 *
 * It is an id, not a credential: the token lives in the Keychain, this lives
 * beside the data it describes.
 */
export const OFFLINE_QUEUE_OWNER_STORAGE_KEY = "trackyourtime.offline-queue-owner";

/** Entries invented client-side carry this prefix until the server replies. */
export const TEMP_ID_PREFIX = "temp-";

/** Id for an entry that exists only in the cache and the offline queue. */
export const createTempId = (): string => `${TEMP_ID_PREFIX}${createId()}`;

export const isTempId = (id: string): boolean => id.startsWith(TEMP_ID_PREFIX);

// ── payloads ─────────────────────────────────────────────────────────

/**
 * Tags carried by a queued entry mutation.
 *
 * Optional, and deliberately so: rows written by a build that predates tags
 * decode without the field, and replaying one must not fail. The server reads
 * an absent list as "no tags" on start/create and as "leave them alone" on
 * update — exactly what those old rows meant when they were written.
 */
export type OfflineTagIds = string[] | undefined;

export type OfflineStartInput = {
  description: string;
  projectId: string | null;
  taskId: string | null;
  tagIds?: OfflineTagIds;
  billable: boolean;
  start: string;
  source: EntrySource;
  /** IANA zone this was recorded in. Replayed unchanged, so a queued entry
   *  keeps the zone it was created in rather than the zone it syncs from. */
  timeZone: string;
  originId: string;
};

export type OfflineStopInput = {
  /** Omitted on purpose during replay — stop whatever is running server-side. */
  id?: string;
  end: string;
  originId: string;
};

export type OfflineCreateInput = {
  description: string;
  projectId: string | null;
  taskId: string | null;
  tagIds?: OfflineTagIds;
  billable: boolean;
  start: string;
  end: string;
  source: EntrySource;
  timeZone: string;
  originId: string;
};

export type OfflineUpdateInput = {
  id: string;
  description?: string;
  projectId?: string | null;
  taskId?: string | null;
  /** Absent leaves the tags alone; `[]` clears them. */
  tagIds?: OfflineTagIds;
  billable?: boolean;
  start?: string;
  end?: string | null;
  originId: string;
};

export type OfflineIdInput = {
  id: string;
  originId: string;
};

export type OfflineDiscardInput = {
  id?: string;
  originId: string;
};

export type OfflinePayloadMap = {
  "entries.start": OfflineStartInput;
  "entries.stop": OfflineStopInput;
  "entries.create": OfflineCreateInput;
  "entries.update": OfflineUpdateInput;
  "entries.remove": OfflineIdInput;
  "entries.discard": OfflineDiscardInput;
};

export type OfflineOp = keyof OfflinePayloadMap;

const OFFLINE_OPS: readonly string[] = [
  "entries.start",
  "entries.stop",
  "entries.create",
  "entries.update",
  "entries.remove",
  "entries.discard",
];

const isOfflineOp = (value: string): value is OfflineOp =>
  OFFLINE_OPS.includes(value);

/** A queued mutation, narrowed back to its typed input. */
export type OfflineMutation = {
  [K in OfflineOp]: {
    /** Queue entry id, not the entry id. */
    queueId: string;
    op: K;
    input: OfflinePayloadMap[K];
    /** Temp id of the entry this mutation invented, when it invented one. */
    tempId?: string;
    /**
     * The workspace the row was queued in (`QueuedMutation.workspaceId`).
     * Present only when the row carries a stamp, so a decoded legacy row has
     * exactly the shape it always had.
     */
    workspaceId?: string;
  };
}[OfflineOp];

/** The envelope `enqueueOffline` writes into a queue row's payload. */
export type StoredOfflinePayload = { input: unknown; tempId?: string };

const readStored = (payload: unknown): StoredOfflinePayload | null => {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as { input?: unknown; tempId?: unknown };
  if (typeof record.input !== "object" || record.input === null) return null;
  return {
    input: record.input,
    tempId: typeof record.tempId === "string" ? record.tempId : undefined,
  };
};

/**
 * Narrow a raw queue row back into a typed mutation. Returns null for rows
 * written by an older build — a stale row must be dropped, never replayed
 * blind against a schema it no longer matches.
 */
export const decodeOfflineMutation = (
  mutation: QueuedMutation
): OfflineMutation | null => {
  if (!isOfflineOp(mutation.op)) return null;
  const stored = readStored(mutation.payload);
  if (stored === null) return null;

  const decoded = decodeOp(mutation.id, mutation.op, stored);
  return mutation.workspaceId === undefined
    ? decoded
    : { ...decoded, workspaceId: mutation.workspaceId };
};

const decodeOp = (
  queueId: string,
  op: OfflineOp,
  stored: StoredOfflinePayload
): OfflineMutation => {
  const tempId = stored.tempId;

  switch (op) {
    case "entries.start":
      return {
        queueId,
        tempId,
        op: "entries.start",
        input: stored.input as OfflineStartInput,
      };
    case "entries.stop":
      return {
        queueId,
        tempId,
        op: "entries.stop",
        input: stored.input as OfflineStopInput,
      };
    case "entries.create":
      return {
        queueId,
        tempId,
        op: "entries.create",
        input: stored.input as OfflineCreateInput,
      };
    case "entries.update":
      return {
        queueId,
        tempId,
        op: "entries.update",
        input: stored.input as OfflineUpdateInput,
      };
    case "entries.remove":
      return {
        queueId,
        tempId,
        op: "entries.remove",
        input: stored.input as OfflineIdInput,
      };
    case "entries.discard":
      return {
        queueId,
        tempId,
        op: "entries.discard",
        input: stored.input as OfflineDiscardInput,
      };
  }
};

// ── replay ───────────────────────────────────────────────────────────

/**
 * The entry a replayed `entries.start` produced, as far as a caller with an
 * untyped mutation result can tell. Only the id matters here, and it has to be
 * read defensively: the replay runner holds the API binding, so what comes
 * back is whatever that binding returned.
 */
const replayedEntryId = (result: unknown): string | null => {
  if (typeof result !== "object" || result === null) return null;
  const { id } = result as { id?: unknown };
  return typeof id === "string" && id.length > 0 ? id : null;
};

/**
 * Rename the idle watcher's ownership claim after a queued start finally
 * reached the server. Returns whether anything changed, so a client that has
 * to persist its watcher only writes when there is something to write.
 *
 * A timer started offline is claimed against its temp id — that is the only id
 * it has — and the claim is what lets this device act on its own idle signal
 * for that entry. Replay gives the entry a real id, and without this the claim
 * still names the temp one, so the ownership check in `observe` fails against
 * every later reading and idle detection silently stops working for the rest
 * of the entry's life.
 *
 * `noteServerId` rather than `noteLocalStart`: a row can sit in the queue for
 * hours, and anything the watcher decided in the meantime — a prompt on
 * screen, a resume waiting for the person to come back — names the temp id and
 * has to survive the rename rather than be reset by a fresh claim.
 */
export const noteReplayedServerId = (
  watcher: Pick<IdleWatcher, "noteServerId">,
  mutation: OfflineMutation,
  result: unknown
): boolean => {
  // Only a start invents an id. Every other op names an entry that already
  // exists, so there is nothing to rename.
  if (mutation.op !== "entries.start") return false;
  const { tempId } = mutation;
  if (tempId === undefined) return false;

  const entryId = replayedEntryId(result);
  if (entryId === null || entryId === tempId) return false;

  watcher.noteServerId(tempId, entryId);
  return true;
};

// ── describing a row ─────────────────────────────────────────────────

/**
 * A queued row as something a person can recognise.
 *
 * Needed wherever a client offers to destroy queued work: rows another account
 * left behind are kept and never replayed, which on its own makes them
 * immortal, and a permanent count nobody can act on is a scold. The way out
 * has to name what it is destroying — deleting "3 changes" is not a decision
 * anybody can make, and deleting two entries called "Invoicing" from 21 Aug
 * is. Shared so the web app and Raycast describe the same row the same way.
 */
export type QueuedMutationSummary = {
  queueId: string;
  /** Null when the row was written by a build whose ops we no longer know. */
  op: OfflineOp | null;
  description: string | null;
  /** When the work happened — the payload's own start, else when it queued. */
  at: string;
  /** The server origin it was queued against, when the row says. */
  server: string | null;
  /** The workspace it was queued in, when the row says. */
  workspaceId: string | null;
  /**
   * That workspace's name, when the caller's lookup knows it. Null for an
   * unstamped row, and for a workspace the person has left — which is the
   * case a client names differently ("a workspace you left"), so the two are
   * never collapsed into a guessed name.
   */
  workspaceName: string | null;
};

/** Workspace id → name, for the workspaces the caller still knows about. */
export type WorkspaceNameLookup = (workspaceId: string) => string | null;

export const describeQueuedMutation = (
  row: QueuedMutation,
  workspaceName?: WorkspaceNameLookup
): QueuedMutationSummary => {
  const workspaceId = row.workspaceId ?? null;
  const workspace = {
    workspaceId,
    workspaceName:
      workspaceId === null || workspaceName === undefined
        ? null
        : workspaceName(workspaceId),
  };
  const decoded = decodeOfflineMutation(row);
  if (decoded === null) {
    return {
      queueId: row.id,
      op: null,
      description: null,
      at: row.createdAt,
      server: row.server ?? null,
      ...workspace,
    };
  }
  const input = decoded.input as { description?: string; start?: string };
  return {
    queueId: row.id,
    op: decoded.op,
    description: input.description ?? null,
    at: input.start ?? row.createdAt,
    server: row.server ?? null,
    ...workspace,
  };
};
