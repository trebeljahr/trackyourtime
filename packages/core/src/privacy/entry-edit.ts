import { z } from "zod";
import { createEntrySchema, entryIdInputSchema, intervalIntersects, projectBillableByDefault, resolveHourlyRate, updateEntrySchema, type PrivateKind, type TimeEntry } from "@starter/shared";
import { privateEntryReader } from "./entry-view.js";
import { privateViewSource, type PrivateViewOptions } from "./view-source.js";
import type { PlainPrivateRecord } from "./records.js";
const paths = ["entries.create", "entries.update", "entries.remove"] as const;
export type PrivateEntryEditPath = typeof paths[number];
export const isPrivateEntryEdit = (path: string): path is PrivateEntryEditPath => (paths as readonly string[]).includes(path);
export const PRIVATE_ENTRY_EDIT_KINDS: readonly PrivateKind[] = ["entries", "entryMoney", "clients", "projects", "projectMoney", "tasks", "tags", "settings", "settingsMoney", "members", "memberMoney", "approvals"];
const rate = z.number().finite().nonnegative().nullish().transform((value) => value ?? null);
const id = z.string().min(1).max(100), instant = z.iso.datetime({ offset: true });
const invoiceFields = ["clientId", "projectId", "taskId", "billable", "start", "end"];
/** Completed manual time only. Starting, stopping or reopening a timer needs
 * account-wide coordination across standard and encrypted workspaces. */
