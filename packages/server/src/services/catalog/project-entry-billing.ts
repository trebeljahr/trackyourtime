// Carrying a project's billing change onto the time already booked on it.
//
// Entries snapshot their rate when they stop, so past earnings never shift
// when a project's rate changes later. That is the right default and it stays
// the default: this module only runs when the person editing the project
// explicitly asks for the change to reach history too.
//
// Three limits, each of which is the same rule stated somewhere else already:
//
// - **Invoiced entries are never rewritten.** `billable` is one of the
//   `INVOICE_RELEVANT_FIELDS`, and the rate is what the invoice's amounts were
//   calculated from. Changing either behind an issued invoice is exactly the
//   divergence `invoicedEntryEditRefusal` exists to refuse.
// - **Only the caller's own entries.** Editing an entry is author-only,
//   independent of viewing, and a bulk edit is still an edit. In a solo
//   workspace that is every entry on the project.
// - **The billable flag moves only when the default did.** A rate change on
//   its own reprices billable time and leaves each entry's flag alone, so an
//   entry somebody deliberately marked non-billable stays that way.
import type {
  ProjectBillingImpact,
  WorkspaceSettings,
} from "@starter/shared";
// Subpath import so `entryBillingWrite` loads under the unit tests, where a
// bare named import from "@starter/shared" throws (see duration.test.ts).
import { resolveHourlyRate } from "@starter/shared/rates";
import { TimeEntry } from "../../models/TimeEntry.js";
import type { WorkspaceScope } from "../scope.js";

/** The rewrite's `updateMany`: which entries, and what they become. */
export type EntryBillingWrite = {
  filter: Record<string, unknown>;
  set: { billable?: boolean; hourlyRate: number | null; currency: string };
};

export type EntryBillingChange = {
  /** The project's billable default after the update. */
  billableDefault: boolean;
  /** True when this update changed the billable default. */
  billableChanged: boolean;
  /** The project's own rate after the update; null falls back to the default. */
  projectRate: number | null;
};

/**
 * The write that brings a project's booked time in line with its billing.
 *
 * Pure, so the rules above are pinned without a database. `baseFilter` is the
 * caller's scope (workspace, project, author, not invoiced); the write only
 * ever narrows it.
 */
export function entryBillingWrite(
  baseFilter: Record<string, unknown>,
  change: EntryBillingChange,
  settings: Pick<WorkspaceSettings, "defaultHourlyRate" | "currency">,
): EntryBillingWrite {
  const rateWhenBillable = resolveHourlyRate({
    billable: true,
    projectRate: change.projectRate,
    defaultRate: settings.defaultHourlyRate,
  });

  if (change.billableChanged) {
    // Every entry takes the new flag, and the rate that flag implies.
    return {
      filter: baseFilter,
      set: {
        billable: change.billableDefault,
        hourlyRate: change.billableDefault ? rateWhenBillable : null,
        currency: settings.currency,
      },
    };
  }

  // Flags stay as they are. Non-billable entries already carry no rate, so
  // only billable ones have anything to reprice.
  return {
    filter: { ...baseFilter, billable: true },
    set: { hourlyRate: rateWhenBillable, currency: settings.currency },
  };
}

/** The caller's own entries on `projectId` — the most a rewrite can reach. */
const ownProjectEntries = (
  scope: WorkspaceScope,
  projectId: string,
): Record<string, unknown> => ({
  workspaceId: scope.workspaceId,
  projectId,
  authorId: scope.userId,
});

/** How much booked time a billing change on `projectId` would reach. */
export async function projectBillingImpact(
  scope: WorkspaceScope,
  projectId: string,
): Promise<ProjectBillingImpact> {
  const own = ownProjectEntries(scope, projectId);
  const [entries, invoiced] = await Promise.all([
    TimeEntry.countDocuments({ ...own, invoiceId: null }),
    TimeEntry.countDocuments({ ...own, invoiceId: { $ne: null } }),
  ]);
  return { entries, invoiced };
}

/**
 * Rewrite the caller's un-invoiced entries on `projectId`.
 *
 * Reports the entries in scope rather than Mongo's `modifiedCount`, which
 * leaves out every entry that already matched — the person asked for all of
 * them to carry the project's billing, and all of them now do.
 */
export async function applyBillingToEntries(
  scope: WorkspaceScope,
  projectId: string,
  change: EntryBillingChange,
  settings: Pick<WorkspaceSettings, "defaultHourlyRate" | "currency">,
): Promise<ProjectBillingImpact> {
  const impact = await projectBillingImpact(scope, projectId);
  const write = entryBillingWrite(
    { ...ownProjectEntries(scope, projectId), invoiceId: null },
    change,
    settings,
  );
  await TimeEntry.updateMany(write.filter, { $set: write.set });
  return impact;
}
