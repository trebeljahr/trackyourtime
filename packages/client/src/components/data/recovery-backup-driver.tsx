"use client";
import * as React from "react";
import { RecoveryBackupPausedError } from "@starter/core";
import { useAuth } from "@/hooks/use-auth";
import { useActiveWorkspace } from "@/components/members/use-active-workspace";
import { recoveryBackupController } from "@/lib/recovery-backup-controller";
import { supportsRecoveryBackupFolders } from "@/lib/recovery-backup-folder";
import { privateDataOrigin, privateSession, privateSessionVersion, subscribePrivateSession } from "@/lib/private-session";
import { useServerSupports } from "@/lib/server-level";
import { trpc } from "@/lib/trpc";
export const RECOVERY_BACKUP_CHANGED = "trackyourtime:recovery-backup-settings";
export type BackupRunState = "idle" | "saved" | "folder-unavailable" | "failed";
const listeners = new Set<() => void>(), states = new Map<string, BackupRunState>();
const key = (userId: string, workspaceId: string) => JSON.stringify([privateDataOrigin(), userId, workspaceId]);
export const recoveryBackupRunState = (userId: string, workspaceId: string): BackupRunState => states.get(key(userId, workspaceId)) ?? "idle";
export function subscribeRecoveryBackupRun(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function noteRecoveryBackupRun(userId: string, workspaceId: string, state: BackupRunState) { states.set(key(userId, workspaceId), state); for (const listener of listeners) listener(); }
/** No UI or prompts. Schedules only the active owner workspace while the app
 * is open, private keys are unlocked and folder permission is already granted. */
export function RecoveryBackupDriver(): null {
  const { user } = useAuth(), { workspace } = useActiveWorkspace(), utils = trpc.useUtils();
  const version = React.useSyncExternalStore(subscribePrivateSession, privateSessionVersion, () => 0);
  const supported = useServerSupports("privacy.keys"), userId = user?.id, workspaceId = workspace?.id, owner = workspace?.role === "owner";
  React.useEffect(() => {
    if (!userId || !workspaceId || !owner || !supported || !privateSession(userId) || !supportsRecoveryBackupFolders()) return;
    let controller: Awaited<ReturnType<typeof recoveryBackupController>> | null = null, cancelled = false, busy = false, retryAt = 0;
    const abort = new AbortController();
    const tick = async () => {
      if (cancelled || busy || Date.now() < retryAt) return; busy = true;
      try {
        controller ??= await recoveryBackupController(userId, workspaceId);
        if (cancelled) { controller.close(); return; }
        const result = await controller.run(async () => ({
          format: "trackyourtime-workspace-recovery-v1", server: privateDataOrigin(), ownerId: userId,
          snapshot: await utils.client.privacy.recoverySnapshot.mutate({ workspaceId }, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]) }),
        }));
        if (!cancelled && result.status === "saved") noteRecoveryBackupRun(userId, workspaceId, "saved");
        if (!cancelled && result.status === "folder-unavailable") { retryAt = Date.now() + 300000; noteRecoveryBackupRun(userId, workspaceId, "folder-unavailable"); }
      } catch (error) {
        if (!cancelled) { retryAt = Date.now() + 300000; noteRecoveryBackupRun(userId, workspaceId, error instanceof RecoveryBackupPausedError ? "folder-unavailable" : "failed"); }
      } finally { busy = false; }
    };
    const changed = () => { retryAt = 0; void tick(); };
    void tick(); const timer = window.setInterval(() => void tick(), 60000);
    window.addEventListener(RECOVERY_BACKUP_CHANGED, changed);
    return () => { cancelled = true; abort.abort(); window.clearInterval(timer); window.removeEventListener(RECOVERY_BACKUP_CHANGED, changed); controller?.close(); };
  }, [userId, workspaceId, owner, supported, version, utils]);
  return null;
}
