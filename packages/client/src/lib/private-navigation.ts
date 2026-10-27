import { setActiveWorkspaceSchema } from "@starter/shared";
import { PrivateContentUnavailableError } from "./private-content-error";
/** Session-default navigation carries one public id, never a workspace draft
 * or a server-selected content mode. Keep it scoped through final dispatch. */
export function workspaceSelectionInput(input: unknown): { workspaceId: string } {
  const result = setActiveWorkspaceSchema.strict().safeParse(input);
  if (!result.success) throw new PrivateContentUnavailableError("Workspace selection metadata could not be verified");
  return { workspaceId: result.data.workspaceId };
}
export function workspaceSelectionResult(workspaceId: string, input: unknown): { workspaceId: string } {
  if (!input || typeof input !== "object" || Array.isArray(input) || (input as { workspaceId?: unknown }).workspaceId !== workspaceId) throw new PrivateContentUnavailableError("The server returned a different workspace selection");
  return { workspaceId };
}
