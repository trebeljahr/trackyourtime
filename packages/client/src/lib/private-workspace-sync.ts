import { PrivateReplicaConflictError, PrivateReplicaDirectoryChangedError } from "@starter/core";
import { openPrivateWorkspaceSyncSession } from "./private-workspace-session";
import { capturePrivateRequestScope, checkPrivateRequestScope } from "./private-request-scope";
export type PrivateSyncScope = { server: string; userId: string; workspaceId: string };
export type PrivateSyncPhase = "checking" | "syncing" | "saved" | "pending" | "unavailable" | "conflict";
export type PrivateSyncState = { phase: PrivateSyncPhase; pending: number | null };
const listeners = new Set<(scope: PrivateSyncScope) => void>();
const TOPIC = "trackyourtime.private-workspace-edits:v1";
let channel: BroadcastChannel | null = null;
const validScope = (value: unknown): value is PrivateSyncScope => {
  if (!value || typeof value !== "object" || Object.keys(value).length !== 3) return false;
  const row = value as PrivateSyncScope;
  if (typeof row.server !== "string" || row.server.length > 2048 || typeof row.userId !== "string" || !row.userId || row.userId.length > 100 || typeof row.workspaceId !== "string" || !row.workspaceId || row.workspaceId.length > 100) return false;
  try { const server = new URL(row.server); return server.origin === row.server && ["https:", "http:"].includes(server.protocol); } catch { return false; }
};
const deliver = (scope: PrivateSyncScope) => { for (const listener of listeners) listener({ ...scope }); };
function openChannel() {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
  const opened = new BroadcastChannel(TOPIC);
  opened.onmessage = (event) => { if (validScope(event.data)) deliver(event.data); };
  return opened;
}
/** Only public scope crosses tabs. A notification grants no authority; the
 * recipient always reopens and verifies its own encrypted local replica. */
export function notifyPrivateWorkspaceEdit(scope: PrivateSyncScope) {
  if (!validScope(scope)) throw new Error("Invalid private workspace notification scope");
  deliver(scope);
  try { const target = channel ?? openChannel(); target?.postMessage({ ...scope }); if (target !== channel) target?.close(); } catch { /* Polling still retains the durable edit. */ }
}
export function subscribePrivateWorkspaceEdits(listener: (scope: PrivateSyncScope) => void) {
  listeners.add(listener); try { channel ??= openChannel(); } catch { /* Optional cross-tab wakeup. */ }
  return () => { listeners.delete(listener); if (!listeners.size) { channel?.close(); channel = null; } };
}
/** One bounded sync pass. Callers serialize passes and own retry scheduling.
 * Local success is distinct from verified server delivery. A conflict never
 * rebases/deletes pending work. Unknown protocol versions have no fallback. */
export async function syncPrivateWorkspace(scope: PrivateSyncScope, publish: (value: PrivateSyncState) => void, current: () => boolean) {
  const original = capturePrivateRequestScope();
  const check = () => { checkPrivateRequestScope(original); if (!current() || scope.server !== original.server || scope.userId !== original.userId) throw new Error("Private sync scope changed"); };
  let beforeHead: string | null | undefined;
  let copy: Awaited<ReturnType<typeof openPrivateWorkspaceSyncSession>> | null = null, pending: number | null = null;
  const emit = (phase: PrivateSyncPhase) => { check(); publish({ phase, pending }); };
  try {
    check(); emit("checking"); copy = await openPrivateWorkspaceSyncSession(scope.userId, scope.workspaceId); check();
    const before = await copy.status(); check(); pending = before.pending; beforeHead = before.head;
    if (before.conflict) { emit("conflict"); return { changed: false }; }
    emit("syncing"); let page = await copy.pull(); check(); let pages = 1;
    while (page.next !== null && pages++ < 8) { page = await copy.pull(page.through); check(); }
    pending = page.pending;
    if (page.next !== null) { emit("syncing"); return { changed: true }; }
    let saves = 0;
    while (pending && saves++ < 8) { const result = await copy.flushOne(); check(); pending = result.pending; }
    const after = await copy.status(); check(); pending = after.pending;
    emit(after.conflict ? "conflict" : pending ? "pending" : "saved");
    return { changed: before.head !== after.head };
  } catch (error) {
    if (!current()) return { changed: false };
    // Re-read only public counts from authenticated local storage after a
    // partial/lost reply. Errors never expose decoder values to telemetry/UI.
    let changed = false;
    if (copy?.current()) { try { const after = await copy.status(); pending = after.pending; changed = beforeHead !== undefined && beforeHead !== after.head; } catch { /* Kept on disk. */ } }
    check(); emit(error instanceof PrivateReplicaConflictError || error instanceof PrivateReplicaDirectoryChangedError ? "conflict" : "unavailable");
    return { changed };
  } finally { copy?.close(); }
}
