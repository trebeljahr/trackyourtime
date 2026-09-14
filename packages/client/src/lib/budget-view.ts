/**
 * Turning a project's budget progress into the strings a row renders.
 *
 * Kept apart from the components so the rules that matter — a missing target
 * renders nothing at all rather than "0% of 0", and money is never shown as a
 * total across currencies — are testable without a DOM.
 */

import {
  overallBudgetStatus,
  type BudgetProgress,
  type BudgetStatus,
} from "@starter/shared";

import type { ClientLocale } from "@/i18n/config";
import { formatList, formatNumber, formatPercent } from "@/i18n/format";
import { getActiveLocale } from "@/i18n/locale-store";
import { getTranslator } from "@/i18n/translator";

const SECONDS_PER_HOUR = 3600;

/** One target's worth of display state. */
export type BudgetMeter = {
  /** "62h 5m of 80h" or "€4,650.00 of €6,000.00". */
  label: string;
  /** "78%". Uncapped, so 140% still reads as 140%. */
  percentLabel: string;
  /** 0–100, clamped — the bar cannot overflow its track. */
  fill: number;
  /** "17h 55m left" or "3h 12m over". */
  remainderLabel: string;
  status: BudgetStatus;
};

export type BudgetView = {
  /** Null when the project carries no hours estimate. */
  hours: BudgetMeter | null;
  /** Null when the project carries no money budget. */
  amount: BudgetMeter | null;
  /** The worse of the two, for the row's single at-a-glance signal. */
  status: BudgetStatus;
  /** Short badge text, or null while the project is comfortably under. */
  badge: string | null;
  /** Explains any earnings left out of the money figure. */
  currencyNote: string | null;
};

export type BudgetFormatters = {
  /** Compact duration — "1h 23m". */
  durationShort: (seconds: number) => string;
  money: (amount: number, currency: string) => string;
  /** Used when the progress has no currency of its own. */
  fallbackCurrency: string;
  /**
   * The language the labels are written in. Defaults to the one rendering
   * now; a component should pass its own (`useLocale()`), so a language switch
   * re-renders the strings along with it.
   */
  locale?: ClientLocale;
};

/** "80h", "7.5h" / "80 h", "7,5 h" — an estimate reads as hours, not as a clock. */
export const formatHoursTarget = (
  hours: number,
  locale: ClientLocale = getActiveLocale(),
): string =>
  getTranslator(locale, "reports")("budget.hoursTarget", {
    hours: formatNumber(hours, locale, { maximumFractionDigits: 2 }),
  });

const clampFill = (ratio: number): number =>
  Math.max(0, Math.min(100, ratio * 100));

const badgeFor = (status: BudgetStatus, locale: ClientLocale): string | null => {
  const t = getTranslator(locale, "reports");
  if (status === "near") return t("budget.nearlyUsedUp");
  if (status === "over") return t("budget.overBudget");
  return null;
};

/**
 * The note under the money figure when a project's entries span more than one
 * currency. Entries snapshot the workspace currency they were tracked in, so
 * a project that outlived a currency change has earnings that genuinely
 * cannot be added together — saying so is the only honest option.
 */
const currencyNoteFor = (
  progress: BudgetProgress,
  locale: ClientLocale,
): string | null => {
  if (!progress.mixedCurrency) return null;
  const t = getTranslator(locale, "reports");
  const currencies = formatList(progress.foreignCurrencies, locale);
  return progress.currency === null
    ? t("budget.trackedIn", { currencies })
    : t("budget.excludes", { currencies });
};

/**
 * Display state for a project's progress, or null when it has no target.
 *
 * Null is the whole point of the "no budget set" case: the caller renders an
 * empty cell instead of a meter reading zero.
 */
export const budgetView = (
  progress: BudgetProgress | null | undefined,
  fmt: BudgetFormatters,
): BudgetView | null => {
  if (!progress) return null;

  const status = overallBudgetStatus(progress);
  if (status === "none") return null;

  const locale = fmt.locale ?? getActiveLocale();
  const t = getTranslator(locale, "reports");
  const percentLabel = (ratio: number): string => formatPercent(ratio, locale);

  const hours: BudgetMeter | null =
    progress.estimatedHours === null || progress.hoursRatio === null
      ? null
      : {
          label: t("budget.progress", {
            spent: fmt.durationShort(progress.trackedSec),
            target: formatHoursTarget(progress.estimatedHours, locale),
          }),
          percentLabel: percentLabel(progress.hoursRatio),
          fill: clampFill(progress.hoursRatio),
          remainderLabel:
            progress.remainingSec !== null && progress.remainingSec < 0
              ? t("budget.over", { amount: fmt.durationShort(-progress.remainingSec) })
              : t("budget.left", { amount: fmt.durationShort(progress.remainingSec ?? 0) }),
          status: progress.hoursStatus,
        };

  const currency = progress.currency ?? fmt.fallbackCurrency;
  const amount: BudgetMeter | null =
    progress.budgetAmount === null || progress.amountRatio === null
      ? null
      : {
          label: t("budget.progress", {
            spent: fmt.money(progress.spentAmount, currency),
            target: fmt.money(progress.budgetAmount, currency),
          }),
          percentLabel: percentLabel(progress.amountRatio),
          fill: clampFill(progress.amountRatio),
          remainderLabel:
            progress.remainingAmount !== null && progress.remainingAmount < 0
              ? t("budget.over", { amount: fmt.money(-progress.remainingAmount, currency) })
              : t("budget.left", {
                  amount: fmt.money(progress.remainingAmount ?? 0, currency),
                }),
          status: progress.amountStatus,
        };

  return {
    hours,
    amount,
    status,
    badge: badgeFor(status, locale),
    currencyNote: currencyNoteFor(progress, locale),
  };
};

/** Seconds an estimate is worth, for callers that need to compare directly. */
export const estimateSeconds = (hours: number): number =>
  Math.round(hours * SECONDS_PER_HOUR);
