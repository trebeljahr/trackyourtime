/**
 * Offline plumbing for the tracker.
 *
 * Every entry mutation goes out optimistically. When the request cannot reach
 * the server — the browser is offline, or the fetch fails at the transport
 * layer — the optimistic cache update stands and the mutation lands here, in a
 * durable FIFO — `localStorage` in a browser, Capacitor Preferences on the
 * native shells. On reconnect the queue is replayed in the order the user
 * performed the actions, so start/stop keeps working with the network fully
 * off.
 *
 * The op/payload contract itself now lives in `@starter/core` so the browser
 * extension writes rows this client can replay, and vice versa. What stays
 * here is the host-bound half: storage selection, the reactive pending count
 * React subscribes to, and the tRPC error classification.
 */

import {
  createOfflineQueue,
  decodeOfflineMutation,
  isForeignTo,
  isReplayableBy,
  memoryStorage,
  OFFLINE_QUEUE_OWNER_STORAGE_KEY,
  OFFLINE_QUEUE_STORAGE_KEY,
  webStorage,
  type FlushResult,
  type KeyValueStorage,
  type OfflineMutation,
  type OfflineOp,
  type OfflinePayloadMap,
  type OfflineQueue,
  type StoredOfflinePayload,
} from "@starter/core";

export {
  createTempId,
  decodeOfflineMutation,
  isForeignTo,
  isReplayableBy,
  isTempId,
  OFFLINE_QUEUE_OWNER_STORAGE_KEY,
  OFFLINE_QUEUE_STORAGE_KEY,
  TEMP_ID_PREFIX,
} from "@starter/core";

export type {
  OfflineCreateInput,
  OfflineDiscardInput,
  OfflineIdInput,
  OfflineMutation,
  OfflineOp,
  OfflinePayloadMap,
  OfflineStartInput,
  OfflineStopInput,
  OfflineUpdateInput,
} from "@starter/core";

import {
  preferencesStorage,
  shouldUseNativeStorage,
} from "@/mobile/preferences-storage";
import { getNetworkOnline } from "@/mobile/network";
import { isNative } from "@/mobile/bridge";

// ── the queue itself ─────────────────────────────────────────────────

/**
 * Where the queue lives.
 *
 * On the native shells this is Capacitor Preferences, not `localStorage`:
 * WKWebView may evict web storage after low disk or a week of inactivity, and
 * what is stored here is time the user tracked that the server has never seen.
 * `mobile/preferences-storage.ts` also hands over anything a previous build
 * left in `localStorage`, once — otherwise the change of address would itself
 * lose every queued row.
 *
 * `shouldUseNativeStorage()` is `isNative()`, a synchronous read of
 * `window.Capacitor` that the native bridge injects before any app code runs.
 * That is what makes it safe for `getOfflineQueue()` to memoise below: the
 * branch is decidable on the very first call, so there is no window in which
 * an early caller could pin the wrong backing store for the rest of the launch.
 */
const resolveStorage = (): KeyValueStorage => {
  if (typeof window === "undefined") return memoryStorage();
  if (shouldUseNativeStorage()) {
    return preferencesStorage({
      migrateKeys: [OFFLINE_QUEUE_STORAGE_KEY, OFFLINE_QUEUE_OWNER_STORAGE_KEY],
    });
  }
  try {
    return webStorage(window.localStorage);
  } catch {
    // Privacy mode / disabled storage — the queue still works for this tab.
    return memoryStorage();
  }
};

/**
 * One store for the queue and for the owner stamp beside it. They describe
 * each other, so they must live or die together: an owner remembered in a
 * store the queue is not in (or the reverse) is worse than neither.
 */
let storage: KeyValueStorage | null = null;

const getStorage = (): KeyValueStorage => {
  storage ??= resolveStorage();
  return storage;
};

let queue: OfflineQueue | null = null;

export const getOfflineQueue = (): OfflineQueue => {
  if (queue === null) {
    queue = createOfflineQueue({
      storage: getStorage(),
      key: OFFLINE_QUEUE_STORAGE_KEY,
    });
  }
  return queue;
};

/** Test seam: drop the memoised queue so the next call re-resolves storage. */
export const __resetOfflineQueueForTests = (): void => {
  queue = null;
  storage = null;
};

// ── who queued what ──────────────────────────────────────────────────

