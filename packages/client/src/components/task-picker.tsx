"use client";

import * as React from "react";

import { TaskFormDialog } from "@/components/catalog/task-form-dialog";
import { taskPickerOptions } from "@/components/task-picker-options";
import { Combobox } from "@/components/ui/combobox";
import { toast } from "@/components/ui/sonner";
import { ORIGIN_ID } from "@/hooks/use-sync";
import { translate } from "@/i18n/translate";
import { useT } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { userErrorMessage } from "@/lib/error-message";

export type TaskPickerProps = {
  value: string | null;
  onChange: (taskId: string | null) => void;
  /**
   * The project the entry is filed under. Only its tasks are suggested; the
   * rest stay reachable by typing. Null suggests every task.
   */
  projectId?: string | null;
  /** Show a "Create <name>" row for unmatched searches. */
  allowCreate?: boolean;
  disabled?: boolean;
  className?: string;
  size?: "default" | "sm" | "lg";
  testId?: string;
};

/**
 * Task selector for the tracker bar and entry rows.
 *
 * Tasks are a flat, workspace-wide list and this picker never changes the
 * project beside it. It does read it: with a project picked, only the tasks
 * booked on that project are suggested (`taskPickerOptions`), and the rest
 * are found by typing. Creating one inline is the point: naming a task should
 * never require a detour to the Tasks screen mid-timer.
 *
 * Two create surfaces, for the same reason the project picker has two. Typing
 * a name that matches nothing offers "Create <name>" — quick, but invisible
 * until you have already typed. "New task…" sits at the bottom of the list
 * whatever the query, and opens the full dialog.
 */
export function TaskPicker({
  value,
  onChange,
  projectId = null,
  allowCreate = true,
  disabled = false,
  className,
  size = "default",
  testId = "task-picker",
}: TaskPickerProps): React.JSX.Element {
  const t = useT("tracker");
  const tc = useT("common");
  const utils = trpc.useUtils();
  const [dialogOpen, setDialogOpen] = React.useState(false);

  const tasks = trpc.tasks.list.useQuery({});

  const createTask = trpc.tasks.create.useMutation({
    onSuccess: async (task) => {
      onChange(task.id);
      toast.success(
        translate("tracker")("taskPicker.created", { name: task.name })
      );
      await utils.tasks.invalidate();
    },
    onError: (error) => {
      toast.error(userErrorMessage(error));
    },
  });

  const otherHeading = t("taskPicker.otherTasks");
  const options = React.useMemo(
    () => taskPickerOptions(tasks.data ?? [], projectId, value, otherHeading),
    [tasks.data, projectId, value, otherHeading],
  );

  const handleCreate = React.useCallback(
    (name: string): void => {
      createTask.mutate({ name, originId: ORIGIN_ID });
    },
    [createTask],
  );

  const handleDialogCreated = React.useCallback(
    (task: { id: string }): void => onChange(task.id),
    [onChange],
  );

  return (
    <>
      <Combobox
        options={options}
        value={value}
        onChange={onChange}
        placeholder={tc("empty.noTask")}
        searchPlaceholder={t("taskPicker.searchPlaceholder")}
        emptyText={
          projectId === null
            ? t("taskPicker.empty")
            : t("taskPicker.emptyForProject")
        }
        allowClear
        clearLabel={tc("empty.noTask")}
        onCreate={allowCreate ? handleCreate : undefined}
        createLabel={(query) => t("taskPicker.createTask", { name: query })}
        disabled={disabled || createTask.isPending}
        size={size}
        className={cn("min-w-40", className)}
        data-testid={testId}
        footerActions={
          allowCreate
            ? [
                {
                  label: t("taskPicker.newTask"),
                  onSelect: () => setDialogOpen(true),
                  testId: "task-picker-new-task",
                },
              ]
            : undefined
        }
      />

      <TaskFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={handleDialogCreated}
      />
    </>
  );
}
