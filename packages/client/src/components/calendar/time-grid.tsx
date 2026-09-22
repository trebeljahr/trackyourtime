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
  MIN_DURATION_MINUTES,
  SNAP_MINUTES,
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
  rangeFromClick,
  rangeFromDrag,
  resizeRange,
  type LaidOut,
  type MinuteRange,
  type ResizeEdge,
  type VisibleRange,
} from "./calendar-math";
import { DraftBlock } from "./draft-block";
import { EntryBlock, type BlockDragMode } from "./entry-block";
import { EntryCreatePopover } from "./entry-create-popover";
import { EntryEditPopover } from "./entry-edit-popover";
import { DensityCluster, DensityClusterPopover } from "./density-cluster";
import { blockPalette } from "./entry-color";
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

/**
 * The entry being created: a block on the grid that is not saved yet. Its
 * edges and body drag like a saved block's, through the same state machine,
 * under this id in place of an entry id.
 */
const DRAFT_ID = "__draft__";

type Draft = {
  dayIndex: number;
  range: MinuteRange;
};

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
      /**
       * The shortest block the drag proposes. A mouse drag can be as short
       * as the snap allows; a long press proposes a real block first and the
       * finger stretches it from there.
       */
      minDuration: number;
    };

/**
 * A finger resting on the grid. Until `LONG_PRESS_MS` passes it is a
 * scroll, a swipe or a tap, and the browser owns it; after that the grid
 * takes it over as the gesture `arm` names.
 */
type TouchPress = {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  timer: ReturnType<typeof setTimeout> | null;
  arm:
    | { kind: "block"; block: Segment; mode: BlockDragMode; dayIndex: number }
    | { kind: "draft"; mode: BlockDragMode }
    | { kind: "column"; dayIndex: number }
    | null;
  /** The long press fired and the grid owns the finger from here. */
  armed: boolean;
};

type Point = { x: number; y: number };

/**
 * Air above the first and below the last gutter label. Each label is centred
 * on its rule, so the first one hangs half a line above the grid — which the
 * scroll box clips, because nothing scrolls to a negative offset.
 */
const GRID_PAD_PX = 12;
/** A finger held still this long arms a gesture instead of scrolling. */
export const LONG_PRESS_MS = 400;
/** Travel before the hold fires means the finger is panning or swiping. */
const TOUCH_SLOP_PX = 10;
/** Horizontal travel that steps the calendar to the previous or next range. */
const SWIPE_MIN_PX = 56;
/** What a long press on empty grid proposes before the finger stretches it. */
export const TOUCH_CREATE_MINUTES = 30;
/** How far two fingers move apart, or together, per zoom level. */
const PINCH_STEP_RATIO = 1.25;
/** A drag this close to the scroll box's edge scrolls it, faster nearer the edge. */
const EDGE_SCROLL_PX = 40;
const EDGE_SCROLL_MAX_PX_PER_FRAME = 14;

const distance = (a: Point, b: Point): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

/** A short tick where the platform offers one; iOS Safari offers none. */
const buzz = (): void => {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.vibrate !== "function"
  ) {
    return;
  }
  try {
    navigator.vibrate(10);
  } catch {
    // Some browsers refuse without a user activation; the gesture works anyway.
  }
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
  /** Step the zoom ladder by `delta` levels, for ctrl/⌘ + wheel and pinch. */
  onZoomBy?: (delta: number) => void;
  /** A horizontal finger swipe: `1` for the next range, `-1` for the previous. */
  onSwipe?: (direction: -1 | 1) => void;
};

