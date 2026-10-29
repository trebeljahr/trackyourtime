"use client";
import * as React from "react";
import { PrivateTimerConflictError, PrivateTimerHistoryProofPendingError } from "@starter/core";
import { syncPrivateAccountTimerIfPresent } from "@/lib/private-account-timer-sync";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./use-auth";
import { useActiveWorkspace } from "@/components/members/use-active-workspace";
import { privateAccountId, privateDataOrigin, privateSession, privateSessionVersion, subscribePrivateSession } from "@/lib/private-session";
import { currentWorkspaceContentRoute, isWorkspaceContentProcedure } from "@/lib/private-content-route";
import { subscribePrivateWorkspaceEdits, syncPrivateWorkspace, type PrivateSyncState } from "@/lib/private-workspace-sync";
/** One driver for the active workspace. Polls only while visible/unlocked;
 * edit/network/resume events request a serialized bounded pass. */
export function usePrivateWorkspaceSync(): PrivateSyncState | null {
  const { user } = useAuth(), { workspace } = useActiveWorkspace(), client = useQueryClient();
  const version = React.useSyncExternalStore(subscribePrivateSession, privateSessionVersion, () => 0);
  const userId = user?.id, workspaceId = workspace?.id, server = privateDataOrigin();
  const key = JSON.stringify([server, userId, workspaceId, version]);
  const [state, setState] = React.useState<{ key: string; value: PrivateSyncState | null } | null>(null);
  React.useEffect(() => {
    if (!userId || !workspaceId || !privateSession(userId)) return;
    let canceled = false, busy = false, queued = false;
    const current = () => !canceled && privateAccountId() === userId && privateDataOrigin() === server && privateSessionVersion() === version;
    const publish = (value: PrivateSyncState | null) => { if (current()) setState({ key, value }); };
    const run = async () => {
      if (!current() || document.visibilityState === "hidden") return;
      if (busy) { queued = true; return; } busy = true;
      try {
        do {
          queued = false;
          const timer = await syncPrivateAccountTimerIfPresent(userId, current); if (!current()) return;
          if (timer?.changed) void client.invalidateQueries({ predicate: (query) => Array.isArray(query.queryKey[0]) && isWorkspaceContentProcedure(query.queryKey[0].join(".")) });
          if (timer && (!timer.caughtUp || timer.pending || timer.committed)) { publish({ phase: "pending", pending: timer.pending + timer.committed }); return; }
          const route = await currentWorkspaceContentRoute(workspaceId); if (!current()) return;
          if (route.mode === "standard") { publish(null); return; }
          route.check();
          const result = await syncPrivateWorkspace({ server, userId, workspaceId }, (value) => { route.check(); publish(value); }, current);
          if (result.changed && current()) void client.invalidateQueries({ predicate: (query) => Array.isArray(query.queryKey[0]) && isWorkspaceContentProcedure(query.queryKey[0].join(".")) });
        } while (queued && current());
      } catch (error) { publish({ phase: error instanceof PrivateTimerConflictError ? "conflict" : error instanceof PrivateTimerHistoryProofPendingError ? "pending" : "unavailable", pending: null }); }
      finally { busy = false; }
    };
    const retry = () => { void run(); };
    const unsubscribe = subscribePrivateWorkspaceEdits((scope) => {
      if (scope.server === server && scope.userId === userId && current()) {
        void client.invalidateQueries({ predicate: (query) => Array.isArray(query.queryKey[0]) && isWorkspaceContentProcedure(query.queryKey[0].join(".")) }); retry();
      }
    });
    const interval = window.setInterval(retry, 30_000);
    window.addEventListener("online", retry); document.addEventListener("visibilitychange", retry); retry();
    return () => { canceled = true; unsubscribe(); clearInterval(interval); window.removeEventListener("online", retry); document.removeEventListener("visibilitychange", retry); };
  }, [client, key, server, userId, version, workspaceId]);
  if (state?.key === key) return state.value;
  return userId && privateSession(userId) ? { phase: "checking", pending: null } : null;
}
