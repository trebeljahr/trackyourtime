// Pure geometry + time math for the calendar. No React, no DOM, no tRPC —
// everything here is deterministic so the drag interactions can be unit
// tested without rendering a grid.

/** Minutes in a nominal calendar day. DST days are clamped to this. */
export const MINUTES_PER_DAY = 1440;

/** Every drag commits on a 5-minute grid. */
export const SNAP_MINUTES = 5;

/** An entry can never be dragged/resized shorter than this. */
export const MIN_DURATION_MINUTES = 5;

/** Pointer travel (px) before a press turns into a drag rather than a click. */
export const DRAG_THRESHOLD_PX = 4;

/** Half-open range of minutes after local midnight. */
export type MinuteRange = {
  startMin: number;
  endMin: number;
};

/** Which handle of a block a resize drag grabbed. */
export type ResizeEdge = "start" | "end";

/** The vertical window of the day the grid renders, in minutes. */
export type VisibleRange = {
  startMin: number;
  endMin: number;
};

/** 6:00 – 22:00, the default window a workday fits into. */
export const DEFAULT_VISIBLE_RANGE: VisibleRange = {
  startMin: 6 * 60,
  endMin: 22 * 60,
};

export const clampMinute = (minute: number): number =>
  Math.min(MINUTES_PER_DAY, Math.max(0, minute));

/** Round to the nearest `step`, never returning a fractional minute. */
export const snapMinutes = (value: number, step: number = SNAP_MINUTES): number =>
  Math.round(value / step) * step;

/** Minute-of-day for a pixel offset measured from the top of the grid. */
export const minutesFromOffset = (
  offsetY: number,
  pxPerMinute: number,
  range: VisibleRange = DEFAULT_VISIBLE_RANGE
): number => {
  if (pxPerMinute <= 0) return range.startMin;
  return range.startMin + offsetY / pxPerMinute;
};

/** Pixel offset from the top of the grid for a minute-of-day. */
export const offsetFromMinutes = (
  minute: number,
  pxPerMinute: number,
  range: VisibleRange = DEFAULT_VISIBLE_RANGE
): number => (minute - range.startMin) * pxPerMinute;

/** Total pixel height of a grid rendering `range` at `pxPerMinute`. */
export const gridHeight = (range: VisibleRange, pxPerMinute: number): number =>
  Math.max(0, (range.endMin - range.startMin) * pxPerMinute);

/**
 * Move a block by `deltaMinutes`, keeping its duration and snapping the new
 * start. The block is kept inside the day rather than clipped.
 */
export const moveRange = (
  range: MinuteRange,
  deltaMinutes: number,
  step: number = SNAP_MINUTES
): MinuteRange => {
  const duration = Math.max(MIN_DURATION_MINUTES, range.endMin - range.startMin);
  const snapped = snapMinutes(range.startMin + deltaMinutes, step);
  const startMin = Math.min(
    MINUTES_PER_DAY - duration,
    Math.max(0, snapped)
  );
  return { startMin, endMin: startMin + duration };
};

/**
 * Drag one edge of a block. The opposite edge is fixed and the block keeps
 * at least `minDuration` minutes, so the edges can never cross.
 */
export const resizeRange = (
  range: MinuteRange,
  edge: ResizeEdge,
  deltaMinutes: number,
  step: number = SNAP_MINUTES,
  minDuration: number = MIN_DURATION_MINUTES
): MinuteRange => {
  if (edge === "start") {
    const snapped = snapMinutes(range.startMin + deltaMinutes, step);
    const startMin = Math.min(
      range.endMin - minDuration,
      Math.max(0, snapped)
    );
    return { startMin, endMin: range.endMin };
  }
  const snapped = snapMinutes(range.endMin + deltaMinutes, step);
  const endMin = Math.max(
    range.startMin + minDuration,
    Math.min(MINUTES_PER_DAY, snapped)
  );
  return { startMin: range.startMin, endMin };
};

/** A click on empty space lands on this grid — the slot it is read as. */
export const CLICK_SNAP_MINUTES = 15;

/** The length a click on empty space proposes, before the edges are dragged. */
export const DEFAULT_CREATE_MINUTES = 60;

/**
 * The range a plain click on empty space proposes: the slot the click landed
 * in, `duration` long, kept inside the day. The person then drags either edge
 * or types the times — the click only has to land near the right hour.
 */
export const rangeFromClick = (
  anchorMin: number,
  duration: number = DEFAULT_CREATE_MINUTES,
  step: number = CLICK_SNAP_MINUTES
): MinuteRange => {
  const length = Math.min(MINUTES_PER_DAY, Math.max(MIN_DURATION_MINUTES, duration));
  const slot = Math.floor(clampMinute(anchorMin) / step) * step;
  const startMin = Math.min(slot, MINUTES_PER_DAY - length);
  return { startMin, endMin: startMin + length };
};

