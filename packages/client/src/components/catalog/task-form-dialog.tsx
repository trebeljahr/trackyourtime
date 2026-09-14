"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { translate, useT } from "@/i18n/use-t";
import type { TaskRow } from "./types";
import { useTaskMutations } from "./use-catalog-mutations";

export type TaskFormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Omitted/null creates; otherwise the dialog edits this task. */
  task?: TaskRow | null;
  /**
   * Called with the newly created task. Lets a caller act on the result — the
   * tracker's task picker selects it immediately, so "New task…" leaves you
   * ready to start the timer.
   */
  onCreated?: (task: { id: string; name: string }) => void;
};

/**
 * The create/edit form behind every "New task…" surface. A task is a
 * workspace-wide label for a kind of work, so a name is all it needs — there
 * is no project to file it under.
 */
export function TaskFormDialog({
  open,
  onOpenChange,
  task,
  onCreated,
}: TaskFormDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="task-dialog">
        {open ? (
          <TaskForm
            key={task?.id ?? "new"}
            task={task ?? null}
            onDone={(created) => {
              onOpenChange(false);
              if (created) onCreated?.(created);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type TaskFormProps = {
  task: TaskRow | null;
  /** Receives the created task on create; nothing on edit. */
  onDone: (created?: { id: string; name: string }) => void;
};

function TaskForm({ task, onDone }: TaskFormProps): React.JSX.Element {
  const t = useT("catalog");
  const tc = useT("common");
  const [name, setName] = React.useState(task?.name ?? "");
  const [nameError, setNameError] = React.useState<string | null>(null);

  const { createTask, updateTask, isSaving } = useTaskMutations({
    onConflict: setNameError,
  });

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setNameError(null);

    const trimmed = name.trim();
    if (trimmed === "") {
      setNameError(t("form.nameRequired"));
      return;
    }

    if (task) {
      void updateTask({ id: task.id, name: trimmed }).then((saved) => {
        if (!saved) return;
        toast.success(translate("catalog")("tasks.form.saved"));
        onDone();
      });
      return;
    }

    void createTask({ name: trimmed }).then((created) => {
      if (!created) return;
      toast.success(
        translate("catalog")("tasks.form.created", { name: created.name }),
      );
      onDone({ id: created.id, name: created.name });
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>
          {task ? t("tasks.form.titleEdit") : t("tasks.form.titleNew")}
        </DialogTitle>
        <DialogDescription>{t("tasks.form.description")}</DialogDescription>
      </DialogHeader>

      <div className="space-y-2">
        <Label htmlFor="task-name">{tc("fields.name")}</Label>
        <Input
          id="task-name"
          value={name}
          autoFocus
          maxLength={200}
          placeholder={t("tasks.form.namePlaceholder")}
          aria-invalid={nameError !== null}
          onChange={(event) => {
            setName(event.target.value);
            if (nameError) setNameError(null);
          }}
          data-testid="task-name-input"
        />
        {nameError ? (
          <p className="text-sm text-destructive" data-testid="task-name-error">
            {nameError}
          </p>
        ) : null}
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          // Wrapped: onDone takes an optional created task, and passing it
          // straight to onClick would hand it the mouse event instead.
          onClick={() => onDone()}
          data-testid="task-cancel"
        >
          {tc("actions.cancel")}
        </Button>
        <Button type="submit" disabled={isSaving} data-testid="task-submit">
          {task ? t("form.saveChanges") : t("tasks.form.create")}
        </Button>
      </DialogFooter>
    </form>
  );
}