/*
 * The account this device is currently signed in as, or null while nobody is.
 *
 * Every row is stamped on the way in and checked against this on the way out,
 * because the queue outlives a sign-out on purpose: `isAuthError` in
 * `hooks/use-offline-queue.ts` stops the flush and KEEPS the rows rather than
 * deleting time the server has never seen. Without a stamp, the next account
 * to sign in on this device replays the previous account's starts and stops
 * into its own workspace. The browser extension solves the same problem the
 * other way — `forgetSession()` clears its queue — which is not available
 * here: the rows we would be destroying are the ones the mobile plan exists to
 * protect.
 *
 * Rows belonging to somebody else are neither replayed nor dropped. They are
 * counted separately and said out loud (see `foreign` in the queue state), and
 * Settings → Devices is where a human can look at them and decide.
 */
let owner: string | null = null;

/*
 * The last account that owned this queue, remembered across launches.
 *
 * `owner` above comes from `useSession()`, and there is a window in which the
 * app is fully usable while that is still null: `(protected)/layout.tsx` keeps
 * a phone with a stored token *inside* the app when the session check cannot
 * reach the server (`verdictForRejection`), which is precisely the cold
 * offline launch the offline queue exists for. Stamping those rows with
 * nothing would leave the flagship offline case producing claimable rows
 * forever — the migration hole would never close.
 *
 * So a mutation queued before the session resolves is stamped with whoever
 * owned the queue last. The device was theirs a moment ago, and the only
 * alternatives are an unowned row or refusing to queue at all.
 *
 * Stamping only. Replay still requires a live session (`isReplayableBy` reads
 * `owner`), because a stamp is a claim about who *made* a mutation and never a
 * licence to send it.
 */
let lastOwner: string | null = null;
let hydration: Promise<void> | null = null;

const hydrateLastOwner = (): Promise<void> => {
  hydration ??= (async () => {
    const stored = await getStorage().getItem(OFFLINE_QUEUE_OWNER_STORAGE_KEY);
    // A live owner set before the read landed always wins — it is the answer
    // this remembers a stale version of.
    if (lastOwner === null && stored) lastOwner = stored;
  })();
  return hydration;
};

export const getOfflineQueueOwner = (): string | null => owner;

/**
 * Point the queue at an account. Returns how many previously unowned rows this
 * account adopted, so a caller can flush straight away when there is something
 * new to send.
 *
 * Adoption is for rows written before ownership stamping existed: the first
 * account to sign in after the upgrade claims them. They are its own in every
 * realistic case — the alternative is stranding a day of tracked time forever,
 * or leaving it for whoever signs in two accounts from now.
 *
 * `null` here means "no session resolved", NOT "signed out" — the two are
 * indistinguishable from `useAuth()`, and a cold offline launch produces the
 * first. So it deliberately does not forget `lastOwner`; an explicit sign-out
 * calls `sealOfflineQueueOwner` for that.
 */
export const setOfflineQueueOwner = async (
  next: string | null
): Promise<number> => {
  await hydrateLastOwner();
  if (next === owner) return 0;
  owner = next;

  let adopted = 0;
  if (next !== null) {
    if (next !== lastOwner) {
      lastOwner = next;
      await getStorage().setItem(OFFLINE_QUEUE_OWNER_STORAGE_KEY, next);
    }
    adopted = await getOfflineQueue().adoptUnowned(next);
  }

  await refreshPendingCount();
  return adopted;
};

/**
 * Close this account's window on the queue: claim whatever it queued before
 * its session resolved, then forget it.
 *
 * Called from the `signOut` wrapper in `lib/auth-client.ts`, the one moment
 * this device knows it has stopped being that person's. Adopting first is the
 * point — an unowned row at sign-out was made in this session by definition,
 * and leaving it unowned would hand it to whoever signs in next. Forgetting
 * `lastOwner` afterwards is what keeps the next account's pre-resolution rows
 * from being stamped with the departed one.
 *
 * The queue itself is untouched. That is the whole difference from the
 * extension's `forgetSession()`.
 */
export const sealOfflineQueueOwner = async (): Promise<number> => {
  await hydrateLastOwner();
  const departing = owner ?? lastOwner;
  const adopted =
    departing === null ? 0 : await getOfflineQueue().adoptUnowned(departing);

  owner = null;
  lastOwner = null;
  await getStorage().removeItem(OFFLINE_QUEUE_OWNER_STORAGE_KEY);
  await refreshPendingCount();
  return adopted;
};

/** Test seam. */
export const __resetOfflineQueueOwnerForTests = (): void => {
  owner = null;
  lastOwner = null;
  hydration = null;
};

// ── reactive pending count ───────────────────────────────────────────

