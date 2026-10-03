"use client";

import * as React from "react";
import type { DetailedEntry } from "@starter/shared";
import { CommandGroup, CommandItem } from "@/components/ui/command";
import { useAuth } from "@/hooks/use-auth";
import { useActiveWorkspace } from "@/components/workspace-switcher";
import { getAbsoluteApiOrigin } from "@/lib/api-origin";
import { getActiveWorkspaceId } from "@/lib/active-workspace";
import { trpc } from "@/lib/trpc";
import { useT } from "@/i18n/use-t";
import { useFormat } from "@/i18n/use-format";
import { useEntrySearch, type FetchEntrySearch } from "./use-entry-search";

export function EntrySearchResults({ search, onOpen }: { search: string; onOpen: (entry: DetailedEntry) => void }): React.JSX.Element | null {
  const { user } = useAuth();
  const { activeId } = useActiveWorkspace();
  const server = getAbsoluteApiOrigin();
  const utils = trpc.useUtils();
  const fetchEntries = React.useCallback<FetchEntrySearch>((input, signal) => utils.client.entries.list.query(input, { signal }), [utils]);
  const scope = user && activeId ? { userId: user.id, workspaceId: activeId, server } : null;
  const state = useEntrySearch(search, scope, fetchEntries);
  const t = useT("shell");
  const tc = useT("common");
  const f = useFormat();
  if (!search.trim()) return null;
  return <CommandGroup heading={t("palette.entries")} forceMount data-testid="command-palette-entry-search">
    {!scope ? <p role="status" className="px-2 py-3 text-sm">{t("palette.searchWaiting")}</p> :
      state.status === "loading" ? <p role="status" className="px-2 py-3 text-sm">{t("palette.searchLoading")}</p> :
      state.status === "error" ? <CommandItem forceMount value="entry-search-retry" onSelect={state.retry}>{t("palette.searchError")}</CommandItem> :
      state.entries.length === 0 ? <p role="status" className="px-2 py-3 text-sm">{t("palette.searchEmpty")}</p> : null}
    {state.entries.map((entry) => <CommandItem forceMount key={entry.id} value={`entry-result-${entry.id}`} data-testid={`command-palette-entry-${entry.id}`}
      onSelect={() => {
        if (entry.workspaceId === getActiveWorkspaceId() && server === getAbsoluteApiOrigin()) onOpen(entry);
      }}>
      <span className="min-w-0 truncate">{entry.description || tc("empty.noDescription")}</span>
      <span className="ml-auto max-w-[45%] truncate text-xs text-muted-foreground">{f.date(entry.start)} · {entry.projectName ?? tc("empty.noProject")}</span>
    </CommandItem>)}
    {state.more ? <p className="px-2 py-2 text-xs text-muted-foreground">{t("palette.searchMore")}</p> : null}
  </CommandGroup>;
}
