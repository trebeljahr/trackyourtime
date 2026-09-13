"use client";

import * as React from "react";
import {
  Archive,
  ArchiveRestore,
  FolderKanban,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";

import { BudgetMeterCell } from "@/components/budget-meter";
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
import { budgetView } from "@/lib/budget-view";
import { formatMoney, useFormatSettings } from "@/lib/format";
import { useAllTimeRange } from "@/lib/entry-links";
import { useApplyToEntriesPrompt } from "./apply-to-entries-prompt";
import { CatalogName } from "./catalog-name";
import { ClientFormDialog } from "./client-form-dialog";
import { ConfirmDialog } from "./confirm-dialog";
import { EntriesLink, ShowEntriesItem } from "./entries-link";
import { ProjectBillingCell } from "./project-billing-cell";
import { ProjectFormDialog } from "./project-form-dialog";
import type { ClientRow, ProjectRow } from "./types";
import { useProjectMutations } from "./use-catalog-mutations";

export type ProjectsTableProps = {
  projects: ProjectRow[];
  clients: ClientRow[];
  isLoading: boolean;
  /** True when filters are hiding rows, so the empty state can say so. */
  isFiltered: boolean;
  onCreate: () => void;
};

export function ProjectsTable({
  projects,
  clients,
  isLoading,
  isFiltered,
  onCreate,
}: ProjectsTableProps): React.JSX.Element {
  const format = useFormatSettings();
  const { setProjectArchived, removeProject, updateProject } =
    useProjectMutations();
  // One prompt for every row's billing cell, so the table mounts one dialog.
  const applyPrompt = useApplyToEntriesPrompt();
  // Both roll-up columns are lifetime totals, so the entry log they open has
  // to span the same thing.
  const allTime = useAllTimeRange();

  // A budget carries its own currency, so the meter formats money with that
  // one rather than through `format.money`, which is bound to the workspace.
  const budgetFormat = React.useMemo(
    () => ({
      durationShort: format.durationShort,
      money: formatMoney,
      fallbackCurrency: format.currency,
    }),
    [format.durationShort, format.currency],
  );

  const [editing, setEditing] = React.useState<ProjectRow | null>(null);
  /** The project row's client, opened for editing from the Client cell. */
  const [editingClient, setEditingClient] = React.useState<ClientRow | null>(
    null,
  );
  const [pendingDelete, setPendingDelete] = React.useState<ProjectRow | null>(
    null,
  );

  if (isLoading) {
    return (
      <div className="space-y-2" data-testid="projects-loading">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <EmptyState
        icon={FolderKanban}
        title={isFiltered ? "No projects match these filters" : "No projects yet"}
        description={
          isFiltered
            ? "Try clearing the search or client filter, or turn on “Show archived”."
            : "Projects group tracked time and carry the billing defaults for new entries."
        }
        action={
          isFiltered ? undefined : (
            <Button onClick={onCreate} data-testid="projects-empty-create">
              <Plus className="size-4" />
              New project
            </Button>
          )
        }
        testId="projects-empty"
      />
    );
  }

  return (
    <>
      <div className="rounded-lg border border-border">
        <Table data-testid="projects-table">
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Billing</TableHead>
              <TableHead className="text-right">Tracked</TableHead>
              <TableHead className="w-56">Budget</TableHead>
              <TableHead className="text-right">Entries</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.map((project) => {
              return (
                <React.Fragment key={project.id}>
                  <TableRow
                    data-testid={`project-row-${project.id}`}
                    data-archived={project.archived ? "true" : "false"}
                  >
                    <TableCell>
                      <CatalogName
                        name={project.name}
                        color={project.color}
                        archived={project.archived}
                        editLabel={`Edit project "${project.name}"`}
                        onEdit={() => setEditing(project)}
                        testId={`project-name-${project.id}`}
                      />
                    </TableCell>

                    <TableCell className="text-muted-foreground">
                      {project.clientName ? (
                        <CatalogName
                          name={project.clientName}
                          color={project.clientColor}
                          nameClassName="font-normal"
                          editLabel={`Edit client "${project.clientName}"`}
                          onEdit={() => {
                            const client = clients.find(
                              (row) => row.id === project.clientId,
                            );
                            if (client) setEditingClient(client);
                          }}
                          testId={`project-client-${project.id}`}
                        />
                      ) : (
                        <span className="text-muted-foreground/70">—</span>
                      )}
                    </TableCell>

                    <TableCell>
                      <ProjectBillingCell
                        project={project}
                        prompt={applyPrompt}
                        updateProject={updateProject}
                      />
                    </TableCell>

                    <TableCell
                      className="text-right tabular-nums"
                      data-testid={`project-tracked-${project.id}`}
                    >
                      <EntriesLink
                        target={{ dimension: "project", id: project.id }}
                        range={allTime}
                        label={project.name}
                        testId={`project-tracked-link-${project.id}`}
                      >
                        {format.duration(project.totalSec)}
                      </EntriesLink>
                    </TableCell>

                    <TableCell data-testid={`project-budget-${project.id}`}>
                      <BudgetMeterCell
                        view={budgetView(project.progress, budgetFormat)}
                        emptyLabel="No budget"
                        testId={`project-budget-meter-${project.id}`}
                      />
                    </TableCell>

                    <TableCell
                      className="text-right tabular-nums text-muted-foreground"
                      data-testid={`project-entries-${project.id}`}
                    >
                      <EntriesLink
                        target={{ dimension: "project", id: project.id }}
                        range={allTime}
                        label={project.name}
                        testId={`project-entries-link-${project.id}`}
                      >
                        {project.entryCount}
                      </EntriesLink>
                    </TableCell>

                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            aria-label={`Actions for ${project.name}`}
                            data-testid={`project-menu-${project.id}`}
                          >
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <ShowEntriesItem
                            target={{ dimension: "project", id: project.id }}
                            range={allTime}
                            testId={`project-entries-menu-${project.id}`}
                          />
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={() => setEditing(project)}
                            data-testid={`project-edit-${project.id}`}
                          >
                            <Pencil className="size-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              setProjectArchived(project.id, !project.archived)
                            }
                            data-testid={`project-archive-${project.id}`}
                          >
                            {project.archived ? (
                              <ArchiveRestore className="size-4" />
                            ) : (
                              <Archive className="size-4" />
                            )}
                            {project.archived ? "Unarchive" : "Archive"}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => setPendingDelete(project)}
                            data-testid={`project-delete-${project.id}`}
                          >
                            <Trash2 className="size-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                </React.Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <ClientFormDialog
        open={editingClient !== null}
        onOpenChange={(next) => {
          if (!next) setEditingClient(null);
        }}
        client={editingClient}
      />

      <ProjectFormDialog
        open={editing !== null}
        onOpenChange={(next) => {
          if (!next) setEditing(null);
        }}
        project={editing}
        clients={clients}
      />

      {applyPrompt.dialog}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
        title={`Delete "${pendingDelete?.name ?? ""}"?`}
        description={
          pendingDelete && pendingDelete.entryCount > 0
            ? `Its tasks are deleted with it. ${pendingDelete.entryCount} time ${
                pendingDelete.entryCount === 1 ? "entry" : "entries"
              } keep their tracked time and become project-less. Archive instead if you want to keep the project.`
            : "This project has no tracked time. It is deleted along with its tasks."
        }
        confirmLabel="Delete project"
        onConfirm={() => {
          if (pendingDelete) removeProject(pendingDelete.id);
          setPendingDelete(null);
        }}
        testId="confirm-project-delete"
      />
    </>
  );
}
