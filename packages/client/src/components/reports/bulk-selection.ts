import type { BulkEditEntriesResult, DetailedEntry } from "@starter/shared";

export function bulkFailures(result: BulkEditEntriesResult): ReadonlySet<string> {
  return new Set(result.results.filter((row) => !row.success).map((row) => row.id));
}

/** Bulk edits require persisted revisions and author permission, including running entries. */
export function selectableBulkEntries(entries: readonly DetailedEntry[], userId: string | null, workspaceId: string | null): DetailedEntry[] {
  return entries.filter((entry) => userId !== null && workspaceId !== null && entry.authorId === userId && entry.workspaceId === workspaceId && /^[a-f0-9]{24}$/i.test(entry.id));
}
