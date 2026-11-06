import { isPrivateLocalResult } from "./private-local-result";
import type { DetailedEntry } from "@starter/shared";
import { getActiveWorkspaceId, getKnownWorkspacesOwner } from "@/lib/active-workspace";
import { getAbsoluteApiOrigin } from "@/lib/api-origin";
import { getOfflineQueueOwner, getOfflineQueueStampOwner } from "@/lib/offline";

/**
 * A draft is disposable only after the server, encrypted local replica or durable queue owns it.
 * Creates always return their exact entry; updates include it when known.
 */
export type EntryMutationResult =
  | { ok: true; saved: EntrySaveLocation; entry?: DetailedEntry }
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
  // A draft opened before the active workspace resolved (null: the session
  // default) has not seen a switch when the first workspace list fills it in.
  // A move between two real workspaces, an owner or a server change still is.
  const workspace = scope.workspaceId === null || scope.workspaceId === current.workspaceId;
  return workspace && scope.owner === current.owner && scope.server === current.server;
};

export type EntrySaveLocation = "server" | "offline" | "private";
export const entrySaveLocation = (result: unknown): "server" | "private" => isPrivateLocalResult(result) ? "private" : "server";
