// What an already-invoiced entry may still be changed to.
/**
 * The parts of an entry an invoice's line items are computed from.
 *
 * `description` and `tagIds` are deliberately absent: neither reaches a line
 * item, so relabelling or re-tagging billed time is harmless and stays allowed.
 * Everything listed here does reach one — changing it behind an issued invoice
 * would leave that invoice claiming hours, a rate or a project the underlying
 * time no longer has, with nothing on screen to say the two had diverged.
 */
export const INVOICE_RELEVANT_FIELDS = [
  "clientId",
  "projectId",
  "taskId",
  "billable",
  "start",
  "end",
] as const;

/**
 * Why an edit to an already-invoiced entry must be refused, or `null` when it
 * is fine to proceed.
 *
 * `Invoice.entryIds` and `TimeEntry.invoiceId` keep the same time from being
 * billed twice, but nothing stopped the billed time itself from moving after
 * the fact. An invoice is a record of what was billed, so the entry is frozen
 * in the ways the invoice depends on rather than the invoice being silently
 * recomputed underneath the customer who already received it.
 *
 * Exported for the unit tests — the rule is worth pinning independently of a
 * database.
 */
export function invoicedEntryEditRefusal(
  invoiceId: string | null | undefined,
  changedFields: readonly string[],
): string | null {
  if (!invoiceId) return null;

  const blocked = INVOICE_RELEVANT_FIELDS.filter((field) =>
    changedFields.includes(field),
  );
  if (blocked.length === 0) return null;

  return (
    `This time has already been invoiced, so its ${blocked.join(", ")} ` +
    "cannot be changed — the invoice's line items were calculated from it. " +
    "Delete the invoice while it is still a draft to release its time, then " +
    "edit and bill it again. Its description and tags can still be changed."
  );
}