export function privateEntryEdit(options: PrivateViewOptions & { path: PrivateEntryEditPath; input: unknown; now?: number; newId?: () => string }): { records: PlainPrivateRecord[]; remove: Pick<PlainPrivateRecord, "kind" | "id" | "authorId">[]; result: TimeEntry | { success: true; id: string } } {
  const { scope } = options, source = privateViewSource(options), { check, ofKind, value, paired } = source;
  if (!isPrivateEntryEdit(options.path)) throw new Error("Unsupported private entry edit");
  const raw = z.record(z.string(), z.unknown()).parse(options.input ?? {});
  if (raw.workspaceId !== undefined && raw.workspaceId !== scope.workspaceId) throw new Error("Private entry intent belongs to another workspace");
  const { workspaceId: _workspace, ...input } = raw; void _workspace;
  const args = (options.path === "entries.create" ? createEntrySchema.strict().parse(input) : options.path === "entries.update" ? updateEntrySchema.strict().parse(input) : entryIdInputSchema.strict().parse(input)) as Record<string, unknown>;
  if (args.operationId !== undefined) throw new Error("Standard queued operations cannot be replayed into private storage");
  const prior = options.path === "entries.create" ? undefined : ofKind("entries").find((row) => row.id === args.id && row.authorId === scope.userId);
  if (options.path !== "entries.create" && !prior) throw new Error("Entry not found");
  const reader = privateEntryReader(source), oldRow = prior ? reader.quick.find((row) => row.doc.id === prior.id) : undefined;
  const old = oldRow ? reader.detailed(oldRow) : null;
  if (prior && (!old || old.authorId !== scope.userId)) throw new Error("Entry author differs from its signed record");
  if (old?.end === null || args.end === null) throw new Error("Private timer changes require account-wide coordination");
  const stamp = new Date(options.now ?? Date.now()).toISOString();
  const approvals = ofKind("approvals").map((row) => {
    const fact = value(row);
    if (fact.authorId !== row.authorId) throw new Error("Approval author differs from its signed record");
    return { row, fact };
  }).filter(({ row }) => row.authorId === scope.userId).map(({ fact }) => {
    const approval = z.object({ start: instant, end: instant, status: z.string().min(1) }).parse(fact);
    if (Date.parse(approval.end) <= Date.parse(approval.start)) throw new Error("Invalid approval interval");
    return approval;
  });
  const writable = (start: string, end: string) => {
    if (approvals.some((approval) => !["draft", "rejected"].includes(approval.status) && intervalIntersects(new Date(start), new Date(end), new Date(approval.start), new Date(approval.end)))) throw new Error("Submitted or approved time cannot be edited");
  };
  if (old) writable(old.start, old.end!);
  if (options.path === "entries.remove") {
    if (old!.invoiceId) throw new Error("Invoiced time cannot be deleted");
    const remove = ["entries", "entryMoney"].map((kind) => ({ kind: kind as PrivateKind, id: prior!.id, authorId: scope.userId }));
    check(); return { records: [] as PlainPrivateRecord[], remove, result: { success: true as const, id: prior!.id } };
  }
  if (old?.invoiceId && invoiceFields.some((field) => args[field] !== undefined)) throw new Error("Invoiced time can only be relabelled or retagged");
  const start = new Date(String(args.start ?? old?.start)).toISOString(), end = new Date(String(args.end ?? old?.end)).toISOString();
  if (Date.parse(end) <= Date.parse(start)) throw new Error("End must be after start");
  writable(start, end);
  const durationSec = Math.round((Date.parse(end) - Date.parse(start)) / 1000);
  if (!Number.isSafeInteger(durationSec) || durationSec < 0) throw new Error("Entry duration exceeds supported precision");
  const projectId = (args.projectId === undefined ? old?.projectId : args.projectId) as string | null | undefined ?? null;
  const taskId = (args.taskId === undefined ? old?.taskId : args.taskId) as string | null | undefined ?? null;
  const sharedValue = (row: PlainPrivateRecord) => { if (row.authorId !== null) throw new Error("Shared entry reference has an unexpected author"); return value(row); };
  const project = ofKind("projects").find((row) => row.id === projectId), projectValue = project ? sharedValue(project) : null;
  if ((options.path === "entries.create" || args.projectId !== undefined || args.taskId !== undefined) && projectId !== null && !project) throw new Error("Project not found");
  if (options.path === "entries.create" || args.projectId !== undefined || args.taskId !== undefined) {
    const task = ofKind("tasks").find((row) => row.id === taskId); if (taskId !== null && !task) throw new Error("Task not found"); if (task) sharedValue(task);
  }
  const clientOfProject = (projectId: string | null) => { const row = ofKind("projects").find((row) => row.id === projectId); return row ? id.nullish().parse(sharedValue(row).clientId) ?? null : null; };
  let clientPatch: { clientId?: string | null } = {};
  if (!prior || args.clientId !== undefined) {
    const clientId = args.clientId === undefined ? clientOfProject(projectId) : id.nullable().parse(args.clientId);
    if (clientId !== null) { const client = ofKind("clients").find((row) => row.id === clientId); if (!client) throw new Error("Client not found"); sharedValue(client); }
    clientPatch = { clientId };
  } else if (old && old.clientId === undefined && args.projectId !== undefined) clientPatch = { clientId: clientOfProject(old.projectId) };
  let tagPatch: { tagIds?: string[] } = {};
  if (!prior || args.tagIds !== undefined) {
    const tagIds = [...new Set(z.array(id).max(20).parse(args.tagIds ?? []))];
    for (const tagId of tagIds) { const tag = ofKind("tags").find((row) => row.id === tagId); if (!tag) throw new Error("Tag not found"); sharedValue(tag); }
    tagPatch = { tagIds };
  }
  const billing = () => {
    const settings = ofKind("settings"); if (settings.length > 1) throw new Error("Duplicate workspace settings");
    const currency = settings.length ? z.string().regex(/^[A-Z]{3}$/).parse(sharedValue(settings[0]!).currency) : "EUR";
    const defaultRate = settings.length ? rate.parse(paired(settings[0]!, "settingsMoney").defaultHourlyRate) ?? 0 : 0;
    const member = ofKind("members").filter((row) => row.authorId === scope.userId);
    if (member.length !== 1 || value(member[0]!).userId !== scope.userId) throw new Error("Original author membership is missing");
    const memberRate = rate.parse(paired(member[0]!, "memberMoney").hourlyRate);
    const projectRate = project ? rate.parse(paired(project, "projectMoney").hourlyRate) : null;
    return { currency, defaultRate, memberRate, projectRate };
  };
  let billable = args.billable as boolean | undefined ?? old?.billable;
  let facts: ReturnType<typeof billing> | undefined;
  if (billable === undefined) { facts = billing(); billable = projectValue ? projectBillableByDefault({ billableDefault: z.boolean().parse(projectValue.billableDefault), hourlyRate: facts.projectRate }, facts.defaultRate, facts.memberRate) : false; }
  const resnapshot = !old || billable !== old.billable || projectId !== old.projectId;
  let financial: PlainPrivateRecord | null = null, currency = old?.currency;
  const entryId = prior?.id ?? z.uuid().parse((options.newId ?? (() => crypto.randomUUID()))());
  if (!prior && ofKind("entries").some((row) => row.id === entryId)) throw new Error("New entry identity already exists");
  if (resnapshot) {
    facts ??= billing(); currency = facts.currency;
    const stored = prior ? ofKind("entryMoney").find((row) => row.id === prior.id)! : null;
    financial = { kind: "entryMoney", id: entryId, authorId: scope.userId, value: { ...(stored?.value ?? { _id: entryId }), hourlyRate: resolveHourlyRate({ billable, ...facts }) } };
  } else if (!billable && old?.hourlyRate !== null) {
    const stored = ofKind("entryMoney").find((row) => row.id === prior!.id)!;
    financial = { ...stored, value: { ...stored.value, hourlyRate: null } };
  }
  const correctedRunaway = old?.runaway && old.runaway.resolvedAt === null && (args.start !== undefined || args.end !== undefined) && durationSec <= old.runaway.limitSec;
  const body: Record<string, unknown> = prior ? { ...prior.value } : { _id: entryId, workspaceId: scope.workspaceId, authorId: scope.userId, source: args.source ?? "web", timeZone: args.timeZone ?? null, runaway: null, invoiceId: null, importId: null, createdAt: stamp };
  Object.assign(body, { description: args.description ?? old?.description ?? "", ...clientPatch, projectId, taskId, billable, start, end, durationSec, currency, ...tagPatch, updatedAt: stamp });
  if (correctedRunaway) body.runaway = { ...(value(prior!).runaway as object), resolvedAt: stamp };
  const records: PlainPrivateRecord[] = [{ kind: "entries", id: entryId, authorId: scope.userId, value: body }, ...(financial ? [financial] : [])];
  const changed = new Set(records.map((row) => JSON.stringify([row.kind, row.id]))), after = options.records.filter((row) => !changed.has(JSON.stringify([row.kind, row.id]))).concat(records);
  const next = privateEntryReader(privateViewSource({ ...options, records: after })), row = next.quick.find((row) => row.doc.id === entryId);
  if (!row) throw new Error("Prepared private entry is missing");
  const result: TimeEntry = next.detailed(row); check(); return { records, remove: [], result };
}
