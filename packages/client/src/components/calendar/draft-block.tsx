"use client";

import * as React from "react";

import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";
import { blockPalette } from "./entry-color";
import type { BlockDragMode } from "./entry-block";

export type DraftBlockProps = {
  /** Pixel geometry inside the day column. */
  top: number;
  height: number;
  timeLabel: string;
  durationLabel: string;
  isDragging: boolean;
  onDraftPointerDown: (
    event: React.PointerEvent<HTMLDivElement>,
    mode: BlockDragMode
  ) => void;
  /** See `EntryBlock`: a finger must be allowed to pan the grid through it. */
  coarsePointer?: boolean;
} & Omit<React.ComponentPropsWithoutRef<"div">, "onPointerDown" | "children">;

/** The resize strip along each edge, for a mouse and for a finger. */
const HANDLE_PX = 7;
const TOUCH_HANDLE_PX = 14;
const COMPACT_HEIGHT = 34;

/**
 * The entry being created, drawn where it will land. A click or drag on
 * empty grid puts one here; its top and bottom edges resize it and its body
 * moves it, exactly like a saved block, and the create popover anchored to it
 * is where the rest of the entry is filled in. Nothing is written until Save.
 */
export const DraftBlock = React.forwardRef<HTMLDivElement, DraftBlockProps>(
  function DraftBlock(
    {
      top,
      height,
      timeLabel,
      durationLabel,
      isDragging,
      onDraftPointerDown,
      coarsePointer = false,
      className,
      style,
      ...rest
    },
    ref
  ) {
    const t = useT("calendar");
    const touchAction = coarsePointer ? "pan-y" : "none";
    const handlePx = coarsePointer ? TOUCH_HANDLE_PX : HANDLE_PX;
    const compact = height < COMPACT_HEIGHT;
    // A finger has no cursor to tell it an edge resizes, so show one.
    const grips = coarsePointer && !compact;

    return (
      <div
        ref={ref}
        role="group"
        aria-label={`${t("create.newEntry")}, ${timeLabel}`}
        data-testid="calendar-create-draft"
        data-dragging={isDragging ? "true" : undefined}
        className={cn(
          "border-primary/70 text-primary absolute z-30 overflow-hidden rounded-md border-2 border-dashed",
          "px-1.5 py-0.5 text-left text-xs shadow-md select-none",
          isDragging ? "cursor-grabbing" : "cursor-grab",
          className
        )}
        style={{
          top,
          height: Math.max(height, 16),
          left: 2,
          right: 2,
          background: blockPalette(null, true).background,
          touchAction,
          ...style,
        }}
        onPointerDown={(event) => {
          onDraftPointerDown(event, "move");
        }}
        {...rest}
      >
        <div
          data-testid="calendar-create-draft-resize-start"
          aria-hidden
          className="absolute inset-x-0 top-0 cursor-ns-resize"
          style={{ height: handlePx, touchAction }}
          onPointerDown={(event) => {
            onDraftPointerDown(event, "resize-start");
          }}
        >
          {grips ? (
            <span className="bg-primary/40 absolute top-1 left-1/2 h-1 w-6 -translate-x-1/2 rounded-full" />
          ) : null}
        </div>
        <div
          data-testid="calendar-create-draft-resize-end"
          aria-hidden
          className="absolute inset-x-0 bottom-0 cursor-ns-resize"
          style={{ height: handlePx, touchAction }}
          onPointerDown={(event) => {
            onDraftPointerDown(event, "resize-end");
          }}
        >
          {grips ? (
            <span className="bg-primary/40 absolute bottom-1 left-1/2 h-1 w-6 -translate-x-1/2 rounded-full" />
          ) : null}
        </div>
        <div className="pointer-events-none flex h-full flex-col gap-0.5 overflow-hidden">
          <span className="truncate font-medium">
            {compact ? timeLabel : t("create.newEntry")}
          </span>
          {compact ? null : (
            <span className="truncate tabular-nums opacity-80">
              {timeLabel} · {durationLabel}
            </span>
          )}
        </div>
      </div>
    );
  }
);