type Listener = () => void;

let pending = 0;
let foreign = 0;
const listeners = new Set<Listener>();

const setCounts = (nextPending: number, nextForeign: number): void => {
  if (nextPending === pending && nextForeign === foreign) return;
  pending = nextPending;
  foreign = nextForeign;
  for (const listener of listeners) listener();
};

export const subscribePending = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Rows this account can replay. */
export const getPendingCount = (): number => pending;

/**
 * Rows queued by a different account. They stay in the queue — that is
 * somebody's tracked time — and are never replayed under this session.
 */
export const getForeignCount = (): number => foreign;

/** Server snapshot for `useSyncExternalStore` — nothing is ever queued on SSR. */
export const getServerPendingCount = (): number => 0;
export const getServerForeignCount = (): number => 0;

/**
 * Recount, and return what this account can send.
 *
 * With no owner resolved yet nothing is called foreign: "we do not know who is
 * signed in" must not render as "somebody else queued this". The flush filter
 * is separate and stricter — it replays nothing at all until an account is
 * known.
 */
export const refreshPendingCount = async (): Promise<number> => {
  const rows = await getOfflineQueue().list();
  const against = owner ?? lastOwner;
  if (against === null) {
    setCounts(rows.length, 0);
    return rows.length;
  }
  const theirs = rows.filter((row) => isForeignTo(row, against)).length;
  setCounts(rows.length - theirs, theirs);
  return rows.length - theirs;
};

/** Append a mutation that could not reach the server. */
export const enqueueOffline = async <K extends OfflineOp>(
  op: K,
  input: OfflinePayloadMap[K],
  tempId?: string
): Promise<void> => {
  const payload: StoredOfflinePayload = tempId ? { input, tempId } : { input };
  await hydrateLastOwner();
  // `lastOwner` is the fallback for a mutation made before the session
  // resolved — routine on a cold offline launch, where the app is usable and
  // `useSession()` has nothing to say. Only a device that has never had an
  // account writes an unowned row now, and the first account to sign in
  // adopts it.
  await getOfflineQueue().enqueue(op, payload, owner ?? lastOwner ?? undefined);
  await refreshPendingCount();
};

/**
 * Drop everything queued for a temp entry. Used when the user deletes an
 * entry they created while offline — replaying its create would resurrect it.
 */
export const cancelQueuedForTemp = async (tempId: string): Promise<boolean> => {
  const offlineQueue = getOfflineQueue();
  const rows = await offlineQueue.list();
  let removed = false;

  for (const row of rows) {
    // Never reach into another account's rows, even to cancel: the temp id
    // being deleted belongs to an entry in THIS session's cache. An unowned
    // row is fair game — it is one this session queued before the account
    // resolved, or one waiting to be adopted.
    if (isForeignTo(row, owner ?? lastOwner)) continue;
    const decoded = decodeOfflineMutation(row);
    if (decoded?.tempId !== tempId) continue;
    await offlineQueue.remove(row.id);
    removed = true;
  }

  if (removed) await refreshPendingCount();
  return removed;
};

/**
 * `meta.createdAt` is the raw row's timestamp, handed over separately rather
 * than folded into the decoded mutation: `decodeOfflineMutation` is core's
 * pure op contract and several clients pin its exact shape. The replay needs
 * the age because a queue that now survives an OS kill can hold a row for
 * days, and some of them stop being safe to replay blind.
 *
 * The filter is the cross-account guard. A row the current account does not
 * own is skipped rather than run, and skipped rows keep their place in the
 * queue — `createOfflineQueue.flush` writes them back untouched.
 */
export const flushOfflineQueue = async (
  runner: (
    mutation: OfflineMutation,
    meta: { createdAt: string }
  ) => Promise<void>
): Promise<FlushResult> => {
  const result = await getOfflineQueue().flush(
    async (row) => {
      const decoded = decodeOfflineMutation(row);
      // A row we can no longer read is dropped by resolving successfully.
      if (decoded === null) return;
      await runner(decoded, { createdAt: row.createdAt });
    },
    { filter: (row) => isReplayableBy(row, owner) }
  );
  await refreshPendingCount();
  return result;
};

export const clearOfflineQueue = async (): Promise<void> => {
  await getOfflineQueue().clear();
  await refreshPendingCount();
};

// ── the document going away ──────────────────────────────────────────

