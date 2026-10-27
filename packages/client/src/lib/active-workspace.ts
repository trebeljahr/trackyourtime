import { capturePrivateMutationAction } from "./private-mutation-guard";
/**
 * Which workspace this device is pointed at.
 *
 * A person in more than one workspace needs every request to say which one it
 * means. The session's `activeOrganizationId` cannot be that answer: it is one
 * value per SESSION on the server, the browser extension and Raycast each hold
 * their own session, and a switch in one place must not silently retarget a
 * timer started in another. So the choice is per client and travels on the
 * request — the tRPC link in `lib/trpc.ts` adds `workspaceId` to every input
 * that names none, reading it from here.
 *
 * What is stored, and where:
 *
 *  - The chosen id, under `ACTIVE_WORKSPACE_STORAGE_KEY`.
 *  - The last membership list this device saw, with the account and server
 *    it belongs to. It is what validates the stored id before the server has
 *    answered — a cold offline launch on a phone never gets that answer — and
 *    what the offline queue stamps rows against in the meantime.
 *
 * Both sit beside the offline queue: Capacitor Preferences on the native
 * shells (WKWebView may evict `localStorage`, and a queued row stamped with a
 * workspace nobody can name any more is a row nobody can decide about),
 * `localStorage` on web.
 *
 * The value is only ever a validated id: the stored choice when it is still a
 * membership, else the workspace the server calls the default. A stored id
 * that fails validation is never sent — every workspace-scoped request would
 * answer NOT_FOUND until something noticed.
 */

import {
  ACTIVE_WORKSPACE_STORAGE_KEY,
  memoryStorage,
  resolveActiveWorkspaceId,
  webStorage,
  type KeyValueStorage,
  type WorkspaceSummary,
} from "@starter/core";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

import {
  preferencesStorage,
  shouldUseNativeStorage,
} from "@/mobile/preferences-storage";
import { getAbsoluteApiOrigin, whenApiOriginReady } from "@/lib/api-origin";

import { KNOWN_WORKSPACES_STORAGE_KEY, publicWorkspaceDirectory, workspaceDirectoryExclusive, strictWorkspaceDirectoryStorage, eraseStoredWorkspaceNames, subscribeWorkspaceNameProtection, type KnownWorkspaces } from "./workspace-name-privacy";
import { privateRoutingRequired, privateRoutingRequiredOnWeb } from "./private-routing-requirement";
import { privateSession, subscribePrivateSession, subscribePrivateAccount } from "./private-session";
export { KNOWN_WORKSPACES_STORAGE_KEY } from "./workspace-name-privacy";

/** Enough for anyone's history of workspaces; the oldest names drop first. */
const MAX_REMEMBERED_NAMES = 50;

export type ActiveWorkspaceSnapshot = {
  /** Null until something has resolved; requests then name no workspace. */
  activeId: string | null;
  /** The last known list, or null when this device has never seen one. */
  workspaces: WorkspaceSummary[] | null;
};

// ── storage ──────────────────────────────────────────────────────────

const resolveStorage = (): KeyValueStorage => {
  if (typeof window === "undefined") return memoryStorage();
  if (shouldUseNativeStorage()) {
    return preferencesStorage({
      migrateKeys: [ACTIVE_WORKSPACE_STORAGE_KEY, KNOWN_WORKSPACES_STORAGE_KEY],
    });
  }
  try {
    return webStorage(window.localStorage);
  } catch {
    return memoryStorage();
  }
};

let storage: KeyValueStorage | null = null;
const getStorage = (): KeyValueStorage => {
  storage ??= resolveStorage();
  return storage;
};

const isSummary = (value: unknown): value is WorkspaceSummary => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id !== "" &&
    typeof record.name === "string" &&
    typeof record.isDefault === "boolean"
  );
};

const parseKnown = (raw: string | null): KnownWorkspaces | null => {
  if (raw === null || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.userId !== "string" || typeof record.server !== "string") {
      return null;
    }
    if (!Array.isArray(record.workspaces)) return null;
    const names: Record<string, string> = {};
    if (typeof record.names === "object" && record.names !== null) {
      for (const [id, name] of Object.entries(record.names)) {
        if (typeof name === "string") names[id] = name;
      }
    }
    return {
      userId: record.userId,
      server: record.server,
      workspaces: record.workspaces.filter(isSummary),
      names,
    };
  } catch {
    return null;
  }
};

