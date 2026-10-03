"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useApiOrigin } from "@/hooks/use-api-origin";
import { getAbsoluteApiOrigin } from "@/lib/api-origin";
import { getActiveWorkspaceSnapshot, getKnownWorkspacesOwner, getServerActiveWorkspaceSnapshot, subscribeActiveWorkspace } from "@/lib/active-workspace";
import { getQueryPersistence } from "@/lib/app-query-persistence";
import { trpc } from "@/lib/trpc";

/** Mounted once in the protected shell. Saved queries never decide authentication. */
export function useQueryPersistence(): void {
  const client = useQueryClient();
  const { user, isLoading } = useAuth();
  const origin = useApiOrigin();
  const { activeId } = useSyncExternalStore(subscribeActiveWorkspace, getActiveWorkspaceSnapshot, getServerActiveWorkspaceSnapshot);
  // Shared with the offline queue; this membership list is never persisted here.
  const memberships = trpc.workspaces.list.useQuery(undefined, { enabled: !!user, staleTime: 60_000 });
  const member = memberships.data?.find((workspace) => workspace.id === activeId);
  const server = getAbsoluteApiOrigin();
  const access = member ? JSON.stringify([member.role, Object.entries(member.permissions).sort(([a], [b]) => a.localeCompare(b))]) : null;

  useEffect(() => {
    const persistence = getQueryPersistence(client);
    if (!isLoading && origin.ready && user && memberships.data !== undefined && !memberships.isError && !member) {
      void persistence.forget();
      return;
    }
    if (isLoading || !origin.ready || !user || !activeId || !member || memberships.isError || getKnownWorkspacesOwner() !== user.id || access === null) {
      persistence.pause();
      return;
    }
    void persistence.activate({ server, userId: user.id, workspaceId: activeId, access });
  }, [client, isLoading, origin.ready, user, activeId, member, memberships.data, memberships.isError, server, access]);

  useEffect(() => () => { getQueryPersistence(client).pause(); }, [client]);
}
