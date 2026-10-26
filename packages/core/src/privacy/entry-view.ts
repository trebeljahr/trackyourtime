import { z } from "zod";
import { canSeeEntry, canSeeMoneyFor, entryAmount, entryDescriptionsSchema, entryListSchema, entrySourceSchema, idInputSchema, projectDetailedEntry, recentEntriesSchema, type DetailedEntry, type TimeEntry } from "@starter/shared";
import { collapseDescriptions, collapseRecents } from "../quick-start-view.js";
import { privateViewSource, privateQuickStartCatalog, type PrivateViewOptions } from "./view-source.js";
const id = z.string().min(1).max(100), nullableId = id.nullish().transform((value) => value ?? null);
const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const quickSchema = z.object({ _id: id, workspaceId: id, authorId: id, description: z.string().max(500).default(""), clientId: id.nullable().optional(), projectId: nullableId, taskId: nullableId, billable: z.boolean(), start: instant, end: instant.nullish().transform((value) => value ?? null), tagIds: z.array(id).default([]) });
const runawaySchema = z.object({ detectedAt: instant, elapsedSec: z.number().finite().nonnegative(), limitSec: z.number().finite().nonnegative(), action: z.enum(["flagged", "capped", "stopped"]), resolvedAt: instant.nullish().transform((value) => value ?? null) });
const entrySchema = quickSchema.extend({ durationSec: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER), currency: z.string().regex(/^[A-Z]{3}$/), source: entrySourceSchema, timeZone: z.string().max(100).nullish().transform((value) => value ?? null), runaway: runawaySchema.nullish().transform((value) => value ?? null), invoiceId: nullableId, importId: nullableId, createdAt: instant, updatedAt: instant });
const rateSchema = z.number().finite().nonnegative().nullable().optional().transform((value) => value ?? null);
const paths = ["entries.list", "entries.get", "entries.recent", "entries.descriptions"] as const;
export type PrivateEntryQueryPath = typeof paths[number];
export const isPrivateEntryQuery = (path: string): path is PrivateEntryQueryPath => (paths as readonly string[]).includes(path);
const byRecency = (a: { start: string; id: string }, b: { start: string; id: string }) => Date.parse(b.start) - Date.parse(a.start) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
/** Scoped reads only. The account-wide current timer and writes need a
 * separate cross-workspace coordinator, so they cannot silently use this view. */
