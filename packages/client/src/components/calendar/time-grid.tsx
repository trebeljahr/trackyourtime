"use client";

import * as React from "react";
import { addDays, isSameDay, startOfDay } from "date-fns";
import type { DetailedEntry } from "@starter/shared";

import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverAnchor } from "@/components/ui/popover";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import { useFormatSettings } from "@/lib/format";
import { cn } from "@/lib/utils";
import { toDateKey } from "@/components/date-range-picker";
import {
  CLUSTER_MIN_PX,
  DRAG_THRESHOLD_PX,
  MINUTES_PER_DAY,
  blockGeometry,
  clusterMicroBlocks,
  daySegment,
  expandVisibleRange,
  formatMinuteOfDay,
  gridTicks,
  isoAtMinute,
  layoutBlocks,
  minutesFromOffset,
  moveRange,
  offsetFromMinutes,
  rangeFromDrag,
  resizeRange,
  type LaidOut,
  type MinuteRange,
  type ResizeEdge,
  type VisibleRange,
} from "./calendar-math";
import { EntryBlock, type BlockDragMode } from "./entry-block";
import { EntryEditPopover } from "./entry-edit-popover";
import { DensityCluster, DensityClusterPopover } from "./density-cluster";
import { blockPalette } from "./entry-color";
import type { CreateDraft } from "./entry-create-dialog";
import type { CalendarActions } from "./use-calendar-entries";
import { useCoarsePointer } from "./use-coarse-pointer";
import { useNow } from "./use-now";

type Segment = MinuteRange & {
  id: string;
  entry: DetailedEntry;
  continuesBefore: boolean;
  continuesAfter: boolean;
  isRunning: boolean;
  /** Running and midnight-spanning segments are read-only. */
  draggable: boolean;
};

/**
 * What the overlap layout positions: either one entry, or one chip standing
 * in for a burst of entries too short to draw at the current zoom.
 */
type GridItem = MinuteRange & {
  id: string;
} & (
    | { kind: "entry"; segment: Segment }
    | {
        kind: "cluster";
        /**
         * The members' true span — the item's own `startMin`/`endMin` are
         * padded out to the chip's drawn height. Not called `span`: the
         * layout writes a column span of its own under that name.
         */
        trueRange: MinuteRange;
        members: Segment[];
      }
  );

type DayColumn = {
  day: Date;
  key: string;
  dayStartMs: number;
  dayEndMs: number;
  items: LaidOut<GridItem>[];
  totalSec: number;
};

type DragState =
  | {
      kind: "move";
      entryId: string;
      dayIndex: number;
      origin: MinuteRange;
      range: MinuteRange;
      pointerStartY: number;
      active: boolean;
    }
  | {
      kind: "resize";
      entryId: string;
      edge: ResizeEdge;
      dayIndex: number;
      origin: MinuteRange;
      range: MinuteRange;
      pointerStartY: number;
      active: boolean;
    }
  | {
      kind: "create";
      dayIndex: number;
      anchorMin: number;
      range: MinuteRange;
      active: boolean;
    };

export type TimeGridProps = {
  /** The consecutive local days to render, left to right. At least one. */
  days: Date[];
  entries: DetailedEntry[];
  isLoading: boolean;
  actions: CalendarActions;
  /** The user's configured window; widened when entries fall outside it. */
  preferredRange: VisibleRange;
  /** Vertical scale. 1 is the 60px-per-hour baseline. */
  pxPerMinute: number;
  /** Step the zoom ladder by `delta` levels, for ctrl/⌘ + wheel. */
  onZoomBy?: (delta: number) => void;
  onRequestCreate: (draft: CreateDraft) => void;
};

/**
 * The time grid behind the day and week views: an hour gutter, one column per
 * day and absolutely positioned entry blocks. All three gestures (move,
 * resize, create) run through one pointer-capture state machine, and every
 * commit goes through the optimistic `actions` so the block never snaps back
 * while the mutation is in flight.
 */
