import { useState, type JSX } from "react";
import type { Task } from "@starter/core";
import { useT } from "../i18n/use-t";
import { RenamePanel, useCatalogEdit } from "./catalog-edit";
import { Combobox } from "./combobox";
import { useSelectWhenCreated } from "./use-created-row";

/**
 * Pick a task, make one, or rename one.
 *
 * Tasks are a flat, workspace-wide list, independent of the project beside
 * them, so nothing here reads or changes the project. Shared by the tracker's
 * composer and the entry form, which each used to carry their own copy of the
 * combobox wiring.
 */
export type TaskPickerProps = {
  tasks: Task[];
  value: string | null;
  onChange: (taskId: string | null) => void;
  disabled?: boolean;
  disabledHint?: string;
  onCreate: (name: string) => Promise<boolean>;
  /** True while a create or rename panel is open; see `ProjectPicker`. */
  onPendingChange?: (pending: boolean) => void;
  testId: string;
};

export function TaskPicker({
  tasks,
  value,
  onChange,
  disabled = false,
  disabledHint,
  onCreate,
  onPendingChange,
  testId,
}: TaskPickerProps): JSX.Element {
  const t = useT("popup");
  const edit = useCatalogEdit();
  const [panel, setPanel] = useState<
    { mode: "create" } | { mode: "edit"; task: Task } | null
  >(null);

  const createTask = useSelectWhenCreated(tasks, (task) => {
    onChange(task.id);
  });

  const open = (next: NonNullable<typeof panel>): void => {
    setPanel(next);
    onPendingChange?.(true);
  };

  const close = (): void => {
    setPanel(null);
    onPendingChange?.(false);
  };

  if (panel?.mode === "create") {
    return (
      <RenamePanel
        title={t("catalogEdit.newTaskTitle")}
        row={{ id: "", name: "" }}
        create
        onSave={async ({ name }) => {
          if (name === undefined) return false;
          let created = false;
          await createTask(name, async () => {
            created = await onCreate(name);
            return created;
          });
          return created;
        }}
        onClose={close}
        testId={`${testId}-new`}
      />
    );
  }

  if (panel?.mode === "edit") {
    return (
      <RenamePanel
        title={t("catalogEdit.editTaskTitle", { name: panel.task.name })}
        row={{ id: panel.task.id, name: panel.task.name }}
        onSave={({ name }) =>
          edit === null || name === undefined
            ? Promise.resolve(false)
            : edit.updateTask(panel.task.id, { name })
        }
        onClose={close}
        testId={`${testId}-edit`}
      />
    );
  }

  return (
    <Combobox
      label={t("fields.task")}
      options={tasks.map((task) => ({ id: task.id, label: task.name }))}
      value={value}
      onChange={onChange}
      emptyLabel={t("fields.noTask")}
      placeholder={t("fields.searchTasks")}
      disabled={disabled}
      disabledHint={disabledHint}
      onCreate={async (name) => {
        await createTask(name, () => onCreate(name));
      }}
      createLabel={(name) => t("fields.createTask", { name })}
      onNew={() => open({ mode: "create" })}
      newLabel={t("catalogEdit.newTask")}
      onEdit={
        edit === null
          ? undefined
          : (id) => {
              const task = tasks.find((candidate) => candidate.id === id);
              if (task) open({ mode: "edit", task });
            }
      }
      editLabel={(name) => t("catalogEdit.editTask", { name })}
      testId={testId}
    />
  );
}
