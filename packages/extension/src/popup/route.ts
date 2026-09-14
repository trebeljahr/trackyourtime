/**
 * Where the popup is, as a value.
 *
 * A stack rather than a tab bar. This surface is destroyed on every focus loss
 * and has exactly one thing it must be instantly good at — start and stop — so
 * a permanent tab bar would tax the screen that matters most on every open,
 * while a stack costs chrome only on screens the user deliberately pushed.
 *
 * Pure and React-free on purpose: navigation is the one piece of popup state
 * that has to survive being written to `chrome.storage.session` and read back
 * as `unknown`, and a model with no DOM or hook in it can be narrowed and
 * tested without mounting anything.
 */
import type { PopupView } from "../lib/messaging";

export type SettingsSection =
  | "general"
  | "idle"
  | "limits"
  | "devices"
  | "activity"
  | "account";

/**
 * A manual entry as it is being written.
 *
 * Held on the route rather than in the create screen's own state, for the same
 * reason the open settings section is: the popup is destroyed on every focus
 * loss, and this is the one form in it that can lose typed input to a stolen
 * focus. On the route it is written to route memory, so coming back within the
 * freshness window finds the half-filled form intact.
 */
export type EntryDraft = {
  description: string;
  projectId: string | null;
  taskId: string | null;
  billable: boolean;
  tagIds: string[];
  start: string;
  end: string;
};

/**
 * The screens the popup can show.
 *
 * `settings` carries which accordion section is open rather than the screen
 * holding it in local state: a section that collapsed itself every time the
 * three-second poll delivered a new snapshot would be unusable, and route
 * memory gets the open section back for free.
 *
 * `entry` carries an id and NOT the entry: the row lives in the worker's
 * snapshot, which is the only copy allowed to be authoritative. A route
 * holding a whole entry would be domain state in the popup, and would go stale
 * the moment another device edited the same row.
 */
export type Route =
  | { name: "tracker" }
  | { name: "settings"; section: SettingsSection | null }
  | { name: "entries" }
  | { name: "entry"; id: string }
  | { name: "entry-new"; draft: EntryDraft }
  /**
   * Untracked activity as suggested entries. `day` is a `YYYY-MM-DD` key in
   * this device's zone, or null for today — null rather than today's key so a
   * route remembered just before midnight still opens on the new today.
   */
  | { name: "suggestions"; day: string | null }
  /**
   * A suggestion opened in the entry form before accepting it. The draft is on
   * the route for the reason the manual create's is: a stolen focus must not
   * cost what was typed.
   */
  | { name: "suggestion-edit"; day: string | null; draft: EntryDraft };

/** Never empty; index 0 is always the tracker. */
export type PopupStack = readonly [Route, ...Route[]];

export const ROOT_STACK: PopupStack = [{ name: "tracker" }];

/** Which snapshot the worker should be scoping its reads to for this screen. */
export function viewOf(route: Route): PopupView {
  switch (route.name) {
    case "tracker":
      return "tracker";
    case "settings":
      return "settings";
    case "entries":
    case "entry":
    case "entry-new":
      // All three read the same window. The detail screen renders one row out
      // of the page the list already fetched, so pushing it must not make the
      // worker drop what it is holding.
      return "entries";
    case "suggestions":
    case "suggestion-edit":
      // The edit form accepts against the same suggestions the list shows.
      return "suggestions";
  }
}

export function topOf(stack: PopupStack): Route {
  return stack[stack.length - 1] ?? stack[0];
}

/**
 * Go to a route.
 *
 * A total function of the target alone: the resulting stack depends only on
 * where you are going, never on where you were. That is what keeps a 380px
 * surface from turning into a maze — level-1 routes REPLACE each other rather
 * than pushing, so settings → entries is a move sideways and not a third
 * level with two back steps out of it.
 */
export function navigate(stack: PopupStack, route: Route): PopupStack {
  switch (route.name) {
    case "tracker":
      return ROOT_STACK;
    case "settings":
    case "entries":
    case "suggestions":
      return [ROOT_STACK[0], route];
    case "suggestion-edit":
      // Back out of the form lands on the list of the same day.
      return [ROOT_STACK[0], { name: "suggestions", day: route.day }, route];
    case "entry":
    case "entry-new":
      // Always reached through the list, even when the route was restored from
      // memory rather than tapped: back out of a detail screen has to land on
      // the entries the row came from, or "back" would mean "the tracker" on
      // one path and "the list" on another.
      return [ROOT_STACK[0], { name: "entries" }, route];
  }
}

const HOUR_MS = 3_600_000;
const FIVE_MINUTES_MS = 300_000;

/**
 * What a fresh manual entry offers: the whole hour that just passed.
 *
 * The web app's `defaultManualRange` rule, plus a floor to five minutes —
 * nobody logging past work by hand means "43 minutes ago", and a round number
 * is one fewer field to correct. Floored on the epoch rather than on a wall
 * clock because every real zone offset is a multiple of five minutes, so the
 * two agree and this needs no zone to be right.
 */
export function defaultDraft(nowMs: number = Date.now()): EntryDraft {
  const end = Math.floor(nowMs / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
  return {
    description: "",
    projectId: null,
    taskId: null,
    billable: false,
    tagIds: [],
    start: new Date(end - HOUR_MS).toISOString(),
    end: new Date(end).toISOString(),
  };
}

/** One step back, floored at the tracker. */
export function back(stack: PopupStack): PopupStack {
  if (stack.length <= 1) return ROOT_STACK;
  const [first, ...rest] = stack;
  const trimmed = rest.slice(0, -1);
  return [first, ...trimmed];
}
