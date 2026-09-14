"use client";

import type { WorkspaceSummary } from "@starter/shared";

import { pickActiveWorkspace } from "@/components/members/member-rules";
import { trpc } from "@/lib/trpc";

export type ActiveWorkspace = {
  workspace: WorkspaceSummary | null;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
};

/**
 * The workspace the screens are showing, with the viewer's permissions in it.
 *
 * One query for the whole app: the nav, Settings → Workspace, Members and
 * Reports all read `workspaces.list` through here, so react-query shares the
 * one request and a `membership.changed` sync event (which invalidates every
 * query) refreshes them together.
 */
export const useActiveWorkspace = (): ActiveWorkspace => {
  const query = trpc.workspaces.list.useQuery(undefined, { staleTime: 30_000 });
  return {
    workspace: pickActiveWorkspace(query.data),
    isLoading: query.isPending,
    isError: query.isError,
    refetch: () => void query.refetch(),
  };
};
