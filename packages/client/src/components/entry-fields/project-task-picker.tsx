"use client";

import * as React from "react";
import { Building2 } from "lucide-react";
import { withProject, withTask, type EntryFields } from "@starter/core";

import { ProjectPicker } from "@/components/project-picker";
import { Label } from "@/components/ui/label";
import { TaskPicker } from "@/components/task-picker";
import { useT } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/**
 * The client of a project, or null when there is no project or no client.
 *
 * Read off the picked project rather than stored anywhere: a client is never
 * chosen for an entry, so there is no second copy of it that could drift.
 */
export const useProjectClientName = (projectId: string | null): string | null => {
  const projects = trpc.projects.list.useQuery({});
  if (projectId === null) return null;
  return (
    projects.data?.find((candidate) => candidate.id === projectId)
      ?.clientName ?? null
  );
};

export type ProjectTaskPickerProps = {
  value: EntryFields;
  /** `patch` is exactly the fields that changed, ready for `entries.update`. */
  onChange: (next: EntryFields, patch: Partial<EntryFields>) => void;
  /**
   * "row" lays the three out inline. "contents" dissolves the wrapper with
   * `display: contents`, so project, client and task become items of the
   * CALLER's grid rather than of a box inside one cell of it. The entry list
   * needs that: its rows share one column template so the columns line up
   * down the whole list, which only works if each field is a grid item in its
   * own right.
   */
  layout?: "row" | "contents";
  /** Give each picker a visible label — the dialog form, not the bar. */
  labelled?: boolean;
  disabled?: boolean;
  size?: "default" | "sm" | "lg";
  /** Borderless controls, for the tracker bar and entry rows. */
  bare?: boolean;
  /**
   * Extra classes for the two pickers themselves — height and width, when the
   * caller's layout decides those. `contents` callers need it: their tracks
   * are sized by the caller's grid, not by this component.
   */
  controlClassName?: string;
  testIdPrefix: string;
  className?: string;
};

/**
 * Project and task, laid out together because they are read together — not
 * because either owns the other.
 *
 * The two references are independent: a task names WHAT the work was, a
 * project names what it was FOR, and every combination of the two is a legal
 * entry. So changing one never touches the other, and the client between them
 * is read off the project rather than picked. The project only narrows which
 * tasks the task picker suggests.
 */
export function ProjectTaskPicker({
  value,
  onChange,
  layout = "row",
  labelled = false,
  disabled = false,
  size = "default",
  bare = false,
  controlClassName,
  testIdPrefix,
  className,
}: ProjectTaskPickerProps): React.JSX.Element {
  const t = useT("tracker");
  const tc = useT("common");
  const clientName = useProjectClientName(value.projectId);

  const handleProject = React.useCallback(
    (projectId: string | null): void => {
      const next = withProject(value, projectId);
      if (next === value) return;
      onChange(next, { projectId: next.projectId });
    },
    [onChange, value]
  );

  const handleTask = React.useCallback(
    (taskId: string | null): void => {
      const next = withTask(value, taskId);
      if (next === value) return;
      onChange(next, { taskId: next.taskId });
    },
    [onChange, value]
  );

  const contents = layout === "contents";
  const control = bare ? "border-0 shadow-none" : "w-full";
  const [projectOpen, setProjectOpen] = React.useState(false);

  /**
   * The client, read-only — but a way into the project picker.
   *
   * Never a picker of its own: a client owns projects and an entry points at a
   * project — so choosing one here would be a second source of truth that can
   * disagree with the project's own client. Shown rather than chosen is what
   * keeps "Redesign" unambiguous when two clients both have one.
   *
   * It still reads as a field, sitting between two pickers, and a label that
   * ignores a click looks broken rather than derived. So clicking it opens
   * the project picker, whose list is grouped by client: the way to move an
   * entry to another client IS to file it under one of that client's
   * projects, and the title says so.
   *
   * How much room it earns depends on where it is. In the caller's grid it
   * owns a track that collapses to 0px on narrower viewports, so it must stay
   * a rendered item whatever it says — `display: none` would drop it and slide
   * every later column one track left. In the labelled form it sits under the
   * project and says "No client" when there is none, which is information. On
   * a bar competing for width it is neither, so it goes away entirely.
   */
  const clientLabel = (
    <>
      <Building2 className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{clientName ?? tc("empty.noClient")}</span>
    </>
  );
  const clientClassName = cn(
    "min-w-0 items-center gap-1 truncate text-xs text-muted-foreground",
    contents
      ? "hidden min-[1140px]:flex"
      : labelled
        ? "flex"
        : "hidden max-w-32 shrink lg:inline-flex"
  );
  const clientTitle =
    clientName === null
      ? tc("empty.noClient")
      : t("entryFields.clientTitle", { name: clientName });
  const client =
    !contents && !labelled && clientName === null ? null : disabled ? (
      <span
        className={clientClassName}
        title={clientTitle}
        data-testid={`${testIdPrefix}-client`}
      >
        {clientLabel}
      </span>
    ) : (
      <button
        type="button"
        className={cn(
          clientClassName,
          "cursor-pointer rounded px-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        )}
        title={t("entryFields.clientHint", { title: clientTitle })}
        onClick={() => setProjectOpen(true)}
        data-testid={`${testIdPrefix}-client`}
      >
        {clientLabel}
      </button>
    );

  const project = (
    <ProjectPicker
      value={value.projectId}
      onChange={handleProject}
      disabled={disabled}
      size={size}
      className={cn(control, !contents && !bare && "flex-1", controlClassName)}
      testId={`${testIdPrefix}-project`}
      open={projectOpen}
      onOpenChange={setProjectOpen}
    />
  );

  const task = (
    <TaskPicker
      value={value.taskId}
      onChange={handleTask}
      projectId={value.projectId}
      disabled={disabled}
      size={size}
      className={cn(control, !contents && !bare && "flex-1", controlClassName)}
      testId={`${testIdPrefix}-task`}
    />
  );

  // `display: contents` is the whole point: the caller laid out the tracks,
  // and this component only decides what goes in them and how the three stay
  // consistent with each other.
  if (contents) {
    return (
      <>
        {project}
        {client}
        {task}
      </>
    );
  }

  // The labelled form keeps the client under the project it belongs to, which
  // is the only placement that reads as "this project's client" rather than as
  // a third thing to pick.
  if (labelled) {
    return (
      <div className={cn("flex flex-wrap gap-3", className)}>
        <div className="min-w-48 flex-1 space-y-2">
          <Label>{tc("fields.project")}</Label>
          {project}
          {client}
        </div>
        <div className="min-w-48 flex-1 space-y-2">
          <Label>{tc("fields.task")}</Label>
          {task}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}
    >
      {project}
      {client}
      {task}
    </div>
  );
}
