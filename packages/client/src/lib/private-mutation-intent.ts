import { registerPrivateMutationGuard, releasePrivateMutationGuard, registerPrivateMutationActionCapture } from "./private-mutation-guard";
import { withWorkspaceId } from "@starter/core";
import { getActiveWorkspaceId } from "./active-workspace";
import { isWorkspaceContentProcedure } from "./private-content-route";
import { PrivateContentUnavailableError } from "./private-content-error";
import { capturePrivateRequestScope, checkPrivateRequestScope, type PrivateRequestScope } from "./private-request-scope";
import { capturePrivateTimerAction, type PrivateTimerAction } from "./private-timer-action";
import { isPrivateTimerIntentPath } from "@starter/core";
type Intent = { owner: object; variables: object; path: string; scope: PrivateRequestScope; activeWorkspaceId: string | null; input: unknown; timerAction?: PrivateTimerAction };
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
  // Standard workspace creation deliberately publishes a new signed inventory
  // reservation. Its dedicated preparer validates that transition separately.
  const scope = capturePrivateRequestScope({ policy: path !== "workspaces.create" }), workspaceId = getActiveWorkspaceId();
  const explicit = (variables as { workspaceId?: unknown }).workspaceId;
  if (path !== "workspaces.create" && workspaceId === null && typeof explicit !== "string") throw new PrivateContentUnavailableError("Choose a workspace before saving data");
  const input = withWorkspaceId(structuredClone(variables), workspaceId), intent = { owner, variables, scope, path, input, activeWorkspaceId: workspaceId, ...(isPrivateTimerIntentPath(path) ? { timerAction: capturePrivateTimerAction(variables) } : {}) };
  inputs.set(variables, intent); owners.set(owner, intent);
  registerPrivateMutationGuard(variables, () => { try { checkPrivateRequestScope(scope); return getActiveWorkspaceId() === workspaceId; } catch { return false; } }, (fields) => {
    checkPrivateRequestScope(scope);
    if (!path.startsWith("entries.") || Object.keys(fields).some((field) => !internalFields.has(field))) throw new PrivateContentUnavailableError("Unsupported late mutation metadata");
    validateInternalFields(intent, fields); intent.input = { ...(intent.input as Record<string, unknown>), ...structuredClone(fields) };
  });
}
export function privateMutationIntent(path: string, variables: unknown) {
  if (!variables || typeof variables !== "object") return null;
  const intent = inputs.get(variables); if (!intent) return null;
  if (intent.path !== path) throw new PrivateContentUnavailableError("The original mutation procedure changed");
  checkPrivateRequestScope(intent.scope);
  if (intent.path.startsWith("entries.")) validateInternalFields(intent, intent.input as Record<string, unknown>);
  return { scope: intent.scope, input: structuredClone(intent.input), timerAction: intent.timerAction };
}
/** Terminal cache events run after local callbacks. Removing a pending
 * mutation on lock does not erase its guard while its async hook still runs. */
export function finishPrivateMutationIntent(owner: object): { stale: boolean } | null {
  const intent = owners.get(owner); if (!intent) return null;
  owners.delete(owner); if (inputs.get(intent.variables) === intent) { inputs.delete(intent.variables); releasePrivateMutationGuard(intent.variables); }
  try { checkPrivateRequestScope(intent.scope); return { stale: getActiveWorkspaceId() !== intent.activeWorkspaceId }; } catch { return { stale: true }; }
}

const internalFields = new Set(["__durableScope", "__durableTempId", "id", "workspaceId"]);
function validateInternalFields(intent: Intent, fields: Record<string, unknown>) {
  const snapshot = intent.input as Record<string, unknown>;
  if (fields.workspaceId !== undefined && fields.workspaceId !== snapshot.workspaceId) throw new PrivateContentUnavailableError("Generated timer metadata belongs to another workspace");
  if (fields.id !== undefined && (typeof fields.id !== "string" || !fields.id || fields.id.length > 100)) throw new PrivateContentUnavailableError("Generated timer identity could not be verified");
  if (fields.__durableTempId !== undefined && (typeof fields.__durableTempId !== "string" || !fields.__durableTempId || fields.__durableTempId.length > 200)) throw new PrivateContentUnavailableError("Generated timer identity could not be verified");
  if (fields.__durableScope !== undefined) {
    const value = fields.__durableScope as { owner?: unknown; server?: unknown; workspaceId?: unknown } | null;
    if (!value || typeof value !== "object" || value.owner !== intent.scope.userId || value.server !== intent.scope.server || value.workspaceId !== snapshot.workspaceId) throw new PrivateContentUnavailableError("Generated timer metadata belongs to another account or workspace");
  }
}

export function installPrivateMutationActionCapture() {
  return registerPrivateMutationActionCapture((options) => {
    const scope = capturePrivateRequestScope(), workspaceId = getActiveWorkspaceId(), bindWorkspace = options?.workspace !== false;
    const check = () => { checkPrivateRequestScope(scope); if (bindWorkspace && getActiveWorkspaceId() !== workspaceId) throw new PrivateContentUnavailableError("The workspace changed before this action could finish"); };
    const current = () => { try { check(); return true; } catch { return false; } };
    return { check, current };
  });
}
