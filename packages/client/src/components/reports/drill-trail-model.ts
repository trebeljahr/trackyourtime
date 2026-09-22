/**
 * The drill trail's data, kept apart from the hook that owns it so both the
 * hook and the pure drill helpers can name a step without importing each other.
 */

/** One drill-down already applied, as the trail under the filter bar shows it. */
export type DrillStep = {
  /** What was drilled into: "ricos.site", "Week of 7 Sep 2026". */
  label: string;
  /** The query string in force BEFORE the step, so Back can restore it. */
  query: string;
};

/**
 * The steps still standing, given the query the report shows now.
 *
 * A step whose starting query is the current one has been undone — by
 * browser Back, by clearing the drilled filter by hand, or by a drill that
 * changed nothing — and so has every step after it. Derived on every render
 * rather than written back in an effect, so the trail can never offer to undo
 * a step the URL already shows undone.
 */
export const pruneDrillTrail = (
  trail: readonly DrillStep[],
  currentQuery: string
): readonly DrillStep[] => {
  for (let index = trail.length - 1; index >= 0; index -= 1) {
    if (trail[index]?.query === currentQuery) return trail.slice(0, index);
  }
  return trail;
};
