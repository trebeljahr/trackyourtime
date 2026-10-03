"use client";

import * as React from "react";
import { ChevronDown, ChevronUp, Pin, PinOff, Play, History } from "lucide-react";
import {
  isBrokenQuickStart,
  repairQuickStart,
  type QuickStartItem,
} from "@starter/core";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BillableGlyph } from "@/components/tracker/billable-glyph";
import type { EntryMutations } from "@/components/tracker/use-entry-mutations";
import { useQuickStarts } from "@/hooks/use-favorites";
import { useT } from "@/i18n/use-t";
import type { Translator } from "@/i18n/translator";
import { cn } from "@/lib/utils";

/**
 * `quickStartLabel` from `@starter/shared`, with its one fallback word
 * translated: the description, else the project, else the task.
 */
const quickStartLabelFor = (
  item: QuickStartItem,
  t: Translator<"tracker">
): string => {
  const description = item.description.trim();
  if (description !== "") return description;
  if (item.projectName) return item.projectName;
  if (item.taskName) return item.taskName;
  return t("quickStart.noDescription");
};

/**
 * `quickStartHint` from `@starter/shared`, translated: project and its client,
 * or null when that would only repeat the label.
 */
const quickStartHintFor = (
  item: QuickStartItem,
  t: Translator<"tracker">
): string | null => {
  if (item.projectMissing === true) return t("quickStart.projectDeleted");
  if (!item.projectName) return item.taskName ?? null;
  if (item.description.trim() === "") return item.clientName ?? null;

  const project = item.projectArchived
    ? t("quickStart.projectArchived", { project: item.projectName })
    : item.projectName;
  return item.clientName
    ? t("quickStart.clientProject", { client: item.clientName, project })
    : project;
};

/**
 * One row of the quick-start menu. Selecting it starts a timer; the trailing
 * controls pin, unpin and reorder without closing the menu.
 *
 * A quick start whose project was deleted is still startable — its description
 * is the part the user typed, and `repairQuickStart` drops the dangling
 * reference rather than sending the server an id it will reject. The row says
 * so, so the start is not a silent downgrade.
 */
function QuickStartMenuItem({
  item,
  index,
  favoriteCount,
  onStart,
  onPin,
  onUnpin,
  onMove,
}: {
  item: QuickStartItem;
  index: number;
  favoriteCount: number;
  onStart: (item: QuickStartItem) => void;
  onPin: (item: QuickStartItem) => void;
  onUnpin: (id: string) => void;
  onMove: (id: string, delta: number) => void;
}): React.JSX.Element {
  const t = useT("tracker");
  const tc = useT("common");
  const pinned = item.kind === "favorite";
  const awaitingPin = pinned && item.id.startsWith("optimistic-");
  const label = quickStartLabelFor(item, t);
  const hint = quickStartHintFor(item, t);
  const broken = isBrokenQuickStart(item);

  // Radix selects an item on click; a click that never reaches it neither
  // starts a timer nor closes the menu, which is exactly what pinning and
  // reordering want.
  const swallow = (event: React.MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <DropdownMenuItem
      className="group gap-2 py-2"
      onSelect={() => onStart(item)}
      data-testid="quick-start-item"
      data-kind={item.kind}
      data-broken={broken ? "true" : "false"}
    >
      {item.projectColor === null ? (
        <Play className="size-3 shrink-0 text-muted-foreground" />
      ) : (
        <span
          aria-hidden
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: item.projectColor }}
        />
      )}

      <span className="flex min-w-0 flex-col">
        <span className="truncate">{label}</span>
        {hint === null ? null : (
          <span
            className={cn(
              "truncate text-xs text-muted-foreground",
              broken && "text-destructive"
            )}
            data-testid="quick-start-hint"
          >
            {hint}
          </span>
        )}
      </span>

      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        {/* Chip-sized rather than the glyph's own icon size — the wrapper
            scales it because BillableGlyph follows the currency setting and
            takes no class of its own. */}
        {item.billable ? (
          <span
            className="mr-1 shrink-0 text-muted-foreground [&_svg]:size-3"
            title={tc("fields.billable")}
            data-testid="quick-start-billable"
          >
            <BillableGlyph billable />
          </span>
        ) : null}

        {pinned ? (
          <>
            <button
              type="button"
              disabled={awaitingPin || index === 0}
              className="rounded p-1 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-0 group-hover:opacity-100 group-data-[highlighted]:opacity-100 focus-visible:opacity-100"
              aria-label={t("quickStart.moveUp", { label })}
              onClick={(event) => {
                swallow(event);
                onMove(item.id, -1);
              }}
              data-testid="quick-start-move-up"
            >
              <ChevronUp className="size-3.5" />
            </button>
            <button
              type="button"
              disabled={awaitingPin || index >= favoriteCount - 1}
              className="rounded p-1 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-0 group-hover:opacity-100 group-data-[highlighted]:opacity-100 focus-visible:opacity-100"
              aria-label={t("quickStart.moveDown", { label })}
              onClick={(event) => {
                swallow(event);
                onMove(item.id, 1);
              }}
              data-testid="quick-start-move-down"
            >
              <ChevronDown className="size-3.5" />
            </button>
            <button
              type="button"
              disabled={awaitingPin}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={t("quickStart.unpinLabel", { label })}
              title={t("quickStart.unpin")}
              onClick={(event) => {
                swallow(event);
                onUnpin(item.id);
              }}
              data-testid="quick-start-unpin"
            >
              <PinOff className="size-3.5" />
            </button>
          </>
        ) : (
          <button
            type="button"
            className="rounded p-1 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100 group-data-[highlighted]:opacity-100 focus-visible:opacity-100"
            aria-label={t("quickStart.pinLabel", { label })}
            title={t("quickStart.pinTitle")}
            onClick={(event) => {
              swallow(event);
              onPin(item);
            }}
            data-testid="quick-start-pin"
          >
            <Pin className="size-3.5" />
          </button>
        )}
      </span>
    </DropdownMenuItem>
  );
}