/**
 * The range produced by dragging on empty space from `anchorMin` to
 * `pointerMin`. Works in both directions and always yields a usable block.
 */
export const rangeFromDrag = (
  anchorMin: number,
  pointerMin: number,
  step: number = SNAP_MINUTES,
  minDuration: number = MIN_DURATION_MINUTES
): MinuteRange => {
  const anchor = clampMinute(snapMinutes(anchorMin, step));
  const pointer = clampMinute(snapMinutes(pointerMin, step));
  let startMin = Math.min(anchor, pointer);
  let endMin = Math.max(anchor, pointer);

  if (endMin - startMin < minDuration) {
    endMin = startMin + minDuration;
    if (endMin > MINUTES_PER_DAY) {
      endMin = MINUTES_PER_DAY;
      startMin = endMin - minDuration;
    }
  }
  return { startMin, endMin };
};

// ── day segmentation ─────────────────────────────────────────────────

/** The part of an entry that falls inside one calendar day. */
export type DaySegment = MinuteRange & {
  /** The entry started before this day (drawn flush to the top). */
  continuesBefore: boolean;
  /** The entry ends after this day (drawn flush to the bottom). */
  continuesAfter: boolean;
};

/**
 * Clip an absolute [startMs, endMs) interval to one calendar day, expressed
 * in minutes after that day's local midnight. Returns null when the entry
 * does not touch the day at all.
 *
 * `dayEndMs` is passed rather than derived so DST days (23h/25h) still land
 * on the right boundary; the resulting minutes are clamped to a nominal day.
 */
export const daySegment = (
  startMs: number,
  endMs: number,
  dayStartMs: number,
  dayEndMs: number
): DaySegment | null => {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

  const safeEnd = Math.max(endMs, startMs);
  const startsInDay = startMs >= dayStartMs && startMs < dayEndMs;
  const overlaps = startMs < dayEndMs && safeEnd > dayStartMs;
  if (!startsInDay && !overlaps) return null;

  const from = Math.max(startMs, dayStartMs);
  const to = Math.min(safeEnd, dayEndMs);

  const startMin = clampMinute((from - dayStartMs) / 60_000);
  const endMin = clampMinute((to - dayStartMs) / 60_000);

  return {
    startMin,
    endMin: Math.max(endMin, startMin),
    continuesBefore: startMs < dayStartMs,
    continuesAfter: safeEnd > dayEndMs,
  };
};

// ── overlap layout ───────────────────────────────────────────────────

/** Anything that can be laid out — an id plus the minutes it occupies. */
export type LayoutInput = MinuteRange & { id: string };

export type LaidOut<T extends LayoutInput> = T & {
  /** 0-based column inside its overlap cluster. */
  column: number;
  /** How many columns the cluster needs. */
  columns: number;
  /** Columns this block may grow across, counting its own. */
  span: number;
};

/** Above this many columns even splitting is unreadable and we shingle. */
export const MAX_EVEN_COLUMNS = 3;

/** How much of a column shingled blocks give up to the ones behind them. */
const SHINGLE_SPREAD_PCT = 58;

/** A block's box inside its day column, as percentages of the column. */
export type BlockGeometry = {
  leftPct: number;
  widthPct: number;
  /** Later columns paint above earlier ones so a shingle stack reads. */
  zIndex: number;
  /** True when the block is offset over a block behind it. */
  stacked: boolean;
};

/** Zero-length blocks still occupy a sliver of time. */
const effectiveEnd = (block: MinuteRange): number =>
  Math.max(block.endMin, block.startMin + 1);

const overlaps = (a: MinuteRange, b: MinuteRange): boolean =>
  a.startMin < effectiveEnd(b) && effectiveEnd(a) > b.startMin;

/**
 * Side-by-side layout for overlapping blocks.
 *
 * Blocks are swept in start order into clusters of mutually overlapping
 * entries; inside a cluster each block takes the first column whose previous
 * block has already ended. Every block then grows rightwards over any column
 * nothing overlapping occupies — the step that stops a lone long entry from
 * being pinned to a third of the day just because two short ones crossed it.
 */