export function privateEntryQuery(options: PrivateViewOptions & { path: PrivateEntryQueryPath; input: unknown; now?: number }) {
  const { scope, path } = options, source = privateViewSource(options), { check, visibility, value, ofKind, paired } = source;
  const rawInput = z.record(z.string(), z.unknown()).parse(options.input ?? {});
  if (rawInput.workspaceId !== undefined && rawInput.workspaceId !== scope.workspaceId) throw new Error("Private entry filter belongs to another workspace");
  const { workspaceId: _scope, ...input } = rawInput; void _scope;
  const quick = ofKind("entries").map((record) => {
    const { _id, ...doc } = quickSchema.parse(value(record));
    if (doc.authorId !== record.authorId || !canSeeEntry(visibility, doc.authorId)) throw new Error("Private entries include ungranted time");
    return { record, doc: { id: _id, ...doc } };
  });
  const quickCatalog = () => privateQuickStartCatalog(source);
  const detailed = (row: typeof quick[number]): TimeEntry => {
    const { _id, ...doc } = entrySchema.parse(value(row.record));
    const hourlyRate = canSeeMoneyFor(visibility, doc.authorId) ? rateSchema.parse(paired(row.record, "entryMoney").hourlyRate) : null;
    return { id: _id, ...doc, hourlyRate };
  };
  let result;
  if (path === "entries.recent" || path === "entries.descriptions") {
    const args = path === "entries.recent" ? recentEntriesSchema.strict().parse(input) : entryDescriptionsSchema.strict().parse(input);
    const now = options.now ?? Date.now(); if (!Number.isFinite(now)) throw new Error("Invalid private entry clock");
    const since = now - (args.days ?? (path === "entries.recent" ? 30 : 180)) * 86400000;
    const descriptions = args as z.infer<typeof entryDescriptionsSchema>, search = descriptions.search?.trim().toLowerCase() ?? "";
    const rows = quick.map(({ doc }) => doc).filter((entry) => entry.authorId === scope.userId && entry.end !== null && Date.parse(entry.start) >= since && (path === "entries.recent" || (entry.description !== "" && (descriptions.projectId === undefined || entry.projectId === descriptions.projectId) && (descriptions.taskId === undefined || entry.taskId === descriptions.taskId) && (!search || entry.description.toLowerCase().includes(search))))).sort(byRecency).slice(0, 400);
    result = path === "entries.recent" ? collapseRecents(rows, quickCatalog(), args.limit ?? 8) : collapseDescriptions(rows, quickCatalog(), args.limit ?? 25);
  } else if (path === "entries.get") {
    const args = idInputSchema.strict().parse(input), row = quick.find(({ doc }) => doc.id === args.id);
    if (!row) throw new Error("Private entry not found"); result = detailed(row);
  } else if (path === "entries.list") {
    const args = entryListSchema.extend({ cursor: z.string().max(512).optional() }).strict().parse(input), from = Date.parse(args.from), to = Date.parse(args.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error("Invalid private entry range");
    const catalog = quickCatalog(), search = args.search?.trim().toLowerCase() ?? "";
    let cursor: { start: string; id: string } | undefined, invalidCursor = false;
    if (args.cursor) {
      const separator = args.cursor.lastIndexOf("|"), cursorId = separator === -1 ? args.cursor : args.cursor.slice(separator + 1);
      const cursorStart = separator === -1 ? quick.find(({ doc }) => doc.id === cursorId)?.doc.start : args.cursor.slice(0, separator);
      if (!cursorId || !cursorStart || !Number.isFinite(Date.parse(cursorStart))) invalidCursor = true;
      else cursor = { id: cursorId, start: new Date(cursorStart).toISOString() };
    }
    const clientOf = (doc: typeof quick[number]["doc"]) => doc.clientId === undefined ? (doc.projectId ? catalog.projects.get(doc.projectId)?.clientId ?? null : null) : doc.clientId;
    const matching = invalidCursor ? [] : quick.filter(({ doc }) => Date.parse(doc.start) < to && (doc.end === null || Date.parse(doc.end) > from) && (!args.projectIds || args.projectIds.includes(doc.projectId!)) && (!args.clientIds?.length || args.clientIds.includes(clientOf(doc)!)) && (!args.taskIds || args.taskIds.includes(doc.taskId!)) && (!args.tagIds?.length || doc.tagIds.some((tag) => args.tagIds!.includes(tag))) && (args.billable === undefined || doc.billable === args.billable) && (!search || doc.description.toLowerCase().includes(search)) && (!cursor || byRecency(doc, cursor) > 0)).sort((a, b) => byRecency(a.doc, b.doc));
    const limit = args.limit ?? 50, page = matching.slice(0, limit), entries: DetailedEntry[] = page.map((row) => {
      const entry = detailed(row), project = entry.projectId ? catalog.projects.get(entry.projectId) : undefined, task = entry.taskId ? catalog.tasks.get(entry.taskId) : undefined, clientId = clientOf(row.doc), amount = entryAmount(entry.durationSec, entry.hourlyRate);
      if (amount !== null && !Number.isFinite(amount)) throw new Error("Private entry amount exceeds supported precision");
      return projectDetailedEntry({ ...entry, projectName: project?.name ?? null, projectColor: project?.color ?? null, taskName: task?.name ?? null, clientName: clientId ? catalog.clients.get(clientId) ?? null : null, amount }, visibility)!;
    });
    const last = entries.at(-1); result = matching.length > limit && last ? { entries, nextCursor: `${last.start}|${last.id}` } : { entries };
  } else throw new Error("This private entry query is not supported");
  check(); return result;
}
