import { accountWorkspacePolicy, PrivateAccountInventoryMissingError, privateCatalogQuery, isPrivateCatalogQuery, privateEntryQuery, isPrivateEntryQuery, privateFavoriteQuery, privateSettingsQuery, privateBusinessProfileQuery, privateReportTrackedSpan, privateReportQuery, isPrivateReportQuery, privateMemberQuery } from "@starter/core";
import { privateAccountWorkspaceInventorySync } from "./private-inventory-sync";
import { privateAccountInventoryStorageHost } from "./private-replica";
import { privateAccountId, privateDataOrigin, privateOperationScope, privateSession, privateSessionVersion, whenPrivateAccountReady } from "./private-session";
import { privateRoutingRequired, privateRoutingRevision } from "./private-routing-requirement";
import { openPrivateWorkspaceSession } from "./private-workspace-session";
import { PrivateContentUnavailableError } from "./private-content-error";
export { PrivateContentUnavailableError } from "./private-content-error";
import { privateDisplayPreferences } from "./private-display-preferences";
import { privateWorkspaceMemberMetadata } from "./private-member-metadata";
import { notePrivateView } from "./private-view-lifecycle";
/** All content-bearing app routers, including queries whose filters contain
 * descriptions, client names, or other private values. Unsupported private
 * procedures fail here, before batching, durable entry storage or HTTP. */
const accountRouters = new Set(["health", "privacy", "profile", "devices", "billing"]);
export const isWorkspaceContentProcedure = (path: string) => !accountRouters.has(path.split(".")[0]!) && path !== "workspaces.list";
export type WorkspaceContentRoute = { mode: "standard" | "encrypted"; scope: { server: string; userId: string; workspaceId: string | null }; check: () => void };
/** Never route from an API mode or an unverified backup. This reads signed
 * local inventory. The marker only requires unlock; it cannot authorize an
 * adapter. A new/cleared device still needs separate trusted enrollment and
 * freshness confirmation before encrypted rollout can be enabled. */
