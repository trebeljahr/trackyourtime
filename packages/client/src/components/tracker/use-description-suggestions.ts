"use client";

import * as React from "react";
import type { DescriptionSuggestion } from "@starter/core";

import { trpc } from "@/lib/trpc";

/**
 * How long typing settles before the server is asked. A request per keystroke
 * would put a round trip behind every letter, and the answers would arrive for
 * prefixes already abandoned.
 */
export const DESCRIPTION_SEARCH_DEBOUNCE_MS = 150;

/** Rows per answer: the list hangs under the bar, and a long one is scrolled past. */
const DESCRIPTION_LIMIT = 8;

export type DescriptionSuggestions = {
  rows: DescriptionSuggestion[];
  /** The trimmed text `rows` answer. `null` until the first answer. */
  rowsFor: string | null;
};

/**
 * `entries.descriptions`, searched server-side and debounced.
 *
 * Server-side because the rows are a page out of six months: filtering a
 * cached page locally answers "no match" for a description that is certainly
 * there. Failures are silent by design — a typeahead that raises an error
 * because the network blinked is worse than one that offers nothing — so the
 * query neither retries nor surfaces its error.
 */
export const useDescriptionSuggestions = (
  text: string,
  enabled: boolean,
): DescriptionSuggestions => {
  const query = text.trim();
  const [debounced, setDebounced] = React.useState(query);

  React.useEffect(() => {
    const timer = setTimeout(
      () => setDebounced(query),
      DESCRIPTION_SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [query]);

  const result = trpc.entries.descriptions.useQuery(
    { search: debounced === "" ? undefined : debounced, limit: DESCRIPTION_LIMIT },
    { enabled, staleTime: 60_000, retry: false },
  );

  return React.useMemo(
    () =>
      result.data === undefined
        ? { rows: [], rowsFor: null }
        : { rows: result.data, rowsFor: debounced },
    [debounced, result.data],
  );
};
