import { privateDataOrigin } from "@/lib/private-session";
export const PRIVATE_RECOVERY_CHANGED = "trackyourtime:private-workspace-backup-settings";
export type PrivateBackupRunState = "idle" | "saved" | "folder-unavailable" | "failed";
const listeners = new Set<() => void>(), states = new Map<string, PrivateBackupRunState>();
const key = (userId: string, workspaceId: string) => JSON.stringify([privateDataOrigin(), userId, workspaceId]);
export const privateBackupRunState = (userId: string, workspaceId: string): PrivateBackupRunState => states.get(key(userId, workspaceId)) ?? "idle";
export function subscribePrivateBackupRun(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function notePrivateBackupRun(userId: string, workspaceId: string, state: PrivateBackupRunState) { states.set(key(userId, workspaceId), state); for (const listener of listeners) listener(); }
