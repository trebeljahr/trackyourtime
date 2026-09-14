/**
 * The host-free half of "which workspace is this client pointed at".
 *
 * Every first-party client — web, the browser extension, Raycast — keeps its
 * OWN choice of workspace and sends it explicitly on every request. None of
 * them follows the session's `activeOrganizationId`: that is one value per
 * session on the server, and a switch in one client must never silently
 * retarget a timer started from another. What the clients share is the rules
 * below, so the three cannot disagree about which workspace a stored id
 * resolves to, which socket events concern the screen, or whose time a total
 * adds up.
 */
import type { SyncEvent, WorkspaceSummary } from "@starter/shared";

/**
 * The workspace a client should address, given what it stored and the
 * membership list it last saw.
 *
 * The stored id when it is still a membership, else the workspace the server
 * calls the default (else the first). A stored id that fails validation is
 * never returned — every workspace-scoped request would answer NOT_FOUND until
 * something noticed. With no list at all (never fetched, or a cold offline
 * start) the stored id is the best answer there is, and the first list to
 * arrive validates it.
 */
export const resolveActiveWorkspaceId = (
  stored: string | null,
  workspaces: readonly WorkspaceSummary[] | null
): string | null => {
  if (workspaces === null) return stored;
  if (stored !== null && workspaces.some((w) => w.id === stored)) return stored;
  return workspaces.find((w) => w.isDefault)?.id ?? workspaces[0]?.id ?? null;
};

/**
 * How much of a sync event concerns the workspace a client is showing.
 *
 * A person's socket carries every workspace they belong to, so:
 *
 *  - `"all"`: the event is about this workspace, or about the person (no
 *    `workspaceId` on the envelope), or no workspace is resolved yet.
 *  - `"timer"`: another workspace's timer or entry event. The running timer is
 *    per PERSON — a start in A stops B's — so the running entry is re-read and
 *    nothing else; A's rows must not reach B's lists.
 *  - `"membership"`: another workspace's membership changed. Only the
 *    workspace list can be affected.
 *  - `"ignore"`: anything else from another workspace.
 */
export type SyncEventReach = "all" | "timer" | "membership" | "ignore";

export const syncEventReach = (
  event: SyncEvent,
  eventWorkspaceId: string | undefined,
  activeWorkspaceId: string | null
): SyncEventReach => {
  if (
    eventWorkspaceId === undefined ||
    activeWorkspaceId === null ||
    eventWorkspaceId === activeWorkspaceId
  ) {
    return "all";
  }
  switch (event.kind) {
    case "timer.started":
    case "timer.stopped":
    case "entry.upserted":
    case "entry.deleted":
      return "timer";
    case "membership.changed":
      return "membership";
    default:
      return "ignore";
  }
};

/**
 * True when `entry` was tracked by `userId`.
 *
 * In a shared workspace a member allowed to see others' time receives their
 * entries from `entries.list` and their timer events over the socket. The
 * extension badge, the Raycast menu bar and every "today" figure are about the
 * person holding the device, so each of those reads goes through this. An
 * unknown user owns nothing: a total that cannot tell whose time it is adds
 * none, rather than adding a colleague's.
 */
export const isOwnEntry = (
  entry: { authorId?: string },
  userId: string | null
): boolean => userId !== null && userId !== "" && entry.authorId === userId;

/** `entries` narrowed to the ones `userId` tracked — see {@link isOwnEntry}. */
export const ownEntries = <T extends { authorId?: string }>(
  entries: readonly T[],
  userId: string | null
): T[] => entries.filter((entry) => isOwnEntry(entry, userId));

/**
 * True when an event is evidence that THIS person was at a keyboard just now.
 *
 * In a shared workspace a colleague's entry events reach this socket too, and
 * a colleague typing is not a reason to believe this person is — counting it
 * would stop idle detection from ever pausing a laptop left open in an office
 * of people tracking time. Entry-bearing events count only for their author;
 * events about the person (no workspace on the envelope) always count; any
 * other workspace event cannot say who caused it, so it does not.
 */
export const isOwnActivity = (
  event: SyncEvent,
  eventWorkspaceId: string | undefined,
  userId: string | null
): boolean => {
  if ("entry" in event) return isOwnEntry(event.entry, userId);
  return eventWorkspaceId === undefined;
};

// ── a client's stored choice ─────────────────────────────────────────

/**
 * What a client that is not the web app keeps about workspaces: the chosen
 * id, the last membership list, and every workspace name it has seen.
 *
 * The list is kept for the offline case — a cold start with no server still
 * has to stamp queued rows with a workspace and name the choice on screen —
 * and the names for the case the list cannot answer: a row held for a
 * workspace the person has since left is described by the name it had
 * ("Start “Design” in Acme"), not an id.
 *
 * `server` and `userId` say whose list it is. Workspace ids mean nothing on
 * another server, and another account on the same machine must resolve its
 * own default rather than inherit an id it may not belong to.
 */
export type StoredWorkspaceChoice = {
  server: string | null;
  userId: string | null;
  /** The chosen id, unvalidated. See {@link resolveActiveWorkspaceId}. */
  workspaceId: string | null;
  workspaces: WorkspaceSummary[] | null;
  names: Record<string, string>;
};

