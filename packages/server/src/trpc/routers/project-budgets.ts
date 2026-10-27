// Budget/estimate roll-ups for projects.
//
// Progress is a LIFETIME measure — a project's whole history against a single
// target — so unlike the reports it clips to no range. What it does share with
// the reports is the money math: earnings come from `computeBudgetProgress`,
// which in turn defers to `entryAmount`/`sumAmounts` and the entry's own rate
// snapshot. Nothing here recomputes earnings from a project's current rate.
import {
  computeBudgetProgress,
  entryDurationSec,
  hasBudgetTarget,
  type BudgetEntry,
  type BudgetProgress,
  type ProjectBudget,
  type Visibility,
} from "@starter/shared";
import { TimeEntry } from "../../models/TimeEntry.js";

/** A project row reduced to what a budget roll-up needs. */
export type BudgetedProject = ProjectBudget & { id: string };

/**
 * May this caller be handed budget progress at all?
 *
 * The same conjunction `projectProjectForVisibility` withholds on, asked
 * BEFORE the roll-up rather than after it, so a caller who would receive
 * `progress: null` never costs the whole-workspace entry read either. Any
 * future surface that reports progress — an over-budget alert, a digest —
 * must ask this per RECIPIENT, not per author of the change that tipped it:
 * `spentAmount` is colleagues' earnings in aggregate, and a notification
 * saying "92% of the budget is spent" discloses exactly that number.
 */
export function canSeeBudgetProgress(visibility: Visibility): boolean {
  return visibility.canViewOthersTime && visibility.canViewOthersMoney;
}

/**
 * Progress for every project that actually has a target, keyed by project id.
 *
 * Projects with no estimate and no budget are skipped entirely, so a workspace
 * that never sets one pays nothing: no entries are read at all.
 *
 * Deliberately spans every member's entries: a project budget is the
 * project's, not one person's. That is what makes the result a disclosure,
 * and why every caller gates it through {@link canSeeBudgetProgress} and
 * `projectProjectForVisibility` — this function itself answers for the
 * workspace and must never be handed to a caller unprojected.
 */
export async function loadBudgetProgress(
  workspaceId: string,
  projects: BudgetedProject[],
): Promise<Map<string, BudgetProgress>> {
  const progress = new Map<string, BudgetProgress>();
  const targeted = projects.filter((project) => hasBudgetTarget(project));
  if (targeted.length === 0) return progress;

  const docs = await TimeEntry.find({
    workspaceId,
    projectId: { $in: targeted.map((project) => project.id) },
  })
    .select("projectId start end durationSec billable hourlyRate currency")
    .lean();

  const nowMs = Date.now();
  const byProject = new Map<string, BudgetEntry[]>();

  for (const doc of docs) {
    if (doc.projectId === null) continue;
    const entries = byProject.get(doc.projectId) ?? [];
    entries.push({
      // A running timer counts up to now, exactly as it does in the reports —
      // work in progress is spending the budget whether or not it is stopped.
      seconds: entryDurationSec(
        {
          start: doc.start.toISOString(),
          end: doc.end === null ? null : doc.end.toISOString(),
          durationSec: doc.durationSec,
        },
        nowMs,
      ),
      billable: doc.billable,
      hourlyRate: doc.hourlyRate ?? null,
      currency: doc.currency,
    });
    byProject.set(doc.projectId, entries);
  }

  for (const project of targeted) {
    progress.set(
      project.id,
      computeBudgetProgress(project, byProject.get(project.id) ?? []),
    );
  }
  return progress;
}

export { budgetWrite, touchesBudget, needsCurrency, type BudgetInput, type ExistingBudget } from "@starter/shared";
