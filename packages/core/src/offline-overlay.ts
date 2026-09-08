/**
 * What a device believes about entries the server has not seen yet.
 *
 * The offline queue holds the *mutations*; this holds their visible
 * consequence. They are separate because they answer different questions: the
 * queue answers "what still has to be sent", and only this can answer "what
 * should the menu bar be showing right now". Without it a timer started with
 * no signal is a row in storage and nothing on screen — every surface would
 * keep drawing whatever the last successful read said, which is "no timer
 * running".
 *
 * Pure and host-free on purpose. The rules here — a queued stop hides a
 * running entry, a second edit builds on the first, a local entry outside the
 * requested window is not shown — are the ones that go quietly wrong, and a
 * host that keeps them next to its own storage code is a host where nothing
 * can test them.
 */
import type { DetailedEntry } from "@starter/shared";

export type OfflineOverlay = {
  /** Entries invented locally. Their ids are temp ids until a replay lands. */
  entries: DetailedEntry[];
  /** Queued edits to entries the server already has, by entry id. */
  patches: Record<string, Partial<DetailedEntry>>;
  /** Entries queued for deletion, by entry id. */
  removed: string[];
};

export const emptyOverlay = (): OfflineOverlay => ({
  entries: [],
  patches: {},
  removed: [],
});

export const isOverlayEmpty = (overlay: OfflineOverlay): boolean =>
  overlay.entries.length === 0 &&
  overlay.removed.length === 0 &&
  Object.keys(overlay.patches).length === 0;

/**
 * Read an overlay back out of storage.
 *
 * Anything unrecognisable is an empty overlay rather than a throw: a device
 * that cannot parse its own scratch state must still render the server's
 * answer, and the queue — which is what actually holds the work — is stored
 * separately and unaffected.
 */
export const parseOverlay = (value: unknown): OfflineOverlay => {
  if (typeof value !== "object" || value === null) return emptyOverlay();
  const record = value as Record<string, unknown>;
  if (
    !Array.isArray(record.entries) ||
    !Array.isArray(record.removed) ||
    typeof record.patches !== "object" ||
    record.patches === null
  ) {
    return emptyOverlay();
  }
  return {
    entries: record.entries as DetailedEntry[],
    patches: record.patches as Record<string, Partial<DetailedEntry>>,
    removed: record.removed as string[],
  };
};

// ── editing ──────────────────────────────────────────────────────────

/**
 * Record an entry this device invented, or replace one it already had.
 *
 * Also the path a queued *stop* takes: stopping an offline-started timer
 * rewrites the same local entry with an end rather than adding a second one.
 */
export const withOptimisticEntry = (
  overlay: OfflineOverlay,
  entry: DetailedEntry
): OfflineOverlay => ({
  ...overlay,
  entries: [
    entry,
    ...overlay.entries.filter((existing) => existing.id !== entry.id),
  ],
});

/**
 * Record a queued edit.
 *
 * An edit to a local entry is applied to that entry directly — there is no
 * server row for a patch to be applied over later, and keeping the two apart
 * would show the pre-edit values until the entry syncs. An edit to a server
 * row is merged onto any earlier queued edit, because a second edit made
 * before the first has been sent is a patch on top of the first: seeding it
 * from the untouched server row would erase the earlier one from the screen
 * while the queue still replayed both.
 */
export const withOptimisticPatch = (
  overlay: OfflineOverlay,
  id: string,
  patch: Partial<DetailedEntry>
): OfflineOverlay => {
  if (overlay.entries.some((entry) => entry.id === id)) {
    return {
      ...overlay,
      entries: overlay.entries.map((entry) =>
        entry.id === id ? { ...entry, ...patch } : entry
      ),
    };
  }
  return {
    ...overlay,
    patches: { ...overlay.patches, [id]: { ...overlay.patches[id], ...patch } },
  };
};

