import { assertPrivateAccountInventory, PrivateAccountInventoryMissingError, privateWorkspaceSummary, permissionsFor, type WorkspaceSummary } from "@starter/core";
import { getActiveWorkspaceSnapshot, getKnownWorkspacesOwner } from "./active-workspace";
import { privateAccountInventoryStorageHost } from "./private-replica";
import { privateAccountWorkspaceInventorySync } from "./private-inventory-sync";
import { privateAccountId, privateDataOrigin, privateOperationScope, privateSession, privateSessionVersion, whenPrivateAccountReady } from "./private-session";
import { privateRoutingRequired, privateRoutingRevision } from "./private-routing-requirement";
import { openPrivateWorkspaceSession } from "./private-workspace-session";
import { PrivateContentUnavailableError } from "./private-content-error";
import { privateMetadataNetworkFailure } from "./private-metadata-network";
import { notePrivateView } from "./private-view-lifecycle";
class StandardWorkspaceListError extends Error {
  constructor(readonly original: unknown) { super("Workspace metadata request failed", { cause: original }); }
}

/** Locked navigation contains no labels or authority from the public cache. */
function lockedWorkspace(id: string, isDefault: boolean): WorkspaceSummary {
  return { id, name: "Workspace", role: "member", memberCount: 0, isDefault,
    permissions: permissionsFor("member", { canViewOthersTime: false, canViewOthersMoney: false }) };
}
/** Signed account inventory chooses membership/mode. Private labels and all
 * permission flags come from the local encrypted identity and signed directory.
 * A server list cannot add, omit, rename or promote a private workspace. */
export async function readWorkspaceList(readStandard: () => Promise<WorkspaceSummary[]>, signal?: AbortSignal): Promise<WorkspaceSummary[]> {
  const transport = async () => { try { return await readStandard(); } catch (error) { throw new StandardWorkspaceListError(error); } };
  try { return await readList(transport, signal); }
  catch (error) {
    if (error instanceof StandardWorkspaceListError) throw error.original;
    if (error instanceof PrivateContentUnavailableError || signal?.aborted) throw error;
    throw new PrivateContentUnavailableError("Workspace list could not be verified. Existing data was kept.");
  }
}
async function readList(readStandard: () => Promise<WorkspaceSummary[]>, signal?: AbortSignal): Promise<WorkspaceSummary[]> {
  const userId = await whenPrivateAccountReady(signal);
  if (!userId) throw new PrivateContentUnavailableError("Sign in before accessing workspaces");
  const scope = { server: privateDataOrigin(), userId }, captured = privateOperationScope(userId), version = privateSessionVersion();
  const alive = () => {
    if (signal?.aborted) throw signal.reason ?? new Error("Workspace lookup canceled");
    captured();
    if (privateAccountId() !== userId || privateDataOrigin() !== scope.server || privateSessionVersion() !== version) throw new PrivateContentUnavailableError("Private data changed before the workspace list was ready");
  };
  alive(); const required = await privateRoutingRequired(scope); alive();
  const cached = () => getKnownWorkspacesOwner() === userId ? getActiveWorkspaceSnapshot() : { activeId: null, workspaces: null };
  const atStart = privateRoutingRevision();
  const unchanged = () => { alive(); if (privateRoutingRevision() !== atStart) throw new PrivateContentUnavailableError("Workspace policy changed before the list was ready"); };
  if (!privateSession(userId) && required) {
    const here = cached(), ids = here.workspaces?.map((row) => row.id) ?? (here.activeId ? [here.activeId] : []);
    unchanged(); return ids.map((id) => lockedWorkspace(id, id === here.activeId));
  }
  const host = privateSession(userId) ? await privateAccountInventoryStorageHost(userId) : null;
  try {
    alive(); const sync = host ? await privateAccountWorkspaceInventorySync(userId, host.storage, host.exclusive) : null;
    let profile;
    try { profile = await sync?.read(); }
    catch (error) { alive(); if (required || !(error instanceof PrivateAccountInventoryMissingError)) throw error; }
    alive();
    if (!profile) {
      unchanged(); const rows = await readStandard(); unchanged();
      if (await privateRoutingRequired(scope)) throw new PrivateContentUnavailableError("Workspace protection changed during this request");
      unchanged(); return rows;
    }
    // Reading an existing signed profile can install the durable marker. Its
    // resulting epoch belongs to this read, rather than invalidating itself.
    const inventory = profile.inventory, revision = privateRoutingRevision();
    const check = () => { alive(); assertPrivateAccountInventory(inventory, scope); if (privateRoutingRevision() !== revision) throw new PrivateContentUnavailableError("Workspace policy changed before the list was ready"); };
    check(); const workspaces = inventory.signed.inventory.workspaces, here = cached();
    let standard: WorkspaceSummary[] = [];
    if (workspaces.some((row) => row.mode === "standard")) {
      try { standard = await readStandard(); }
      catch (error) { check(); if (!privateMetadataNetworkFailure(error) || !here.workspaces) throw error; standard = here.workspaces; }
      check();
      if (!Array.isArray(standard) || standard.length > 1000 || standard.some((row) => !row || typeof row.id !== "string") || new Set(standard.map((row) => row.id)).size !== standard.length) throw new Error("Invalid workspace metadata list");
      // Unknown additions need explicit trusted enrollment, never a downgrade.
      if (standard.some((row) => !workspaces.some((known) => known.workspaceId === row.id))) throw new Error("Workspace is absent from the trusted account inventory");
    }
    const selected = workspaces.some((row) => row.workspaceId === here.activeId) ? here.activeId : workspaces[0]?.workspaceId;
    const rows: WorkspaceSummary[] = [];
    for (const row of workspaces) {
      check();
      if (row.mode === "standard") {
        const found = standard.find((item) => item.id === row.workspaceId);
        if (found) rows.push({ ...found, isDefault: found.id === selected });
        continue;
      }
      const session = await openPrivateWorkspaceSession(userId, row.workspaceId);
      try {
        check(); const view = await session.readKinds(["workspaceIdentity"]); check();
        rows.push(privateWorkspaceSummary({ scope: session.scope, directory: session.directory, records: view.records,
          isDefault: row.workspaceId === selected, current: () => { try { check(); return session.current(); } catch { return false; } } }));
      } finally { session.close(); }
    }
    // Detect another window publishing inventory while the list was loading.
    const after = await sync!.read(); check();
    if (after.inventory.checkpoint.digest !== inventory.checkpoint.digest) throw new Error("Workspace inventory changed during the read");
    if (workspaces.some((row) => row.mode === "encrypted")) { notePrivateView(scope); check(); }
    return rows;
  } finally { host?.close(); }
}
