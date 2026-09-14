"use client";

import * as React from "react";
import type { WorkspaceSummary } from "@starter/shared";

import { pickActiveWorkspace } from "@/components/members/member-rules";
import {
  getActiveWorkspaceSnapshot,
  getServerActiveWorkspaceSnapshot,
  subscribeActiveWorkspace,
} from "@/lib/active-workspace";
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
 *
 * WHICH row is the device's choice from `lib/active-workspace.ts`, never the
 * session default alone: after a switch every request carries the chosen
 * workspace, and screens reading the default would offer one workspace's
 * controls under another's permissions.
 */
export const useActiveWorkspace = (): ActiveWorkspace => {
  const query = trpc.workspaces.list.useQuery(undefined, { staleTime: 30_000 });
  const { activeId } = React.useSyncExternalStore(
    subscribeActiveWorkspace,
    getActiveWorkspaceSnapshot,
    getServerActiveWorkspaceSnapshot,
  );
  return {
    workspace: pickActiveWorkspace(query.data, activeId),
    isLoading: query.isPending,
    isError: query.isError,
    refetch: () => void query.refetch(),
  };
};
