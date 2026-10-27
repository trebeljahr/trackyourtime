/**
 * Per-project estimates and budgets.
 *
 * A budget is a *lifetime* target for one project: "this job was quoted at 80
 * hours / EUR 6,000". Progress against it is a roll-up of the project's own
 * entries, so this module owns no money math of its own — it defers to
 * `entryAmount` / `sumAmounts` in `rates.ts`, the same helpers the reports
 * use, because the per-entry rate snapshot rules are subtle and already
 * encoded once there.
 *
 * Two rules the callers depend on:
 *  - `null` and `0` are different targets. No estimate at all yields `null`
 *    ratios and a `"none"` status, never "0% of 0".
 *  - Money is never summed across currencies. Each entry snapshots the
 *    workspace currency it was tracked in, so spend is bucketed per currency
 *    and only the bucket matching the budget's own currency counts towards it.
 *    Anything else is reported through `foreignCurrencies` for the UI to
 *    explain rather than silently folded into the total.
 */

import { entryAmount, normalizeCurrency, sumAmounts } from "./rates.js";
export { normalizeCurrency } from "./rates.js";

const SECONDS_PER_HOUR = 3600;

/** Fraction of a target at which progress starts reading as "nearly used up". */
export const BUDGET_NEAR_RATIO = 0.8;

/**
 * How a target is doing. `"none"` means no target was set — distinct from
 * `"under"`, which means a target exists and there is room left.
 */
export type BudgetStatus = "none" | "under" | "near" | "over";

/** The target fields carried by a Project. All null when nothing is set. */
export type ProjectBudget = {
  /** Lifetime hours estimate. */
  estimatedHours: number | null;
  /** Lifetime money budget. */
  budgetAmount: number | null;
  /** ISO 4217 code the budget is denominated in. */
  budgetCurrency: string | null;
};

/** The per-entry facts progress needs — a projection of a TimeEntry. */
export type BudgetEntry = {
  /** Whole seconds tracked, running entries already measured by the caller. */
  seconds: number;
  billable: boolean;
  /** The entry's own rate snapshot, never the project's current rate. */
  hourlyRate: number | null;
  /** The entry's own currency snapshot. */
  currency: string;
};

/** Everything earned in one currency. */
export type CurrencySpend = {
  currency: string;
  amount: number;
  seconds: number;
};

export type BudgetProgress = {
  trackedSec: number;
  billableSec: number;
  estimatedHours: number | null;
  budgetAmount: number | null;
  /**
   * The currency `spentAmount` is in: the budget's own when there is a money
   * budget, otherwise the single currency the project was tracked in. Null
   * when neither is decidable, which is exactly when `spentAmount` is 0.
   */
  currency: string | null;
  /** Earnings in `currency` only. */
  spentAmount: number;
  /** Every currency the project earned in, biggest first. */
  spentByCurrency: CurrencySpend[];
  /** Tracked ÷ estimate. Null when no estimate is set. */
  hoursRatio: number | null;
  /** Spent ÷ budget. Null when no budget is set. */
  amountRatio: number | null;
  hoursStatus: BudgetStatus;
  amountStatus: BudgetStatus;
  /** Seconds left on the estimate; negative once over. Null without one. */
  remainingSec: number | null;
  /** Money left in the budget; negative once over. Null without one. */
  remainingAmount: number | null;
  /** True when earnings exist outside `currency` and are excluded above. */
  mixedCurrency: boolean;
  /** The excluded currencies, biggest first. */
  foreignCurrencies: string[];
};

/** True when the project has any target at all — 0 counts, null does not. */
export const hasBudgetTarget = (budget: ProjectBudget): boolean =>
  budget.estimatedHours !== null || budget.budgetAmount !== null;

/**
 * Progress as a fraction of the target.
 *
 * A target of 0 is a real target, so any spend against it is already over
 * (ratio 1) while no spend is 0 — the alternative, dividing by zero, would
 * render as Infinity or NaN.
 */
const ratioOf = (spent: number, target: number | null): number | null => {
  if (target === null || !Number.isFinite(target)) return null;
  if (target <= 0) return spent > 0 ? 1 : 0;
  return spent / target;
};