export const layoutBlocks = <T extends LayoutInput>(
  blocks: readonly T[]
): LaidOut<T>[] => {
  const sorted = [...blocks].sort(
    (a, b) =>
      a.startMin - b.startMin ||
      b.endMin - b.startMin - (a.endMin - a.startMin) ||
      a.id.localeCompare(b.id)
  );

  const out: LaidOut<T>[] = [];
  let cluster: LaidOut<T>[] = [];
  let columnEnds: number[] = [];
  let clusterEnd = Number.NEGATIVE_INFINITY;

  const flush = (): void => {
    const columns = Math.max(1, columnEnds.length);
    for (const block of cluster) {
      let span = 1;
      while (block.column + span < columns) {
        const column = block.column + span;
        const blocked = cluster.some(
          (other) => other.column === column && overlaps(other, block)
        );
        if (blocked) break;
        span += 1;
      }
      out.push({ ...block, columns, span });
    }
    cluster = [];
    columnEnds = [];
    clusterEnd = Number.NEGATIVE_INFINITY;
  };

  for (const block of sorted) {
    const end = effectiveEnd(block);
    if (cluster.length > 0 && block.startMin >= clusterEnd) flush();

    let column = columnEnds.findIndex((columnEnd) => block.startMin >= columnEnd);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(end);
    } else {
      columnEnds[column] = end;
    }

    cluster.push({ ...block, column, columns: 1, span: 1 });
    clusterEnd = Math.max(clusterEnd, end);
  }
  flush();

  return out;
};

/**
 * Where a laid-out block sits inside its day column.
 *
 * Up to `MAX_EVEN_COLUMNS` the cluster splits the column evenly, the way
 * Google Calendar and Clockify do. Past that an even split leaves slivers too
 * narrow to read, so the blocks shingle instead: each one starts a little
 * further right and runs to the edge, keeping every title legible while the
 * offsets still show how many entries are stacked.
 */
export const blockGeometry = (block: {
  column: number;
  columns: number;
  span: number;
}): BlockGeometry => {
  const columns = Math.max(1, block.columns);
  const column = Math.min(Math.max(0, block.column), columns - 1);

  if (columns <= MAX_EVEN_COLUMNS) {
    const span = Math.min(Math.max(1, block.span), columns - column);
    return {
      leftPct: (column / columns) * 100,
      widthPct: (span / columns) * 100,
      zIndex: column,
      stacked: false,
    };
  }

  const leftPct = column * (SHINGLE_SPREAD_PCT / (columns - 1));
  return {
    leftPct,
    widthPct: 100 - leftPct,
    zIndex: column,
    stacked: column > 0,
  };
};

