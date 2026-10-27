import { withWorkspaceId } from "@starter/core";
import { getActiveWorkspaceId } from "./active-workspace";
import { isWorkspaceContentProcedure } from "./private-content-route";
import { PrivateContentUnavailableError } from "./private-content-error";
import { capturePrivateRequestScope, checkPrivateRequestScope, type PrivateRequestScope } from "./private-request-scope";
type Intent = { owner: object; variables: object; path: string; scope: PrivateRequestScope; activeWorkspaceId: string | null; input: unknown };
const inputs = new WeakMap<object, Intent>(), owners = new WeakMap<object, Intent>();
function pathOf(key: unknown): string | null {
  if (!Array.isArray(key) || !Array.isArray(key[0]) || !key[0].length || key[0].some((part: unknown) => typeof part !== "string" || !part)) return null;
  return key[0].join(".");
}
/** Runs before React Query's optimistic hooks or network pause. The tRPC link
 * retrieves intent by the original variables object, so rerendering mutation
 * options cannot replace the binding. No credential or key is retained. */
export function beginPrivateMutationIntent(key: unknown, variables: unknown, owner: object) {
  const path = pathOf(key); if (!path || !isWorkspaceContentProcedure(path)) return;
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) throw new PrivateContentUnavailableError("Use an explicit input object before saving workspace data");
  if (inputs.has(variables)) throw new PrivateContentUnavailableError("This input is already being saved. Wait before reusing it");
  const scope = capturePrivateRequestScope(), workspaceId = getActiveWorkspaceId();
  const explicit = (variables as { workspaceId?: unknown }).workspaceId;
  if (path !== "workspaces.create" && workspaceId === null && typeof explicit !== "string") throw new PrivateContentUnavailableError("Choose a workspace before saving data");
  const input = withWorkspaceId(structuredClone(variables), workspaceId), intent = { owner, variables, scope, path, input, activeWorkspaceId: workspaceId };
  inputs.set(variables, intent); owners.set(owner, intent);
}
export function privateMutationIntent(path: string, variables: unknown) {
  if (!variables || typeof variables !== "object") return null;
  const intent = inputs.get(variables); if (!intent) return null;
  if (intent.path !== path) throw new PrivateContentUnavailableError("The original mutation procedure changed");
  checkPrivateRequestScope(intent.scope); return { scope: intent.scope, input: structuredClone(intent.input) };
}
/** Terminal cache events run after local callbacks. Removing a pending
 * mutation on lock does not erase its guard while its async hook still runs. */
export function finishPrivateMutationIntent(owner: object): { stale: boolean } | null {
  const intent = owners.get(owner); if (!intent) return null;
  owners.delete(owner); if (inputs.get(intent.variables) === intent) inputs.delete(intent.variables);
  try { checkPrivateRequestScope(intent.scope); return { stale: getActiveWorkspaceId() !== intent.activeWorkspaceId }; } catch { return { stale: true }; }
}