/**
 * Record a queued deletion.
 *
 * A local entry is simply forgotten — the caller drops its queued rows at the
 * same time, so nothing is left to replay. A server entry is remembered as
 * removed until the delete actually lands.
 */
export const withOptimisticRemoval = (
  overlay: OfflineOverlay,
  id: string
): OfflineOverlay => {
  if (overlay.entries.some((entry) => entry.id === id)) {
    return {
      ...overlay,
      entries: overlay.entries.filter((entry) => entry.id !== id),
    };
  }
  return {
    ...overlay,
    removed: overlay.removed.includes(id)
      ? overlay.removed
      : [...overlay.removed, id],
  };
};

/**
 * Forget the local copies of starts that have now reached the server.
 *
 * `resolved` maps a temp id to the real id its replayed start was given, so
 * the local row can go: the next read carries the server's own, which is
 * richer. Everything else waits for a fully drained queue, which is the one
 * condition under which server truth is strictly better than anything held
 * here and needs no per-row reasoning.
 */
export const withoutResolved = (
  overlay: OfflineOverlay,
  resolved: ReadonlyMap<string, string>
): OfflineOverlay => {
  if (resolved.size === 0) return overlay;
  return {
    ...overlay,
    entries: overlay.entries.filter((entry) => !resolved.has(entry.id)),
  };
};

// ── reading ──────────────────────────────────────────────────────────

/** Newest first, the order every entry list renders. */
const byStartDesc = (a: DetailedEntry, b: DetailedEntry): number =>
  Date.parse(b.start) - Date.parse(a.start);

/**
 * The server's entries with this device's unsynced work folded in.
 *
 * `window` narrows the local entries to the range the caller asked the server
 * for, so a day view does not sprout an entry from last week merely because it
 * has not synced yet. A local entry whose id is already in the server's page —
 * which happens for the one read that races a replay — is dropped rather than
 * shown twice.
 */
export const applyOverlay = (
  entries: readonly DetailedEntry[],
  overlay: OfflineOverlay,
  window?: { from?: string; to?: string }
): DetailedEntry[] => {
  const removed = new Set(overlay.removed);
  const patched = entries
    .filter((entry) => !removed.has(entry.id))
    .map((entry) => {
      const patch = overlay.patches[entry.id];
      return patch ? { ...entry, ...patch } : entry;
    });

  const known = new Set(patched.map((entry) => entry.id));
  const fromMs = window?.from
    ? Date.parse(window.from)
    : Number.NEGATIVE_INFINITY;
  const toMs = window?.to ? Date.parse(window.to) : Number.POSITIVE_INFINITY;

  const local = overlay.entries.filter((entry) => {
    if (known.has(entry.id)) return false;
    const startMs = Date.parse(entry.start);
    return startMs >= fromMs && startMs <= toMs;
  });

  return [...local, ...patched].sort(byStartDesc);
};

/** The locally started timer, if this device has one the server has not seen. */
export const overlayRunning = (
  overlay: OfflineOverlay
): DetailedEntry | null =>
  overlay.entries.find((entry) => entry.end === null) ?? null;

/**
 * What is actually running, once this device's unsynced work is applied over
 * the server's answer.
 *
 * Three cases, and the middle one is the one that bites: a stop queued for a
 * server entry leaves that entry running as far as the server is concerned, so
 * a surface that trusted the read would keep the clock going on a timer the
 * user stopped ten minutes ago — and pressing stop again would queue a second
 * stop against it.
 */
export const resolveRunning = <T extends { id: string; end: string | null }>(
  server: T | null,
  overlay: OfflineOverlay
): T | DetailedEntry | null => {
  const local = overlayRunning(overlay);
  if (local) return local;
  if (server === null) return null;
  if (overlay.removed.includes(server.id)) return null;
  const patch = overlay.patches[server.id];
  if (patch === undefined) return server;
  // A queued stop is a patch that gives the entry an end.
  if (patch.end !== undefined && patch.end !== null) return null;
  return { ...server, ...patch };
};