export function TimeGrid({
  days,
  entries,
  isLoading,
  actions,
  preferredRange,
  pxPerMinute,
  onZoomBy,
  onRequestCreate,
}: TimeGridProps): React.JSX.Element {
  const format = useFormatSettings();
  const f = useFormat();
  const t = useT("calendar");
  const hasRunning = entries.some((entry) => entry.end === null);
  const nowMs = useNow(hasRunning ? 1_000 : 30_000);

  // Computed once for the whole grid rather than per block: the flag is the
  // same for every one of them, and a MediaQueryList listener per entry would
  // scale with the day's density for no reason.
  const coarsePointer = useCoarsePointer();

  const gridRef = React.useRef<HTMLDivElement | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  /** The entry a finger last pressed — see `handleBlockPointerDown`. */
  const touchTapRef = React.useRef<string | null>(null);

  const [drag, setDrag] = React.useState<DragState | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [openClusterId, setOpenClusterId] = React.useState<string | null>(null);

  const columns = React.useMemo<DayColumn[]>(() => {
    return days.map((day) => {
      const dayStartMs = startOfDay(day).getTime();
      const dayEndMs = startOfDay(addDays(day, 1)).getTime();
      const segments: Segment[] = [];
      let totalSec = 0;

      for (const entry of entries) {
        const startMs = Date.parse(entry.start);
        const isRunning = entry.end === null;
        const endMs = isRunning
          ? Math.max(nowMs, startMs)
          : Date.parse(entry.end ?? entry.start);
        const segment = daySegment(startMs, endMs, dayStartMs, dayEndMs);
        if (!segment) continue;

        totalSec += Math.max(0, segment.endMin - segment.startMin) * 60;
        segments.push({
          id: `${entry.id}:${toDateKey(day)}`,
          startMin: segment.startMin,
          endMin: segment.endMin,
          entry,
          continuesBefore: segment.continuesBefore,
          continuesAfter: segment.continuesAfter,
          isRunning,
          draggable:
            !isRunning && !segment.continuesBefore && !segment.continuesAfter,
        });
      }

      // A running entry is never folded away — it is the one block whose
      // shortness is temporary, and hiding the live timer reads as a bug.
      const { loose, clusters } = clusterMicroBlocks(
        segments.filter((segment) => !segment.isRunning),
        pxPerMinute
      );

      const items: GridItem[] = [
        ...loose,
        ...segments.filter((segment) => segment.isRunning),
      ].map((segment) => ({
        kind: "entry",
        id: segment.id,
        startMin: segment.startMin,
        endMin: segment.endMin,
        segment,
      }));

      for (const cluster of clusters) {
        // Lay the chip out at its drawn height, not its true span, so the
        // block below it gets its own column instead of being covered.
        const minSpan = pxPerMinute > 0 ? CLUSTER_MIN_PX / pxPerMinute : 0;
        items.push({
          kind: "cluster",
          id: cluster.id,
          startMin: cluster.startMin,
          endMin: Math.max(cluster.endMin, cluster.startMin + minSpan),
          trueRange: { startMin: cluster.startMin, endMin: cluster.endMin },
          members: cluster.members,
        });
      }

      return {
        day,
        key: toDateKey(day),
        dayStartMs,
        dayEndMs,
        items: layoutBlocks(items),
        totalSec,
      };
    });
  }, [days, entries, nowMs, pxPerMinute]);

  const visible = React.useMemo<VisibleRange>(
    () =>
      expandVisibleRange(
        preferredRange,
        columns.flatMap((column) => column.items)
      ),
    [columns, preferredRange]
  );
  const { startMin: visibleStart, endMin: visibleEnd } = visible;
  const height = (visibleEnd - visibleStart) * pxPerMinute;

  const { labelStepMin, minorStepMin } = React.useMemo(
    () => gridTicks(pxPerMinute),
    [pxPerMinute]
  );

  /** The labelled rules — thinned out as the grid shrinks. */
  const majorMinutes = React.useMemo<number[]>(() => {
    const out: number[] = [];
    const first = Math.ceil(visibleStart / labelStepMin) * labelStepMin;
    for (let minute = first; minute <= visibleEnd; minute += labelStepMin) {
      out.push(minute);
    }
    return out;
  }, [labelStepMin, visibleEnd, visibleStart]);

  /** Fainter unlabelled guides between them, when there is room. */
  const minorMinutes = React.useMemo<number[]>(() => {
    if (minorStepMin === null) return [];
    const out: number[] = [];
    const first = Math.ceil(visibleStart / minorStepMin) * minorStepMin;
    for (let minute = first; minute < visibleEnd; minute += minorStepMin) {
      if (minute <= visibleStart || minute % labelStepMin === 0) continue;
      out.push(minute);
    }
    return out;
  }, [labelStepMin, minorStepMin, visibleEnd, visibleStart]);

  // Auto-scroll to the first entry on screen (minus a little air).
  const rangeKey = days.map((day) => toDateKey(day)).join(",");
  const firstEntryMin = React.useMemo<number | null>(() => {
    let earliest: number | null = null;
    for (const column of columns) {
      for (const item of column.items) {
        if (earliest === null || item.startMin < earliest) {
          earliest = item.startMin;
        }
      }
    }
    return earliest;
  }, [columns]);

  React.useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const target = firstEntryMin ?? preferredRange.startMin;
    node.scrollTop = Math.max(
      0,
      offsetFromMinutes(target, pxPerMinute, visible) - 40
    );
    // Only re-aim when the visible days change, never on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey]);

  // ── zoom ───────────────────────────────────────────────────────────
  // Zooming keeps one minute pinned under the viewport centre (or under the
  // pointer, for ctrl+wheel), so the grid grows around what you were reading
  // instead of jumping to a different hour.
  const scrollTopRef = React.useRef(0);
  const prevPxRef = React.useRef(pxPerMinute);
  const zoomAnchorRef = React.useRef<{
    minute: number;
    viewportY: number;
  } | null>(null);

  React.useLayoutEffect(() => {
    const node = scrollRef.current;
    const prevPx = prevPxRef.current;
    const anchor = zoomAnchorRef.current;
    zoomAnchorRef.current = null;
    prevPxRef.current = pxPerMinute;
    if (!node || prevPx === pxPerMinute || prevPx <= 0) return;

    const viewportY = anchor?.viewportY ?? node.clientHeight / 2;
    const minute =
      anchor?.minute ?? visibleStart + (scrollTopRef.current + viewportY) / prevPx;
    node.scrollTop = Math.max(
      0,
      offsetFromMinutes(minute, pxPerMinute, visible) - viewportY
    );
  }, [pxPerMinute, visible, visibleStart]);

  React.useEffect(() => {
    const node = scrollRef.current;
    if (!node || !onZoomBy) return;
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const viewportY = event.clientY - node.getBoundingClientRect().top;
      zoomAnchorRef.current = {
        minute: visibleStart + (node.scrollTop + viewportY) / pxPerMinute,
        viewportY,
      };
      onZoomBy(event.deltaY < 0 ? 1 : -1);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      node.removeEventListener("wheel", onWheel);
    };
  }, [onZoomBy, pxPerMinute, visibleStart]);

  // Escape aborts an in-flight drag without committing anything.
  const dragging = drag !== null;
  React.useEffect(() => {
    if (!dragging) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setDrag(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [dragging]);

  const minuteAtClientY = (clientY: number): number => {
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) return visibleStart;
    return minutesFromOffset(clientY - rect.top, pxPerMinute, visible);
  };

  const capture = (event: React.PointerEvent<HTMLDivElement>): void => {
    gridRef.current?.setPointerCapture(event.pointerId);
  };

  const closePopovers = (): void => {
    setSelectedId(null);
    setOpenClusterId(null);
  };

  const handleBlockPointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
    mode: BlockDragMode,
    block: Segment,
    dayIndex: number
  ): void => {
    event.stopPropagation();
    // A finger never arms move or resize. With `touchAction: "pan-y"` the
    // browser owns the vertical pan, so the press that follows the finger is
    // a scroll far more often than an edit — and arming here would commit
    // that scroll as a real change to the entry. The tap that *was* a tap is
    // resolved from the click below instead.
    if (event.pointerType === "touch") {
      touchTapRef.current = block.entry.id;
      return;
    }
    // Any mouse or pen press clears a stale tap, so a drag with the mouse can
    // never end by also opening the editor through the click below.
    touchTapRef.current = null;
    if (event.button !== 0 && event.pointerType === "mouse") return;

    if (!block.draggable) {
      setSelectedId(block.entry.id);
      return;
    }

    const origin: MinuteRange = {
      startMin: block.startMin,
      endMin: block.endMin,
    };
    capture(event);
    setDrag(
      mode === "move"
        ? {
            kind: "move",
            entryId: block.entry.id,
            dayIndex,
            origin,
            range: origin,
            pointerStartY: event.clientY,
            active: false,
          }
        : {
            kind: "resize",
            entryId: block.entry.id,
            edge: mode === "resize-start" ? "start" : "end",
            dayIndex,
            origin,
            range: origin,
            pointerStartY: event.clientY,
            active: false,
          }
    );
  };

  const handleColumnPointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
    dayIndex: number
  ): void => {
    // Same reason as the block: a finger dragging across empty grid is the
    // page scrolling, and arming create-a-new-entry here is what turns every
    // stray drag into an invented time entry.
    if (event.pointerType === "touch") return;
    if (event.button !== 0 && event.pointerType === "mouse") return;
    // A popover is a React child of its block, so React bubbles its events
    // up to this column even though the DOM node lives in a portal. Without
    // this, every click inside the editor closed it and armed a create-drag.
    const target = event.target;
    if (!(target instanceof Node) || !gridRef.current?.contains(target)) return;
    closePopovers();
    const anchorMin = minuteAtClientY(event.clientY);
    capture(event);
    setDrag({
      kind: "create",
      dayIndex,
      anchorMin,
      range: rangeFromDrag(anchorMin, anchorMin),
      active: false,
    });
  };

  const handleGridPointerMove = (
    event: React.PointerEvent<HTMLDivElement>
  ): void => {
    if (!drag) return;
    const clientY = event.clientY;
    // Read the geometry once, outside the state updater, which must stay pure.
    const pointerMin = minuteAtClientY(clientY);

    setDrag((current) => {
      if (!current) return current;

      if (current.kind === "create") {
        const active =
          current.active ||
          Math.abs(pointerMin - current.anchorMin) * pxPerMinute >
            DRAG_THRESHOLD_PX;
        return {
          ...current,
          active,
          range: rangeFromDrag(current.anchorMin, pointerMin),
        };
      }

      const deltaPx = clientY - current.pointerStartY;
      const active = current.active || Math.abs(deltaPx) > DRAG_THRESHOLD_PX;
      if (!active) return current;

      const deltaMinutes = deltaPx / pxPerMinute;
      const range =
        current.kind === "move"
          ? moveRange(current.origin, deltaMinutes)
          : resizeRange(current.origin, current.edge, deltaMinutes);
      return { ...current, active, range };
    });
  };

  const commitDrag = (state: DragState): void => {
    const day = days[state.dayIndex];
    if (!day) return;

    if (state.kind === "create") {
      if (!state.active) return;
      onRequestCreate({
        start: isoAtMinute(day, state.range.startMin),
        end: isoAtMinute(day, state.range.endMin),
      });
      return;
    }

    if (!state.active) {
      // A press that never moved is a click — open the editor.
      setSelectedId(state.entryId);
      return;
    }

    if (
      state.range.startMin === state.origin.startMin &&
      state.range.endMin === state.origin.endMin
    ) {
      return;
    }

    if (state.kind === "move") {
      actions.update(state.entryId, {
        start: isoAtMinute(day, state.range.startMin),
        end: isoAtMinute(day, state.range.endMin),
      });
      return;
    }

    if (state.edge === "start") {
      actions.update(state.entryId, {
        start: isoAtMinute(day, state.range.startMin),
      });
      return;
    }
    actions.update(state.entryId, {
      end: isoAtMinute(day, state.range.endMin),
    });
  };

  const handleGridPointerUp = (
    event: React.PointerEvent<HTMLDivElement>
  ): void => {
    if (!drag) return;
    if (gridRef.current?.hasPointerCapture(event.pointerId)) {
      gridRef.current.releasePointerCapture(event.pointerId);
    }
    commitDrag(drag);
    setDrag(null);
  };

  const todayIndex = days.findIndex((day) => isSameDay(day, new Date(nowMs)));
  const nowMinute =
    todayIndex === -1
      ? null
      : (nowMs - startOfDay(new Date(nowMs)).getTime()) / 60_000;

  const isSingleDay = days.length === 1;
  const gridTemplate = `3.5rem repeat(${days.length}, minmax(0, 1fr))`;

  return (
    <div
      className="flex min-h-[26rem] flex-col"
      style={{ height: "calc(100dvh - 15rem)" }}
      data-testid={isSingleDay ? "calendar-day" : "calendar-week"}
      data-day-count={days.length}
    >
      {/* Column headers — weekday, date and the day's tracked total. */}
      <div
        className="border-border bg-background grid border-b"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        <div className="border-border border-r" />
        {columns.map((column, index) => {
          const isToday = index === todayIndex;
          return (
            <div
              key={column.key}
              data-testid={`calendar-day-header-${column.key}`}
              className={cn(
                "border-border flex flex-col items-center gap-0.5 border-r px-1 py-2 last:border-r-0",
                isToday && "bg-accent/40"
              )}
            >
              <span className="text-muted-foreground text-[0.7rem] tracking-wide uppercase">
                {f.date(column.day, {
                  weekday: isSingleDay ? "long" : "short",
                })}
              </span>
              <span
                className={cn(
                  "text-sm font-semibold tabular-nums",
                  isToday && "text-primary"
                )}
              >
                {isSingleDay
                  ? f.date(column.day, { day: "numeric", month: "long" })
                  : f.number(column.day.getDate())}
              </span>
              <span
                className="text-muted-foreground text-[0.7rem] tabular-nums"
                data-testid={`calendar-day-total-${column.key}`}
              >
                {column.totalSec > 0 ? format.durationShort(column.totalSec) : "–"}
              </span>
            </div>
          );
        })}
      </div>

      {/* Scrollable body. */}
      <div
        ref={scrollRef}
        className="relative flex-1 overflow-y-auto"
        onScroll={(event) => {
          scrollTopRef.current = event.currentTarget.scrollTop;
        }}
      >
        {isLoading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : (
          <div
            ref={gridRef}
            className="relative grid"
            style={{ gridTemplateColumns: gridTemplate, height }}
            onPointerMove={handleGridPointerMove}
            onPointerUp={handleGridPointerUp}
            onPointerCancel={() => {
              // The browser took the gesture over — the finger is panning,
              // not tapping.
              touchTapRef.current = null;
              setDrag(null);
            }}
          >
            {/* Hour gutter — sub-hour marks read as minutes of the hour above. */}
            <div className="border-border relative border-r">
              {majorMinutes.map((minute) => {
                const onHour = minute % 60 === 0;
                return (
                  <span
                    key={minute}
                    className={cn(
                      "absolute right-1 -translate-y-1/2 tabular-nums",
                      onHour
                        ? "text-muted-foreground text-[0.7rem]"
                        : "text-muted-foreground/60 text-[0.62rem]"
                    )}
                    style={{
                      top: offsetFromMinutes(minute, pxPerMinute, visible),
                    }}
                  >
                    {onHour
                      ? formatMinuteOfDay(minute, format.timeFormat)
                      : `:${String(minute % 60).padStart(2, "0")}`}
                  </span>
                );
              })}
            </div>

            {columns.map((column, dayIndex) => {
              const isToday = dayIndex === todayIndex;
              const createPreview =
                drag?.kind === "create" &&
                drag.dayIndex === dayIndex &&
                drag.active
                  ? drag.range
                  : null;

              return (
                <div
                  key={column.key}
                  data-testid={`calendar-day-column-${column.key}`}
                  className={cn(
                    "border-border relative border-r last:border-r-0",
                    isToday && "bg-accent/20"
                  )}
                  style={{ touchAction: coarsePointer ? "pan-y" : "none" }}
                  onPointerDown={(event) => {
                    handleColumnPointerDown(event, dayIndex);
                  }}
                >
                  {majorMinutes.map((minute) => (
                    <div
                      key={minute}
                      aria-hidden
                      className={cn(
                        "pointer-events-none absolute inset-x-0 border-t",
                        minute % 60 === 0
                          ? "border-border/70"
                          : "border-border/40"
                      )}
                      style={{
                        top: offsetFromMinutes(minute, pxPerMinute, visible),
                      }}
                    />
                  ))}
                  {minorMinutes.map((minute) => (
                    <div
                      key={minute}
                      aria-hidden
                      className="border-border/30 pointer-events-none absolute inset-x-0 border-t"
                      style={{
                        top: offsetFromMinutes(minute, pxPerMinute, visible),
                      }}
                    />
                  ))}

                  {column.items.map((item) => {
                    const geometry = blockGeometry(item);

                    if (item.kind === "cluster") {
                      const selected = item.members.find(
                        (member) => member.entry.id === selectedId
                      );
                      const listOpen = openClusterId === item.id;

                      return (
                        <Popover
                          key={item.id}
                          open={listOpen || selected !== undefined}
                          onOpenChange={(open) => {
                            if (!open) closePopovers();
                          }}
                        >
                          <PopoverAnchor asChild>
                            <DensityCluster
                              members={item.members}
                              startMin={item.trueRange.startMin}
                              endMin={item.trueRange.endMin}
                              top={offsetFromMinutes(
                                item.startMin,
                                pxPerMinute,
                                visible
                              )}
                              height={
                                (item.endMin - item.startMin) * pxPerMinute
                              }
                              leftPct={geometry.leftPct}
                              widthPct={geometry.widthPct}
                              zIndex={geometry.zIndex}
                              stacked={geometry.stacked}
                              isOpen={listOpen || selected !== undefined}
                              coarsePointer={coarsePointer}
                              onOpen={() => {
                                setSelectedId(null);
                                setOpenClusterId(item.id);
                              }}
                            />
                          </PopoverAnchor>
                          {selected ? (
                            <EntryEditPopover
                              entry={selected.entry}
                              actions={actions}
                              nowMs={nowMs}
                              onClose={() => {
                                // Step back to the list rather than closing
                                // outright — the other entries are still there.
                                setSelectedId(null);
                                setOpenClusterId(item.id);
                              }}
                            />
                          ) : listOpen ? (
                            <DensityClusterPopover
                              members={item.members}
                              startMin={item.trueRange.startMin}
                              endMin={item.trueRange.endMin}
                              onSelect={(entryId) => {
                                setOpenClusterId(null);
                                setSelectedId(entryId);
                              }}
                            />
                          ) : null}
                        </Popover>
                      );
                    }

                    const block = item.segment;
                    const dragged =
                      drag &&
                      drag.kind !== "create" &&
                      drag.active &&
                      drag.entryId === block.entry.id &&
                      drag.dayIndex === dayIndex
                        ? drag.range
                        : null;
                    const range = dragged ?? {
                      startMin: block.startMin,
                      endMin: block.endMin,
                    };
                    const seconds = Math.max(
                      0,
                      (range.endMin - range.startMin) * 60
                    );

                    return (
                      <Popover
                        key={item.id}
                        open={selectedId === block.entry.id}
                        onOpenChange={(open) => {
                          if (!open) closePopovers();
                        }}
                      >
                        <PopoverAnchor asChild>
                          <EntryBlock
                            entry={block.entry}
                            top={offsetFromMinutes(range.startMin, pxPerMinute, visible)}
                            height={
                              (range.endMin - range.startMin) * pxPerMinute
                            }
                            leftPct={geometry.leftPct}
                            widthPct={geometry.widthPct}
                            zIndex={geometry.zIndex}
                            stacked={geometry.stacked}
                            isRunning={block.isRunning}
                            isDragging={dragged !== null}
                            isSelected={selectedId === block.entry.id}
                            draggable={block.draggable}
                            continuesBefore={block.continuesBefore}
                            continuesAfter={block.continuesAfter}
                            timeLabel={`${formatMinuteOfDay(range.startMin, format.timeFormat)} – ${
                              block.isRunning
                                ? t("grid.now")
                                : formatMinuteOfDay(range.endMin, format.timeFormat)
                            }`}
                            durationLabel={format.duration(seconds)}
                            coarsePointer={coarsePointer}
                            onClick={() => {
                              // Only ever the tap that pointer-down declined.
                              // A finger that panned the grid fires no click
                              // at all, and a mouse never sets the ref — so
                              // the mouse and pen paths are untouched even on
                              // a touchscreen with a mouse attached.
                              if (touchTapRef.current !== block.entry.id) return;
                              touchTapRef.current = null;
                              setSelectedId(block.entry.id);
                            }}
                            onBlockPointerDown={(event, mode) => {
                              handleBlockPointerDown(
                                event,
                                mode,
                                block,
                                dayIndex
                              );
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                setSelectedId(block.entry.id);
                              }
                            }}
                          />
                        </PopoverAnchor>
                        {selectedId === block.entry.id ? (
                          <EntryEditPopover
                            entry={block.entry}
                            actions={actions}
                            nowMs={nowMs}
                            onClose={() => {
                              setSelectedId(null);
                            }}
                          />
                        ) : null}
                      </Popover>
                    );
                  })}

                  {createPreview ? (
                    <div
                      data-testid="calendar-create-preview"
                      className="border-primary/60 text-primary pointer-events-none absolute inset-x-1 rounded-md border-2 border-dashed px-2 py-1 text-xs tabular-nums"
                      style={{
                        top: offsetFromMinutes(
                          createPreview.startMin,
                          pxPerMinute,
                          visible
                        ),
                        height:
                          (createPreview.endMin - createPreview.startMin) *
                          pxPerMinute,
                        background: blockPalette(null).background,
                      }}
                    >
                      {formatMinuteOfDay(createPreview.startMin, format.timeFormat)}
                      {" – "}
                      {formatMinuteOfDay(createPreview.endMin, format.timeFormat)}
                    </div>
                  ) : null}

                  {isToday && nowMinute !== null ? (
                    <div
                      data-testid="calendar-now-line"
                      aria-hidden
                      className="pointer-events-none absolute inset-x-0 z-10 flex items-center"
                      style={{
                        top: offsetFromMinutes(
                          Math.min(nowMinute, MINUTES_PER_DAY),
                          pxPerMinute,
                          visible
                        ),
                      }}
                    >
                      <span className="bg-destructive -ml-1 size-2 rounded-full" />
                      <span className="bg-destructive h-px flex-1" />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
