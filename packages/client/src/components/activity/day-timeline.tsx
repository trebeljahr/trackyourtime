"use client";

import * as React from "react";
import { Sparkles } from "lucide-react";

import { HOUR_MS, type TimelineWindow } from "@/components/activity/day-timeline-window";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";

export type TimelineEntry = {
  id: string;
  start: number;
  end: number;
  label: string;
  /** A project colour, or null for none. */
  color: string | null;
  autopilot: boolean;
};

export type TimelineGap = { start: number; end: number };

const percent = (value: number, window: TimelineWindow): number =>
  ((Math.min(Math.max(value, window.start), window.end) - window.start) / (window.end - window.start)) * 100;

/**
 * One day as a single strip: what is tracked in its project colours, what
 * Autopilot started marked with its spark, and what is not tracked yet as a
 * hatched outline you can click to reach its suggestion. Read-only; it is a
 * map, and the cards below are where things are done.
 */
export function DayTimeline({
  window: frame,
  entries,
  gaps,
  now,
  dayLabel,
  clock,
  onPickGap,
}: {
  window: TimelineWindow;
  entries: readonly TimelineEntry[];
  gaps: readonly TimelineGap[];
  /** Today only: where the "now" line goes. */
  now: number | null;
  dayLabel: string;
  clock: (ms: number) => string;
  onPickGap: (gap: TimelineGap) => void;
}): React.JSX.Element {
  const t = useT("activity");
  const span = frame.end - frame.start;
  if (!(span > 0)) return <div data-testid="activity-timeline" />;
  const step = span > 12 * HOUR_MS ? 3 : span > 6 * HOUR_MS ? 2 : 1;

  return (
    <figure className="space-y-2" data-testid="activity-timeline" aria-label={t("autopilot.timeline.label", { day: dayLabel })}>
      <div className="relative h-10 overflow-hidden rounded-md border border-border bg-muted/30">
        {frame.ticks.map((tick) => (
          <span
            key={tick}
            className="absolute inset-y-0 w-px bg-border/70"
            style={{ left: `${percent(tick, frame)}%` }}
            aria-hidden
          />
        ))}

        {gaps.map((gap) => (
          <button
            key={`gap:${gap.start}`}
            type="button"
            className="absolute inset-y-1.5 rounded-sm border border-dashed border-brand/60 bg-brand/5 transition-colors hover:bg-brand/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{
              left: `${percent(gap.start, frame)}%`,
              width: `max(4px, ${percent(gap.end, frame) - percent(gap.start, frame)}%)`,
              backgroundImage:
                "repeating-linear-gradient(135deg, transparent 0 5px, hsl(var(--brand) / .12) 5px 7px)",
            }}
            title={t("autopilot.timeline.gap", { from: clock(gap.start), to: clock(gap.end) })}
            aria-label={t("autopilot.timeline.gap", { from: clock(gap.start), to: clock(gap.end) })}
            onClick={() => onPickGap(gap)}
            data-testid="activity-timeline-gap"
            data-start={gap.start}
          />
        ))}

        {entries.map((entry) => (
          <span
            key={entry.id}
            role="img"
            className={cn(
              "absolute inset-y-1.5 flex items-center justify-center overflow-hidden rounded-sm",
              entry.autopilot && "ring-2 ring-brand/70 ring-offset-1 ring-offset-background",
            )}
            style={{
              left: `${percent(entry.start, frame)}%`,
              width: `max(3px, ${percent(entry.end, frame) - percent(entry.start, frame)}%)`,
              backgroundColor: entry.color ?? "hsl(var(--muted-foreground) / .45)",
            }}
            title={t("autopilot.timeline.entry", { label: entry.label, from: clock(entry.start), to: clock(entry.end) })}
            aria-label={t("autopilot.timeline.entry", { label: entry.label, from: clock(entry.start), to: clock(entry.end) })}
            data-testid="activity-timeline-entry"
            data-autopilot={entry.autopilot ? "true" : "false"}
          >
            {entry.autopilot ? <Sparkles className="size-3 shrink-0 text-white drop-shadow" aria-hidden /> : null}
          </span>
        ))}

        {now !== null && now > frame.start && now < frame.end ? (
          <span
            className="absolute inset-y-0 w-0.5 bg-brand"
            style={{ left: `${percent(now, frame)}%` }}
            title={t("autopilot.timeline.now")}
            aria-hidden
          />
        ) : null}
      </div>

      <div className="relative h-4 text-[11px] tabular-nums text-muted-foreground" aria-hidden>
        {frame.ticks
          .filter((_, index) => index % step === 0)
          .map((tick) => (
            <span key={tick} className="absolute -translate-x-1/2" style={{ left: `${percent(tick, frame)}%` }}>
              {clock(tick)}
            </span>
          ))}
      </div>

      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-muted-foreground/45" aria-hidden />
          {t("autopilot.timeline.tracked")}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-muted-foreground/45 ring-2 ring-brand/70 ring-offset-1 ring-offset-background" aria-hidden />
          {t("autopilot.timeline.autopilot")}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm border border-dashed border-brand/60 bg-brand/5" aria-hidden />
          {t("autopilot.timeline.untracked")}
        </span>
      </figcaption>
    </figure>
  );
}
