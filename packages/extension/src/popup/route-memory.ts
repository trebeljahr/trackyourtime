/**
 * Remembering which screen the popup was on, briefly.
 *
 * `chrome.storage.session`, not `local`: this is memory-only and dies with the
 * browser, which is the same reason the session token lives there. Tomorrow
 * morning the toolbar button must open on the timer; thirty seconds after you
 * clicked away to read a ticket number, it must not — hence a freshness
 * window rather than a durable preference.
 *
 * Written by the popup directly rather than through the worker. Navigation is
 * not domain state, so it sits outside the whole-snapshot contract, and waking
 * a sleeping service worker to learn *which screen to paint* would delay the
 * timer the user opened the popup for.
 */
import { chromeStorage, sessionStorageArea } from "../lib/chrome-storage";
import {
  defaultDraft,
  navigate,
  ROOT_STACK,
  type EntryDraft,
  type PopupStack,
  type Route,
  type SettingsSection,
} from "./route";

const KEY = "tracktime.popup-route";

/** Past this the popup is being opened afresh, not returned to. */
const ROUTE_MEMORY_MS = 120_000;

const store = (): ReturnType<typeof chromeStorage> =>
  chromeStorage(sessionStorageArea());

const SETTINGS_SECTIONS: ReadonlySet<string> = new Set([
  "general",
  "idle",
  "limits",
  "devices",
  "activity",
  "account",
]);

const asDayOrNull = (value: unknown): string | null =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Narrow one stored route, never cast one.
 *
 * The value came out of storage as `unknown` and may have been written by an
 * older build of this extension whose route union was a different shape. A
 * cast would paint a screen that no longer exists; returning null sends the
 * user to the tracker, which every build has.
 */
const asStringOrNull = (value: unknown): string | null | undefined =>
  value === null || typeof value === "string" ? value : undefined;

const asIso = (value: unknown): string | undefined =>
  typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? value
    : undefined;

/**
 * Narrow a stored draft, field by field.
 *
 * Returns null on anything it cannot vouch for, and the caller then offers a
 * fresh default range instead: a draft is a convenience, and half-restoring one
 * — a start whose end failed to parse, say — would put a form on screen whose
 * "Add entry" button is disabled for a reason the user cannot see.
 */
const parseDraft = (value: unknown): EntryDraft | null => {
  const record = asRecord(value);
  if (record === null) return null;

  const description = record.description;
  const projectId = asStringOrNull(record.projectId);
  const taskId = asStringOrNull(record.taskId);
  const billable = record.billable;
  const tagIds = record.tagIds;
  const start = asIso(record.start);
  const end = asIso(record.end);

  if (typeof description !== "string") return null;
  if (projectId === undefined || taskId === undefined) return null;
  if (typeof billable !== "boolean") return null;
  if (!Array.isArray(tagIds) || !tagIds.every((id) => typeof id === "string")) {
    return null;
  }
  if (start === undefined || end === undefined) return null;

  return { description, projectId, taskId, billable, tagIds, start, end };
};

const parseRoute = (value: unknown): Route | null => {
  const record = asRecord(value);
  if (record === null) return null;

  if (record.name === "tracker") return { name: "tracker" };

  if (record.name === "entries") return { name: "entries" };

  if (record.name === "entry") {
    // The id is checked against the entry window, not here: the window has not
    // been fetched yet at the moment this is read, and refusing the route on a
    // row that simply has not arrived would send the user back for no reason.
    return typeof record.id === "string" ? { name: "entry", id: record.id } : null;
  }

  if (record.name === "entry-new") {
    return { name: "entry-new", draft: parseDraft(record.draft) ?? defaultDraft() };
  }

  if (record.name === "suggestions") {
    // An unreadable day is today, not a reason to lose the screen.
    return { name: "suggestions", day: asDayOrNull(record.day) };
  }

  if (record.name === "suggestion-edit") {
    // Unlike a manual draft there is no sensible default to fall back to: the
    // times ARE the suggestion. Without them, return to the list.
    const draft = parseDraft(record.draft);
    const day = asDayOrNull(record.day);
    return draft === null
      ? { name: "suggestions", day }
      : { name: "suggestion-edit", day, draft };
  }

  if (record.name === "settings") {
    const section = record.section;
    if (section === null || section === undefined) {
      return { name: "settings", section: null };
    }
    if (typeof section === "string" && SETTINGS_SECTIONS.has(section)) {
      return { name: "settings", section: section as SettingsSection };
    }
    return { name: "settings", section: null };
  }

  return null;
};

const parseStack = (value: unknown): PopupStack | null => {
  const record = asRecord(value);
  if (record === null) return null;

  const at = record.at;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (Date.now() - at > ROUTE_MEMORY_MS) return null;

  const raw = record.stack;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const routes: Route[] = [];
  for (const entry of raw) {
    const route = parseRoute(entry);
    // One unreadable frame invalidates the whole stack: a back button that
    // skips a level the user actually walked through is worse than starting
    // over at the tracker.
    if (route === null) return null;
    routes.push(route);
  }

  const [first] = routes;
  const top = routes[routes.length - 1];
  if (first === undefined || first.name !== "tracker" || top === undefined) return null;
  // Rebuilt from the top frame: `navigate` is a total function of the target,
  // so this is the stack the user walked — and a frame narrowed to something
  // else above (an unreadable suggestion draft becomes its list) cannot leave
  // two copies of one screen to step back through.
  return navigate(ROOT_STACK, top);
};

export async function rememberRoute(stack: PopupStack): Promise<void> {
  await store().setItem(KEY, JSON.stringify({ stack, at: Date.now() }));
}

/** The remembered stack, or null when it is missing, stale or unreadable. */
export async function loadRoute(): Promise<PopupStack | null> {
  const raw = await store().getItem(KEY);
  if (raw === null) return null;

  try {
    return parseStack(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export async function forgetRoute(): Promise<void> {
  await store().removeItem(KEY);
}
