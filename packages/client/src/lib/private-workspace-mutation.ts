import { isPrivateFavoriteEdit, isPrivateCatalogEdit } from "@starter/core";
import { PrivateContentUnavailableError } from "./private-content-error";
import type { WorkspaceContentRoute } from "./private-content-route";
import { openPrivateWorkspaceSyncSession } from "./private-workspace-session";
import { notifyPrivateWorkspaceEdit } from "./private-workspace-sync";
import { notePrivateView } from "./private-view-lifecycle";
/** Supported private edits never enter standard HTTP, the legacy queue, or a
 * plaintext mirror. Return only after the encrypted local write is read back.
 * The shell reports pending delivery separately from this local result. */
export async function mutatePrivateWorkspace(route: WorkspaceContentRoute, path: string, input: unknown) {
  const frozen = structuredClone(input); route.check();
  if (route.mode !== "encrypted" || !route.scope.workspaceId || (!isPrivateFavoriteEdit(path) && !isPrivateCatalogEdit(path))) throw new PrivateContentUnavailableError("This operation is not available for private workspaces yet. Existing work was kept.");
  let copy: Awaited<ReturnType<typeof openPrivateWorkspaceSyncSession>> | null = null;
  try {
    copy = await openPrivateWorkspaceSyncSession(route.scope.userId, route.scope.workspaceId); route.check();
    notePrivateView(route.scope); route.check();
    const saved = isPrivateFavoriteEdit(path) ? await copy.editFavorite(path, frozen) : await copy.editCatalog(path as Parameters<typeof copy.editCatalog>[0], frozen); route.check();
    notifyPrivateWorkspaceEdit(copy.scope); return saved.result;
  } catch (error) {
    if (error instanceof PrivateContentUnavailableError) throw error;
    throw new PrivateContentUnavailableError("The private edit could not be confirmed on this device. Existing saved work was kept.");
  } finally { copy?.close(); }
}