// ── state ────────────────────────────────────────────────────────────

let storedId: string | null = null;
let known: KnownWorkspaces | null = null;
let snapshot: ActiveWorkspaceSnapshot = { activeId: null, workspaces: null };
let hydration: Promise<void> | null = null;
let hydrated = false;
let protectedScope: string | null = null;
const scopeKey = ({ server, userId }: { server: string; userId: string }) => JSON.stringify([server, userId]);

const listeners = new Set<() => void>();

/**
 * The known list, but only when it describes the server this device talks to
 * now. A phone pointed at a different server keeps the old list on disk (it
 * names the rows queued there) and must not validate against it.
 */
const knownHere = (): KnownWorkspaces | null =>
  known !== null && known.server === getAbsoluteApiOrigin() ? known : null;

/**
 * The id to send: the stored choice when it is still a membership, else the
 * default. The rule lives in core so the extension and Raycast resolve a
 * stored id exactly the same way.
 */
export { resolveActiveWorkspaceId };

const publish = (notify = true): void => {
  const here = knownHere();
  const next: ActiveWorkspaceSnapshot = {
    activeId: resolveActiveWorkspaceId(storedId, here?.workspaces ?? null),
    workspaces: here?.workspaces ?? null,
  };
  if (
    next.activeId === snapshot.activeId &&
    next.workspaces === snapshot.workspaces
  ) {
    return;
  }
  snapshot = next;
  if (notify) for (const listener of listeners) listener();
};

/**
 * On web the stored values are in `localStorage`, which reads synchronously —
 * so they are read synchronously, the first time anything asks. That is what
 * lets the tRPC link add the workspace to a request without waiting: a link
 * cannot defer an operation without building an observable of its own, and
 * the only request that could leave un-addressed is one made before this ran.
 * The native shells read Preferences, which is asynchronous; see
 * `whenActiveWorkspaceReady` and the fetch wrapper in `lib/trpc.ts`.
 */
const hydrateSyncOnWeb = (): void => {
  if (hydrated || hydration !== null || typeof window === "undefined" || shouldUseNativeStorage()) {
    return;
  }
  try {
    const id = window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
    storedId = id !== null && id !== "" ? id : null;
    known = parseKnown(
      window.localStorage.getItem(KNOWN_WORKSPACES_STORAGE_KEY)
    );
    if (known) {
      let required = true;
      try { required = privateRoutingRequiredOnWeb(known); } catch { /* Uncertain privacy metadata never exposes cached names. */ }
      if (required) {
        const scope = { server: known.server, userId: known.userId }; protectedScope = scopeKey(scope); known = publicWorkspaceDirectory(known);
        hydration = eraseStoredWorkspaceNames(scope, () => true).then(() => { hydrated = true; publish(); });
        hydration.catch(() => undefined); publish(false); return;
      }
    }
  } catch {
    // Storage denied: nothing stored, the first list decides.
  }
  hydrated = true;
  hydration = Promise.resolve();
  // Silently: this runs inside whichever getter asked first, which may be a
  // `useSyncExternalStore` snapshot read during render. Nobody can have read
  // the pre-hydration value, because every read hydrates first.
  publish(false);
};

/**
 * Read the stored choice and list, once. On a phone every request waits on
 * this (the fetch wrapper in `lib/trpc.ts`), so nothing can leave naming no
 * workspace — or the default one — while the stored choice is still being read.
 */
