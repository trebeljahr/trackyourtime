import { z } from "zod";
import type { DetailedFavorite } from "@starter/shared";
import { resolveQuickStartLabels } from "../quick-start-view.js";
import { privateQuickStartCatalog, privateViewSource, type PrivateViewOptions } from "./view-source.js";
const id = z.string().min(1).max(100), nullableId = id.nullish().transform((value) => value ?? null);
const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const favoriteSchema = z.object({ _id: id, workspaceId: id, userId: id, description: z.string().max(500).default(""), clientId: id.nullable().optional(), projectId: nullableId, taskId: nullableId, billable: z.boolean(), order: z.number().int().nonnegative(), createdAt: instant, updatedAt: instant });
/** Personal pins never use colleague-visibility flags. Neither an owner nor
 * an administrator receives someone else's favorites through this adapter. */
export function privateFavoriteQuery(options: PrivateViewOptions & { input: unknown }): DetailedFavorite[] {
  const source = privateViewSource(options), { check, ofKind, value } = source;
  const input = z.object({ workspaceId: id.optional() }).strict().parse(options.input ?? {});
  if (input.workspaceId !== undefined && input.workspaceId !== options.scope.workspaceId) throw new Error("Private favorite filter belongs to another workspace");
  const rows = ofKind("favorites").map((row) => {
    const { _id, ...favorite } = favoriteSchema.parse(value(row));
    if (row.authorId !== options.scope.userId || favorite.userId !== options.scope.userId) throw new Error("Private favorites include another person's pins");
    return { id: _id, ...favorite };
  }).sort((a, b) => a.order - b.order || Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
  const catalog = rows.length ? privateQuickStartCatalog(source) : null;
  const result = rows.map((row) => ({ ...row, ...resolveQuickStartLabels(row, catalog!) })); check(); return result;
}
