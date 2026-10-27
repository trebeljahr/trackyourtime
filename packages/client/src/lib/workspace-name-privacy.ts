import { permissionsFor, type KeyValueStorage, type WorkspaceSummary } from "@starter/core";
import { isCapacitor } from "./shell";
import { preferencesStorage } from "@/mobile/preferences-storage";
export const KNOWN_WORKSPACES_STORAGE_KEY = "trackyourtime.known-workspaces";
export type WorkspaceDirectoryScope = { server: string; userId: string };
export type KnownWorkspaces = WorkspaceDirectoryScope & { workspaces: WorkspaceSummary[]; names: Record<string, string> };
const permissionKeys = Object.keys(permissionsFor("member", { canViewOthersTime: false, canViewOthersMoney: false })) as (keyof WorkspaceSummary["permissions"])[];
const listeners = new Set<(scope: WorkspaceDirectoryScope) => void>();
export function subscribeWorkspaceNameProtection(listener: (scope: WorkspaceDirectoryScope) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function noteWorkspaceNameProtection(scope: WorkspaceDirectoryScope) { for (const listener of listeners) listener(scope); }

/** Public cache metadata only. Never retain names, slugs, logos, unknown fields
 * or arbitrary permission payloads alongside a private account's routing ids. */
export function publicWorkspaceDirectory(known: KnownWorkspaces): KnownWorkspaces {
  return { userId: known.userId, server: known.server, names: Object.fromEntries(Object.keys(known.names).map((id) => [id, "Workspace"])), workspaces: known.workspaces.map((row) => ({
    id: row.id, name: "Workspace", role: row.role === "owner" || row.role === "admin" ? row.role : "member",
    ...(row.kind === "personal" || row.kind === "team" ? { kind: row.kind } : {}),
    memberCount: Number.isSafeInteger(row.memberCount) && row.memberCount >= 0 ? row.memberCount : 0,
    isDefault: row.isDefault === true,
    permissions: Object.fromEntries(permissionKeys.map((key) => [key, row.permissions?.[key] === true])) as WorkspaceSummary["permissions"],
  })) };
}

let tail = Promise.resolve();
/** Current clients serialize this single public cache across tabs. Legacy
 * browsers retain their in-process standard-mode cache behavior. Private
 * enrollment itself already requires Web Locks for its encrypted stores. */
export function workspaceDirectoryExclusive<T>(work: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) return navigator.locks.request("trackyourtime.workspace-directory", { mode: "exclusive" }, work);
  const result = tail.then(work, work); tail = result.then(() => undefined, () => undefined); return result;
}
export function strictWorkspaceDirectoryStorage(): KeyValueStorage {
  if (isCapacitor()) return preferencesStorage({ strict: true });
  return strictWebWorkspaceDirectoryStorage();
}
function strictWebWorkspaceDirectoryStorage(): KeyValueStorage {
  if (typeof window === "undefined") throw new Error("Workspace privacy requires persistent device storage");
  return { getItem: async (key) => window.localStorage.getItem(key), setItem: async (key, value) => { window.localStorage.setItem(key, value); }, removeItem: async (key) => { window.localStorage.removeItem(key); } };
}
/** Strict readback is required before publishing private inventory. This cache
 * is disposable; malformed copies are removed, never interpreted as data. */
async function eraseOne(storage: KeyValueStorage, scope: WorkspaceDirectoryScope, current: () => boolean) {
  const check = () => { if (!current()) throw new Error("Workspace privacy scope changed before cache cleanup"); };
  check(); const raw = await storage.getItem(KNOWN_WORKSPACES_STORAGE_KEY); check(); if (raw === null) return;
  let known: KnownWorkspaces | null = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (typeof parsed.userId === "string" && typeof parsed.server === "string" && (parsed.userId !== scope.userId || parsed.server !== scope.server)) return;
      if (parsed.userId === scope.userId && parsed.server === scope.server && Array.isArray(parsed.workspaces) && parsed.workspaces.every((row: unknown) => row !== null && typeof row === "object" && "id" in row && typeof row.id === "string")) known = { ...scope, workspaces: parsed.workspaces, names: parsed.names && typeof parsed.names === "object" && !Array.isArray(parsed.names) ? parsed.names : {} };
    }
  } catch { /* Malformed disposable cache cannot retain private text. */ }
  const safe = known ? JSON.stringify(publicWorkspaceDirectory(known)) : null;
  if (safe === raw) return;
  check(); if (safe === null) await storage.removeItem(KNOWN_WORKSPACES_STORAGE_KEY); else await storage.setItem(KNOWN_WORKSPACES_STORAGE_KEY, safe); check();
  if (await storage.getItem(KNOWN_WORKSPACES_STORAGE_KEY) !== safe) throw new Error("Could not confirm private workspace-name cache cleanup"); check();
}
export function eraseStoredWorkspaceNames(scope: WorkspaceDirectoryScope, current: () => boolean) {
  return workspaceDirectoryExclusive(async () => {
    await eraseOne(strictWorkspaceDirectoryStorage(), scope, current);
    // Native migration must not later resurrect an old WebKit copy.
    if (isCapacitor()) await eraseOne(strictWebWorkspaceDirectoryStorage(), scope, current);
  });
}
