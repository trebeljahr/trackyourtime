"use client";

import * as React from "react";
import { Play } from "lucide-react";
import type { DetailedEntry } from "@starter/shared";

import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";
import { blockPalette } from "./entry-color";

/** How the pointer press that started on this block should be interpreted. */
export type BlockDragMode = "move" | "resize-start" | "resize-end";

export type EntryBlockProps = {
  entry: DetailedEntry;
  /** Pixel geometry inside the day column. */
  top: number;
  height: number;
  /** Percentages, so overlapping blocks share the column width. */
  leftPct: number;
  widthPct: number;
  /** Paint order inside the column — later overlap columns sit on top. */
  zIndex?: number;
  /** The block is offset over another one rather than beside it. */
  stacked?: boolean;
  isRunning: boolean;
  isDragging: boolean;
  isSelected: boolean;
  /** Running and multi-day segments are read-only. */
  draggable: boolean;
  /** The segment is clipped at the top / bottom by midnight. */
  continuesBefore?: boolean;
  continuesAfter?: boolean;
  timeLabel: string;
  durationLabel: string;
  onBlockPointerDown: (
    event: React.PointerEvent<HTMLDivElement>,
    mode: BlockDragMode
  ) => void;
  /**
   * The primary pointer is a finger. The block then has to let the browser
   * pan the grid vertically through it — `touchAction: "none"` swallows the
   * scroll and leaves every stray drag to be committed as a real edit.
   */
  coarsePointer?: boolean;
} & Omit<React.ComponentPropsWithoutRef<"div">, "onPointerDown" | "children">;

/** Below this the time/project lines are dropped. */
const COMPACT_HEIGHT = 34;
/** Below this only a single clipped line of title fits. */
const TINY_HEIGHT = 21;
/** The resize strip along each edge, for a mouse. */
const HANDLE_PX = 7;
/**
 * The same strip for a finger, which lands within about a fingertip of where
 * it meant to. Still short of half the block: a hold in the middle of a
 * `COMPACT_HEIGHT` block has to stay a move.
 */
const TOUCH_HANDLE_PX = 14;

/**
 * One entry drawn on the week grid. Purely presentational — every pointer
 * gesture is reported upwards so the grid owns a single drag state machine.
 */
export const EntryBlock = React.forwardRef<HTMLDivElement, EntryBlockProps>(
  function EntryBlock(
    {
      entry,
      top,
      height,
      leftPct,
      widthPct,
      zIndex = 0,
      stacked = false,
      isRunning,
      isDragging,
      isSelected,
      draggable,
      continuesBefore = false,
      continuesAfter = false,
      timeLabel,
      durationLabel,
      onBlockPointerDown,
      coarsePointer = false,
      className,
      style,
      ...rest
    },
    ref
  ) {
    const palette = blockPalette(entry.projectColor, isDragging || isSelected);
    const touchAction = coarsePointer ? "pan-y" : "none";
    const handlePx = coarsePointer ? TOUCH_HANDLE_PX : HANDLE_PX;
    const tc = useT("common");
    const title = entry.description || tc("empty.noDescription");
    const compact = height < COMPACT_HEIGHT;
    const tiny = height < TINY_HEIGHT;
    // A mouse has a cursor to say "this edge resizes"; a finger has nothing,
    // so a block tall enough to have edges shows a grip on each.
    const grips = coarsePointer && draggable && !compact;
    // Shingled blocks need an opaque backing, or the block behind bleeds
    // through the translucent tint and both titles become unreadable. The
    // tint is painted as a one-colour gradient layer over that backing.
    const backgroundColor = stacked
      ? "var(--color-background)"
      : palette.background;
    const backgroundImage = stacked
      ? `linear-gradient(${palette.background}, ${palette.background})`
      : undefined;

    return (
      <div
        ref={ref}
        role="button"
        tabIndex={0}
        aria-label={`${title}, ${timeLabel}`}
        title={`${title} · ${timeLabel} · ${durationLabel}${
          entry.projectName ? ` · ${entry.projectName}` : ""
        }`}
        data-testid={`calendar-entry-${entry.id}`}
        data-running={isRunning ? "true" : undefined}
        className={cn(
          "group absolute overflow-hidden rounded-md border text-left text-xs",
          "text-foreground shadow-sm transition-shadow select-none",
          tiny ? "px-1 py-0" : "px-1.5 py-0.5",
          stacked && "shadow-md",
          "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
          draggable ? "cursor-grab" : "cursor-pointer",
          isDragging && "z-30 cursor-grabbing shadow-lg",
          isSelected && "ring-ring/60 z-20 ring-2",
          continuesBefore && "rounded-t-none",
          continuesAfter && "rounded-b-none",
          className
        )}
        style={{
          top,
          height: Math.max(height, 16),
          left: `calc(${leftPct}% + 2px)`,
          width: `calc(${widthPct}% - 4px)`,
          zIndex: isDragging ? 30 : isSelected ? 20 : zIndex,
          backgroundColor,
          backgroundImage,
          // Longhand only: mixing `borderColor` with the `borderLeft`
          // shorthand makes React warn about conflicting style properties.
          borderTopColor: continuesBefore ? "transparent" : palette.border,
          borderRightColor: palette.border,
          borderBottomColor: continuesAfter ? "transparent" : palette.border,
          borderLeftColor: palette.accent,
          borderLeftStyle: "solid",
          borderLeftWidth: 3,
          touchAction,
          ...style,
        }}
        onPointerDown={(event) => {
          onBlockPointerDown(event, "move");
        }}
        {...rest}
      >
        {draggable ? (
          <>
            <div
              data-testid={`calendar-entry-resize-start-${entry.id}`}
              aria-hidden
              className="absolute inset-x-0 top-0 cursor-ns-resize"
              style={{ height: handlePx, touchAction }}
              onPointerDown={(event) => {
                onBlockPointerDown(event, "resize-start");
              }}
            >
              {grips ? (
                <span className="bg-foreground/25 absolute top-1 left-1/2 h-1 w-6 -translate-x-1/2 rounded-full" />
              ) : null}
            </div>
            <div
              data-testid={`calendar-entry-resize-end-${entry.id}`}
              aria-hidden
              className="absolute inset-x-0 bottom-0 cursor-ns-resize"
              style={{ height: handlePx, touchAction }}
              onPointerDown={(event) => {
                onBlockPointerDown(event, "resize-end");
              }}
            >
              {grips ? (
                <span className="bg-foreground/25 absolute bottom-1 left-1/2 h-1 w-6 -translate-x-1/2 rounded-full" />
              ) : null}
            </div>
          </>
        ) : null}

        <div
          className={cn(
            "pointer-events-none flex h-full flex-col overflow-hidden",
            tiny ? "justify-center gap-0" : "gap-0.5"
          )}
        >
          <span
            className={cn(
              "flex min-w-0 items-center gap-1 font-medium",
              tiny && "text-[0.65rem] leading-none"
            )}
          >
            {isRunning ? (
              <Play className="size-3 shrink-0 fill-current" aria-hidden />
            ) : null}
            <span className="truncate">{title}</span>
            {tiny ? (
              <span className="text-muted-foreground shrink truncate tabular-nums">
                {durationLabel}
              </span>
            ) : null}
          </span>
          {compact ? null : (
            <>
              <span className="text-muted-foreground truncate tabular-nums">
                {timeLabel} · {durationLabel}
              </span>
              {entry.projectName ? (
                <span className="text-muted-foreground truncate">
                  {entry.projectName}
                </span>
              ) : null}
            </>
          )}
        </div>
      </div>
    );
  }
);
