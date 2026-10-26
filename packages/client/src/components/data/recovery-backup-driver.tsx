"use client";
import * as React from "react";
import { RecoveryBackupPausedError } from "@starter/core";
import { useAuth } from "@/hooks/use-auth";
import { useActiveWorkspace } from "@/components/members/use-active-workspace";
import { readCombinedBackupSource } from "@/lib/combined-backup-source";
import { recoveryBackupController } from "@/lib/recovery-backup-controller";
import { supportsRecoveryBackupFolders } from "@/lib/recovery-backup-folder";
import { privateDataOrigin, privateSession, privateSessionVersion, subscribePrivateSession } from "@/lib/private-session";
import { useServerSupports } from "@/lib/server-level";
import { trpc } from "@/lib/trpc";
import { privateRecoveryMode } from "@/lib/private-recovery-mode";
import { privateRecoveryController } from "@/lib/private-recovery-controller";
import { PRIVATE_RECOVERY_CHANGED, notePrivateBackupRun } from "./private-recovery-status";
export const RECOVERY_BACKUP_CHANGED = "trackyourtime:recovery-backup-settings";
export type BackupRunState = "idle" | "saved" | "folder-unavailable" | "failed";
const listeners = new Set<() => void>(), states = new Map<string, BackupRunState>();
const key = (userId: string, workspaceId: string) => JSON.stringify([privateDataOrigin(), userId, workspaceId]);
export const recoveryBackupRunState = (userId: string, workspaceId: string): BackupRunState => states.get(key(userId, workspaceId)) ?? "idle";
export function subscribeRecoveryBackupRun(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function noteRecoveryBackupRun(userId: string, workspaceId: string, state: BackupRunState) { states.set(key(userId, workspaceId), state); for (const listener of listeners) listener(); }
/** No UI or prompts. Back up the active private member copy, or a standard
 * owner workspace, while keys are unlocked and folder access is granted. */
export function RecoveryBackupDriver(): null {
  const { user } = useAuth(), { workspace } = useActiveWorkspace(), utils = trpc.useUtils();
  const version = React.useSyncExternalStore(subscribePrivateSession, privateSessionVersion, () => 0);
  const supported = useServerSupports("privacy.combinedRecovery"), userId = user?.id, workspaceId = workspace?.id, owner = workspace?.role === "owner";
  React.useEffect(() => {
    if (!userId || !workspaceId || !privateSession(userId) || !supportsRecoveryBackupFolders()) return;
    let controller: Awaited<ReturnType<typeof recoveryBackupController>> | null = null, cancelled = false, busy = false, retryAt = 0;
    let privateController: Awaited<ReturnType<typeof privateRecoveryController>> | null = null, privateMode = false;
    const abort = new AbortController();
    const tick = async () => {
      if (cancelled || busy || Date.now() < retryAt) return; busy = true;
      try {
        privateMode = await privateRecoveryMode(userId, workspaceId) === "encrypted";
        if (cancelled) return;
        if (privateMode) {
          privateController ??= await privateRecoveryController(userId, workspaceId);
          if (cancelled) { privateController.close(); return; }
          const result = await privateController.run();
          if (!cancelled && result.status === "saved") notePrivateBackupRun(userId, workspaceId, "saved");
          if (!cancelled && result.status === "folder-unavailable") { retryAt = Date.now() + 300000; notePrivateBackupRun(userId, workspaceId, "folder-unavailable"); }
          return;
        }
        if (!owner || !supported) return;
        controller ??= await recoveryBackupController(userId, workspaceId);
        if (cancelled) { controller.close(); return; }
        const result = await controller.run(() => {
          const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]);
          return readCombinedBackupSource(userId, workspaceId, {
            challenge: () => utils.client.privacy.recoveryChallenge.mutate({ workspaceId }, { signal }),
            originals: (proof) => utils.client.privacy.combinedRecovery.mutate({ workspaceId, ...proof }, { signal }),
          }, signal);
        });
        if (!cancelled && result.status === "saved") noteRecoveryBackupRun(userId, workspaceId, "saved");
        if (!cancelled && result.status === "folder-unavailable") { retryAt = Date.now() + 300000; noteRecoveryBackupRun(userId, workspaceId, "folder-unavailable"); }
      } catch (error) {
        if (!cancelled) { retryAt = Date.now() + 300000; (privateMode ? notePrivateBackupRun : noteRecoveryBackupRun)(userId, workspaceId, error instanceof RecoveryBackupPausedError ? "folder-unavailable" : "failed"); }
      } finally { busy = false; }
    };
    const changed = () => { retryAt = 0; void tick(); };
    void tick(); const timer = window.setInterval(() => void tick(), 60000);
    window.addEventListener(RECOVERY_BACKUP_CHANGED, changed);
    window.addEventListener(PRIVATE_RECOVERY_CHANGED, changed);
    return () => { cancelled = true; abort.abort(); window.clearInterval(timer); window.removeEventListener(RECOVERY_BACKUP_CHANGED, changed); window.removeEventListener(PRIVATE_RECOVERY_CHANGED, changed); controller?.close(); privateController?.close(); };
  }, [userId, workspaceId, owner, supported, version, utils]);
  return null;
}
