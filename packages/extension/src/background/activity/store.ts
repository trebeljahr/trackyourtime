/**
 * Where captured activity lives: IndexedDB, on this device only.
 *
 * Not `chrome.storage.local`. A day of browsing is hundreds of segments and a
 * retention window is up to ninety days of them, which is exactly the kind of
 * volume that area's quota is not meant for — and a write that failed on quota
 * would fail silently through the adapter the rest of the extension uses.
 *
 * Everything is keyed by a **scope**, the signed-in user plus the workspace
 * they are tracking into. Rules name catalog ids, and a catalog id means
 * nothing in another workspace; dismissals name time somebody decided was
 * accounted for, which is a statement by one person. `wipeAllActivity` is what
 * sign-out calls, and it takes every scope with it.
 *
 * This module and everything else under `background/activity/` must not import
 * the runtime, the API client or anything that can reach a network. What is
 * recorded here leaves the device only as an entry somebody accepted, and a
 * test walks the import graph to keep it that way.
 */
import type {
  ActivityRule,
  ActivitySegment,
} from "@starter/core/activity/index";

export const ACTIVITY_DB_NAME = "tracktime-activity";
const ACTIVITY_DB_VERSION = 1;

const SEGMENTS = "segments";
const RULES = "rules";
const DISMISSALS = "dismissals";
const META = "meta";

/** A captured segment as stored: the core shape plus whose it is. */
export type StoredSegment = ActivitySegment & { scope: string };

export type StoredRule = ActivityRule & { scope: string; createdAt: number };

/** "This span is accounted for." Subtracted like a tracked entry. */
export type Dismissal = { scope: string; start: number; end: number };

/**
 * The segment still being watched.
 *
 * Persisted on every change and on every heartbeat, because an MV3 worker is
 * evicted without warning: the next instance reads this back and closes the
 * segment at `lastSeen` when too long has passed, instead of either losing the
 * stretch or stretching it across a laptop lid that was closed for the night.
 */
export type OpenSegment = {
  scope: string;
  key: string;
  label?: string;
  start: number;
  lastSeen: number;
};

type MetaRecord = { name: "open"; value: OpenSegment };

let opening: Promise<IDBDatabase> | null = null;
/** The factory `opening` came from; a replaced global means a new database. */
let openedFrom: IDBFactory | null = null;

const requestToPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });

const openDatabase = (): Promise<IDBDatabase> => {
  if (opening !== null && openedFrom === indexedDB) return opening;
  openedFrom = indexedDB;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(ACTIVITY_DB_NAME, ACTIVITY_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SEGMENTS)) {
        const segments = db.createObjectStore(SEGMENTS, { autoIncrement: true });
        segments.createIndex("scope_start", ["scope", "start"]);
        segments.createIndex("end", "end");
      }
      if (!db.objectStoreNames.contains(RULES)) {
        const rules = db.createObjectStore(RULES, { keyPath: ["scope", "id"] });
        rules.createIndex("scope", "scope");
      }
      if (!db.objectStoreNames.contains(DISMISSALS)) {
        const dismissals = db.createObjectStore(DISMISSALS, {
          keyPath: ["scope", "start", "end"],
        });
        dismissals.createIndex("end", "end");
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: "name" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another context (a future build's upgrade, or a test deleting the
      // database) asks for the connection back; holding on would block it.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open activity storage"));
  });
  opening = pending;
  pending.catch(() => {
    if (opening === pending) opening = null;
  });
  return pending;
};

/** Drop the cached connection. Tests use it between databases. */
export const closeActivityDatabase = async (): Promise<void> => {
  const pending = opening;
  opening = null;
  if (pending === null) return;
  try {
    (await pending).close();
  } catch {
    /* never opened */
  }
};

const run = async <T>(
  stores: string[],
  mode: IDBTransactionMode,
  body: (transaction: IDBTransaction) => Promise<T> | T,
): Promise<T> => {
  const db = await openDatabase();
  const transaction = db.transaction(stores, mode);
  const done = transactionDone(transaction);
  const result = await body(transaction);
  await done;
  return result;
};

// ── segments ─────────────────────────────────────────────────────────

/** Store one closed segment. Empty or inverted ones are ignored. */
export async function appendSegment(segment: StoredSegment): Promise<void> {
  if (!(segment.end > segment.start)) return;
  const record: StoredSegment = { ...segment };
  if (record.label === undefined) delete record.label;
  await run([SEGMENTS], "readwrite", (tx) => {
    tx.objectStore(SEGMENTS).add(record);
  });
}

/**
 * Segments of one scope that overlap `[from, to)`.
 *
 * Read by start from `from - lookbackMs`, because the index is on the start and
 * a segment that began before the window may still reach into it.
 */
export async function readSegments(
  scope: string,
  from: number,
  to: number,
  lookbackMs = 86_400_000,
): Promise<StoredSegment[]> {
  return run([SEGMENTS], "readonly", async (tx) => {
    const range = IDBKeyRange.bound([scope, from - lookbackMs], [scope, to], false, true);
    const rows = (await requestToPromise(
      tx.objectStore(SEGMENTS).index("scope_start").getAll(range),
    )) as StoredSegment[];
    return rows.filter((row) => row.end > from && row.start < to);
  });
}

