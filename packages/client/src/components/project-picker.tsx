"use client";

import * as React from "react";

import { ProjectFormDialog } from "@/components/catalog/project-form-dialog";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { toast } from "@/components/ui/sonner";
import { ORIGIN_ID } from "@/hooks/use-sync";
import { translate } from "@/i18n/translate";
import { useT } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { userErrorMessage } from "@/lib/error-message";

/** The minimum a picker row needs — matches `projects.list` output. */
export type PickableProject = {
  id: string;
  name: string;
  color: string;
  clientName?: string | null;
};

/**
 * Split a create query written as "Client / Project".
 *
 * Lets a whole client-and-project pair be created from the dropdown itself,
 * without a detour to the Projects screen. A query with no separator (or an
 * empty half) is just a project name.
 */
export const splitClientAndProject = (
  query: string
): { clientName: string | null; projectName: string } => {
  const separator = query.indexOf("/");
  if (separator === -1) return { clientName: null, projectName: query.trim() };

  const clientName = query.slice(0, separator).trim();
  const projectName = query.slice(separator + 1).trim();

  if (clientName === "" || projectName === "") {
    return { clientName: null, projectName: query.replace("/", " ").trim() };
  }
  return { clientName, projectName };
};

/**
 * Group by client so the list reads the way the sidebar does. `ungrouped` is
 * the heading, in the rendered language, for projects without a client.
 */
export const toProjectOptions = (
  projects: PickableProject[],
  ungrouped: string
): ComboboxOption[] =>
  projects.map((project) => ({
    value: project.id,
    label: project.name,
    color: project.color,
    group: project.clientName ?? ungrouped,
    keywords: [project.name, project.clientName ?? ungrouped],
  }));

export type ProjectPickerProps = {
  value: string | null;
  onChange: (projectId: string | null) => void;
  /** Show a "Create <name>" row for unmatched searches. */
  allowCreate?: boolean;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  size?: "default" | "sm" | "lg";
  testId?: string;
  /** Controlled open state, for a caller with a second way in — the client label. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/**
 * Project selector shared by the tracker bar, the entry rows and the report
 * filters. Reads the catalog straight from tRPC so it always reflects the
 * latest sync event without the caller threading data through.
 */
export function ProjectPicker({
  value,
  onChange,
  allowCreate = true,
  placeholder,
  disabled = false,
  className,
  size = "default",
  testId = "project-picker",
  open,
  onOpenChange,
}: ProjectPickerProps): React.JSX.Element {
  const t = useT("tracker");
  const tc = useT("common");
  const utils = trpc.useUtils();
  const projects = trpc.projects.list.useQuery({});
  const clients = trpc.clients.list.useQuery({});

  const createProject = trpc.projects.create.useMutation({
    onSuccess: async (project) => {
      onChange(project.id);
      toast.success(
        translate("tracker")("projectPicker.created", { name: project.name })
      );
      await utils.projects.invalidate();
    },
    onError: (error) => {
      toast.error(userErrorMessage(error));
    },
  });

  const createClient = trpc.clients.create.useMutation({
    onError: (error) => {
      toast.error(userErrorMessage(error));
    },
  });

  // Explicit create surfaces. The "Client / Project" shorthand is quick once
  // you know it, but it only appears after typing a name that matches nothing —
  // so on an empty workspace there was no visible way to make a project at all.
  // Only "New project…" lives here. A client is a property OF a project, so it
  // is created inside the project dialog rather than as a sibling action in a
  // picker that is about choosing a project.
  const [projectDialogOpen, setProjectDialogOpen] = React.useState(false);

  const ungrouped = tc("empty.noClient");
  const options = React.useMemo(
    () => toProjectOptions(projects.data ?? [], ungrouped),
    [projects.data, ungrouped]
  );

  /**
   * Create a project, and its client too when the query is written as
   * "Client / Project". An existing client of that name is reused rather than
   * duplicated (the server rejects duplicate names anyway), so typing the same
   * client repeatedly keeps filing projects under the one client.
   */
  const handleCreate = React.useCallback(
    (query: string): void => {
      const { clientName, projectName } = splitClientAndProject(query);

      if (clientName === null) {
        createProject.mutate({ name: projectName, originId: ORIGIN_ID });
        return;
      }

      const existing = (clients.data ?? []).find(
        (client) => client.name.toLowerCase() === clientName.toLowerCase()
      );

      if (existing) {
        createProject.mutate({
          name: projectName,
          clientId: existing.id,
          originId: ORIGIN_ID,
        });
        return;
      }

      createClient.mutate(
        { name: clientName, originId: ORIGIN_ID },
        {
          onSuccess: async (client) => {
            await utils.clients.invalidate();
            createProject.mutate({
              name: projectName,
              clientId: client.id,
              originId: ORIGIN_ID,
            });
          },
        }
      );
    },
    [clients.data, createClient, createProject, utils]
  );

  return (
    <>
      <Combobox
        options={options}
        value={value}
        onChange={onChange}
        placeholder={placeholder ?? tc("empty.noProject")}
        searchPlaceholder={t("projectPicker.searchPlaceholder")}
        emptyText={t("projectPicker.empty")}
        allowClear
        clearLabel={tc("empty.noProject")}
        onCreate={allowCreate ? handleCreate : undefined}
        createLabel={(query) => {
          const { clientName, projectName } = splitClientAndProject(query);
          return clientName
            ? t("projectPicker.createProjectForClient", {
                project: projectName,
                client: clientName,
              })
            : t("projectPicker.createProject", { project: projectName });
        }}
        createHint={t("projectPicker.createHint")}
        disabled={disabled || createProject.isPending || createClient.isPending}
        size={size}
        className={cn("min-w-48", className)}
        data-testid={testId}
        open={open}
        onOpenChange={onOpenChange}
        footerActions={
          allowCreate
            ? [
                {
                  label: t("projectPicker.newProject"),
                  onSelect: () => setProjectDialogOpen(true),
                  testId: "project-picker-new-project",
                },
              ]
            : undefined
        }
      />

      <ProjectFormDialog
        open={projectDialogOpen}
        onOpenChange={setProjectDialogOpen}
        clients={clients.data ?? []}
        onCreated={(project) => onChange(project.id)}
      />
    </>
  );
}