/** Separate shortcuts for recent work and pinned favorites. */
export function QuickStartMenu({
  mutations,
}: {
  mutations: EntryMutations;
}): React.JSX.Element | null {
  const t = useT("tracker");
  const quickStarts = useQuickStarts();

  const start = React.useCallback(
    (item: QuickStartItem): void => {
      mutations.startQuickStart(repairQuickStart(item));
    },
    [mutations]
  );

  const pin = React.useCallback(
    (item: QuickStartItem): void => {
      quickStarts.pin(repairQuickStart(item));
    },
    [quickStarts]
  );

  const favorites = React.useMemo(
    () => quickStarts.items.filter((item) => item.kind === "favorite"),
    [quickStarts.items]
  );
  const recents = React.useMemo(
    () => quickStarts.items.filter((item) => item.kind === "recent"),
    [quickStarts.items]
  );

  // Nothing tracked yet and nothing pinned: an empty menu would be a button
  // that explains itself and does nothing, so it simply is not there.
  if (quickStarts.isLoading || quickStarts.items.length === 0) return null;

  return (
    <div className="flex max-w-full flex-wrap items-center gap-1">
      {([
        { kind: "recent", label: t("quickStart.recent"), items: recents, Icon: History },
        { kind: "favorite", label: t("quickStart.favorites"), items: favorites, Icon: Pin },
      ] as const).map(({ kind, label, items, Icon }) => (
        <DropdownMenu key={kind}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="h-8 shrink-0 gap-1.5 px-2 text-muted-foreground cap-touch"
              aria-label={label}
              data-testid={`${kind}-start-trigger`}
            >
              <Icon className="size-4" />
              <span>{label}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="max-h-[60vh] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto"
            data-testid={`${kind}-start-menu`}
          >
            <DropdownMenuLabel>{label}</DropdownMenuLabel>
            {items.length === 0 ? (
              <DropdownMenuItem disabled>{t("quickStart.empty")}</DropdownMenuItem>
            ) : items.map((item, index) => (
              <QuickStartMenuItem
                key={item.kind === "favorite" ? item.id : item.key}
                item={item}
                index={index}
                favoriteCount={favorites.length}
                onStart={start}
                onPin={pin}
                onUnpin={quickStarts.unpin}
                onMove={quickStarts.move}
              />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ))}
    </div>
  );
}