export const whenActiveWorkspaceReady = (): Promise<void> => {
  hydrateSyncOnWeb();
  hydration ??= (async () => {
    await whenApiOriginReady();
    if (typeof window !== "undefined" && shouldUseNativeStorage()) {
      const legacy = parseKnown(window.localStorage.getItem(KNOWN_WORKSPACES_STORAGE_KEY));
      if (legacy && await privateRoutingRequired(legacy)) await eraseStoredWorkspaceNames(legacy, () => true);
    }
    const store = getStorage();
    const [id, list] = await Promise.all([
      store.getItem(ACTIVE_WORKSPACE_STORAGE_KEY),
      store.getItem(KNOWN_WORKSPACES_STORAGE_KEY),
    ]);
    // A choice made before the read landed is newer than what is on disk.
    if (!hydrated) {
      storedId = id !== null && id !== "" ? id : storedId;
      known = known ?? parseKnown(list);
    }
    if (known && await privateRoutingRequired(known)) {
      protectedScope = scopeKey(known); known = publicWorkspaceDirectory(known);
      await eraseStoredWorkspaceNames(known, () => true);
    }
    hydrated = true;
    publish();
  })();
  return hydration;
};

export const isActiveWorkspaceReady = (): boolean => {
  hydrateSyncOnWeb();
  return hydrated;
};

export const getActiveWorkspaceId = (): string | null => {
  hydrateSyncOnWeb();
  return snapshot.activeId;
};

export const getActiveWorkspaceSnapshot = (): ActiveWorkspaceSnapshot => {
  hydrateSyncOnWeb();
  return snapshot;
};

const SERVER_SNAPSHOT: ActiveWorkspaceSnapshot = {
  activeId: null,
  workspaces: null,
};
export const getServerActiveWorkspaceSnapshot = (): ActiveWorkspaceSnapshot =>
  SERVER_SNAPSHOT;

export const subscribeActiveWorkspace = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Name for a workspace id, from the last known list. */
export const workspaceNameFor = (workspaceId: string): string | null => {
  hydrateSyncOnWeb();
  const here = knownHere();
  if (here === null) return null;
  return (
    here.workspaces.find((w) => w.id === workspaceId)?.name ??
    here.names[workspaceId] ??
    null
  );
};

/** The ids of every workspace this account is known to belong to, or null. */
export const getKnownWorkspaceIds = (): ReadonlySet<string> | null => {
  hydrateSyncOnWeb();
  const here = knownHere();
  return here === null ? null : new Set(here.workspaces.map((w) => w.id));
};

/**
 * The account the known list belongs to, for a caller that has no session yet
 * (the offline queue on a cold launch).
 */
export const getKnownWorkspacesOwner = (): string | null => {
  hydrateSyncOnWeb();
  return knownHere()?.userId ?? null;
};

// ── applying what the server says ────────────────────────────────────

export type WorkspaceListOutcome = {
  /** The id requests now carry. */
  activeId: string | null;
  /** The id they carried before this list; null when they named none. */
  previousId: string | null;
  /** True when that differs from what they carried before this list. */
  changed: boolean;
  /**
   * The workspace the device WAS pointed at when this list no longer contains
   * it — the person was removed, or left on another device. Null when the
   * change was anything else (first list, a stored id that was never valid).
   */
  lost: WorkspaceSummary | null;
};

/**
 * Take a fresh `workspaces.list` answer for `userId`: remember it, and
 * re-resolve the active workspace against it.
 *
 * Idempotent: the same list twice reports no change the second time, so the
 * flush and the query effect can both call it.
 */