/** `"none"` without a target, then under / near / over as it fills up. */
export const budgetStatus = (ratio: number | null): BudgetStatus => {
  if (ratio === null) return "none";
  if (ratio >= 1) return "over";
  if (ratio >= BUDGET_NEAR_RATIO) return "near";
  return "under";
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * What a project's entries add up to, before any target is applied.
 *
 * Split out from the comparison so a target can be changed without re-reading
 * a single entry — the optimistic update behind the budget form does exactly
 * that.
 */
export type BudgetRollup = {
  trackedSec: number;
  billableSec: number;
  /** Earnings per currency, biggest first. */
  spentByCurrency: CurrencySpend[];
};

export const EMPTY_ROLLUP: BudgetRollup = {
  trackedSec: 0,
  billableSec: 0,
  spentByCurrency: [],
};

/** Sum a project's entries. The only place money is added up here. */
export const rollUpEntries = (entries: BudgetEntry[]): BudgetRollup => {
  let trackedSec = 0;
  let billableSec = 0;
  const buckets = new Map<string, { amounts: number[]; seconds: number }>();

  for (const entry of entries) {
    const seconds = Number.isFinite(entry.seconds)
      ? Math.max(0, Math.round(entry.seconds))
      : 0;
    trackedSec += seconds;
    if (!entry.billable) continue;
    billableSec += seconds;

    // A billable entry with no rate snapshot earned nothing, so it must not
    // conjure a currency bucket that would read as a currency conflict.
    const amount = entryAmount(seconds, entry.hourlyRate);
    if (amount === 0) continue;

    const code = normalizeCurrency(entry.currency);
    const bucket = buckets.get(code) ?? { amounts: [], seconds: 0 };
    bucket.amounts.push(amount);
    bucket.seconds += seconds;
    buckets.set(code, bucket);
  }

  return {
    trackedSec,
    billableSec,
    spentByCurrency: [...buckets.entries()]
      .map(([currency, bucket]) => ({
        currency,
        amount: sumAmounts(bucket.amounts),
        seconds: bucket.seconds,
      }))
      .sort(
        (a, b) => b.amount - a.amount || a.currency.localeCompare(b.currency),
      ),
  };
};

/** The rollup back out of a computed progress, for re-targeting it. */
export const rollupOf = (progress: BudgetProgress): BudgetRollup => ({
  trackedSec: progress.trackedSec,
  billableSec: progress.billableSec,
  spentByCurrency: progress.spentByCurrency,
});

/** Compare an already-summed project against a target. Pure. */
export const budgetProgress = (
  budget: ProjectBudget,
  rollup: BudgetRollup,
): BudgetProgress => {
  const budgetCurrency =
    budget.budgetCurrency === null || budget.budgetCurrency.trim() === ""
      ? null
      : normalizeCurrency(budget.budgetCurrency);

  const { trackedSec, billableSec, spentByCurrency } = rollup;
  const firstSpend = spentByCurrency[0];
  const currency =
    budgetCurrency ??
    (spentByCurrency.length === 1 && firstSpend ? firstSpend.currency : null);

  const spentAmount =
    currency === null
      ? 0
      : (spentByCurrency.find((spend) => spend.currency === currency)?.amount ??
        0);

  const foreignCurrencies = spentByCurrency
    .map((spend) => spend.currency)
    .filter((code) => code !== currency);

  const trackedHours = trackedSec / SECONDS_PER_HOUR;
  const hoursRatio = ratioOf(trackedHours, budget.estimatedHours);
  const amountRatio = ratioOf(spentAmount, budget.budgetAmount);

  return {
    trackedSec,
    billableSec,
    estimatedHours: budget.estimatedHours,
    budgetAmount: budget.budgetAmount,
    currency,
    spentAmount,
    spentByCurrency,
    hoursRatio,
    amountRatio,
    hoursStatus: budgetStatus(hoursRatio),
    amountStatus: budgetStatus(amountRatio),
    remainingSec:
      budget.estimatedHours === null
        ? null
        : Math.round(budget.estimatedHours * SECONDS_PER_HOUR - trackedSec),
    remainingAmount:
      budget.budgetAmount === null
        ? null
        : round2(budget.budgetAmount - spentAmount),
    mixedCurrency: foreignCurrencies.length > 0,
    foreignCurrencies,
  };
};

/** Roll a project's entries up against its targets. Pure; safe to memoize. */
export const computeBudgetProgress = (
  budget: ProjectBudget,
  entries: BudgetEntry[],
): BudgetProgress => budgetProgress(budget, rollUpEntries(entries));

/**
 * The worse of the two statuses, for a single at-a-glance signal on a row.
 * `"none"` only survives when neither target is set.
 */
export const overallBudgetStatus = (
  progress: BudgetProgress,
): BudgetStatus => {
  const order: BudgetStatus[] = ["none", "under", "near", "over"];
  const hours = order.indexOf(progress.hoursStatus);
  const amount = order.indexOf(progress.amountStatus);
  return order[Math.max(hours, amount)] ?? "none";
};

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