export async function workspaceContentRoute(userId: string, workspaceId: string | null, server = privateDataOrigin()): Promise<WorkspaceContentRoute> {
  try { return await resolveWorkspaceContentRoute(userId, workspaceId, server); }
  catch (error) {
    if (error instanceof PrivateContentUnavailableError) throw error;
    if (error instanceof PrivateAccountInventoryMissingError) throw new PrivateContentUnavailableError("Trusted account workspace inventory is missing. Restore this device's trusted copy before continuing.");
    // Do not pass structured decoder errors or raw values to UI telemetry.
    throw new PrivateContentUnavailableError("Private workspace policy could not be verified. Existing data was kept.");
  }
}
async function resolveWorkspaceContentRoute(userId: string, workspaceId: string | null, server: string): Promise<WorkspaceContentRoute> {
  const scope = Object.freeze({ server, userId, workspaceId }), captured = privateOperationScope(userId), version = privateSessionVersion();
  const alive = () => { captured(); if (privateDataOrigin() !== server || privateSessionVersion() !== version) throw new PrivateContentUnavailableError("Private data changed before this operation could finish"); };
  alive();
  for (let attempt = 0; attempt < 3; attempt++) {
    const at = privateRoutingRevision(), required = await privateRoutingRequired(scope); alive();
    let mode: "standard" | "encrypted" = "standard";
    if (!privateSession(userId)) {
      if (required) throw new PrivateContentUnavailableError();
    } else {
      const host = await privateAccountInventoryStorageHost(userId);
      try {
        alive(); const inventories = await privateAccountWorkspaceInventorySync(userId, host.storage, host.exclusive);
        let profile;
        try { profile = await inventories.read(); }
        catch (error) { alive(); if (required || !(error instanceof PrivateAccountInventoryMissingError)) throw error; }
        alive();
        if (profile) {
          if (!workspaceId) throw new PrivateContentUnavailableError("Choose a workspace from this device's trusted inventory before continuing");
          mode = accountWorkspacePolicy(profile.inventory, { server, userId }, workspaceId).mode;
        }
      } finally { host.close(); }
    }
    if (privateRoutingRevision() !== at) continue;
    const check = () => { alive(); if (privateRoutingRevision() !== at) throw new PrivateContentUnavailableError("Workspace encryption policy changed before this operation could finish"); };
    check(); return { mode, scope, check };
  }
  throw new PrivateContentUnavailableError("Workspace policy is changing; retry after private data is ready");
}
export async function currentWorkspaceContentRoute(workspaceId: string | null, signal?: AbortSignal) {
  const userId = await whenPrivateAccountReady(signal);
  if (!userId) throw new PrivateContentUnavailableError("Sign in before accessing workspace data");
  const route = await workspaceContentRoute(userId, workspaceId);
  const check = () => { if (signal?.aborted) throw signal.reason ?? new Error("Private operation canceled"); if (privateAccountId() !== userId) throw new PrivateContentUnavailableError("The signed-in account changed"); route.check(); };
  check(); return { ...route, check };
}
export async function assertStandardWorkspaceContent(userId: string, workspaceId: string | null, server?: string) {
  const route = await workspaceContentRoute(userId, workspaceId, server);
  if (route.mode !== "standard") throw new PrivateContentUnavailableError("Keep or export existing plaintext queued work before using this encrypted workspace");
  route.check(); return route.check;
}
export async function readPrivateWorkspaceQuery(route: WorkspaceContentRoute, path: string, input: unknown, type: string) {
  route.check();
  if (route.mode !== "encrypted" || !route.scope.workspaceId) throw new PrivateContentUnavailableError();
  if (type !== "query" || (!isPrivateCatalogQuery(path) && !isPrivateEntryQuery(path) && path !== "favorites.list" && path !== "settings.get" && path !== "settings.businessProfile" && path !== "reports.trackedSpan" && !isPrivateReportQuery(path) && path !== "members.list")) throw new PrivateContentUnavailableError("This operation is not available for private workspaces yet. Existing work was kept.");
  let session: Awaited<ReturnType<typeof openPrivateWorkspaceSession>> | null = null;
  try {
    session = await openPrivateWorkspaceSession(route.scope.userId, route.scope.workspaceId);
    route.check();
    notePrivateView(route.scope);
    route.check(); const view = await session.read(); route.check();
    const opened = session;
    const options = { input, scope: opened.scope, directory: opened.directory, records: view.records, current: () => { try { route.check(); return opened.current(); } catch { return false; } } };
    if (path === "members.list") { const metadata = await privateWorkspaceMemberMetadata(options); route.check(); return privateMemberQuery({ ...options, metadata }); }
    if (isPrivateReportQuery(path)) {
      const metadata = path === "reports.summary" && input !== null && typeof input === "object" && "groupBy" in input && input.groupBy === "member" ? await privateWorkspaceMemberMetadata(options) : undefined;
      route.check(); return privateReportQuery({ ...options, path, metadata, policy: opened.policy });
    }
    if (path === "reports.trackedSpan") return privateReportTrackedSpan(options);
    if (path === "settings.businessProfile") return await privateBusinessProfileQuery(options);
    if (path === "settings.get") { const preferences = await privateDisplayPreferences(route.scope.userId); route.check(); return privateSettingsQuery({ ...options, preferences }); }
    if (path === "favorites.list") return privateFavoriteQuery(options);
    if (isPrivateEntryQuery(path)) return privateEntryQuery({ ...options, path });
    if (isPrivateCatalogQuery(path)) return privateCatalogQuery({ ...options, path });
    throw new PrivateContentUnavailableError();
  } catch (error) {
    if (error instanceof PrivateContentUnavailableError) throw error;
    throw new PrivateContentUnavailableError("Private workspace data could not be verified. Existing data was kept.");
  } finally { session?.close(); }
}

/** Final HTTP boundary, after native origin/workspace readiness and batching.
 * Revalidate every content-bearing member; one private/locked/unknown member
 * refuses the entire batch before any body or query filter reaches fetch. */
export async function assertStandardContentRequest(url: string, init?: RequestInit) {
  const target = new URL(url, privateDataOrigin()), prefix = "/api/trpc/";
  if (!target.pathname.startsWith(prefix)) throw new PrivateContentUnavailableError("Unexpected workspace request URL");
  const paths = decodeURIComponent(target.pathname.slice(prefix.length)).split(",");
  if (!paths.some(isWorkspaceContentProcedure)) return () => {};
  let raw;
  try { raw = typeof init?.body === "string" ? JSON.parse(init.body) : target.searchParams.has("input") ? JSON.parse(target.searchParams.get("input")!) : undefined; }
  catch { throw new PrivateContentUnavailableError("Workspace request could not be verified"); }
  const checks: (() => void)[] = [];
  for (const [index, path] of paths.entries()) {
    if (!isWorkspaceContentProcedure(path)) continue;
    const input = target.searchParams.get("batch") === "1" ? raw?.[String(index)] : raw;
    const workspaceId = input !== null && typeof input === "object" && typeof input.workspaceId === "string" ? input.workspaceId : null;
    const route = await currentWorkspaceContentRoute(workspaceId, init?.signal ?? undefined);
    if (target.origin !== route.scope.server || route.mode !== "standard") throw new PrivateContentUnavailableError("Private workspace content cannot use the standard HTTP transport");
    checks.push(route.check);
  }
  const check = () => { for (const guard of checks) guard(); }; check(); return check;
}