export const emptyWorkspaceChoice = (): StoredWorkspaceChoice => ({
  server: null,
  userId: null,
  workspaceId: null,
  workspaces: null,
  names: {},
});

/** Enough for anyone's history of workspaces; the oldest names drop first. */
const MAX_REMEMBERED_WORKSPACE_NAMES = 50;

const isWorkspaceSummary = (value: unknown): value is WorkspaceSummary => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id !== "" &&
    typeof record.name === "string" &&
    typeof record.isDefault === "boolean"
  );
};

const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/**
 * Read a stored choice back. A malformed record reads as "never chosen",
 * never as an error — the only cost is resolving the default again.
 */
export const parseWorkspaceChoice = (raw: string | null): StoredWorkspaceChoice => {
  if (raw === null || raw === "") return emptyWorkspaceChoice();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return emptyWorkspaceChoice();
    const record = parsed as Record<string, unknown>;
    const names: Record<string, string> = {};
    if (typeof record.names === "object" && record.names !== null) {
      for (const [id, name] of Object.entries(record.names)) {
        if (typeof name === "string") names[id] = name;
      }
    }
    return {
      server: nonEmpty(record.server),
      userId: nonEmpty(record.userId),
      workspaceId: nonEmpty(record.workspaceId),
      workspaces: Array.isArray(record.workspaces)
        ? record.workspaces.filter(isWorkspaceSummary)
        : null,
      names,
    };
  } catch {
    return emptyWorkspaceChoice();
  }
};

/**
 * `choice` if it was recorded for this server and account, else an empty one.
 *
 * A null on either side of a comparison is "not recorded", which matches
 * anything: a client that has no account id yet (a session borrowed from the
 * web app's cookie) must still be able to use the choice it made.
 */
export const workspaceChoiceFor = (
  choice: StoredWorkspaceChoice,
  owner: { server: string | null; userId: string | null }
): StoredWorkspaceChoice => {
  const serverMatches =
    choice.server === null || owner.server === null || choice.server === owner.server;
  const userMatches =
    choice.userId === null || owner.userId === null || choice.userId === owner.userId;
  return serverMatches && userMatches ? choice : emptyWorkspaceChoice();
};

/**
 * `names` with every workspace in `list` recorded, newest last, capped.
 *
 * Names are only ever added or renamed, never removed because a list stopped
 * containing them: a removal is exactly when the name is needed.
 */
export const rememberWorkspaceNames = (
  names: Readonly<Record<string, string>>,
  list: readonly WorkspaceSummary[]
): Record<string, string> => {
  const next: Record<string, string> = { ...names };
  for (const workspace of list) {
    delete next[workspace.id];
    next[workspace.id] = workspace.name;
  }
  const ids = Object.keys(next);
  const overflow = Math.max(0, ids.length - MAX_REMEMBERED_WORKSPACE_NAMES);
  for (const id of ids.slice(0, overflow)) delete next[id];
  return next;
};

/**
 * Install a fresh membership list into a choice.
 *
 * The resolved id is written back as the choice, so a later offline start
 * addresses the workspace this answer settled on. `moved` is true when the
 * resolution changed — the stored workspace is no longer a membership, or
 * nothing had been resolved — which is when a client must drop every cache
 * describing the old one.
 */
export const withWorkspaceList = (
  choice: StoredWorkspaceChoice,
  list: readonly WorkspaceSummary[],
  owner: { server: string | null; userId: string | null } = {
    server: choice.server,
    userId: choice.userId,
  }
): { choice: StoredWorkspaceChoice; activeId: string | null; moved: boolean } => {
  const before = resolveActiveWorkspaceId(choice.workspaceId, choice.workspaces);
  const activeId = resolveActiveWorkspaceId(choice.workspaceId, list);
  return {
    choice: {
      server: owner.server,
      userId: owner.userId,
      workspaceId: activeId,
      workspaces: [...list],
      names: rememberWorkspaceNames(choice.names, list),
    },
    activeId,
    moved: before !== activeId,
  };
};

/** A workspace's name from a choice, including one the person has left. */
export const workspaceNameIn = (
  choice: StoredWorkspaceChoice,
  workspaceId: string
): string | null =>
  choice.workspaces?.find((it) => it.id === workspaceId)?.name ??
  choice.names[workspaceId] ??
  null;

/**
 * True when a queued row is held: it names a workspace that the last known
 * list does not contain. With no list at all nothing is held — "we have never
 * asked" is not evidence that the person left.
 */
export const isHeldByWorkspace = (
  row: { workspaceId?: string },
  workspaces: readonly WorkspaceSummary[] | null
): boolean =>
  workspaces !== null &&
  row.workspaceId !== undefined &&
  !workspaces.some((it) => it.id === row.workspaceId);

/**
 * A storage key for data that describes ONE workspace — a local read cache,
 * an optimistic overlay. `base` alone while no workspace is known, which is
 * also where a build from before workspaces wrote it; the first client to
 * resolve a workspace adopts that value (see the Raycast bindings).
 */
export const workspaceScopedKey = (base: string, workspaceId: string | null): string =>
  workspaceId === null || workspaceId === "" ? base : `${base}:${workspaceId}`;
