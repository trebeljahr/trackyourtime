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

/** The budget fields as they arrive on a create/update input. */
export type BudgetInput = {
  estimatedHours?: number | null | undefined;
  budgetAmount?: number | null | undefined;
  budgetCurrency?: string | null | undefined;
};

/** What the project already stores, so an edit can build on it. */
export type ExistingBudget = {
  budgetAmount: number | null;
  budgetCurrency: string | null;
};

const NO_EXISTING_BUDGET: ExistingBudget = {
  budgetAmount: null,
  budgetCurrency: null,
};

/**
 * The `$set` fragment for a project's budget fields.
 *
 * Enforces the one invariant the model has: `budgetCurrency` is non-null
 * exactly when `budgetAmount` is. A currency only exists to denominate an
 * amount, so it is written whenever the amount is and cleared with it — never
 * left behind pointing at nothing.
 *
 * Setting an amount without naming a currency snapshots the one the budget was
 * agreed in: the project's existing one when it already had a budget,
 * otherwise today's workspace currency. Changing the workspace currency later
 * therefore never re-denominates a budget agreed in the old one, exactly as a
 * time entry's own rate snapshot works.
 */
export function budgetWrite(
  input: BudgetInput,
  workspaceCurrency: string,
  existing: ExistingBudget = NO_EXISTING_BUDGET,
): Record<string, unknown> {
  const set: Record<string, unknown> = {};

  if (input.estimatedHours !== undefined) {
    set.estimatedHours = input.estimatedHours ?? null;
  }

  const touchesMoney =
    input.budgetAmount !== undefined || input.budgetCurrency !== undefined;
  if (!touchesMoney) return set;

  const amount =
    input.budgetAmount === undefined
      ? existing.budgetAmount
      : (input.budgetAmount ?? null);

  if (input.budgetAmount !== undefined) set.budgetAmount = amount;
  set.budgetCurrency =
    amount === null
      ? null
      : (input.budgetCurrency ?? existing.budgetCurrency ?? workspaceCurrency);

  return set;
}

/** True when a create/update input touches any budget field at all. */
export function touchesBudget(input: BudgetInput): boolean {
  return (
    input.estimatedHours !== undefined ||
    input.budgetAmount !== undefined ||
    input.budgetCurrency !== undefined
  );
}

/** True when resolving the write needs the workspace/project currency. */
export function needsCurrency(input: BudgetInput): boolean {
  return input.budgetAmount !== undefined || input.budgetCurrency !== undefined;
}
