/**
 * The autocomplete behind the popup's description fields.
 *
 * Searched server-side rather than filtered here, and that is the whole point
 * of the round trip: `entries.descriptions` reads a page out of six months of
 * work, so a list narrowed locally would answer "no match" for a description
 * the user has certainly typed before — it simply was not among the rows the
 * unfiltered call happened to return. Pushing the query down means the regex
 * runs against the whole window.
 *
 * Sibling of `favorites.ts`'s recents rather than a mode of it. A recent is
 * keyed on the whole (description, project, task, billable) combination and
 * answers "resume this job"; a suggestion is keyed on the description alone
 * and answers "you have called work this before". One list cannot do both
 * without either repeating a name once per project it was ever filed under, or
 * hiding the project it usually belongs to.
 */
import type { DescriptionSuggestion } from "@starter/core";
import {
  ensureReady,
  getCachedDescriptions,
  getServerLevels,
  setCachedDescriptions,
  type CachedDescriptions,
} from "./runtime";

/**
 * How many rows one query answers with.
 *
 * Lower than the server's own default: the popup is 380px wide and the list
 * hangs under a field that already has a start button below it, so a longer
 * list is scrolled past rather than read.
 */
const DESCRIPTION_LIMIT = 8;

/**
 * How long a query's rows stand before they are asked for again.
 *
 * Long enough that backspacing through a word and retyping it does not put a
 * request behind every letter, short enough that a description typed a minute
 * ago on another device shows up. `entries.changed` drops the cache outright,
 * so this only governs the case where nothing has happened at all.
 */
const CACHE_TTL_MS = 60_000;

/** Trimmed, so " foo" and "foo" are not two cache entries for one question. */
const normalize = (query: string): string => query.trim();

export async function searchDescriptions(query: string): Promise<void> {
  const search = normalize(query);
  const cached = getCachedDescriptions();
  if (
    cached !== null &&
    cached.query === search &&
    Date.now() - cached.fetchedAt < CACHE_TTL_MS
  ) {
    return;
  }

  const current = await ensureReady();
  if (!current.session) return;

  // Gating a feature on the server (docs/versioning.md → "Gating a feature on
  // the server"): ask the level cache whether the server has the capability,
  // never a release number. A server that lacks it answers an empty list, so
  // the field simply offers nothing — no request, no error. An unknown level
  // counts as supported; a failed read is silent anyway.
  if (!getServerLevels().supports(current.apiUrl, "entries.descriptions")) {
    setCachedDescriptions({ query: search, rows: [], fetchedAt: Date.now() });
    return;
  }

  try {
    const rows = await current.api.query<DescriptionSuggestion[]>(
      "entries.descriptions",
      // `search` is omitted rather than sent empty: the server treats a blank
      // string as "no filter" already, but an omitted key is what the schema
      // is written for and keeps the two callers' shapes identical.
      search === ""
        ? { limit: DESCRIPTION_LIMIT }
        : { search, limit: DESCRIPTION_LIMIT },
    );
    const next: CachedDescriptions = {
      query: search,
      rows,
      fetchedAt: Date.now(),
    };
    setCachedDescriptions(next);
  } catch {
    // Deliberately silent. This is a typeahead: raising the popup's error
    // banner because the network blinked mid-word would be far more disruptive
    // than offering nothing, and every other read in the snapshot already
    // reports whether the server is reachable.
  }
}