/** Every stored segment, any scope. For tests and the settings count. */
export async function countSegments(): Promise<number> {
  return run([SEGMENTS], "readonly", (tx) =>
    requestToPromise(tx.objectStore(SEGMENTS).count()),
  );
}

export async function readAllSegments(): Promise<StoredSegment[]> {
  return run([SEGMENTS], "readonly", async (tx) =>
    (await requestToPromise(tx.objectStore(SEGMENTS).getAll())) as StoredSegment[],
  );
}

/** Delete segments and dismissals that ended before `cutoff`. Returns how many went. */
export async function deleteEndedBefore(cutoff: number): Promise<number> {
  return run([SEGMENTS, DISMISSALS], "readwrite", async (tx) => {
    let removed = 0;
    for (const name of [SEGMENTS, DISMISSALS]) {
      const index = tx.objectStore(name).index("end");
      const keys = await requestToPromise(
        index.getAllKeys(IDBKeyRange.upperBound(cutoff, true)),
      );
      for (const key of keys) tx.objectStore(name).delete(key);
      removed += keys.length;
    }
    return removed;
  });
}

// ── rules ────────────────────────────────────────────────────────────

/** Oldest first, which is the order rules are tried in. */
export async function listRules(scope: string): Promise<ActivityRule[]> {
  const rows = await run([RULES], "readonly", async (tx) =>
    (await requestToPromise(
      tx.objectStore(RULES).index("scope").getAll(scope),
    )) as StoredRule[],
  );
  return rows
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    .map(({ scope: _scope, createdAt: _createdAt, ...rule }) => rule);
}

export async function putRule(scope: string, rule: ActivityRule, createdAt: number): Promise<void> {
  await run([RULES], "readwrite", (tx) => {
    tx.objectStore(RULES).put({ ...rule, scope, createdAt } satisfies StoredRule);
  });
}

export async function deleteRule(scope: string, id: string): Promise<void> {
  await run([RULES], "readwrite", (tx) => {
    tx.objectStore(RULES).delete([scope, id]);
  });
}

// ── dismissals ───────────────────────────────────────────────────────

export async function addDismissal(dismissal: Dismissal): Promise<void> {
  if (!(dismissal.end > dismissal.start)) return;
  await run([DISMISSALS], "readwrite", (tx) => {
    tx.objectStore(DISMISSALS).put({ ...dismissal });
  });
}

export async function listDismissals(scope: string): Promise<Dismissal[]> {
  return run([DISMISSALS], "readonly", async (tx) =>
    (await requestToPromise(
      tx.objectStore(DISMISSALS).getAll(
        IDBKeyRange.bound([scope, -Infinity, -Infinity], [scope, Infinity, Infinity]),
      ),
    )) as Dismissal[],
  );
}

// ── the open segment ─────────────────────────────────────────────────

export async function loadOpenSegment(): Promise<OpenSegment | null> {
  const record = await run([META], "readonly", async (tx) =>
    (await requestToPromise(tx.objectStore(META).get("open"))) as MetaRecord | undefined,
  );
  return record?.value ?? null;
}

export async function saveOpenSegment(open: OpenSegment | null): Promise<void> {
  await run([META], "readwrite", (tx) => {
    const store = tx.objectStore(META);
    if (open === null) store.delete("open");
    else store.put({ name: "open", value: open } satisfies MetaRecord);
  });
}

// ── wiping ───────────────────────────────────────────────────────────

/**
 * Remove every row that does not belong to `keepScope`.
 *
 * Run when the scope changes — a different account signed in on this browser,
 * or the same person switched workspace — so one person's browsing is never
 * sitting in storage under the next one's session.
 */
export async function deleteOtherScopes(keepScope: string): Promise<void> {
  await run([SEGMENTS, RULES, DISMISSALS, META], "readwrite", async (tx) => {
    for (const name of [SEGMENTS, RULES, DISMISSALS]) {
      const store = tx.objectStore(name);
      const keys = await requestToPromise(store.getAllKeys());
      const values = (await requestToPromise(store.getAll())) as { scope: string }[];
      values.forEach((value, index) => {
        const key = keys[index];
        if (value.scope !== keepScope && key !== undefined) store.delete(key);
      });
    }
    const open = (await requestToPromise(tx.objectStore(META).get("open"))) as
      | MetaRecord
      | undefined;
    if (open !== undefined && open.value.scope !== keepScope) {
      tx.objectStore(META).delete("open");
    }
  });
}

/** Everything: activity, rules, dismissals and the open segment, every scope. */
export async function wipeAllActivity(): Promise<void> {
  await run([SEGMENTS, RULES, DISMISSALS, META], "readwrite", (tx) => {
    for (const name of [SEGMENTS, RULES, DISMISSALS, META]) tx.objectStore(name).clear();
  });
}