/*
 * A full page navigation aborts every request in flight, and an aborted fetch
 * is indistinguishable from a failed one — `isNetworkError()` says "network",
 * the mutation is queued, and the next document replays it.
 *
 * That guess is usually WRONG. The request was fully written before the
 * document died; aborting a fetch does not un-send the bytes, so the server
 * has almost always processed it and only the response was lost. Replaying it
 * therefore does not recover a lost entry — it creates a second one, and the
 * user is left deleting duplicates they did not make.
 *
 * So a mutation that fails while the document is being torn down is not
 * queued. The app is a moment away from reloading and asking the server what
 * is actually there, which is a better answer than a blind replay.
 *
 * **Web only.** There is no navigation-teardown on the native shells — the
 * document is loaded once and lives for the process — and `pagehide` fires
 * there for other reasons (backgrounding, the back-forward cache). A latched
 * flag on a phone would silently stop queueing offline work, which is the one
 * thing that must never happen. `persisted` is checked as well, so even on web
 * a bfcache suspension does not count.
 */
let documentUnloading = false;
let unwatchUnload: (() => void) | null = null;

export const isDocumentUnloading = (): boolean => documentUnloading;

export const watchDocumentUnload = (): void => {
  if (unwatchUnload !== null || typeof window === "undefined") return;
  if (isNative()) return;

  const onHide = (event: PageTransitionEvent): void => {
    if (event.persisted) return;
    documentUnloading = true;
  };
  // A restored page is alive again, and everything it does from here is a real
  // mutation by a real user.
  const onShow = (): void => {
    documentUnloading = false;
  };

  window.addEventListener("pagehide", onHide);
  window.addEventListener("pageshow", onShow);
  unwatchUnload = () => {
    window.removeEventListener("pagehide", onHide);
    window.removeEventListener("pageshow", onShow);
  };
};

/** Test seam. */
export const __resetDocumentUnloadForTests = (): void => {
  documentUnloading = false;
  unwatchUnload?.();
  unwatchUnload = null;
};

// ── error classification ─────────────────────────────────────────────

/**
 * Delegated to `mobile/network.ts`, which prefers the radio's own answer on
 * native and falls back to `navigator.onLine` everywhere else. In WKWebView
 * the browser's value is routinely `true` on a dead radio, and this function
 * is what `isNetworkError()` short-circuits on — so believing it files genuine
 * server refusals as transport failures and queues them forever.
 */
export const isOnline = (): boolean => getNetworkOnline();

/** A tRPC error carrying `data.code` came from the server, not the wire. */
const hasServerCode = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const data = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return false;
  return typeof (data as { code?: unknown }).code === "string";
};

const NETWORK_MARKERS = [
  "failed to fetch",
  "fetch failed",
  "networkerror",
  "network error",
  "network request failed",
  "load failed",
  "err_internet_disconnected",
  "err_network",
  "err_connection",
  "connection refused",
  "socket hang up",
  "offline",
];

const messagesOf = (error: unknown): string[] => {
  const messages: string[] = [];
  let cursor: unknown = error;

  for (let depth = 0; depth < 4 && cursor !== null && cursor !== undefined; depth += 1) {
    if (typeof cursor === "string") {
      messages.push(cursor);
      break;
    }
    if (typeof cursor !== "object") break;
    const record = cursor as { message?: unknown; cause?: unknown };
    if (typeof record.message === "string") messages.push(record.message);
    cursor = record.cause;
  }

  return messages;
};

/**
 * True when the server refused the mutation because it does not believe the
 * caller is signed in.
 *
 * This is deliberately NOT a network error — the request arrived and was
 * answered — but it must not be treated as "the server has spoken, drop the
 * row" either. A queue that outlives an expired or revoked session would
 * otherwise delete a whole day of offline-tracked entries one 401 at a time,
 * invalidate the caches, and leave the user looking at an empty day with no
 * error anywhere. The flush stops instead, and everything keeps its place
 * until there is a session to replay it with.
 */
export const isAuthError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const data = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return false;
  const code = (data as { code?: unknown }).code;
  return code === "UNAUTHORIZED" || code === "FORBIDDEN";
};

/**
 * True when the mutation never reached the server, so it is safe to keep the
 * optimistic update and replay later. A server rejection (validation,
 * conflict, auth) is never a network error — those must roll back.
 */
export const isNetworkError = (error: unknown): boolean => {
  if (hasServerCode(error)) return false;
  if (!isOnline()) return true;
  if (error instanceof TypeError) return true;

  return messagesOf(error).some((message) => {
    const lower = message.toLowerCase();
    return NETWORK_MARKERS.some((marker) => lower.includes(marker));
  });
};
