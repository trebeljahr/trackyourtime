"use client";

import * as React from "react";
import {
  Archive,
  ArchiveRestore,
  ListChecks,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
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
import { ConfirmDialog } from "./confirm-dialog";
import { EntriesLink, ShowEntriesItem } from "./entries-link";
import { TaskFormDialog } from "./task-form-dialog";
import type { TaskRow } from "./types";
import { useTaskMutations } from "./use-catalog-mutations";

export type TasksTableProps = {
  tasks: TaskRow[];
  isLoading: boolean;
  /** True when filters are hiding rows, so the empty state can say so. */
  isFiltered: boolean;
  onCreate: () => void;
};

/** Every task in the workspace — the Tasks manage screen. */
export function TasksTable({
  tasks,
  isLoading,
  isFiltered,
  onCreate,
}: TasksTableProps): React.JSX.Element {
  const t = useT("catalog");
  const tc = useT("common");
  const f = useFormat();
  const format = useFormatSettings();
  const { setTaskArchived, removeTask } = useTaskMutations();
  // The Tracked column is a lifetime total, so its link has to span one too.
  const allTime = useAllTimeRange();

  const [editing, setEditing] = React.useState<TaskRow | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<TaskRow | null>(
    null,
  );

  if (isLoading) {
    return (
      <div className="space-y-2" data-testid="tasks-loading">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <EmptyState
        icon={ListChecks}
        title={
          isFiltered ? t("tasks.empty.filteredTitle") : t("tasks.empty.title")
        }
        description={
          isFiltered
            ? t("tasks.empty.filteredDescription")
            : t("tasks.empty.description")
        }
        action={
          isFiltered ? undefined : (
            <Button onClick={onCreate} data-testid="tasks-empty-create">
              <Plus className="size-4" />
              {t("tasks.new")}
            </Button>
          )
        }
        testId="tasks-empty"
      />
    );
  }

  return (
    <>
      <div className="rounded-lg border border-border">
        <Table data-testid="tasks-table">
          <TableHeader>
            <TableRow>
              <TableHead>{tc("fields.task")}</TableHead>
              <TableHead className="text-right">{t("columns.tracked")}</TableHead>
              <TableHead className="text-right">{t("columns.entries")}</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.map((task) => (
              <TableRow
                key={task.id}
                data-testid={`task-row-${task.id}`}
                data-archived={task.archived ? "true" : "false"}
              >
                <TableCell>
                  <CatalogName
                    name={task.name}
                    color={task.color}
                    archived={task.archived}
                    editLabel={t("tasks.editLabel", { name: task.name })}
                    onEdit={() => setEditing(task)}
                    nameTestId={`task-name-${task.id}`}
                  />
                </TableCell>

                <TableCell
                  className="text-right tabular-nums"
                  data-testid={`task-total-${task.id}`}
                >
                  <EntriesLink
                    target={{ dimension: "task", id: task.id }}
                    range={allTime}
                    label={task.name}
                    testId={`task-total-link-${task.id}`}
                  >
                    {format.duration(task.totalSec)}
                  </EntriesLink>
                </TableCell>

                <TableCell
                  className="text-right tabular-nums text-muted-foreground"
                  data-testid={`task-entries-${task.id}`}
                >
                  <EntriesLink
                    target={{ dimension: "task", id: task.id }}
                    range={allTime}
                    label={task.name}
                    testId={`task-entries-link-${task.id}`}
                  >
                    {f.number(task.entryCount)}
                  </EntriesLink>
                </TableCell>

                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label={t("row.actions", { name: task.name })}
                        data-testid={`task-menu-${task.id}`}
                      >
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <ShowEntriesItem
                        target={{ dimension: "task", id: task.id }}
                        range={allTime}
                        testId={`task-entries-menu-${task.id}`}
                      />
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() => setEditing(task)}
                        data-testid={`task-edit-${task.id}`}
                      >
                        <Pencil className="size-4" />
                        {tc("actions.edit")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() =>
                          setTaskArchived(task.id, !task.archived)
                        }
                        data-testid={`task-archive-${task.id}`}
                      >
                        {task.archived ? (
                          <ArchiveRestore className="size-4" />
                        ) : (
                          <Archive className="size-4" />
                        )}
                        {task.archived
                          ? tc("actions.unarchive")
                          : tc("actions.archive")}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => setPendingDelete(task)}
                        data-testid={`task-delete-${task.id}`}
                      >
                        <Trash2 className="size-4" />
                        {tc("actions.delete")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <TaskFormDialog
        open={editing !== null}
        onOpenChange={(next) => {
          if (!next) setEditing(null);
        }}
        task={editing}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
        title={t("tasks.delete.title", { name: pendingDelete?.name ?? "" })}
        description={
          pendingDelete && pendingDelete.totalSec > 0
            ? t("tasks.delete.withTime")
            : t("tasks.delete.noTime")
        }
        confirmLabel={t("tasks.delete.confirm")}
        onConfirm={() => {
          if (pendingDelete) removeTask(pendingDelete.id);
          setPendingDelete(null);
        }}
        testId="confirm-task-delete"
      />
    </>
  );
}