// ── formatting + conversion ──────────────────────────────────────────

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** "09:30" or "9:30 AM" for a minute-of-day. */
export const formatMinuteOfDay = (
  minute: number,
  timeFormat: "12h" | "24h" = "24h"
): string => {
  const total = Math.round(clampMinute(minute));
  const hours24 = Math.floor(total / 60) % 24;
  const minutes = total % 60;
  if (timeFormat === "24h") return `${pad2(hours24)}:${pad2(minutes)}`;
  const suffix = hours24 < 12 ? "AM" : "PM";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${pad2(minutes)} ${suffix}`;
};

/** ISO timestamp for `minute` minutes after the local midnight of `day`. */
export const isoAtMinute = (day: Date, minute: number): string => {
  const date = new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    0,
    0,
    0,
    0
  );
  date.setMinutes(date.getMinutes() + Math.round(minute));
  return date.toISOString();
};

/**
 * Widen `preferred` so every one of `segments` is reachable, then round out
 * to whole hours. Entries outside the configured window must still render.
 */
export const expandVisibleRange = (
  preferred: VisibleRange,
  segments: readonly MinuteRange[]
): VisibleRange => {
  let startMin = preferred.startMin;
  let endMin = preferred.endMin;

  for (const segment of segments) {
    if (segment.startMin < startMin) startMin = segment.startMin;
    if (segment.endMin > endMin) endMin = segment.endMin;
  }

  startMin = Math.max(0, Math.floor(startMin / 60) * 60);
  endMin = Math.min(MINUTES_PER_DAY, Math.ceil(endMin / 60) * 60);
  if (endMin - startMin < 60) endMin = Math.min(MINUTES_PER_DAY, startMin + 60);
  return { startMin, endMin };
};

// ── zoom ─────────────────────────────────────────────────────────────

/**
 * Selectable vertical scales, in pixels per minute. 1 is the baseline the
 * grid was designed at (60px per hour). The bottom of the ladder fits a whole
 * 24h day on a laptop screen; the top is high enough that even a three-minute
 * entry clears {@link MICRO_BLOCK_PX}, so zooming all the way in always
 * dissolves the last density cluster into real blocks.
 */
export const ZOOM_LEVELS = [0.35, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6] as const;

/** Index of the 1px-per-minute baseline. */
export const DEFAULT_ZOOM_INDEX = ZOOM_LEVELS.indexOf(1);

export const clampZoomIndex = (index: number): number =>
  Math.min(ZOOM_LEVELS.length - 1, Math.max(0, Math.round(index)));

/** Pixels per minute for a zoom index, clamped to the ladder. */
export const zoomPxPerMinute = (index: number): number =>
  ZOOM_LEVELS[clampZoomIndex(index)] ?? 1;

/** How the hour rules are drawn at a given scale. */
export type GridTicks = {
  /** Minutes between labelled lines. */
  labelStepMin: number;
  /** Minutes between fainter unlabelled lines, or null for none. */
  minorStepMin: number | null;
};

/**
 * The rules follow the scale in both directions: they thin out as the grid
 * shrinks — hour labels collide below roughly 34px per hour, and half-hour
 * guides stop helping long before that — and they subdivide as it grows, so
 * the gutter reads 30, 15, 10 and finally 5 minute marks rather than staying
 * on the hour while blocks get taller.
 *
 * Each tier keeps labels at least ~30px apart and minor guides at least
 * ~15px apart, which is what stops the gutter turning into a grey band. The
 * hour lines stay emphasised at every tier, so a sub-hour label reads as a
 * subdivision of the hour above it rather than as another hour.
 */
export const gridTicks = (pxPerMinute: number): GridTicks => {
  const hourPx = pxPerMinute * 60;
  if (hourPx >= 300) return { labelStepMin: 5, minorStepMin: null };
  if (hourPx >= 200) return { labelStepMin: 10, minorStepMin: 5 };
  if (hourPx >= 140) return { labelStepMin: 15, minorStepMin: 5 };
  if (hourPx >= 84) return { labelStepMin: 30, minorStepMin: 15 };
  if (hourPx >= 46) return { labelStepMin: 60, minorStepMin: 30 };
  if (hourPx >= 34) return { labelStepMin: 60, minorStepMin: null };
  if (hourPx >= 20) return { labelStepMin: 120, minorStepMin: 60 };
  return { labelStepMin: 180, minorStepMin: 60 };
};

// ── density clustering ───────────────────────────────────────────────

/** A block shorter than this many pixels cannot carry a readable label. */
export const MICRO_BLOCK_PX = 16;

/** Micro blocks closer together than this belong to the same burst. */
export const MICRO_GAP_PX = 12;

/** A burst is only worth collapsing from this many blocks up. */
export const MIN_CLUSTER_SIZE = 3;

/**
 * Cluster chips are drawn at least this tall, however short their span — one
 * line of label plus its padding. Kept tight on purpose: the grid lays the
 * chip out at its drawn height, so every extra pixel is time the chip claims
 * from whatever follows it, and a taller chip starts shouldering real blocks
 * into a second column at low zoom.
 */
export const CLUSTER_MIN_PX = 20;

/** A run of unreadably short blocks, drawn as one density chip. */
export type MicroCluster<T extends LayoutInput> = MinuteRange & {
  id: string;
  members: T[];
};

export type ClusterOptions = {
  microPx?: number;
  gapPx?: number;
  minSize?: number;
};

/**
 * Split blocks into the ones worth drawing individually and the bursts of
 * unreadably short ones.
 *
 * A five-minute entry is 5px tall at the default scale — a line, not a block,
 * and a dozen of them in one afternoon read as noise rather than as work. So
 * anything under `microPx` is swept into runs with its neighbours, and a run
 * of at least `minSize` becomes one chip that says how many there are and
 * where they sit. Zooming in raises every block's height, which dissolves the
 * clusters back into real blocks — the chip is a function of scale, not a
 * property of the entries.
 */
export const clusterMicroBlocks = <T extends LayoutInput>(
  blocks: readonly T[],
  pxPerMinute: number,
  options: ClusterOptions = {}
): { loose: T[]; clusters: MicroCluster<T>[] } => {
  const microPx = options.microPx ?? MICRO_BLOCK_PX;
  const gapPx = options.gapPx ?? MICRO_GAP_PX;
  const minSize = options.minSize ?? MIN_CLUSTER_SIZE;

  if (pxPerMinute <= 0) return { loose: [...blocks], clusters: [] };

  const loose: T[] = [];
  const micro: T[] = [];
  for (const block of blocks) {
    const heightPx = (block.endMin - block.startMin) * pxPerMinute;
    if (heightPx < microPx) micro.push(block);
    else loose.push(block);
  }

  micro.sort((a, b) => a.startMin - b.startMin || a.id.localeCompare(b.id));

  const clusters: MicroCluster<T>[] = [];
  let group: T[] = [];
  let groupEnd = Number.NEGATIVE_INFINITY;

  const flush = (): void => {
    const [first] = group;
    if (first && group.length >= minSize) {
      clusters.push({
        id: `cluster:${first.id}`,
        startMin: first.startMin,
        endMin: groupEnd,
        members: group,
      });
    } else {
      loose.push(...group);
    }
    group = [];
    groupEnd = Number.NEGATIVE_INFINITY;
  };

  for (const block of micro) {
    if (group.length > 0 && (block.startMin - groupEnd) * pxPerMinute > gapPx) {
      flush();
    }
    group.push(block);
    groupEnd = Math.max(groupEnd, block.endMin);
  }
  flush();

  return { loose, clusters };
};
