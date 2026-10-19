// The condition a newest-first keyset page puts after its cursor: every row
// sorted after (`field`, `_id`), both descending.

/**
 * Two conditions, and the query needs both. The `$or` is the exact rule: an
 * older `field`, or the same `field` with a smaller `_id`. The plain
 * `field <= value` beside it changes no result — every row the `$or` matches
 * passes it — but it is what an index scan can seek to. The planner bounds a
 * scan by a contained `$or` only when it chooses to plan that `$or` as a
 * union, and a query with a second `$or` (the overlap rule, a visibility
 * filter) gives it another to choose. When it picks the other, the cursor is
 * filtered after the fetch, and page k reads every row above it again.
 *
 * The seek also needs an index whose sort is `field: -1, _id: -1`. Without
 * the `_id` the sort is a blocking one, which reads every row below the
 * cursor however the scan is bounded.
 */
export function keysetAfter(
  field: string,
  value: Date,
  id: unknown,
): Record<string, unknown>[] {
  return [
    { [field]: { $lte: value } },
    { $or: [{ [field]: { $lt: value } }, { [field]: value, _id: { $lt: id } }] },
  ];
}
