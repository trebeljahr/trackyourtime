"use client";

import * as React from "react";
import { BarChart3, PieChart as PieChartIcon } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  ReportGroupBy,
  SummaryGroup,
  SummaryTimelinePoint,
  WeekStart,
} from "@starter/shared";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import {
  MONEY_WITHHELD,
  sumReportMoney,
} from "@/components/reports/report-money";
import { isDrillableKey } from "@/components/reports/drill";
import {
  bucketTimeline,
  formatBucketLabel,
  type TimelineBucket,
  type TimelineGranularity,
} from "@/components/reports/timeline-buckets";
import { cn } from "@/lib/utils";

/**
 * Series colours come from the theme tokens rather than literals, so the
 * charts follow the light/dark switch without a re-render. Recharts writes
 * these straight into SVG `fill`, where `var()` resolves normally.
 */
export const CHART_COLORS: string[] = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
];

const BILLABLE_COLOR = "hsl(var(--chart-1))";
const NON_BILLABLE_COLOR = "hsl(var(--chart-3))";
const AXIS_COLOR = "hsl(var(--muted-foreground))";
const GRID_COLOR = "hsl(var(--border))";

/** Colour for a group row - its own catalogue colour, else a palette slot. */
export const colorForGroup = (group: SummaryGroup, index: number): string =>
  group.color ?? CHART_COLORS[index % CHART_COLORS.length];

const SECONDS_PER_HOUR = 3600;
const MAX_SLICES = 8;

// Recharts hands its own props to whatever it is given as `content`; these
// are the fields the custom tooltips actually read.
type TooltipItem = {
  dataKey?: string | number;
  name?: string | number;
  value?: number | string;
  color?: string;
  payload?: Record<string, unknown>;
};

type ChartTooltipProps = {
  active?: boolean;
  payload?: readonly TooltipItem[];
  label?: string | number;
  /** Injected by the caller through `React.cloneElement`. */
  formatDurationValue?: (seconds: number) => string;
  granularity?: TimelineGranularity;
  formatMoneyValue?: (amount: number) => string;
  /** Whether a click on the mark under the cursor narrows the report. */
  drillable?: boolean;
};

const readString = (
  source: Record<string, unknown> | undefined,
  key: string
): string => {
  const value = source?.[key];
  return typeof value === "string" ? value : "";
};

