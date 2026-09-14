"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { defaultFilter } from "cmdk";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { TAG_LIST_INPUT } from "@/components/tags/use-tags";
import { useEntryMutations } from "@/components/tracker/use-entry-mutations";
import {
  runPaletteAction,
  type PalettePage,
} from "@/components/command-palette/palette-actions";
import {
  buildDiscardGroups,
  buildPaletteGroups,
  scorePaletteItem,
  type PaletteGroup,
  type PaletteItem,
  type PaletteSection,
} from "@/components/command-palette/palette-model";
import { useQuickStarts } from "@/hooks/use-favorites";
import { useRunningEntry } from "@/hooks/use-sync";
import { useT } from "@/i18n/use-t";
import { useAllTimeRange } from "@/lib/entry-links";
import { useFormatSettings } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/**
 * Cmd/Ctrl+K, and nothing else: no Shift, no Alt, so the browser's and the
 * calendar's own bindings keep every other combination.
 */
export const isPaletteShortcut = (
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): boolean =>
  (event.metaKey || event.ctrlKey) &&
  !event.altKey &&
  !event.shiftKey &&
  event.key.toLowerCase() === "k";

/**
 * Toggles the palette from anywhere, typing targets included — Cmd+K in a text
 * field does nothing of its own, and Ctrl+K would otherwise focus the
 * browser's address bar. The calendar's single-key shortcuts return early on
 * any modifier, so this steals none of them.
 */
export const useCommandPaletteShortcut = (toggle: () => void): void => {
  const toggleRef = React.useRef(toggle);
  React.useEffect(() => {
    toggleRef.current = toggle;
  }, [toggle]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isPaletteShortcut(event)) return;
      event.preventDefault();
      toggleRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
};

/** Scores a row by its keywords, never by its id-shaped `value`. */
const filterByKeywords = (
  _value: string,
  search: string,
  keywords?: string[],
): number =>
  scorePaletteItem(
    (text, query) => defaultFilter(text, query),
    search,
    keywords,
  );

export type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The shell's NAV_SECTIONS, passed in rather than imported: the shell
   * renders this palette, and a new screen added there must appear here with
   * no second list to update.
   */
  sections: readonly PaletteSection[];
};

/**
 * The keyboard-first way through the app: timer actions, every destination,
 * and the catalog. Controlled, so `ui/dialog.tsx` registers it with the
 * overlay stack and Android's back button closes it first.
 */
export function CommandPalette({
  open,
  onOpenChange,
  sections,
}: CommandPaletteProps): React.JSX.Element {
  const t = useT("shell");
  const close = React.useCallback((): void => onOpenChange(false), [onOpenChange]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("palette.title")}
      description={t("palette.description")}
      // Top-anchored: a centred panel jumps every time filtering changes its
      // height, which is on every keystroke.
      contentClassName="top-[12%] translate-y-0"
      commandProps={{
        filter: filterByKeywords,
        loop: true,
      }}
    >
      {/* Radix does not render closed content, so the queries and mutation
          hooks below exist only while the palette is open. */}
      <PaletteBody close={close} sections={sections} />
    </CommandDialog>
  );
}

function PaletteBody({
  close,
  sections,
}: {
  close: () => void;
  sections: readonly PaletteSection[];
}): React.JSX.Element {
  const t = useT("shell");
  const router = useRouter();
  const [search, setSearch] = React.useState("");
  const [page, setPageState] = React.useState<PalettePage>("root");

  const { entry: running, elapsedSec } = useRunningEntry();
  const format = useFormatSettings();
  const mutations = useEntryMutations();
  const quickStarts = useQuickStarts();
  const reportRange = useAllTimeRange();

  // The same inputs every other screen asks with, so these are cache hits.
  const projects = trpc.projects.list.useQuery({});
  const clients = trpc.clients.list.useQuery({});
  const tasks = trpc.tasks.list.useQuery({});
  const tags = trpc.tags.list.useQuery(TAG_LIST_INPUT);

  const setPage = React.useCallback((next: PalettePage): void => {
    setPageState(next);
    setSearch("");
  }, []);

  const elapsed = running === null ? "" : format.duration(elapsedSec);
  const runningView = React.useMemo(
    () =>
      running === null
        ? null
        : { description: running.description, elapsed },
    [elapsed, running],
  );

  // The confirmation is about one running timer. If it stops while the page
  // is open — on another device, say — there is nothing left to confirm.
  const discardPage = page === "discard" && runningView !== null;

  const groups: PaletteGroup[] = React.useMemo(() => {
    if (discardPage && runningView !== null) {
      return buildDiscardGroups(runningView, t);
    }
    return buildPaletteGroups({
      t,
      running: runningView,
      quickStarts: quickStarts.items,
      sections,
      projects: (projects.data ?? []).map((project) => ({
        id: project.id,
        name: project.name,
        color: project.color,
        clientName: project.clientName,
        billableDefault: project.billableDefault,
        archived: project.archived,
      })),
      clients: clients.data ?? [],
      tasks: tasks.data ?? [],
      tags: tags.data ?? [],
      reportRange,
      searching: search.trim() !== "",
    });
  }, [
    clients.data,
    discardPage,
    projects.data,
    quickStarts.items,
    reportRange,
    runningView,
    search,
    sections,
    t,
    tags.data,
    tasks.data,
  ]);

  const run = (item: PaletteItem): void => {
    runPaletteAction(item.action, {
      mutations,
      navigate: (href) => router.push(href),
      running,
      close,
      setPage,
    });
  };

  return (
    <>
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder={t("palette.placeholder")}
        onKeyDown={(event) => {
          // Backspace on an empty confirmation goes back, like a breadcrumb.
          if (discardPage && event.key === "Backspace" && search === "") {
            event.preventDefault();
            setPage("root");
          }
        }}
        data-testid="command-palette-input"
      />
      <CommandList className="max-h-[min(24rem,60dvh)]">
        <CommandEmpty>{t("palette.empty")}</CommandEmpty>
        {groups.map((group) => (
          <CommandGroup
            key={group.id}
            heading={group.heading}
            data-testid={`command-palette-group-${group.id}`}
          >
            {group.items.map((item) => (
              <PaletteRow key={item.id} item={item} onRun={run} />
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </>
  );
}

function PaletteRow({
  item,
  onRun,
}: {
  item: PaletteItem;
  onRun: (item: PaletteItem) => void;
}): React.JSX.Element {
  const Icon = item.icon;
  return (
    <CommandItem
      value={item.id}
      keywords={item.keywords}
      onSelect={() => onRun(item)}
      className={cn(
        item.destructive &&
          "text-destructive data-[selected=true]:text-destructive",
      )}
      data-testid={`command-palette-item-${item.id}`}
    >
      {item.color === null ? (
        <Icon aria-hidden="true" />
      ) : (
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: item.color }}
        />
      )}
      <span className="min-w-0 truncate">{item.label}</span>
      {item.hint === null ? null : (
        <span className="ml-auto min-w-0 shrink truncate pl-2 text-xs text-muted-foreground">
          {item.hint}
        </span>
      )}
    </CommandItem>
  );
}
