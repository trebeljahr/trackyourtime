"use client";

import * as React from "react";
import type { DetailedEntry } from "@starter/shared";
import { EntryEditDialog } from "@/components/tracker/entry-edit-dialog";
import { useEntryMutations } from "@/components/tracker/use-entry-mutations";
import { useAuth } from "@/hooks/use-auth";
import { useActiveWorkspace } from "@/components/workspace-switcher";
import { useActiveWorkspace as useWorkspacePermissions } from "@/components/members/use-active-workspace";
import { getAbsoluteApiOrigin } from "@/lib/api-origin";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/i18n/use-t";
import { useFormat } from "@/i18n/use-format";

export type SelectedSearchEntry = { entry: DetailedEntry; userId: string; server: string };
export function SearchEntryDialog({ selected, onClose }: { selected: SelectedSearchEntry; onClose: () => void }): React.JSX.Element | null {
  const { user } = useAuth();
  const { activeId } = useActiveWorkspace();
  const mutations = useEntryMutations();
  const { workspace } = useWorkspacePermissions();
  const t = useT("shell");
  const tc = useT("common");
  const f = useFormat();
  if (user?.id !== selected.userId || activeId !== selected.entry.workspaceId || getAbsoluteApiOrigin() !== selected.server) return null;
  const entry = selected.entry;
  if (entry.authorId === user.id) return <EntryEditDialog entry={entry} onClose={onClose} mutations={mutations} />;
  if (workspace?.id !== activeId || !workspace.permissions.viewOthersTime) return null;
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent data-testid="search-entry-details">
      <DialogHeader><DialogTitle>{entry.description || tc("empty.noDescription")}</DialogTitle><DialogDescription>{t("palette.entryReadOnly")}</DialogDescription></DialogHeader>
      <dl className="grid grid-cols-2 gap-2 text-sm">
        <dt>{tc("fields.project")}</dt><dd>{entry.projectName ?? tc("empty.noProject")}</dd>
        <dt>{tc("fields.task")}</dt><dd>{entry.taskName ?? "—"}</dd>
        <dt>{t("palette.entryStart")}</dt><dd>{f.date(entry.start)} {f.time(entry.start)}</dd>
        <dt>{t("palette.entryEnd")}</dt><dd>{entry.end ? `${f.date(entry.end)} ${f.time(entry.end)}` : t("palette.entryRunning")}</dd>
        <dt>{tc("fields.duration")}</dt><dd>{f.duration(entry.durationSec)}</dd>
      </dl>
    </DialogContent>
  </Dialog>;
}
