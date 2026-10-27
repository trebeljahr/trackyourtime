import { PrivateContentUnavailableError } from "./private-content-error";
type Guard = { current: () => boolean; metadata?: (fields: Record<string, unknown>) => void };
const guards = new WeakMap<object, Guard>();
/** UI hooks use this small registry without importing auth/key machinery.
 * Boolean guards retain primitive scopes/epochs. The optional metadata sink
 * belongs to an active intent. SDK dispatch checks still apply. */
export const registerPrivateMutationGuard = (variables: object, current: () => boolean, metadata?: Guard["metadata"]) => { guards.set(variables, { current, metadata }); };
export const releasePrivateMutationGuard = (variables: object) => { guards.delete(variables); };
export function privateMutationStillCurrent(variables: unknown): boolean {
  return !variables || typeof variables !== "object" || (guards.get(variables)?.current() ?? true);
}
export function assertPrivateMutationStillCurrent(variables: unknown) {
  if (!privateMutationStillCurrent(variables)) throw new PrivateContentUnavailableError("The account or workspace changed before this edit could finish");
}

/** Explicit generated timer fields pass through the owning intent validator.
 * Standalone legacy adapters without an app intent retain their old behavior. */
export function assignPrivateMutationMetadata<T extends object>(variables: T, fields: Record<string, unknown>): T {
  guards.get(variables)?.metadata?.(fields); return Object.assign(variables, fields);
}

export type PrivateMutationAction = { current: () => boolean; check: () => void };
let captureAction: (() => PrivateMutationAction) | null = null;
export const registerPrivateMutationActionCapture = (capture: () => PrivateMutationAction) => { captureAction = capture; };
/** App-level actions that await before creating a React Query mutation can
 * capture the same primitive scope. Isolated legacy adapters remain usable. */
export const capturePrivateMutationAction = (): PrivateMutationAction => captureAction?.() ?? { current: () => true, check: () => {} };
export const capturePrivateMutationGuard = (variables: unknown): (() => boolean) => variables && typeof variables === "object" ? guards.get(variables)?.current ?? (() => true) : () => true;
