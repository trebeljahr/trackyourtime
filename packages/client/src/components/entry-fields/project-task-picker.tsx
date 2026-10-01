"use client";

import * as React from "react";
import { Combobox } from "@/components/ui/combobox";
import { useServerSupports } from "@/lib/server-level";
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
 * Used only as a default for legacy entries without their own client.
 */
export const useProjectClientName = (
  projectId: string | null,
): string | null => {
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

/** Independent project, client and task fields, shared by every entry editor. */
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
  const clients = trpc.clients.list.useQuery({});
  const projects = trpc.projects.list.useQuery({});
  const supportsClient = useServerSupports("entries.client");
  const tc = useT("common");
  const selectedClient =
    value.clientId === undefined
      ? (projects.data?.find((project) => project.id === value.projectId)
          ?.clientId ?? null)
      : value.clientId;

  const handleProject = React.useCallback(
    (projectId: string | null): void => {
      const next = withProject(value, projectId);
      if (next === value) return;
      const clientPatch =
        supportsClient && value.clientId === undefined
          ? { clientId: selectedClient }
          : {};
      onChange(
        { ...next, ...clientPatch },
        { projectId: next.projectId, ...clientPatch },
      );
    },
    [onChange, value, supportsClient, selectedClient],
  );

  const handleTask = React.useCallback(
    (taskId: string | null): void => {
      const next = withTask(value, taskId);
      if (next === value) return;
      onChange(next, { taskId: next.taskId });
    },
    [onChange, value],
  );

  const contents = layout === "contents";
  const control = bare ? "border-0 shadow-none" : "w-full";
  const [projectOpen, setProjectOpen] = React.useState(false);

  const client = (
    <Combobox
      options={(clients.data ?? []).map((client) => ({
        value: client.id,
        label: client.name,
        color: client.color,
      }))}
      value={selectedClient}
      onChange={(clientId) => onChange({ ...value, clientId }, { clientId })}
      placeholder={tc("empty.noClient")}
      allowClear
      clearLabel={tc("empty.noClient")}
      aria-label={tc("fields.client")}
      disabled={disabled || !supportsClient}
      title={!supportsClient ? t("entryFields.clientNeedsUpdate") : undefined}
      size={size}
      className={cn(control, "min-w-0", controlClassName)}
      data-testid={`${testIdPrefix}-client`}
    />
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

  if (labelled) {
    return (
      <div className={cn("flex flex-wrap gap-3", className)}>
        <div className="min-w-48 flex-1 space-y-2">
          <Label>{tc("fields.project")}</Label>
          {project}
        </div>
        <div className="min-w-48 flex-1 space-y-2">
          <Label>{tc("fields.client")}</Label>
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
    <div className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}>
      {project}
      {client}
      {task}
    </div>
  );
}
