"use client";

import * as React from "react";
import {
  Archive,
  ArchiveRestore,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Users,
} from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import { useFormatSettings } from "@/lib/format";
import { useAllTimeRange } from "@/lib/entry-links";
import { CatalogName } from "./catalog-name";
import { ClientFormDialog } from "./client-form-dialog";
import { ConfirmDialog } from "./confirm-dialog";
import { EntriesLink, ShowEntriesItem } from "./entries-link";
import type { ClientRow, ProjectRow } from "./types";
import { useClientMutations } from "./use-catalog-mutations";

/** Roll-ups a client owns, derived from the already-loaded project list. */
type ClientStats = {
  projectCount: number;
  totalSec: number;
  entryCount: number;
};

const EMPTY_STATS: ClientStats = {
  projectCount: 0,
  totalSec: 0,
  entryCount: 0,
};

export function clientStatsByClientId(
  projects: ProjectRow[],
): Map<string, ClientStats> {
  const stats = new Map<string, ClientStats>();
  for (const project of projects) {
    if (project.clientId === null) continue;
    const current = stats.get(project.clientId) ?? { ...EMPTY_STATS };
    stats.set(project.clientId, {
      projectCount: current.projectCount + 1,
      totalSec: current.totalSec + project.totalSec,
      entryCount: current.entryCount + project.entryCount,
    });
  }
  return stats;
}

export type ClientsTableProps = {
  clients: ClientRow[];
  /** Every project (archived included) — the source of the roll-ups. */
  projects: ProjectRow[];
  isLoading: boolean;
  isFiltered: boolean;
  onCreate: () => void;
};

export function ClientsTable({
  clients,
  projects,
  isLoading,
  isFiltered,
  onCreate,
}: ClientsTableProps): React.JSX.Element {
  const t = useT("catalog");
  const tc = useT("common");
  const f = useFormat();
  const format = useFormatSettings();
  const { setClientArchived, removeClient } = useClientMutations();
  // The roll-ups on these rows are lifetime totals, so the entry log they
  // link to has to be too.
  const allTime = useAllTimeRange();

  const [editing, setEditing] = React.useState<ClientRow | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<ClientRow | null>(
    null,
  );

  const stats = React.useMemo(
    () => clientStatsByClientId(projects),
    [projects],
  );

  const pendingStats = pendingDelete
    ? (stats.get(pendingDelete.id) ?? EMPTY_STATS)
    : EMPTY_STATS;

  if (isLoading) {
    return (
      <div className="space-y-2" data-testid="clients-loading">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  if (clients.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title={
          isFiltered
            ? t("clients.empty.filteredTitle")
            : t("clients.empty.title")
        }
        description={
          isFiltered
            ? t("clients.empty.filteredDescription")
            : t("clients.empty.description")
        }
        action={
          isFiltered ? undefined : (
            <Button onClick={onCreate} data-testid="clients-empty-create">
              <Plus className="size-4" />
              {t("clients.new")}
            </Button>
          )
        }
        testId="clients-empty"
      />
    );
  }

  return (
    <>
      <div className="rounded-lg border border-border">
        <Table data-testid="clients-table">
          <TableHeader>
            <TableRow>
              <TableHead>{tc("fields.client")}</TableHead>
              <TableHead className="text-right">{tc("fields.projects")}</TableHead>
              <TableHead className="text-right">{t("columns.tracked")}</TableHead>
              <TableHead className="text-right">{t("columns.entries")}</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {clients.map((client) => {
              const rollup = stats.get(client.id) ?? EMPTY_STATS;
              return (
                <TableRow
                  key={client.id}
                  data-testid={`client-row-${client.id}`}
                  data-archived={client.archived ? "true" : "false"}
                >
                  <TableCell>
                    <CatalogName
                      name={client.name}
                      color={client.color}
                      archived={client.archived}
                      editLabel={t("clients.editLabel", { name: client.name })}
                      onEdit={() => setEditing(client)}
                      testId={`client-name-${client.id}`}
                    />
                  </TableCell>

                  <TableCell
                    className="text-right tabular-nums text-muted-foreground"
                    data-testid={`client-projects-${client.id}`}
                  >
                    {f.number(rollup.projectCount)}
                  </TableCell>

                  <TableCell
                    className="text-right tabular-nums"
                    data-testid={`client-tracked-${client.id}`}
                  >
                    <EntriesLink
                      target={{ dimension: "client", id: client.id }}
                      range={allTime}
                      label={client.name}
                      testId={`client-tracked-link-${client.id}`}
                    >
                      {format.duration(rollup.totalSec)}
                    </EntriesLink>
                  </TableCell>

                  <TableCell
                    className="text-right tabular-nums text-muted-foreground"
                    data-testid={`client-entries-${client.id}`}
                  >
                    <EntriesLink
                      target={{ dimension: "client", id: client.id }}
                      range={allTime}
                      label={client.name}
                      testId={`client-entries-link-${client.id}`}
                    >
                      {f.number(rollup.entryCount)}
                    </EntriesLink>
                  </TableCell>

                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label={t("row.actions", { name: client.name })}
                          data-testid={`client-menu-${client.id}`}
                        >
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <ShowEntriesItem
                          target={{ dimension: "client", id: client.id }}
                          range={allTime}
                          testId={`client-entries-menu-${client.id}`}
                        />
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onSelect={() => setEditing(client)}
                          data-testid={`client-edit-${client.id}`}
                        >
                          <Pencil className="size-4" />
                          {tc("actions.edit")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() =>
                            setClientArchived(client.id, !client.archived)
                          }
                          data-testid={`client-archive-${client.id}`}
                        >
                          {client.archived ? (
                            <ArchiveRestore className="size-4" />
                          ) : (
                            <Archive className="size-4" />
                          )}
                          {client.archived
                            ? tc("actions.unarchive")
                            : tc("actions.archive")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => setPendingDelete(client)}
                          data-testid={`client-delete-${client.id}`}
                        >
                          <Trash2 className="size-4" />
                          {tc("actions.delete")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <ClientFormDialog
        open={editing !== null}
        onOpenChange={(next) => {
          if (!next) setEditing(null);
        }}
        client={editing}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
        title={t("clients.delete.title", { name: pendingDelete?.name ?? "" })}
        description={
          pendingStats.projectCount > 0
            ? t("clients.delete.withProjects", {
                projects: pendingStats.projectCount,
                entries: pendingStats.entryCount,
              })
            : t("clients.delete.noProjects")
        }
        confirmLabel={t("clients.delete.confirm")}
        onConfirm={() => {
          if (pendingDelete) removeClient(pendingDelete.id);
          setPendingDelete(null);
        }}
        testId="confirm-client-delete"
      />
    </>
  );
}
