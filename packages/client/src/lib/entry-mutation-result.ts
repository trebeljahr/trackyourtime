import type { DetailedEntry } from "@starter/shared";
import { getActiveWorkspaceId, getKnownWorkspacesOwner } from "@/lib/active-workspace";
import { getAbsoluteApiOrigin } from "@/lib/api-origin";
import { getOfflineQueueOwner, getOfflineQueueStampOwner } from "@/lib/offline";

/**
 * A draft is disposable only after the server or durable queue owns it.
 * Creates always return their exact entry; updates include it when known.
 */
export type EntryMutationResult =
  | { ok: true; saved: "server" | "offline"; entry?: DetailedEntry }
  | { ok: false; message: string };

export type EntryMutationScope = {
  workspaceId: string | null;
  owner: string | null;
  server: string;
};

export const entryMutationScope = (): EntryMutationScope => ({
  workspaceId: getActiveWorkspaceId(),
  owner: getOfflineQueueOwner() ?? getKnownWorkspacesOwner() ?? getOfflineQueueStampOwner(),
  server: getAbsoluteApiOrigin(),
});

export const sameEntryMutationScope = (scope: EntryMutationScope): boolean => {
  const current = entryMutationScope();
  return scope.workspaceId === current.workspaceId && scope.owner === current.owner && scope.server === current.server;
};