const readNumber = (
  source: Record<string, unknown> | undefined,
  key: string
): number => {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

const TooltipShell = ({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element => (
  <div
    role="status"
    aria-live="polite"
    className="rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
  >
    {children}
  </div>
);

/** The one line that tells a person the mark is a way down, not a picture. */
function DrillHint({ show }: { show: boolean }): React.JSX.Element | null {
  const t = useT("reports");
  if (!show) return null;
  return (
    <p className="mt-1 border-t border-border pt-1 text-[11px] text-muted-foreground">
      {t("drill.hint")}
    </p>
  );
}

const TooltipSwatch = ({ color }: { color: string }): React.JSX.Element => (
  <span
    aria-hidden="true"
    className="size-2.5 shrink-0 rounded-[2px]"
    style={{ backgroundColor: color }}
  />
);

/** Bucket tooltip: billable / non-billable split plus the bucket's total. */
function TimelineTooltip({
  active,
  payload,
  label,
  formatDurationValue,
  granularity = "day",
  drillable = false,
}: ChartTooltipProps): React.JSX.Element | null {
  const tc = useT("common");
  const f = useFormat();
  if (active !== true || payload === undefined || payload.length === 0) {
    return null;
  }
  const asDuration = formatDurationValue ?? f.durationShort;
  const point = payload[0]?.payload;
  const billable = readNumber(point, "billableSec");
  const nonBillable = readNumber(point, "nonBillableSec");
  const dayLabel = typeof label === "string" ? label : String(label ?? "");

  return (
    <TooltipShell>
      <p className="mb-1 font-medium">
        {formatBucketLabel(dayLabel, granularity, true, f.locale)}
      </p>
      <p className="flex items-center gap-2">
        <TooltipSwatch color={BILLABLE_COLOR} />
        <span className="text-muted-foreground">{tc("fields.billable")}</span>
        <span className="ml-auto tabular-nums">{asDuration(billable)}</span>
      </p>
      <p className="flex items-center gap-2">
        <TooltipSwatch color={NON_BILLABLE_COLOR} />
        <span className="text-muted-foreground">{tc("fields.nonBillable")}</span>
        <span className="ml-auto tabular-nums">{asDuration(nonBillable)}</span>
      </p>
      <p className="mt-1 flex items-center gap-2 border-t border-border pt-1 font-medium">
        <span>{tc("fields.total")}</span>
        <span className="ml-auto tabular-nums">
          {asDuration(billable + nonBillable)}
        </span>
      </p>
      <DrillHint show={drillable} />
    </TooltipShell>
  );
}

/** Slice tooltip: label, duration, share of total and earnings. */
function BreakdownTooltip({
  active,
  payload,
  formatDurationValue,
  formatMoneyValue,
  drillable = false,
}: ChartTooltipProps): React.JSX.Element | null {
  const t = useT("reports");
  const tc = useT("common");
  const f = useFormat();
  if (active !== true || payload === undefined || payload.length === 0) {
    return null;
  }
  const asDuration = formatDurationValue ?? f.durationShort;
  const asMoney = formatMoneyValue ?? ((amount: number) => f.number(amount));
  const slice = payload[0]?.payload;
  const seconds = readNumber(slice, "seconds");
  // Read raw rather than through `readNumber`, which would turn a withheld
  // `null` into a confident 0.
  const rawAmount = slice?.["amount"];
  const amountLabel =
    typeof rawAmount === "number" && Number.isFinite(rawAmount)
      ? asMoney(rawAmount)
      : MONEY_WITHHELD;
  const share = readNumber(slice, "share");

  return (
    <TooltipShell>
      <p className="mb-1 flex items-center gap-2 font-medium">
        <TooltipSwatch color={readString(slice, "fill")} />
        {readString(slice, "label")}
      </p>
      <p className="flex items-center gap-4">
        <span className="text-muted-foreground">{t("charts.tracked")}</span>
        <span className="ml-auto tabular-nums">
          {t("charts.durationWithShare", {
            duration: asDuration(seconds),
            share: formatShare(f, share),
          })}
        </span>
      </p>
      <p className="flex items-center gap-4">
        <span className="text-muted-foreground">{tc("fields.amount")}</span>
        <span className="ml-auto tabular-nums">{amountLabel}</span>
      </p>
      <p className="sr-only">
        {t("charts.sliceSummary", {
          label: readString(slice, "label"),
          duration: asDuration(seconds),
          amount: amountLabel,
        })}
      </p>
      <DrillHint show={drillable && isDrillableKey(readString(slice, "key"))} />
    </TooltipShell>
  );
}

/** A share of 0–100 as a percentage with one decimal: "12.5%" / "12,5 %". */
const formatShare = (f: ReturnType<typeof useFormat>, share: number): string =>
  f.number(share / 100, {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

export type TimelineChartProps = {
  timeline: SummaryTimelinePoint[];
  duration: (seconds: number) => string;
  weekStartsOn?: WeekStart;
  /**
   * Called with the bar somebody clicked — the way to narrow the report to
   * that day, week or month. Omitted, the bars are only a picture.
   */
  onSelectBucket?: (bucket: TimelineBucket, granularity: TimelineGranularity) => void;
};

/**
 * Stacked bars, billable at the bottom — one per day, rolled up to weeks or
 * months when the range is too long for daily bars to be readable.
 */
export function TimelineChart({
  timeline,
  duration,
  weekStartsOn = 1,
  onSelectBucket,
}: TimelineChartProps): React.JSX.Element {
  const t = useT("reports");
  const tc = useT("common");
  const f = useFormat();
  const { granularity, buckets: data } = React.useMemo(
    () => bucketTimeline(timeline, weekStartsOn),
    [timeline, weekStartsOn]
  );

  const hasTime = data.some(
    (point) => point.billableSec + point.nonBillableSec > 0
  );

  // Both stacked bars of a bucket share its index, which is the only thing
  // the handler needs: the bucket is read from the data the chart was drawn
  // from rather than from the shape recharts hands over.
  const selectBar = React.useCallback(
    (_: unknown, index: number): void => {
      const bucket = data[index];
      if (bucket !== undefined) onSelectBucket?.(bucket, granularity);
    },
    [data, granularity, onSelectBucket]
  );

  const formatHourTick = (seconds: number): string => {
    const hours = seconds / SECONDS_PER_HOUR;
    if (hours === 0) return f.number(0);
    return t("charts.hourTick", {
      hours: f.number(hours, {
        minimumFractionDigits: hours >= 10 ? 0 : 1,
        maximumFractionDigits: hours >= 10 ? 0 : 1,
      }),
    });
  };

  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm font-medium">
          <span>{t(`charts.timelineTitle.${granularity}`)}</span>
          <span className="flex items-center gap-3 text-xs font-normal text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <TooltipSwatch color={BILLABLE_COLOR} />
              {tc("fields.billable")}
            </span>
            <span className="flex items-center gap-1.5">
              <TooltipSwatch color={NON_BILLABLE_COLOR} />
              {tc("fields.nonBillable")}
            </span>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className={cn(
            "h-[280px] w-full",
            onSelectBucket && "[&_.recharts-bar-rectangle]:cursor-pointer"
          )}
          role="img"
          aria-label={t(`charts.timelineAria.${granularity}`, { count: data.length })}
          data-testid="timeline-chart"
          data-drillable={onSelectBucket ? "true" : undefined}
        >
          {hasTime ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data}
                margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                accessibilityLayer
              >
                <CartesianGrid
                  vertical={false}
                  stroke={GRID_COLOR}
                  strokeDasharray="3 3"
                />
                <XAxis
                  dataKey="date"
                  tickFormatter={(value: string) =>
                    formatBucketLabel(value, granularity, false, f.locale)
                  }
                  tick={{ fill: AXIS_COLOR, fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: GRID_COLOR }}
                  minTickGap={16}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tickFormatter={formatHourTick}
                  tick={{ fill: AXIS_COLOR, fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={44}
                />
                <Tooltip
                  cursor={{ fill: GRID_COLOR, fillOpacity: 0.35 }}
                  content={
                    <TimelineTooltip
                      formatDurationValue={duration}
                      granularity={granularity}
                      drillable={onSelectBucket !== undefined}
                    />
                  }
                />
                <Bar
                  dataKey="billableSec"
                  name={tc("fields.billable")}
                  stackId="time"
                  fill={BILLABLE_COLOR}
                  radius={[0, 0, 0, 0]}
                  onClick={selectBar}
                />
                <Bar
                  dataKey="nonBillableSec"
                  name={tc("fields.nonBillable")}
                  stackId="time"
                  fill={NON_BILLABLE_COLOR}
                  radius={[3, 3, 0, 0]}
                  onClick={selectBar}
                />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState
              icon={BarChart3}
              title={t("charts.timelineEmptyTitle")}
              description={t("charts.timelineEmptyDescription")}
              className="h-full"
              testId="timeline-chart-empty"
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

type Slice = {
  key: string;
  label: string;
  seconds: number;
  /** `null` when the report's money is withheld. */
  amount: number | null;
  share: number;
  fill: string;
};

export type GroupBreakdownChartProps = {
  groups: SummaryGroup[];
  totalSec: number;
  duration: (seconds: number) => string;
  money: (amount: number) => string;
  /** What the groups are, which names the heading. */
  groupBy: ReportGroupBy;
  /**
   * Called with the group somebody clicked, on the slice or on its legend
   * row — the way to narrow the report to it. Never called for the unassigned
   * bucket or the folded "n more" slice. Omitted, the donut is only a picture.
   */
  onSelectGroup?: (group: SummaryGroup) => void;
};

/** Donut of the grouped breakdown, with a readable legend beside it. */
export function GroupBreakdownChart({
  groups,
  totalSec,
  duration,
  money,
  groupBy,
  onSelectGroup,
}: GroupBreakdownChartProps): React.JSX.Element {
  const t = useT("reports");
  const f = useFormat();

  const selectSlice = React.useCallback(
    (key: string): void => {
      if (onSelectGroup === undefined || !isDrillableKey(key)) return;
      const group = groups.find((candidate) => candidate.key === key);
      if (group !== undefined) onSelectGroup(group);
    },
    [groups, onSelectGroup]
  );

  const slices = React.useMemo<Slice[]>(() => {
    const positive = groups.filter((group) => group.seconds > 0);
    const head = positive.slice(0, MAX_SLICES);
    const tail = positive.slice(MAX_SLICES);
    const total = totalSec > 0 ? totalSec : 1;

    const mapped: Slice[] = head.map((group, index) => ({
      key: group.key,
      label: group.label,
      seconds: group.seconds,
      amount: group.amount,
      share: (group.seconds / total) * 100,
      fill: colorForGroup(group, index),
    }));

    if (tail.length > 0) {
      const seconds = tail.reduce((sum, group) => sum + group.seconds, 0);
      mapped.push({
        key: "__other",
        label: t("charts.more", { count: tail.length }),
        seconds,
        amount: sumReportMoney(tail.map((group) => group.amount)),
        share: (seconds / total) * 100,
        fill: "hsl(var(--muted-foreground))",
      });
    }

    return mapped;
  }, [groups, totalSec, t]);

  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          {t("groupBy.breakdownTitle", { groupBy })}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className={cn(
            "h-[280px] w-full",
            onSelectGroup && "[&_.recharts-sector]:cursor-pointer"
          )}
          role="img"
          aria-label={t("groupBy.breakdownAria", { groupBy })}
          data-testid="breakdown-chart"
          data-drillable={onSelectGroup ? "true" : undefined}
        >
          {slices.length > 0 ? (
            <div className="flex h-full flex-col items-center gap-4 sm:flex-row">
              <div className="h-[180px] w-full sm:h-full sm:w-1/2">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Tooltip
                      content={
                        <BreakdownTooltip
                          formatDurationValue={duration}
                          formatMoneyValue={money}
                          drillable={onSelectGroup !== undefined}
                        />
                      }
                    />
                    <Pie
                      data={slices}
                      dataKey="seconds"
                      nameKey="label"
                      innerRadius="58%"
                      outerRadius="86%"
                      paddingAngle={1}
                      stroke="hsl(var(--background))"
                      strokeWidth={2}
                      isAnimationActive={false}
                      onClick={(_, index) => selectSlice(slices[index]?.key ?? "")}
                    >
                      {slices.map((slice) => (
                        <Cell key={slice.key} fill={slice.fill} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <ul className="w-full space-y-1.5 overflow-y-auto text-xs sm:h-full sm:w-1/2">
                {slices.map((slice) => {
                  const drillable =
                    onSelectGroup !== undefined && isDrillableKey(slice.key);
                  const row = (
                    <>
                      <TooltipSwatch color={slice.fill} />
                      <span className="min-w-0 flex-1 truncate">
                        {slice.label}
                      </span>
                      <span className="tabular-nums text-muted-foreground">
                        {f.percent(slice.share / 100)}
                      </span>
                      <span className="w-16 text-right tabular-nums">
                        {duration(slice.seconds)}
                      </span>
                    </>
                  );
                  return (
                    <li key={slice.key} data-testid={`breakdown-legend-${slice.key}`}>
                      {/* The legend row is the keyboard's way onto a slice:
                          a sector of an SVG cannot take focus. */}
                      {drillable ? (
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          title={t("drill.narrowTo", { name: slice.label })}
                          onClick={() => selectSlice(slice.key)}
                          data-testid={`breakdown-drill-${slice.key}`}
                        >
                          {row}
                        </button>
                      ) : (
                        <span className="flex items-center gap-2 px-1 py-0.5">
                          {row}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <EmptyState
              icon={PieChartIcon}
              title={t("charts.breakdownEmptyTitle")}
              description={t("charts.breakdownEmptyDescription")}
              className="h-full"
              testId="breakdown-chart-empty"
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
