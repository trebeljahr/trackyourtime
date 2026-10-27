import { TRPCError } from "@trpc/server";
const nested = ["entry", "stopped", "replaced"] as const;
/** Known receipt response shapes, shared with the original-retirement audit.
 * A replacement notice can contain a private workspace's clear name even when
 * the newly started entry and receipt belong to a standard workspace. */
export const ENTRY_OPERATION_RESULT_WORKSPACE_PATHS = ["workspaceId", ...nested.map(key => `${key}.workspaceId`)];
export function entryOperationResultWorkspaceIds(result: unknown): string[] {
  const invalid = () => new TRPCError({ code: "PRECONDITION_FAILED", message: "The stored entry result scope cannot be verified." });
  if (!result || typeof result !== "object" || Array.isArray(result)) throw invalid();
  const row = result as Record<string, unknown>, ids = new Set<string>();
  const read = (value: unknown, required: boolean) => {
    if (value === undefined && !required) return;
    if (typeof value !== "string" || !value) throw invalid();
    ids.add(value);
  };
  read(row.workspaceId, false);
  for (const key of nested) {
    const value = row[key]; if (value == null) continue;
    if (typeof value !== "object" || Array.isArray(value)) throw invalid();
    read((value as Record<string, unknown>).workspaceId, true);
  }
  return [...ids];
}
