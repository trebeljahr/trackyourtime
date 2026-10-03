import type { DetailedEntry } from "@starter/shared";
import { isTempId } from "@/lib/offline";

export type BlockProtection = "missing" | "foreign" | "running" | "invoiced" | "syncing";

/** A cell slice is never an editable entry. Check the full record before opening or saving. */
export const blockProtection = (
  entry: DetailedEntry | undefined,
  userId: string | null,
  workspaceId: string | null,
): BlockProtection | null => {
  if (entry === undefined) return "missing";
  if (userId === null || workspaceId === null || entry.authorId !== userId || entry.workspaceId !== workspaceId) return "foreign";
  if (entry.end === null) return "running";
  if (entry.invoiceId != null) return "invoiced";
  if (isTempId(entry.id)) return "syncing";
  return null;
};
