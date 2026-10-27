"use client";
import { useSyncExternalStore } from "react";
import { getActiveWorkspaceSnapshot, getServerActiveWorkspaceSnapshot, subscribeActiveWorkspace } from "@/lib/active-workspace";
import { observedWorkspaceMode, subscribeVerifiedWorkspaceModes } from "@/lib/private-workspace-mode-cache";
const local = { networkMode: "always" as const }, standard = {};
/** Bypass the radio only for independently verified private local adapters.
 * Standard/unknown workspaces retain React Query's normal pause behavior. */
export function usePrivateMutationOptions(): { networkMode?: "always" } {
  const { activeId } = useSyncExternalStore(subscribeActiveWorkspace, getActiveWorkspaceSnapshot, getServerActiveWorkspaceSnapshot);
  const mode = useSyncExternalStore(subscribeVerifiedWorkspaceModes, () => observedWorkspaceMode(activeId), () => null);
  return mode === "encrypted" ? local : standard;
}
