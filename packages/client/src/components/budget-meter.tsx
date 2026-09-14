"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";
import type { BudgetStatus } from "@starter/shared";

import { Badge } from "@/components/ui/badge";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";
import type { BudgetMeter as BudgetMeterData, BudgetView } from "@/lib/budget-view";

/**
 * Colour is the only signal a budget gets. There is no alerting anywhere in
 * this app — a solo user looking at their own row does not need to be warned
 * twice, so "over" borrows the destructive token and "near" the same amber the
 * account screen already uses for "read this before you continue".
 */
const TEXT_TONE: Record<BudgetStatus, string> = {
  none: "text-muted-foreground",
  under: "text-muted-foreground",
  near: "text-amber-700 dark:text-amber-400",
  over: "text-destructive",
};

const BAR_TONE: Record<BudgetStatus, string> = {
  none: "bg-muted-foreground/40",
  under: "bg-primary",
  near: "bg-amber-500",
  over: "bg-destructive",
};

export type BudgetBadgeProps = {
  status: BudgetStatus;
  label: string;
  testId?: string;
};

/** The "Over budget" / "Nearly used up" pill. Nothing renders while under. */
export function BudgetBadge({
  status,
  label,
  testId,
}: BudgetBadgeProps): React.JSX.Element | null {
  if (status !== "near" && status !== "over") return null;
  return (
    <Badge
      variant={status === "over" ? "destructive" : "outline"}
      className={cn(
        "shrink-0 gap-1",
        status === "near" && "border-amber-500/50 text-amber-700 dark:text-amber-400",
      )}
      data-status={status}
      data-testid={testId}
    >
      <AlertTriangle className="size-3" aria-hidden="true" />
      {label}
    </Badge>
  );
}

type MeterProps = {
  meter: BudgetMeterData;
  /** Names the bar for screen readers, e.g. "Hours against estimate". */
  name: string;
  testId?: string;
};

function Meter({ meter, name, testId }: MeterProps): React.JSX.Element {
  const t = useT("reports");
  return (
    <div className="space-y-1" title={meter.remainderLabel} data-testid={testId}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate tabular-nums">{meter.label}</span>
        <span
          className={cn("shrink-0 tabular-nums", TEXT_TONE[meter.status])}
          data-testid={testId ? `${testId}-percent` : undefined}
        >
          {meter.percentLabel}
        </span>
      </div>
      <span
        role="progressbar"
        aria-label={name}
        aria-valuenow={Math.round(meter.fill)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={t("budget.meterValue", {
          percent: meter.percentLabel,
          remainder: meter.remainderLabel,
        })}
        className="block h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <span
          className={cn("block h-full rounded-full", BAR_TONE[meter.status])}
          style={{ width: `${meter.fill}%` }}
        />
      </span>
    </div>
  );
}

export type BudgetMeterProps = {
  /** Null when the project has no estimate and no budget — renders a dash. */
  view: BudgetView | null;
  /** Shown in place of a meter when there is no target. */
  emptyLabel?: string;
  testId?: string;
};

/**
 * A project's progress against its estimate and budget.
 *
 * A project with no target renders `emptyLabel`, never a meter sitting at
 * zero: "no budget set" and "nothing spent yet" are different facts.
 */
export function BudgetMeterCell({
  view,
  emptyLabel = "—",
  testId,
}: BudgetMeterProps): React.JSX.Element {
  const t = useT("reports");
  if (view === null) {
    return (
      <span className="text-muted-foreground/70" data-testid={testId}>
        {emptyLabel}
      </span>
    );
  }

  return (
    <div className="min-w-40 space-y-1.5" data-testid={testId}>
      {view.hours ? (
        <Meter
          meter={view.hours}
          name={t("budget.hoursMeter")}
          testId={testId ? `${testId}-hours` : undefined}
        />
      ) : null}
      {view.amount ? (
        <Meter
          meter={view.amount}
          name={t("budget.amountMeter")}
          testId={testId ? `${testId}-amount` : undefined}
        />
      ) : null}
      {view.badge ? (
        <BudgetBadge
          status={view.status}
          label={view.badge}
          testId={testId ? `${testId}-badge` : undefined}
        />
      ) : null}
      {view.currencyNote ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid={testId ? `${testId}-currency-note` : undefined}
        >
          {view.currencyNote}
        </p>
      ) : null}
    </div>
  );
}
