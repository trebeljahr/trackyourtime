"use client";

import { useTaskOptions } from "@/hooks/use-catalog-options";

import * as React from "react";

import { CatalogScreen } from "@/components/catalog/catalog-screen";
import { TaskFormDialog } from "@/components/catalog/task-form-dialog";
import { TasksTable } from "@/components/catalog/tasks-table";
import { TASK_LIST_INPUT, type TaskTableRow } from "@/components/catalog/types";
import { useFormatSettings } from "@/lib/format";
import { useT } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";

export default function TasksPage(): React.JSX.Element {
  const t = useT("catalog");
  const tc = useT("common");
  const format = useFormatSettings();

  const [search, setSearch] = React.useState("");
  const [showArchived, setShowArchived] = React.useState(false);
  const [creating, setCreating] = React.useState(false);

  const metadata = useTaskOptions(TASK_LIST_INPUT);
  const tasksQuery = trpc.tasks.list.useQuery(TASK_LIST_INPUT, {
    staleTime: 30_000,
  });

  const allTasks = React.useMemo<TaskTableRow[]>(
    () => {
      const stats = new Map(tasksQuery.data?.map((row) => [row.id, row]));
      return (metadata.data ?? tasksQuery.data ?? []).map((row) => {
        const totals = stats.get(row.id);
        return totals ? { ...row, entryCount: totals.entryCount, totalSec: totals.totalSec, projectIds: totals.projectIds } : row;
      });
    },
    [metadata.data, tasksQuery.data],
  );

  const needle = search.trim().toLowerCase();

  const visibleTasks = React.useMemo(
    () =>
      allTasks.filter((task) => {
        if (!showArchived && task.archived) return false;
        if (needle === "") return true;
        return task.name.toLowerCase().includes(needle);
      }),
    [allTasks, showArchived, needle],
  );

  const trackedTotal = visibleTasks.reduce(
    (sum, task) => sum + (task.totalSec ?? 0),
    0,
  );
  return (
    <CatalogScreen
      title={tc("fields.tasks")}
      description={t("tasks.description")}
      actionLabel={t("tasks.new")}
      onAction={() => setCreating(true)}
      actionTestId="new-task"
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder={t("tasks.search")}
      showArchived={showArchived}
      onShowArchivedChange={setShowArchived}
      summary={t("tasks.summary", {
        count: visibleTasks.length,
        duration: tasksQuery.data ? format.duration(trackedTotal) : "—",
      })}
      hasError={tasksQuery.isError}
      testId="tasks-page"
    >
      <TasksTable
        tasks={visibleTasks}
        isLoading={metadata.isPending && tasksQuery.isPending}
        isFiltered={needle !== ""}
        onCreate={() => setCreating(true)}
      />

      <TaskFormDialog open={creating} onOpenChange={setCreating} />
    </CatalogScreen>
  );
}
