"use client";

import { useMemo } from "react";
import type { ClientListInput, ProjectListInput, TaskListInput } from "@starter/shared";
import { trpc } from "@/lib/trpc";

export const CATALOG_OPTIONS_INPUT = { includeArchived: true } as const;
type Options = { enabled?: boolean; staleTime?: number };

/** One metadata cache per catalog. Screens and pickers select from the same rows. */
export function useProjectOptions(input: ProjectListInput = {}, options: Options = {}) {
  const query = trpc.projects.options.useQuery(CATALOG_OPTIONS_INPUT, options);
  const data = useMemo(() => query.data?.filter((row) =>
    (input.includeArchived || !row.archived) &&
    (input.clientId === undefined || row.clientId === input.clientId),
  ), [query.data, input.includeArchived, input.clientId]);
  return { ...query, data };
}

export function useClientOptions(input: ClientListInput = {}, options: Options = {}) {
  const query = trpc.clients.options.useQuery(CATALOG_OPTIONS_INPUT, options);
  const data = useMemo(() => query.data?.filter((row) => input.includeArchived || !row.archived), [query.data, input.includeArchived]);
  return { ...query, data };
}

export function useTaskOptions(input: TaskListInput = {}, options: Options = {}) {
  const query = trpc.tasks.options.useQuery(CATALOG_OPTIONS_INPUT, options);
  // Associations improve sorting once available; never hold the task list for them.
  const links = trpc.tasks.projectLinks.useQuery({}, { ...options, staleTime: 60_000 });
  const data = useMemo(() => query.data?.filter((row) => input.includeArchived || !row.archived)
    .map((row) => ({ ...row, projectIds: links.data?.[row.id] ??
      ("projectIds" in row && Array.isArray(row.projectIds) ? row.projectIds as string[] : []) })), [query.data, input.includeArchived, links.data]);
  return { ...query, data };
}
