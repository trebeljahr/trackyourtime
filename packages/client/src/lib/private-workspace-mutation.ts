import { isPrivateFavoriteEdit, isPrivateCatalogEdit, isPrivateEntryEdit, isPrivateBusinessProfileEdit, isPrivateInvoiceEdit, PrivateBusinessLogoError, PrivateInvoiceRefusal, PRIVATE_INVOICE_PERMISSION_REQUIRED } from "@starter/core";
import { PrivateContentUnavailableError } from "./private-content-error";
import type { WorkspaceContentRoute } from "./private-content-route";
import { openPrivateWorkspaceSyncSession } from "./private-workspace-session";
import { notifyPrivateWorkspaceEdit } from "./private-workspace-sync";
import { markPrivateLocalResult } from "./private-local-result";
import { privateDisplayPreferences } from "./private-display-preferences";
import { notePrivateView } from "./private-view-lifecycle";
/** Supported private edits never enter standard HTTP, the legacy queue, or a
 * plaintext mirror. Return only after the encrypted local write is read back.
 * The shell reports pending delivery separately from this local result. */
export async function mutatePrivateWorkspace(route: WorkspaceContentRoute, path: string, input: unknown) {
  const frozen = structuredClone(input); route.check();
  if (route.mode !== "encrypted" || !route.scope.workspaceId || (!isPrivateFavoriteEdit(path) && !isPrivateCatalogEdit(path) && !isPrivateEntryEdit(path) && !isPrivateBusinessProfileEdit(path) && !isPrivateInvoiceEdit(path) && path !== "settings.update" && path !== "members.updateRate")) throw new PrivateContentUnavailableError("This operation is not available for private workspaces yet. Existing work was kept.");
  let copy: Awaited<ReturnType<typeof openPrivateWorkspaceSyncSession>> | null = null;
  try {
    copy = await openPrivateWorkspaceSyncSession(route.scope.userId, route.scope.workspaceId); route.check();
    notePrivateView(route.scope); route.check();
    let saved;
    if (isPrivateFavoriteEdit(path)) saved = await copy.editFavorite(path, frozen);
    else if (isPrivateCatalogEdit(path)) saved = await copy.editCatalog(path, frozen);
    else if (isPrivateBusinessProfileEdit(path)) saved = await copy.editBusinessProfile(path, frozen);
    else if (path === "members.updateRate") saved = await copy.editMemberRate(frozen);
    else if (isPrivateInvoiceEdit(path)) {
      const preferences = await privateDisplayPreferences(route.scope.userId); route.check();
      saved = await copy.editInvoice(path, frozen, preferences);
    }
    else if (path === "settings.update") {
      const preferences = await privateDisplayPreferences(route.scope.userId); route.check();
      saved = await copy.editSettings(frozen, preferences);
    } else if (isPrivateEntryEdit(path)) {
      if (!frozen || typeof frozen !== "object" || Array.isArray(frozen)) throw new PrivateContentUnavailableError();
      const { __durableScope, __durableTempId, __privateIntentId, ...input } = frozen as Record<string, unknown>;
      if (__durableScope !== undefined) {
        const scope = __durableScope as { owner?: unknown; server?: unknown; workspaceId?: unknown } | null;
        if (!scope || typeof scope !== "object" || scope.owner !== route.scope.userId || scope.server !== route.scope.server || scope.workspaceId !== route.scope.workspaceId) throw new PrivateContentUnavailableError("The original entry scope changed before this edit could finish");
      }
      if (__durableTempId !== undefined && (typeof __durableTempId !== "string" || !__durableTempId || __durableTempId.length > 200)) throw new PrivateContentUnavailableError();
      if (__privateIntentId !== undefined && typeof __privateIntentId !== "string") throw new PrivateContentUnavailableError();
      saved = await copy.editEntry(path, input, __privateIntentId);
    } else throw new PrivateContentUnavailableError(); route.check();
    notifyPrivateWorkspaceEdit(copy.scope); return markPrivateLocalResult(saved.result);
  } catch (error) {
    if (error instanceof PrivateContentUnavailableError) throw error;
    if (error instanceof PrivateBusinessLogoError) throw new PrivateContentUnavailableError(error.refusal);
    // An invoice refusal names what to change (range, number, nothing to bill).
    if (error instanceof PrivateInvoiceRefusal) throw new PrivateContentUnavailableError(error.message);
    if (error instanceof Error && error.message === PRIVATE_INVOICE_PERMISSION_REQUIRED) throw new PrivateContentUnavailableError(error.message);
    throw new PrivateContentUnavailableError("The private edit could not be confirmed on this device. Existing saved work was kept.");
  } finally { copy?.close(); }
}
