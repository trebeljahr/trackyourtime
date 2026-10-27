import { PrivateContentUnavailableError } from "./private-content-error";
export class PrivateWorkspaceCreationError extends PrivateContentUnavailableError {
  constructor(readonly reason: "server" | "private" | "local" | "response") {
    super("Workspace creation could not be verified. Existing workspace access was kept.");
    this.name = "PrivateWorkspaceCreationError";
  }
}
/** Only local instances select UI copy; never display a raw server message. */
export function privateWorkspaceCreationFailure(input: unknown) {
  let value = input;
  for (let i = 0; i < 5 && value && typeof value === "object"; i++) {
    if (value instanceof PrivateWorkspaceCreationError) return value.reason;
    value = (value as { cause?: unknown }).cause;
  }
  return null;
}
