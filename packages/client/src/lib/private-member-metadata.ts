import { privateMemberDisplayMetadata, workspaceMemberMetadataSchema, REQUIRES_API_LEVEL, type PrivateViewOptions, type WorkspaceMemberMetadata } from "@starter/core";
import { privateClientScope } from "./private-client-scope";
import { privateWorkspaceStorageHost } from "./private-replica";
import { privateWorkspaceStorage } from "./private-session";
import { privateScopedRpc } from "./private-scoped-rpc";
import { currentServerApiLevel } from "./server-level";
import { privateMetadataNetworkFailure } from "./private-metadata-network";
/** Cached names/ids cannot enroll a device, change a directory or authorize a
 * content operation. Scope and the current directory are checked on each read. */
export async function privateWorkspaceMemberMetadata(options: Pick<PrivateViewOptions, "scope" | "directory" | "current">): Promise<WorkspaceMemberMetadata | null> {
  const { scope } = options, binding = privateClientScope(scope.userId);
  if (binding.server !== scope.server) throw new Error("Member metadata belongs to another server");
  const check = () => { binding.check(); if (!options.current()) throw new Error("Private member view changed during this read"); };
  check(); privateMemberDisplayMetadata(options, null);
  const host = await privateWorkspaceStorageHost(scope.userId, scope.workspaceId);
  try {
    const storage = await privateWorkspaceStorage(scope.userId, scope.workspaceId, host.storage), key = `member-display-metadata:${options.directory.digest}`;
    const validate = (input: unknown) => { const data = workspaceMemberMetadataSchema.parse(input); privateMemberDisplayMetadata(options, data); return data; };
    const cached = await host.exclusive(async () => { check(); const raw = await storage.getItem(key); check(); return raw === null ? null : validate(JSON.parse(raw)); }); check();
    const level = currentServerApiLevel();
    if (typeof level !== "number" || !Number.isSafeInteger(level) || level < REQUIRES_API_LEVEL["profile.workspaceMemberMetadata"]) return cached;
    const { rpc, supported } = privateScopedRpc(scope.userId, "profile.workspaceMemberMetadata");
    let raw;
    try { supported(); raw = await rpc.profile.workspaceMemberMetadata.query({ workspaceId: scope.workspaceId }); supported(); }
    catch (error) { check(); if (privateMetadataNetworkFailure(error)) return cached; throw error; }
    const data = validate(raw); check();
    await host.exclusive(async () => { check(); await storage.setItem(key, JSON.stringify(data)); check(); }); check(); return data;
  } finally { host.close(); }
}