/**
 * The time grid behind the day and week views: an hour gutter, one column per
 * day and absolutely positioned entry blocks. All three gestures (move,
 * resize, create) run through one pointer-capture state machine, and every
 * commit goes through the optimistic `actions` so the block never snaps back
 * while the mutation is in flight.
 *
 * Creating works the way a calendar app does it: a click on empty grid puts
 * a draft block down (an hour from the slot clicked, see `rangeFromClick`), a
 * drag puts one down over the dragged span, and the draft's edges and body
 * then drag like a saved block's while the popover anchored to it takes the
 * rest of the entry. Nothing is written until its Create button.
 *
 * A mouse or pen arms a gesture on the press. A finger never does: the
 * browser owns it as a scroll until it has rested for `LONG_PRESS_MS`, after
 * which the grid takes it over — a long press on empty grid proposes an
 * entry the finger stretches, on a block (or the draft) moves it, on its edge
 * resizes it — and a non-passive `touchmove` listener keeps the browser from
 * scrolling underneath. A tap on empty grid still puts an hour's draft down.
 * A finger that travels sideways instead steps to the next or previous
 * range, and two fingers pinch the zoom ladder around their midpoint.
 */
export function TimeGrid({
  days,
  entries,
  isLoading,
  actions,
  preferredRange,
  pxPerMinute,
  onZoomBy,
  onSwipe,
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
  /** The empty column a finger last pressed — see `handleColumnPointerDown`. */
  const touchColumnTapRef = React.useRef<number | null>(null);
  const draftRef = React.useRef<HTMLDivElement | null>(null);
  /** The finger resting on the grid, if any. */
  const touchPressRef = React.useRef<TouchPress | null>(null);
  /** Every finger on the grid, for the pinch. */
  const touchPointsRef = React.useRef<Map<number, Point>>(new Map());
  /** The finger spread the last zoom step was measured against. */
  const pinchBaseRef = React.useRef<number | null>(null);
  /** Where the dragging pointer last was, for the edge auto-scroll. */
  const lastPointerYRef = React.useRef<number | null>(null);

  const [drag, setDrag] = React.useState<DragState | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [openClusterId, setOpenClusterId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);

  // A new set of days is a new grid; a draft on the old one has no column.
  const rangeKey = days.map((day) => toDateKey(day)).join(",");
  const [draftRangeKey, setDraftRangeKey] = React.useState(rangeKey);
  if (draftRangeKey !== rangeKey) {
    setDraftRangeKey(rangeKey);
    setDraft(null);
  }

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

  // The draft counts too: an hour proposed at the bottom of the window must
  // not run off the grid it was clicked on.
  const draftRange = draft?.range ?? null;
  const visible = React.useMemo<VisibleRange>(
    () =>
      expandVisibleRange(preferredRange, [
        ...columns.flatMap((column) => column.items),
        ...(draftRange ? [draftRange] : []),
      ]),
    [columns, draftRange, preferredRange]
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
      GRID_PAD_PX + offsetFromMinutes(target, pxPerMinute, visible) - 40
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
      anchor?.minute ??
      visibleStart + (scrollTopRef.current + viewportY - GRID_PAD_PX) / prevPx;
    node.scrollTop = Math.max(
      0,
      GRID_PAD_PX + offsetFromMinutes(minute, pxPerMinute, visible) - viewportY
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
        minute:
          visibleStart + (node.scrollTop + viewportY - GRID_PAD_PX) / pxPerMinute,
        viewportY,
      };
      onZoomBy(event.deltaY < 0 ? 1 : -1);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      node.removeEventListener("wheel", onWheel);
    };
  }, [onZoomBy, pxPerMinute, visibleStart]);

  // The browser decides at the first touch whether a finger scrolls, from
  // `touch-action` — which cannot change mid-gesture. What can still stop the
  // scroll is `preventDefault` on a cancelable `touchmove`, and a move is
  // cancelable right up to the moment the browser commits to scrolling. A
  // finger that rested for the long press has not moved, so the first move
  // after the grid armed is still ours to refuse; and a second finger landing
  // makes the pair a pinch rather than a two-finger scroll. (A finger that
  // lands during a momentum fling is never cancelable; nothing can take that
  // one over, and its hold is simply cancelled with the pointer.)
  React.useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onTouchMove = (event: TouchEvent): void => {
      if (!event.cancelable) return;
      if (touchPressRef.current?.armed || event.touches.length > 1) {
        event.preventDefault();
      }
    };
    node.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      node.removeEventListener("touchmove", onTouchMove);
    };
  }, []);

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

  /**
   * The pointer's offset inside the grid, not the viewport. A drag's delta
   * has to be measured against the grid, because the edge auto-scroll moves
   * the grid under a pointer that has not moved at all.
   */
  const gridYAtClientY = (clientY: number): number =>
    clientY - (gridRef.current?.getBoundingClientRect().top ?? 0);

  const capture = (pointerId: number): void => {
    try {
      gridRef.current?.setPointerCapture(pointerId);
    } catch {
      // The pointer is already gone; the up or cancel that follows cleans up.
    }
  };

  const closePopovers = (): void => {
    setSelectedId(null);
    setOpenClusterId(null);
  };

  const anythingOpen =
    selectedId !== null || openClusterId !== null || draft !== null;

  const closeEverything = (): void => {
    closePopovers();
    setDraft(null);
  };

  const armBlockDrag = (
    pointer: { pointerId: number; clientY: number },
    mode: BlockDragMode,
    entryId: string,
    origin: MinuteRange,
    dayIndex: number,
    /** A long press is already past the threshold; a mouse press is not. */
    active = false
  ): void => {
    capture(pointer.pointerId);
    lastPointerYRef.current = pointer.clientY;
    const pointerStartY = gridYAtClientY(pointer.clientY);
    setDrag(
      mode === "move"
        ? {
            kind: "move",
            entryId,
            dayIndex,
            origin,
            range: origin,
            pointerStartY,
            active,
          }
        : {
            kind: "resize",
            entryId,
            edge: mode === "resize-start" ? "start" : "end",
            dayIndex,
            origin,
            range: origin,
            pointerStartY,
            active,
          }
    );
  };

  const clearTouchPress = (): void => {
    const press = touchPressRef.current;
    if (press?.timer !== null && press?.timer !== undefined) {
      clearTimeout(press.timer);
    }
    touchPressRef.current = null;
  };

  /** The long press fired: the grid takes the finger over from the browser. */
  const armTouchPress = (pointerId: number): void => {
    const press = touchPressRef.current;
    if (!press || press.pointerId !== pointerId || press.armed || !press.arm) {
      return;
    }
    // Two fingers are a pinch, whatever the first one was resting on.
    if (touchPointsRef.current.size > 1) return;
    press.timer = null;
    press.armed = true;
    // A long press is not a tap: the click the browser fires on release
    // must not open the editor over a block that was just moved, nor put a
    // draft down under one that was just proposed.
    touchTapRef.current = null;
    touchColumnTapRef.current = null;
    buzz();
    const pointer = { pointerId, clientY: press.lastY };

    if (press.arm.kind === "column") {
      capture(pointerId);
      lastPointerYRef.current = press.lastY;
      const anchorMin = minuteAtClientY(press.lastY);
      setDrag({
        kind: "create",
        dayIndex: press.arm.dayIndex,
        anchorMin,
        range: rangeFromDrag(
          anchorMin,
          anchorMin,
          SNAP_MINUTES,
          TOUCH_CREATE_MINUTES
        ),
        active: true,
        minDuration: TOUCH_CREATE_MINUTES,
      });
      return;
    }

    if (press.arm.kind === "draft") {
      if (!draft) return;
      armBlockDrag(pointer, press.arm.mode, DRAFT_ID, draft.range, draft.dayIndex, true);
      return;
    }

    const { block, mode, dayIndex } = press.arm;
    // Holding a saved block while a draft is open walks away from the draft.
    setDraft(null);
    armBlockDrag(
      pointer,
      mode,
      block.entry.id,
      { startMin: block.startMin, endMin: block.endMin },
      dayIndex,
      true
    );
  };

  // The timer fires against whatever the grid holds *then* — the geometry,
  // the draft — not the render the finger landed in.
  const armTouchPressRef = React.useRef(armTouchPress);
  React.useLayoutEffect(() => {
    armTouchPressRef.current = armTouchPress;
  });

  const beginTouchPress = (
    event: React.PointerEvent<HTMLDivElement>,
    arm: TouchPress["arm"]
  ): void => {
    clearTouchPress();
    // A second finger is the other half of a pinch, never a press of its
    // own — the capture-phase tracker has already dropped the first one's.
    // Without this its release, after the fingers spread, reads as a swipe.
    if (touchPointsRef.current.size > 1) return;
    const pointerId = event.pointerId;
    touchPressRef.current = {
      pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      timer:
        arm === null
          ? null
          : setTimeout(() => {
              armTouchPressRef.current(pointerId);
            }, LONG_PRESS_MS),
      arm,
      armed: false,
    };
  };

  /**
   * Runs in the capture phase, so it sees the press on a block too — that
   * handler stops propagation, as it must, so the column under the block
   * does not also arm a create.
   */
  const trackTouchPointerDown = (
    event: React.PointerEvent<HTMLDivElement>
  ): void => {
    if (event.pointerType !== "touch") return;
    const target = event.target;
    if (!(target instanceof Node) || !gridRef.current?.contains(target)) return;
    const points = touchPointsRef.current;
    points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (points.size < 2) return;
    // A second finger turns whatever the first was doing into a pinch.
    clearTouchPress();
    touchTapRef.current = null;
    touchColumnTapRef.current = null;
    setDrag(null);
    const [a, b] = [...points.values()];
    pinchBaseRef.current = a && b ? distance(a, b) : null;
  };

  const forgetTouchPointer = (pointerId: number): void => {
    touchPointsRef.current.delete(pointerId);
    if (touchPointsRef.current.size < 2) pinchBaseRef.current = null;
  };

  /** Two fingers moving apart or together step the zoom around their midpoint. */
  const handlePinch = (): void => {
    const node = scrollRef.current;
    const base = pinchBaseRef.current;
    const [a, b] = [...touchPointsRef.current.values()];
    if (!node || !onZoomBy || base === null || !a || !b) return;
    const spread = distance(a, b);
    if (spread <= 0 || base <= 0) return;
    const ratio = spread / base;
    if (ratio < PINCH_STEP_RATIO && ratio > 1 / PINCH_STEP_RATIO) return;
    const midY = (a.y + b.y) / 2;
    zoomAnchorRef.current = {
      minute: minuteAtClientY(midY),
      viewportY: midY - node.getBoundingClientRect().top,
    };
    pinchBaseRef.current = spread;
    onZoomBy(ratio > 1 ? 1 : -1);
  };

  const handleDraftPointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
    mode: BlockDragMode
  ): void => {
    event.stopPropagation();
    // A finger pans the grid through the draft, as through a saved block,
    // until it has rested long enough to be holding it.
    if (event.pointerType === "touch") {
      beginTouchPress(event, { kind: "draft", mode });
      return;
    }
    if (event.button !== 0 && event.pointerType === "mouse") return;
    if (!draft) return;
    armBlockDrag(event, mode, DRAFT_ID, draft.range, draft.dayIndex);
  };

  const handleBlockPointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
    mode: BlockDragMode,
    block: Segment,
    dayIndex: number
  ): void => {
    event.stopPropagation();
    // A finger never arms move or resize on the press. With `touchAction:
    // "pan-y"` the browser owns the vertical pan, so the press that follows
    // the finger is a scroll far more often than an edit — and arming here
    // would commit that scroll as a real change to the entry. The tap that
    // *was* a tap is resolved from the click below; the hold that was a hold
    // is resolved by `armTouchPress`, once the finger has rested long enough
    // to be neither.
    if (event.pointerType === "touch") {
      // A second finger is a pinch: neither a tap nor a hold on this block.
      if (touchPointsRef.current.size > 1) return;
      touchTapRef.current = block.entry.id;
      beginTouchPress(
        event,
        block.draggable ? { kind: "block", block, mode, dayIndex } : null
      );
      return;
    }
    // Any mouse or pen press clears a stale tap, so a drag with the mouse can
    // never end by also opening the editor through the click below.
    touchTapRef.current = null;
    if (event.button !== 0 && event.pointerType === "mouse") return;
    // Pressing a saved block while a draft is open walks away from the draft.
    setDraft(null);

    if (!block.draggable) {
      setSelectedId(block.entry.id);
      return;
    }

    armBlockDrag(
      event,
      mode,
      block.entry.id,
      { startMin: block.startMin, endMin: block.endMin },
      dayIndex
    );
  };

  const handleColumnPointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
    dayIndex: number
  ): void => {
    // A popover is a React child of its block, so React bubbles its events
    // up to this column even though the DOM node lives in a portal. Without
    // this, every click inside the editor closed it and armed a create-drag.
    const target = event.target;
    if (!(target instanceof Node) || !gridRef.current?.contains(target)) return;
    // Same reason as the block: a finger dragging across empty grid is the
    // page scrolling, and arming create-a-new-entry here is what turns every
    // stray drag into an invented time entry. The tap that *was* a tap is
    // resolved from the click that follows it, like a tap on a block.
    // A finger that *rests* here instead is asking for a block over the span
    // it then drags out — `armTouchPress` proposes it after the long press.
    if (event.pointerType === "touch") {
      // A second finger is a pinch: it neither taps nor holds this column.
      if (touchPointsRef.current.size > 1) return;
      touchColumnTapRef.current = anythingOpen ? null : dayIndex;
      if (anythingOpen) closeEverything();
      beginTouchPress(event, anythingOpen ? null : { kind: "column", dayIndex });
      return;
    }
    touchColumnTapRef.current = null;
    if (event.button !== 0 && event.pointerType === "mouse") return;
    // A press on empty grid while an editor or a draft is open only closes
    // it; a second press is what starts the next entry. Otherwise clicking
    // away from an editor would put a draft down every time.
    if (anythingOpen) {
      closeEverything();
      return;
    }
    const anchorMin = minuteAtClientY(event.clientY);
    lastPointerYRef.current = event.clientY;
    capture(event.pointerId);
    setDrag({
      kind: "create",
      dayIndex,
      anchorMin,
      range: rangeFromDrag(anchorMin, anchorMin),
      active: false,
      minDuration: MIN_DURATION_MINUTES,
    });
  };

  /** Re-aim the drag in flight at the pointer's current position. */
  const applyPointer = (clientY: number): void => {
    lastPointerYRef.current = clientY;
    // Read the geometry once, outside the state updater, which must stay pure.
    const pointerMin = minuteAtClientY(clientY);
    const gridY = gridYAtClientY(clientY);

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
          range: rangeFromDrag(
            current.anchorMin,
            pointerMin,
            SNAP_MINUTES,
            current.minDuration
          ),
        };
      }

      const deltaPx = gridY - current.pointerStartY;
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

  const applyPointerRef = React.useRef(applyPointer);
  React.useLayoutEffect(() => {
    applyPointerRef.current = applyPointer;
  });

  // A drag near the top or bottom of the scroll box scrolls it, so an entry
  // can be carried to an hour that is off screen — with a finger there is no
  // other way to get there, since the finger *is* the scroll. The grid moves
  // under the pointer, so each step re-aims the drag at the same clientY.
  const dragActive = drag?.active === true;
  React.useEffect(() => {
    if (!dragActive) return;
    const node = scrollRef.current;
    if (!node || typeof requestAnimationFrame !== "function") return;
    let frame = 0;
    const step = (): void => {
      const y = lastPointerYRef.current;
      if (y !== null) {
        const rect = node.getBoundingClientRect();
        const fromTop = y - rect.top;
        const fromBottom = rect.bottom - y;
        let velocity = 0;
        if (fromTop < EDGE_SCROLL_PX) {
          velocity = -Math.ceil(
            ((EDGE_SCROLL_PX - Math.max(0, fromTop)) / EDGE_SCROLL_PX) *
              EDGE_SCROLL_MAX_PX_PER_FRAME
          );
        } else if (fromBottom < EDGE_SCROLL_PX) {
          velocity = Math.ceil(
            ((EDGE_SCROLL_PX - Math.max(0, fromBottom)) / EDGE_SCROLL_PX) *
              EDGE_SCROLL_MAX_PX_PER_FRAME
          );
        }
        if (velocity !== 0) {
          const before = node.scrollTop;
          node.scrollTop = before + velocity;
          if (node.scrollTop !== before) applyPointerRef.current(y);
        }
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [dragActive]);

  const handleGridPointerMove = (
    event: React.PointerEvent<HTMLDivElement>
  ): void => {
    if (event.pointerType === "touch") {
      const points = touchPointsRef.current;
      if (points.has(event.pointerId)) {
        points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }
      if (points.size > 1) {
        handlePinch();
        return;
      }
      const press = touchPressRef.current;
      if (press && press.pointerId === event.pointerId) {
        press.lastX = event.clientX;
        press.lastY = event.clientY;
        // Travel before the hold fires is a pan or a swipe, never a hold.
        if (
          !press.armed &&
          press.timer !== null &&
          Math.hypot(
            event.clientX - press.startX,
            event.clientY - press.startY
          ) > TOUCH_SLOP_PX
        ) {
          clearTimeout(press.timer);
          press.timer = null;
        }
      }
    }
    if (!drag) return;
    applyPointer(event.clientY);
  };

  const commitDrag = (state: DragState): void => {
    const day = days[state.dayIndex];
    if (!day) return;

    if (state.kind === "create") {
      // A press that never moved proposes an hour from where it landed; a
      // drag proposes exactly what it covered. Either way the draft's edges
      // can still be dragged before anything is saved.
      setDraft({
        dayIndex: state.dayIndex,
        range: state.active
          ? state.range
          : rangeFromClick(state.anchorMin),
      });
      return;
    }

    if (state.entryId === DRAFT_ID) {
      if (!state.active) return;
      setDraft((current) =>
        current ? { ...current, range: state.range } : current
      );
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
    if (event.pointerType === "touch") {
      forgetTouchPointer(event.pointerId);
      const press = touchPressRef.current;
      if (press && press.pointerId === event.pointerId) {
        clearTouchPress();
        if (!press.armed && !drag) {
          // The finger travelled sideways: `pan-y` leaves that to us, and it
          // is the gesture every phone calendar reads as "next" / "previous".
          // A finger that swiped never taps, so the pending taps go too.
          const dx = event.clientX - press.startX;
          const dy = event.clientY - press.startY;
          if (
            onSwipe &&
            Math.abs(dx) >= SWIPE_MIN_PX &&
            Math.abs(dx) > Math.abs(dy) * 1.5
          ) {
            touchTapRef.current = null;
            touchColumnTapRef.current = null;
            onSwipe(dx < 0 ? 1 : -1);
          }
          return;
        }
      }
    }
    if (!drag) return;
    if (gridRef.current?.hasPointerCapture(event.pointerId)) {
      gridRef.current.releasePointerCapture(event.pointerId);
    }
    lastPointerYRef.current = null;
    commitDrag(drag);
    setDrag(null);
  };

  const handleGridPointerCancel = (
    event: React.PointerEvent<HTMLDivElement>
  ): void => {
    // The browser took the gesture over — the finger is panning, not
    // tapping, holding or swiping.
    forgetTouchPointer(event.pointerId);
    clearTouchPress();
    touchTapRef.current = null;
    touchColumnTapRef.current = null;
    lastPointerYRef.current = null;
    setDrag(null);
  };

  // A timer left running would arm a drag on a grid that no longer exists.
  React.useEffect(() => clearTouchPress, []);

  const todayIndex = days.findIndex((day) => isSameDay(day, new Date(nowMs)));
  const nowMinute =
    todayIndex === -1
      ? null
      : (nowMs - startOfDay(new Date(nowMs)).getTime()) / 60_000;

  const isSingleDay = days.length === 1;
  const gridTemplate = `3.5rem repeat(${days.length}, minmax(0, 1fr))`;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
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

      {/* Scrollable body. `overscroll-contain` keeps a flick at either end
          from turning into pull-to-refresh or the page behind; `pan-y` on the
          box itself covers the gutter, so a pinch anywhere over the grid is
          ours rather than the page zooming. */}
      <div
        ref={scrollRef}
        className="relative flex-1 overflow-y-auto overscroll-y-contain"
        style={{ touchAction: "pan-y" }}
        data-testid="calendar-grid-scroll"
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
            data-testid="calendar-grid-pad"
            style={{ paddingTop: GRID_PAD_PX, paddingBottom: GRID_PAD_PX }}
          >
            <div
              ref={gridRef}
              className="relative grid select-none"
              // No callout or selection on a held finger: the hold is a gesture.
              style={{
                gridTemplateColumns: gridTemplate,
                height,
                WebkitTouchCallout: "none",
              }}
              onPointerDownCapture={trackTouchPointerDown}
              onPointerMove={handleGridPointerMove}
              onPointerUp={handleGridPointerUp}
              onPointerCancel={handleGridPointerCancel}
              onContextMenu={(event) => {
                // Android fires a context menu on a long press; the long
                // press is spoken for.
                if (touchPressRef.current) event.preventDefault();
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
              const draftHere = draft?.dayIndex === dayIndex ? draft : null;
              const draftDragged =
                draftHere &&
                drag &&
                drag.kind !== "create" &&
                drag.entryId === DRAFT_ID &&
                drag.active
                  ? drag.range
                  : null;
              const draftShown = draftDragged ?? draftHere?.range ?? null;

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
                  onClick={(event) => {
                    // Only ever the tap that pointer-down declined — a
                    // finger that panned fires no click, and a mouse never
                    // sets the ref (see the block's `onClick`).
                    if (touchColumnTapRef.current !== dayIndex) return;
                    touchColumnTapRef.current = null;
                    setDraft({
                      dayIndex,
                      range: rangeFromClick(minuteAtClientY(event.clientY)),
                    });
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

                  {draftHere && draftShown ? (
                    <Popover
                      open
                      onOpenChange={(open) => {
                        if (!open) setDraft(null);
                      }}
                    >
                      <PopoverAnchor asChild>
                        <DraftBlock
                          ref={draftRef}
                          top={offsetFromMinutes(
                            draftShown.startMin,
                            pxPerMinute,
                            visible
                          )}
                          height={
                            (draftShown.endMin - draftShown.startMin) *
                            pxPerMinute
                          }
                          timeLabel={`${formatMinuteOfDay(draftShown.startMin, format.timeFormat)} – ${formatMinuteOfDay(draftShown.endMin, format.timeFormat)}`}
                          durationLabel={format.duration(
                            (draftShown.endMin - draftShown.startMin) * 60
                          )}
                          isDragging={draftDragged !== null}
                          coarsePointer={coarsePointer}
                          onDraftPointerDown={handleDraftPointerDown}
                        />
                      </PopoverAnchor>
                      <EntryCreatePopover
                        day={column.day}
                        range={draftShown}
                        onRangeChange={(range) => {
                          setDraft({ dayIndex, range });
                        }}
                        actions={actions}
                        draftRef={draftRef}
                        onClose={() => {
                          setDraft(null);
                        }}
                      />
                    </Popover>
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
          </div>
        )}
      </div>
    </div>
  );
}
