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
  SummaryGroup,
  SummaryTimelinePoint,
  WeekStart,
} from "@starter/shared";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import {
  bucketTimeline,
  formatBucketLabel,
  type TimelineGranularity,
} from "@/components/reports/timeline-buckets";

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
}: ChartTooltipProps): React.JSX.Element | null {
  if (active !== true || payload === undefined || payload.length === 0) {
    return null;
  }
  const asDuration = formatDurationValue ?? ((seconds: number) => `${seconds}s`);
  const point = payload[0]?.payload;
  const billable = readNumber(point, "billableSec");
  const nonBillable = readNumber(point, "nonBillableSec");
  const dayLabel = typeof label === "string" ? label : String(label ?? "");

  return (
    <TooltipShell>
      <p className="mb-1 font-medium">
        {formatBucketLabel(dayLabel, granularity, true)}
      </p>
      <p className="flex items-center gap-2">
        <TooltipSwatch color={BILLABLE_COLOR} />
        <span className="text-muted-foreground">Billable</span>
        <span className="ml-auto tabular-nums">{asDuration(billable)}</span>
      </p>
      <p className="flex items-center gap-2">
        <TooltipSwatch color={NON_BILLABLE_COLOR} />
        <span className="text-muted-foreground">Non-billable</span>
        <span className="ml-auto tabular-nums">{asDuration(nonBillable)}</span>
      </p>
      <p className="mt-1 flex items-center gap-2 border-t border-border pt-1 font-medium">
        <span>Total</span>
        <span className="ml-auto tabular-nums">
          {asDuration(billable + nonBillable)}
        </span>
      </p>
    </TooltipShell>
  );
}

/** Slice tooltip: label, duration, share of total and earnings. */
function BreakdownTooltip({
  active,
  payload,
  formatDurationValue,
  formatMoneyValue,
}: ChartTooltipProps): React.JSX.Element | null {
  if (active !== true || payload === undefined || payload.length === 0) {
    return null;
  }
  const asDuration = formatDurationValue ?? ((seconds: number) => `${seconds}s`);
  const asMoney = formatMoneyValue ?? ((amount: number) => String(amount));
  const slice = payload[0]?.payload;
  const seconds = readNumber(slice, "seconds");
  const amount = readNumber(slice, "amount");
  const share = readNumber(slice, "share");

  return (
    <TooltipShell>
      <p className="mb-1 flex items-center gap-2 font-medium">
        <TooltipSwatch color={readString(slice, "fill")} />
        {readString(slice, "label")}
      </p>
      <p className="flex items-center gap-4">
        <span className="text-muted-foreground">Tracked</span>
        <span className="ml-auto tabular-nums">
          {asDuration(seconds)} ({share.toFixed(1)}%)
        </span>
      </p>
      <p className="flex items-center gap-4">
        <span className="text-muted-foreground">Amount</span>
        <span className="ml-auto tabular-nums">{asMoney(amount)}</span>
      </p>
      <p className="sr-only">
        {readString(slice, "label")}: {asDuration(seconds)}, {asMoney(amount)}
      </p>
    </TooltipShell>
  );
}

const formatHourTick = (seconds: number): string => {
  const hours = seconds / SECONDS_PER_HOUR;
  if (hours === 0) return "0";
  return hours >= 10 ? `${Math.round(hours)}h` : `${hours.toFixed(1)}h`;
};

export type TimelineChartProps = {
  timeline: SummaryTimelinePoint[];
  duration: (seconds: number) => string;
  weekStartsOn?: WeekStart;
};

const TIMELINE_TITLE: Record<TimelineGranularity, string> = {
  day: "Daily activity",
  week: "Weekly activity",
  month: "Monthly activity",
};

const TIMELINE_UNIT: Record<TimelineGranularity, string> = {
  day: "days",
  week: "weeks",
  month: "months",
};

/**
 * Stacked bars, billable at the bottom — one per day, rolled up to weeks or
 * months when the range is too long for daily bars to be readable.
 */
export function TimelineChart({
  timeline,
  duration,
  weekStartsOn = 1,
}: TimelineChartProps): React.JSX.Element {
  const { granularity, buckets: data } = React.useMemo(
    () => bucketTimeline(timeline, weekStartsOn),
    [timeline, weekStartsOn]
  );

  const hasTime = data.some(
    (point) => point.billableSec + point.nonBillableSec > 0
  );

  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm font-medium">
          <span>{TIMELINE_TITLE[granularity]}</span>
          <span className="flex items-center gap-3 text-xs font-normal text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <TooltipSwatch color={BILLABLE_COLOR} />
              Billable
            </span>
            <span className="flex items-center gap-1.5">
              <TooltipSwatch color={NON_BILLABLE_COLOR} />
              Non-billable
            </span>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className="h-[280px] w-full"
          role="img"
          aria-label={`Tracked time across ${data.length} ${TIMELINE_UNIT[granularity]}`}
          data-testid="timeline-chart"
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
                    formatBucketLabel(value, granularity)
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
                    />
                  }
                />
                <Bar
                  dataKey="billableSec"
                  name="Billable"
                  stackId="time"
                  fill={BILLABLE_COLOR}
                  radius={[0, 0, 0, 0]}
                />
                <Bar
                  dataKey="nonBillableSec"
                  name="Non-billable"
                  stackId="time"
                  fill={NON_BILLABLE_COLOR}
                  radius={[3, 3, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState
              icon={BarChart3}
              title="No time in this range"
              description="Track some time or widen the date range to see the breakdown over time."
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
  amount: number;
  share: number;
  fill: string;
};

export type GroupBreakdownChartProps = {
  groups: SummaryGroup[];
  totalSec: number;
  duration: (seconds: number) => string;
  money: (amount: number) => string;
  /** Heading noun, e.g. "project" - already lower-case. */
  dimension: string;
};

/** Donut of the grouped breakdown, with a readable legend beside it. */
export function GroupBreakdownChart({
  groups,
  totalSec,
  duration,
  money,
  dimension,
}: GroupBreakdownChartProps): React.JSX.Element {
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
        label: `${tail.length} more`,
        seconds,
        amount: tail.reduce((sum, group) => sum + group.amount, 0),
        share: (seconds / total) * 100,
        fill: "hsl(var(--muted-foreground))",
      });
    }

    return mapped;
  }, [groups, totalSec]);

  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          Breakdown by {dimension}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className="h-[280px] w-full"
          role="img"
          aria-label={`Share of tracked time by ${dimension}`}
          data-testid="breakdown-chart"
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
                    >
                      {slices.map((slice) => (
                        <Cell key={slice.key} fill={slice.fill} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <ul className="w-full space-y-1.5 overflow-y-auto text-xs sm:h-full sm:w-1/2">
                {slices.map((slice) => (
                  <li
                    key={slice.key}
                    className="flex items-center gap-2"
                    data-testid={`breakdown-legend-${slice.key}`}
                  >
                    <TooltipSwatch color={slice.fill} />
                    <span className="min-w-0 flex-1 truncate">
                      {slice.label}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {slice.share.toFixed(0)}%
                    </span>
                    <span className="w-16 text-right tabular-nums">
                      {duration(slice.seconds)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <EmptyState
              icon={PieChartIcon}
              title="Nothing to break down"
              description="No tracked time matches the current filters."
              className="h-full"
              testId="breakdown-chart-empty"
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