export const applyWorkspaceList = async (
  workspaces: readonly WorkspaceSummary[],
  userId: string
): Promise<WorkspaceListOutcome> => {
  await whenActiveWorkspaceReady();
  return workspaceDirectoryExclusive(async () => {
    const scope = { userId, server: getAbsoluteApiOrigin() };
    const required = typeof window !== "undefined" && await privateRoutingRequired(scope);
    if (required) protectedScope = scopeKey(scope);
    const before = snapshot.activeId;
    const previous = knownHere();
    const sameAccount = previous !== null && previous.userId === userId;

    const names: Record<string, string> = sameAccount ? { ...previous.names } : {};
    for (const workspace of workspaces) {
      // Re-inserted so the current ones are the newest keys.
      delete names[workspace.id];
      names[workspace.id] = workspace.name;
    }
    const ids = Object.keys(names);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_REMEMBERED_NAMES))) {
      delete names[id];
    }
    known = {
      userId,
      server: getAbsoluteApiOrigin(),
      workspaces: [...workspaces],
      names,
    };
    if (required && !privateSession(userId)) known = publicWorkspaceDirectory(known);
    // Another account's stored choice is not this account's.
    if (!sameAccount && previous !== null) storedId = null;
    publish();

    const after = snapshot.activeId;
    const lost =
      before !== null &&
      after !== before &&
      sameAccount &&
      !workspaces.some((w) => w.id === before)
        ? (previous.workspaces.find((w) => w.id === before) ?? null)
        : null;

    const persisted = JSON.stringify(required ? publicWorkspaceDirectory(known) : known);
    if (required) {
      const strict = strictWorkspaceDirectoryStorage();
      await strict.setItem(KNOWN_WORKSPACES_STORAGE_KEY, persisted);
      if (await strict.getItem(KNOWN_WORKSPACES_STORAGE_KEY) !== persisted) throw new Error("Could not confirm private workspace-name cache protection");
    } else await getStorage().setItem(KNOWN_WORKSPACES_STORAGE_KEY, persisted);
    if (after !== null && after !== storedId) {
      storedId = after;
      await getStorage().setItem(ACTIVE_WORKSPACE_STORAGE_KEY, after);
    }
    const safeLost = required && lost && !privateSession(userId) ? publicWorkspaceDirectory({ ...scope, workspaces: [lost], names: {} }).workspaces[0] ?? null : lost;
    return { activeId: after, previousId: before, changed: after !== before, lost: safeLost };
  });
};

/**
 * Forget everything about the departing account: its choice and its list.
 * Called on sign-out, so the next account neither sends the previous one's
 * workspace id nor sees its workspace names.
 */
export const clearActiveWorkspace = async (): Promise<void> => {
  await whenActiveWorkspaceReady();
  storedId = null;
  known = null;
  publish();
  const store = getStorage();
  await workspaceDirectoryExclusive(async () => { await Promise.all([
    store.removeItem(ACTIVE_WORKSPACE_STORAGE_KEY),
    store.removeItem(KNOWN_WORKSPACES_STORAGE_KEY),
  ]); });
};

const concealLockedWorkspaceNames = () => {
  if (known && protectedScope === scopeKey(known) && !privateSession(known.userId)) { known = publicWorkspaceDirectory(known); publish(); }
};
subscribePrivateSession(concealLockedWorkspaceNames);
subscribePrivateAccount(concealLockedWorkspaceNames);
subscribeWorkspaceNameProtection((scope) => {
  if (known && scopeKey(known) === scopeKey(scope)) { protectedScope = scopeKey(scope); concealLockedWorkspaceNames(); }
});

// ── switching ────────────────────────────────────────────────────────

/**
 * Queries that answer about the PERSON rather than a workspace, and so survive
 * a switch: the workspace list itself (the switcher is reading it while the
 * switch happens), the profile and the devices list.
 */
const PERSON_SCOPED_ROUTERS = new Set(["workspaces", "profile", "devices"]);

const isWorkspaceScoped = (queryKey: QueryKey): boolean => {
  const path = queryKey[0];
  if (!Array.isArray(path)) return true;
  const router = path[0];
  return !(typeof router === "string" && PERSON_SCOPED_ROUTERS.has(router));
};

/**
 * Drop every workspace-scoped answer so nothing from the old workspace can be
 * rendered under the new one.
 *
 * React Query's keys are built from the input a component passes, and the
 * workspace is added by the link BELOW them — so `entries.list` in A and in B
 * share one key. The cache therefore has to go, in this order:
 *
 *  1. cancel what is in flight, so an answer for A cannot land after the
 *     switch and fill B's screen;
 *  2. remove what nothing is looking at;
 *  3. reset what is on screen — back to no data, and refetched, which now
 *     carries B. `resetQueries` notifies observers; `removeQueries` alone
 *     would leave mounted screens holding A's data until they re-render.
 */
