/**
 * The last good answer to every read this extension makes, kept so a command
 * launched with no network still has something true to show and something
 * accurate to shape an optimistic entry from.
 *
 * Raycast's own `useCachedPromise` already paints stale data in a *view*, but
 * it cannot help the two cases that matter most here: a `no-view` hotkey,
 * which has no rendered cache at all, and `buildOptimisticEntry`, which needs
 * the project's rate and the workspace currency to guess the money snapshot
 * the server is about to write. Guessing those wrong is worse than showing a
 * stale project name — the entry carries the wrong rate until it replays, and
 * on a queue that can sit for hours that is what the user sees all evening.
 *
 * Written through from the API wrappers on every successful read, so no
 * surface has to remember to warm it.
 */
import type {
  DetailedEntry,
  DetailedFavorite,
  EntryShapeContext,
  ResolvedSettings,
  ShapeableTask,
} from "@starter/core";
import type { Client } from "@starter/core";
import type { ProjectWithStats, TagWithStats, TaskWithStats } from "./api.js";
import { raycastStorage } from "./storage.js";

const CACHE_KEY = "tracktime.local-cache";

/** Entries written from Raycast are stamped `api`, like every other call it makes. */
const SOURCE = "api" as const;

/**
 * How much history is worth keeping. Wide enough to cover the window every
 * timer surface asks for, small enough that this stays one modest string in a
 * store shared with a session token.
 */
const MAX_ENTRIES = 200;

export type LocalCache = {
  entries: DetailedEntry[];
  favorites: DetailedFavorite[];
  projects: ProjectWithStats[];
  tasks: TaskWithStats[];
  tags: TagWithStats[];
  clients: Client[];
  settings: ResolvedSettings | null;
};

const EMPTY: LocalCache = {
  entries: [],
  favorites: [],
  projects: [],
  tasks: [],
  tags: [],
  clients: [],
  settings: null,
};

const isCache = (value: unknown): value is Partial<LocalCache> =>
  typeof value === "object" && value !== null;

/** Never throws: a surface that cannot read this must still try the network. */
export const loadCache = async (): Promise<LocalCache> => {
  try {
    const raw = await raycastStorage.getItem(CACHE_KEY);
    if (raw === null) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    return isCache(parsed) ? { ...EMPTY, ...parsed } : EMPTY;
  } catch {
    return EMPTY;
  }
};

/**
 * Remember whichever parts just came back.
 *
 * Deliberately partial: the reads happen on different surfaces at different
 * times — the menu bar fetches entries, favorites and projects, an entry form
 * fetches tasks and tags — so overwriting the absent halves would make each
 * read undo the last one. `settings` is compared against `undefined` rather
 * than truthiness, because null is a legitimate "not loaded" value to keep.
 */
export const remember = async (parts: Partial<LocalCache>): Promise<void> => {
  const current = await loadCache();
  const next: LocalCache = {
    entries: (parts.entries ?? current.entries).slice(0, MAX_ENTRIES),
    favorites: parts.favorites ?? current.favorites,
    projects: parts.projects ?? current.projects,
    tasks: parts.tasks ?? current.tasks,
    tags: parts.tags ?? current.tags,
    clients: parts.clients ?? current.clients,
    settings: parts.settings === undefined ? current.settings : parts.settings,
  };
  try {
    await raycastStorage.setItem(CACHE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — reads still work, offline shaping gets less right */
  }
};

/**
 * Fold a freshly fetched window into the remembered entries.
 *
 * A merge rather than a replace, because the windows differ per surface: the
 * menu bar asks for seven days and the entries command asks for a month, and
 * whichever ran last must not shrink what the other can fall back on.
 */
export const rememberEntries = async (
  fetched: readonly DetailedEntry[],
): Promise<void> => {
  const current = await loadCache();
  const byId = new Map(current.entries.map((entry) => [entry.id, entry]));
  for (const entry of fetched) byId.set(entry.id, entry);
  const merged = [...byId.values()].sort(
    (a, b) => Date.parse(b.start) - Date.parse(a.start),
  );
  await remember({ entries: merged });
};

/** Drop an entry the server has confirmed is gone. */
export const forgetEntry = async (id: string): Promise<void> => {
  const current = await loadCache();
  if (!current.entries.some((entry) => entry.id === id)) return;
  await remember({ entries: current.entries.filter((entry) => entry.id !== id) });
};

/** Everything this Mac knows, wiped — used when the session is handed over. */
export const clearCache = async (): Promise<void> => {
  try {
    await raycastStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
};

/**
 * The context to shape an optimistic entry with.
 *
 * `settings` is null on a Mac that has never had a successful read, which the
 * builders already handle — the entry gets a zero rate and a default currency,
 * and the replay corrects both. That is the honest answer: nothing local knows
 * the rate yet.
 */
export const loadShapeContext = async (): Promise<EntryShapeContext> => {
  const cache = await loadCache();
  const tasks: ShapeableTask[] = cache.tasks;
  return {
    projects: cache.projects,
    tasks,
    settings: cache.settings
      ? {
          workspaceId: cache.settings.workspaceId,
          userId: cache.settings.userId,
          currency: cache.settings.currency,
          defaultHourlyRate: cache.settings.defaultHourlyRate,
        }
      : null,
    source: SOURCE,
  };
};

/**
 * Whether a project bills by default, as far as this Mac knows.
 *
 * The server resolves this from the project when a start omits `billable`;
 * offline there is nobody to ask, so the cached project answers and an unknown
 * one falls back to not billable — the choice that cannot silently invent
 * money on an entry the user never marked.
 */
export const cachedBillableDefault = async (
  projectId: string | null,
): Promise<boolean> => {
  if (projectId === null) return false;
  const cache = await loadCache();
  return (
    cache.projects.find((project) => project.id === projectId)
      ?.billableDefault ?? false
  );
};
