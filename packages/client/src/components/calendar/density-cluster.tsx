"use client";

import * as React from "react";
import type { DetailedEntry } from "@starter/shared";

import { PopoverContent } from "@/components/ui/popover";
import { useT } from "@/i18n/use-t";
import { useFormatSettings } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CLUSTER_MIN_PX, formatMinuteOfDay } from "./calendar-math";
import { blockPalette } from "./entry-color";

/** One of the short entries a chip stands in for. */
export type ClusterMember = {
  id: string;
  entry: DetailedEntry;
  startMin: number;
  endMin: number;
};

export type DensityClusterProps = {
  members: ClusterMember[];
  /** Minute span the chip covers — the union of its members. */
  startMin: number;
  endMin: number;
  /** Pixel geometry inside the day column. */
  top: number;
  height: number;
  leftPct: number;
  widthPct: number;
  zIndex?: number;
  stacked?: boolean;
  isOpen: boolean;
  onOpen: () => void;
  /**
   * The primary pointer is a finger, so the chip has to let the browser pan
   * the grid vertically through it rather than swallowing the scroll.
   */
  coarsePointer?: boolean;
} & Omit<React.ComponentPropsWithoutRef<"div">, "onPointerDown" | "children">;

/** Below this width the chip drops everything but the count. */
const NARROW_PX_PCT = 34;

/**
 * The stand-in for a burst of entries too short to draw as blocks.
 *
 * Rather than a plain "+7 more", the chip keeps the shape of what it hides:
 * every member is a tick at its own offset inside the span, in its project's
 * colour. A dozen two-minute switches therefore look like a dozen switches —
 * dense, striped, obviously fragmented — instead of a smear of slivers.
 */
export const DensityCluster = React.forwardRef<
  HTMLDivElement,
  DensityClusterProps
>(function DensityCluster(
  {
    members,
    startMin,
    endMin,
    top,
    height,
    leftPct,
    widthPct,
    zIndex = 0,
    stacked = false,
    isOpen,
    onOpen,
    coarsePointer = false,
    className,
    style,
    ...rest
  },
  ref
) {
  const format = useFormatSettings();
  const t = useT("calendar");
  const drawnHeight = Math.max(height, CLUSTER_MIN_PX);
  const span = Math.max(1, endMin - startMin);
  const totalSec = members.reduce(
    (sum, member) => sum + Math.max(0, member.endMin - member.startMin) * 60,
    0
  );
  const timeLabel = `${formatMinuteOfDay(startMin, format.timeFormat)} – ${formatMinuteOfDay(
    endMin,
    format.timeFormat
  )}`;
  const narrow = widthPct < NARROW_PX_PCT;

  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      aria-label={t("cluster.ariaLabel", {
        count: members.length,
        time: timeLabel,
      })}
      title={t("cluster.title", {
        count: members.length,
        time: timeLabel,
        duration: format.duration(totalSec),
      })}
      data-testid="calendar-density-cluster"
      data-cluster-size={members.length}
      className={cn(
        "border-border bg-muted/70 group absolute overflow-hidden rounded-md",
        "border border-dashed select-none",
        "hover:bg-muted focus-visible:ring-ring cursor-pointer transition-colors",
        "focus-visible:ring-2 focus-visible:outline-none",
        stacked && "bg-background shadow-md",
        isOpen && "ring-ring/60 ring-2",
        className
      )}
      style={{
        top,
        height: drawnHeight,
        left: `calc(${leftPct}% + 2px)`,
        width: `calc(${widthPct}% - 4px)`,
        zIndex: isOpen ? 20 : zIndex,
        touchAction: coarsePointer ? "pan-y" : "none",
        ...style,
      }}
      onPointerDown={(event) => {
        // Never let the press fall through to the column's create-drag.
        event.stopPropagation();
      }}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      {...rest}
    >
      {/* A rail of ticks — one per hidden entry, at its own offset inside
          the span. The burst keeps its shape instead of becoming a number. */}
      <div className="pointer-events-none flex h-full items-stretch gap-1.5 px-1 py-[3px]">
        <div
          aria-hidden
          className="bg-background/70 relative w-8 shrink-0 overflow-hidden rounded-sm"
        >
          {members.map((member) => {
            const inner = drawnHeight - 6;
            const offset = ((member.startMin - startMin) / span) * inner;
            const tall = ((member.endMin - member.startMin) / span) * inner;
            return (
              <span
                key={member.id}
                className="absolute inset-x-0 rounded-[1px]"
                style={{
                  top: Math.max(0, Math.min(inner - 2, offset)),
                  height: Math.max(2, tall),
                  backgroundColor: blockPalette(member.entry.projectColor)
                    .accent,
                }}
              />
            );
          })}
        </div>

        <span className="text-muted-foreground flex min-w-0 flex-1 items-center gap-1 truncate text-[0.7rem] leading-tight">
          <span className="text-foreground font-semibold tabular-nums">
            {members.length}
          </span>
          {narrow ? null : (
            <span className="truncate">
              {t("cluster.chipSuffix", {
                count: members.length,
                duration: format.durationShort(totalSec),
              })}
            </span>
          )}
        </span>
      </div>
    </div>
  );
});

export type DensityClusterPopoverProps = {
  members: ClusterMember[];
  startMin: number;
  endMin: number;
  onSelect: (entryId: string) => void;
};

/** The expanded list behind a density chip: every entry it stands in for. */
export function DensityClusterPopover({
  members,
  startMin,
  endMin,
  onSelect,
}: DensityClusterPopoverProps): React.JSX.Element {
  const format = useFormatSettings();
  const t = useT("calendar");
  const tc = useT("common");
  const totalSec = members.reduce(
    (sum, member) => sum + Math.max(0, member.endMin - member.startMin) * 60,
    0
  );

  return (
    <PopoverContent
      align="start"
      side="bottom"
      sideOffset={8}
      collisionPadding={8}
      className="w-72 p-0"
      data-testid="calendar-cluster-popover"
    >
      <div className="border-border space-y-0.5 border-b px-3 py-2">
        <p className="text-sm font-semibold">
          {t("cluster.count", { count: members.length })}
        </p>
        <p className="text-muted-foreground text-xs tabular-nums">
          {formatMinuteOfDay(startMin, format.timeFormat)} –{" "}
          {formatMinuteOfDay(endMin, format.timeFormat)} ·{" "}
          {format.duration(totalSec)}
        </p>
      </div>
      <ul className="max-h-64 overflow-y-auto py-1">
        {members.map((member) => (
          <li key={member.id}>
            <button
              type="button"
              data-testid={`calendar-cluster-item-${member.entry.id}`}
              className="hover:bg-accent flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs"
              onClick={() => {
                onSelect(member.entry.id);
              }}
            >
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{
                  backgroundColor: blockPalette(member.entry.projectColor)
                    .accent,
                }}
              />
              <span className="text-muted-foreground shrink-0 tabular-nums">
                {formatMinuteOfDay(member.startMin, format.timeFormat)}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {member.entry.description || tc("empty.noDescription")}
              </span>
              <span className="text-muted-foreground shrink-0 tabular-nums">
                {format.durationShort(
                  Math.max(0, member.endMin - member.startMin) * 60
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </PopoverContent>
  );
}