export const resetWorkspaceCaches = async (
  queryClient: QueryClient,
  current: () => boolean = () => true
): Promise<void> => {
  const filters = {
    predicate: (query: { queryKey: QueryKey }) =>
      isWorkspaceScoped(query.queryKey),
  };
  if (!current()) return;
  await queryClient.cancelQueries(filters);
  if (!current()) return;
  queryClient.removeQueries({ ...filters, type: "inactive" });
  await queryClient.resetQueries(filters);
};

/**
 * Point this device at `workspaceId`.
 *
 * The choice is made locally first and is what requests carry from then on;
 * telling the server (`workspaces.setActive`) is best effort — it only moves
 * the default for requests that name no workspace, which no first-party
 * client sends, and a switch must work offline.
 */
export const switchWorkspace = async (
  workspaceId: string,
  deps: {
    queryClient: QueryClient;
    setActive?: (workspaceId: string) => Promise<unknown>;
  }
): Promise<void> => {
  const action = capturePrivateMutationAction({ workspace: false });
  await whenActiveWorkspaceReady(); if (!action.current()) return;
  const here = knownHere();
  // Only ever a membership: the switcher lists nothing else, and a stale
  // dialog must not be able to point requests at a workspace that is gone.
  if (here !== null && !here.workspaces.some((w) => w.id === workspaceId)) {
    return;
  }
  if (snapshot.activeId === workspaceId) return;

  storedId = workspaceId;
  publish();
  // Choice writes share the directory lock with account cleanup. A delayed
  // native write cannot overwrite the next selection after it has persisted.
  await workspaceDirectoryExclusive(async () => {
    if (!action.current() || snapshot.activeId !== workspaceId) return;
    await getStorage().setItem(ACTIVE_WORKSPACE_STORAGE_KEY, workspaceId);
  });
  if (!action.current() || snapshot.activeId !== workspaceId) return;
  await resetWorkspaceCaches(deps.queryClient, () => action.current() && snapshot.activeId === workspaceId);
  if (!action.current() || snapshot.activeId !== workspaceId) return;
  if (deps.setActive) {
    void deps.setActive(workspaceId).catch(() => undefined);
  }
};

/**
 * Store `workspaceId` as this device's choice for the NEXT page load, without
 * checking it against the known list.
 *
 * For joining and leaving (`components/members/enter-workspace.ts`), which
 * reload straight afterwards. A workspace just joined is not in the known list
 * yet, so `switchWorkspace` would refuse it; the first list after the reload
 * validates the stored id the same way it validates any other. Written through
 * this module's storage, never `localStorage` directly: on the native shells
 * the choice lives in Preferences, and a `localStorage` write there is ignored.
 */
export const chooseWorkspaceForNextLoad = async (
  workspaceId: string
): Promise<void> => {
  await whenActiveWorkspaceReady();
  storedId = workspaceId;
  publish();
  await getStorage().setItem(ACTIVE_WORKSPACE_STORAGE_KEY, workspaceId);
};

// ── NOT_FOUND on the active workspace ────────────────────────────────

let refetchList: (() => void) | null = null;
let lastNotFoundAt = 0;
const NOT_FOUND_THROTTLE_MS = 5_000;

/** Registered by the one component that owns the `workspaces.list` query. */
export const registerWorkspaceListRefetch = (
  refetch: () => void
): (() => void) => {
  refetchList = refetch;
  return () => {
    if (refetchList === refetch) refetchList = null;
  };
};

/**
 * A query answered NOT_FOUND. Most of those are about a row (an entry deleted
 * elsewhere), but the one that matters here is the workspace itself: removed
 * from it on another device while this screen was open, with the socket down.
 * The error cannot say which, so the list is re-asked — throttled, because a
 * removed workspace makes every query on screen fail at once.
 */
export const noteNotFound = (now: number = Date.now()): void => {
  if (now - lastNotFoundAt < NOT_FOUND_THROTTLE_MS) return;
  lastNotFoundAt = now;
  refetchList?.();
};

/** Test seam. */
export const __resetActiveWorkspaceForTests = (): void => {
  storage = null;
  storedId = null;
  known = null;
  snapshot = { activeId: null, workspaces: null };
  hydration = null;
  hydrated = false;
  protectedScope = null;
  refetchList = null;
  lastNotFoundAt = 0;
  listeners.clear();
};
