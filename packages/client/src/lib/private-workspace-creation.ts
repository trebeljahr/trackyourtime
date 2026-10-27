import { capturePrivateRequestScope, checkPrivateRequestScope } from "./private-request-scope";
import { accountWorkspacePolicy } from "@starter/core";
import { createWorkspaceSchema } from "@starter/shared";
import { privateClientScope } from "./private-client-scope";
import { privateAccountInventoryStorageHost } from "./private-replica";
import { privateAccountInventoryTransport, privateAccountWorkspaceInventorySync } from "./private-inventory-sync";
import { privateAccountId, privateDataOrigin, privateSession, whenPrivateAccountReady } from "./private-session";
import { privateRoutingRequired } from "./private-routing-requirement";
import { requireStandardDeviceAccess } from "./private-device-access";
import { privateScopedRpc } from "./private-scoped-rpc";
import { PrivateContentUnavailableError } from "./private-content-error";
import { PrivateWorkspaceCreationError } from "./private-workspace-creation-error";
/** Enrolled standard accounts reserve a fresh local UUID, never a mode/id from
 * an API response. Private accounts require encrypted initialization instead.
 * This prepares metadata intent only; the normal final HTTP boundary still
 * checks the fresh workspace's signed standard policy before sending its name. */
export async function preparePrivateWorkspaceCreation(input: unknown, signal?: AbortSignal) {
  const originalScope = capturePrivateRequestScope(), frozen = structuredClone(input), userId = await whenPrivateAccountReady(signal);
  checkPrivateRequestScope(originalScope);
  if (!userId) throw new PrivateContentUnavailableError("Sign in before creating a workspace");
  if (!privateSession(userId)) {
    const scope = { server: privateDataOrigin(), userId };
    if (await privateRoutingRequired(scope)) throw new PrivateContentUnavailableError();
    await requireStandardDeviceAccess(scope); checkPrivateRequestScope(originalScope); return null;
  }
  const binding = privateClientScope(userId);
  const check = () => { checkPrivateRequestScope(originalScope); binding.check(); if (signal?.aborted) throw signal.reason ?? new Error("Workspace creation canceled"); if (privateAccountId() !== userId) throw new PrivateContentUnavailableError("The signed-in account changed"); };
  let host: Awaited<ReturnType<typeof privateAccountInventoryStorageHost>> | null = null, retained = false;
  try {
    check(); host = await privateAccountInventoryStorageHost(userId); check();
    const sync = await privateAccountWorkspaceInventorySync(userId, host.storage, host.exclusive), transport = privateAccountInventoryTransport(userId);
    let profile = await sync.read(); check();
    if (profile.inventory.signed.inventory.workspaces.some((row) => row.mode !== "standard")) throw new PrivateWorkspaceCreationError("private");
    const supported = privateScopedRpc(userId, "workspaces.clientCreation").supported;
    try { supported(); } catch { throw new PrivateWorkspaceCreationError("server"); }
    const parsed = createWorkspaceSchema.parse(frozen && typeof frozen === "object" && !Array.isArray(frozen) ? { ...frozen, clientWorkspaceId: undefined } : frozen);
    for (let i = 0; profile.pending && i < 8; i++) { check(); await sync.flushOne(transport); check(); profile = await sync.read(); }
    check(); if (profile.pending) throw new PrivateWorkspaceCreationError("local");
    // The account-wide lock performs a fresh all-standard check and appends,
    // so another tab's additions cannot be dropped by an earlier list copy.
    const intent = await sync.prepareStandardWorkspace(); check();
    const workspaceId = intent.workspaceId, ownedHost = host;
    const close = () => ownedHost.close();
    const request = Object.freeze({ ...parsed, clientWorkspaceId: workspaceId, workspaceId });
    retained = true;
    return { input: request, check, close, accept: async (value: unknown) => {
      try {
      check();
      if (!value || typeof value !== "object" || !("workspaceId" in value) || value.workspaceId !== workspaceId) throw new PrivateWorkspaceCreationError("response");
      const after = await sync.read(); check();
      if (accountWorkspacePolicy(after.inventory, binding, workspaceId).mode !== "standard") throw new PrivateWorkspaceCreationError("response");
      return { workspaceId };
      } catch (error) { if (error instanceof PrivateContentUnavailableError) throw error; throw new PrivateWorkspaceCreationError("local"); }
    } };
  } catch (error) {
    if (error instanceof PrivateContentUnavailableError) throw error;
    throw new PrivateWorkspaceCreationError("local");
  } finally { if (!retained) host?.close(); }
}
