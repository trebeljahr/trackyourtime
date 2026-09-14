/**
 * Captured activity, and the entries it suggests.
 *
 * Host-free on purpose: the browser extension is the first capturer, and the
 * desktop shell and the Android app are expected to feed the same functions
 * with their own detectors. Nothing here reads a clock, a zone, a DOM or a
 * network — every instant is an epoch millisecond count supplied by the caller,
 * which is what keeps a suggestion built on one device identical to the one
 * built from the same rows on another, and what makes a DST change a non-event
 * (an epoch instant has no wall clock to jump).
 */

/** Which kind of detector produced a segment. */
export type ActivitySource = "browser" | "desktop";

/**
 * One uninterrupted stretch of attention on one thing.
 *
 * `key` is what the time is attributed to: a hostname for the browser, an
 * application id for a desktop capturer. `label` is the optional detail (a page
 * title) that capturers store only when the person opted into it.
 */
export type ActivitySegment = {
  source: ActivitySource;
  /** Epoch ms, inclusive. */
  start: number;
  /** Epoch ms, exclusive. Never before `start`. */
  end: number;
  key: string;
  label?: string;
  /** True for a stretch the detector knows the person was away for. */
  afk: boolean;
};

/** A half-open `[start, end)` span in epoch ms. */
export type ActivityInterval = {
  start: number;
  end: number;
};

/**
 * "Always file <host> under …".
 *
 * `pattern` is a host glob: `*` matches any run of characters, and a leading
 * `*.` also matches the bare domain, so `*.example.com` covers `example.com`
 * and `docs.example.com` alike. Matching is case-insensitive. Every filing
 * field is optional — a rule that names only a project leaves the description
 * to the person.
 */
export type ActivityRule = {
  id: string;
  pattern: string;
  description?: string;
  projectId?: string | null;
  taskId?: string | null;
  tagIds?: string[];
  billable?: boolean;
};

/** What a rule proposes for a block, in the shape an entry create takes. */
export type ProposedEntryFields = {
  description?: string;
  projectId?: string | null;
  taskId?: string | null;
  tagIds?: string[];
  billable?: boolean;
};

export type ActivityKeyShare = {
  key: string;
  /** Whole seconds attributed to this key inside the block. */
  seconds: number;
  /** `seconds` over the block's attributed total, 0..1. */
  share: number;
};

/** One untracked stretch of activity, offered to be turned into an entry. */
export type ActivitySuggestion = {
  /** Epoch ms of the first recorded activity in the block. */
  start: number;
  /** Epoch ms of the end of the last recorded activity in the block. */
  end: number;
  /** Most time first; ties by key, so the order is stable. */
  topKeys: ActivityKeyShare[];
  /** The id of the rule that filled `proposed`, when one matched. */
  ruleId?: string;
  proposed: ProposedEntryFields;
};

export type BuildSuggestionsOptions = {
  /** Two stretches further apart than this become two blocks. Default 10. */
  gapMinutes?: number;
  /** A block with less activity than this is dropped. Default 5. */
  minMinutes?: number;
  /** How many keys `topKeys` carries at most. Default 5. */
  maxKeys?: number;
};

export type MergeSegmentsOptions = {
  /**
   * Two same-key segments this close together are one segment. Default 60s —
   * a capturer that closes and reopens a segment on every heartbeat or tab
   * reload would otherwise produce a row per minute.
   */
  pulseGapMs?: number;
};
