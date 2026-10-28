import { z } from "zod";
import { createEntrySchema, entryIdInputSchema, intervalIntersects, projectBillableByDefault, resolveHourlyRate, startTimerSchema, continueEntrySchema, updateEntrySchema, type PrivateKind, type TimeEntry } from "@starter/shared";
import { canonicalJson } from "./crypto.js";
import { privateEntryReader } from "./entry-view.js";
import { privateViewSource, type PrivateViewOptions } from "./view-source.js";
import { privateValue, type PlainPrivateRecord } from "./records.js";
const paths = ["entries.create", "entries.update", "entries.remove"] as const;
export type PrivateEntryEditPath = typeof paths[number];
export const isPrivateEntryEdit = (path: string): path is PrivateEntryEditPath => (paths as readonly string[]).includes(path);
export const PRIVATE_ENTRY_EDIT_KINDS: readonly PrivateKind[] = ["entries", "entryMoney", "clients", "projects", "projectMoney", "tasks", "tags", "settings", "settingsMoney", "members", "memberMoney", "approvals", "imports"];
const rate = z.number().finite().nonnegative().nullish().transform((value) => value ?? null);
const id = z.string().min(1).max(100), instant = z.iso.datetime({ offset: true });
const invoiceFields = ["clientId", "projectId", "taskId", "billable", "start", "end"];
declare const privateEntryIntentBrand: unique symbol;
export type VerifiedPrivateEntryIntent = Readonly<{ scope: PrivateViewOptions["scope"]; path: PrivateEntryEditPath; intentId: string; receiptId: string; request: string; requestHash: string; current: () => boolean }> & { readonly [privateEntryIntentBrand]: true };
const intents = new WeakSet<object>();
function entryArguments(scope: PrivateViewOptions["scope"], path: PrivateEntryEditPath, rawInput: unknown, timer = false) {
  if (!isPrivateEntryEdit(path)) throw new Error("Unsupported private entry edit");
  const raw = z.record(z.string(), z.unknown()).parse(rawInput ?? {});
  if (raw.workspaceId !== undefined && raw.workspaceId !== scope.workspaceId) throw new Error("Private entry intent belongs to another workspace");
  const { workspaceId: _workspace, ...input } = raw; void _workspace;
  const args = (path === "entries.create" ? (timer ? z.object({ ...createEntrySchema.shape, end: instant.nullable() }) : createEntrySchema).strict().parse(input) : path === "entries.update" ? updateEntrySchema.strict().parse(input) : entryIdInputSchema.strict().parse(input)) as Record<string, unknown>;
  if (args.operationId !== undefined) throw new Error("Standard queued operations cannot be replayed into private storage");
  return args;
}
const hash = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)))), byte => byte.toString(16).padStart(2, "0")).join("");
/** The host prepares this from original frozen intent before waiting for the
 * replica lock. Only branded, scope-bound descriptors can address receipts. */
export async function preparePrivateEntryIntent(options: { scope: PrivateViewOptions["scope"]; path: PrivateEntryEditPath; input: unknown; intentId: string; current: () => boolean }): Promise<VerifiedPrivateEntryIntent> {
  const scope = Object.freeze({ ...options.scope }), path = options.path, intentId = z.uuid().parse(options.intentId), current = options.current;
  const check = () => { if (!current()) throw new Error("Private entry intent changed before preparation finished"); }; check();
  const args = entryArguments(scope, path, options.input), request = canonicalJson(args);
  const [identityHash, requestHash] = await Promise.all([hash([scope.userId, scope.workspaceId, intentId]), hash([path, args])]); check();
  const prepared = Object.freeze({ scope, path, intentId, receiptId: `entryoperations:${identityHash}`, request, requestHash, current }) as VerifiedPrivateEntryIntent;
  intents.add(prepared); return prepared;
}
/** Completed manual time only. Starting, stopping or reopening a timer needs
 * account-wide coordination across standard and encrypted workspaces. */
type EntryEditOptions = PrivateViewOptions & { path: PrivateEntryEditPath; input: unknown; now?: number; newId?: () => string; intent?: VerifiedPrivateEntryIntent };
export function privateEntryEdit(options: EntryEditOptions) { return buildEntryEdit(options, null); }
const timerCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start"), entryId: z.uuid(), input: startTimerSchema.strict() }).strict(),
  z.object({ kind: z.literal("continue"), entryId: z.uuid(), input: continueEntrySchema.strict() }).strict(),
  z.object({ kind: z.literal("stop"), id, end: instant }).strict(),
  z.object({ kind: z.literal("discard"), id }).strict(),
  z.object({ kind: z.literal("reopen"), id }).strict(),
  z.object({ kind: z.literal("update"), input: updateEntrySchema.strict() }).strict(),
]);
export type PrivateTimerEntryCommand = z.infer<typeof timerCommandSchema>;
/** Domain planning only, for the account timer coordinator. Never enqueue
 * this result through an ordinary workspace-only edit: its pointer and record
 * changes must share the signed account transaction and recovery checkpoint. */
export function privateTimerEntryEdit(options: PrivateViewOptions & { command: PrivateTimerEntryCommand; expectedRunningId: string | null; now: number }) {
  const source = privateViewSource(options), reader = privateEntryReader(source), command = timerCommandSchema.parse(options.command);
  const running = reader.quick.filter(row => row.doc.authorId === options.scope.userId && row.doc.end === null);
  if (running.length > 1 || (running[0]?.doc.id ?? null) !== options.expectedRunningId) throw new Error("Private timer differs from its account checkpoint");
  const stamp = new Date(z.number().finite().parse(options.now)).toISOString();
  let path: PrivateEntryEditPath, input: Record<string, unknown>, action: TimerAction, newId: string | undefined;
  if (command.kind === "start" || command.kind === "continue") {
    if (running.length) throw new Error("Stop the original private timer in the account transition before starting another");
    path = "entries.create"; action = "start"; newId = command.entryId;
    if (command.kind === "start") input = { ...command.input, start: command.input.start ?? stamp, end: null };
    else {
      const original = reader.quick.find(row => row.doc.id === command.input.id);
      if (!original) throw new Error("Entry not found");
      const entry = reader.detailed(original, false);
      const tags = new Set(source.ofKind("tags").map(row => row.id));
      input = { description: entry.description, clientId: entry.clientId, projectId: entry.projectId, taskId: entry.taskId, billable: entry.billable, source: entry.source, tagIds: entry.tagIds.filter(tag => tags.has(tag)), timeZone: command.input.timeZone, start: stamp, end: null };
    }
  } else if (command.kind === "reopen") {
    if (running.length) throw new Error("Another private timer is already running");
    path = "entries.update"; action = "reopen"; input = { id: command.id, end: null };
  } else {
    const target = command.kind === "update" ? command.input.id : command.id;
    if (running.length !== 1 || running[0]!.doc.id !== target) throw new Error("The original private timer is not running");
    action = command.kind;
    path = command.kind === "discard" ? "entries.remove" : "entries.update";
    input = command.kind === "update" ? { ...command.input } : command.kind === "stop" ? { id: command.id, end: command.end } : { id: command.id };
    if (command.kind === "update" && command.input.end !== undefined) throw new Error("Use an account stop or reopen transition to change timer state");
  }
  const result = buildEntryEdit({ ...options, path, input, newId: newId ? () => newId! : undefined }, action);
  const current = "end" in result.result && result.result.end === null ? { workspaceId: options.scope.workspaceId, entryId: result.result.id } : null;
  source.check();
  return { ...result, previous: options.expectedRunningId === null ? null : { workspaceId: options.scope.workspaceId, entryId: options.expectedRunningId }, current };
}
type TimerAction = "start" | "stop" | "update" | "reopen" | "discard";
function buildEntryEdit(options: EntryEditOptions, timer: TimerAction | null): { records: PlainPrivateRecord[]; remove: Pick<PlainPrivateRecord, "kind" | "id" | "authorId">[]; result: TimeEntry | { success: true; id: string } } {
  const { scope } = options, source = privateViewSource(options), { check, ofKind, value, paired } = source;
  const args = entryArguments(scope, options.path, options.input, timer !== null), intent = options.intent;
  if (intent) {
    if (!intents.has(intent) || !intent.current() || intent.scope.server !== scope.server || intent.scope.userId !== scope.userId || intent.scope.workspaceId !== scope.workspaceId || intent.path !== options.path || intent.request !== canonicalJson(args)) throw new Error("Private entry intent differs from its original request");
    const existing = ofKind("imports").find(row => row.id === intent.receiptId);
    if (existing) {
      if (existing.authorId !== scope.userId) throw new Error("Private entry receipt belongs to another author");
      const receipt = z.record(z.string(), z.unknown()).parse(privateValue(existing.value));
      if (receipt._id !== intent.receiptId.slice("entryoperations:".length) || receipt.protocol !== "trackyourtime-private-entry-operation-v1" || receipt.userId !== scope.userId || receipt.workspaceId !== scope.workspaceId || receipt.operation !== options.path || receipt.requestHash !== intent.requestHash) throw new Error("Private operation identity was reused for a different request");
      let result: TimeEntry | { success: true; id: string };
      if (options.path === "entries.remove") {
        result = z.object({ success: z.literal(true), id }).strict().parse(receipt.result);
        if (result.id !== args.id) throw new Error("Private deletion receipt differs from its original target");
      } else {
        const stored = z.record(z.string(), z.unknown()).parse(receipt.result), entryId = id.parse(stored.id);
        if (!Object.hasOwn(stored, "hourlyRate")) throw new Error("Private entry receipt is missing its monetary snapshot");
        const reader = privateEntryReader(privateViewSource({ ...options, records: [
          { kind: "entries", id: entryId, authorId: scope.userId, value: { ...stored, _id: entryId } },
          { kind: "entryMoney", id: entryId, authorId: scope.userId, value: { _id: entryId, hourlyRate: stored.hourlyRate } },
        ] }));
        result = reader.detailed(reader.quick[0]!);
        if (result.end === null || result.authorId !== scope.userId || (options.path === "entries.create" ? result.id !== intent.intentId : result.id !== args.id)) throw new Error("Private entry receipt differs from its original target");
      }
      check(); if (!intent.current()) throw new Error("Private entry receipt changed"); return { records: [], remove: [], result };
    }
  }
  const receipt = (result: TimeEntry | { success: true; id: string }): PlainPrivateRecord[] => {
    if (!intent) return []; if (!intent.current()) throw new Error("Private entry intent changed before receipt publication");
    return [{ kind: "imports", id: intent.receiptId, authorId: scope.userId, value: { _id: intent.receiptId.slice("entryoperations:".length), protocol: "trackyourtime-private-entry-operation-v1", workspaceId: scope.workspaceId, userId: scope.userId, requestHash: intent.requestHash, operation: options.path, result: structuredClone(result), createdAt: stamp, updatedAt: stamp } }];
  };
  const prior = options.path === "entries.create" ? undefined : ofKind("entries").find((row) => row.id === args.id && row.authorId === scope.userId);
  if (options.path !== "entries.create" && !prior) throw new Error("Entry not found");
  const reader = privateEntryReader(source), oldRow = prior ? reader.quick.find((row) => row.doc.id === prior.id) : undefined;
  const old = oldRow ? reader.detailed(oldRow) : null;
  if (prior && (!old || old.authorId !== scope.userId)) throw new Error("Entry author differs from its signed record");
  if (timer === null && (old?.end === null || args.end === null)) throw new Error("Private timer changes require account-wide coordination");
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
  const writable = (start: string, end: string | null) => {
    if (approvals.some((approval) => !["draft", "rejected"].includes(approval.status) && intervalIntersects(new Date(start), end === null ? new Date(8640000000000000) : new Date(end), new Date(approval.start), new Date(approval.end)))) throw new Error("Submitted or approved time cannot be edited");
  };
  if (old) writable(old.start, timer === "stop" ? instant.parse(args.end) : old.end);
  if (options.path === "entries.remove") {
    if (old!.invoiceId) throw new Error("Invoiced time cannot be deleted");
    const remove = ["entries", "entryMoney"].map((kind) => ({ kind: kind as PrivateKind, id: prior!.id, authorId: scope.userId }));
    const result = { success: true as const, id: prior!.id }; check(); return { records: receipt(result), remove, result };
  }
  if (old?.invoiceId && invoiceFields.some((field) => args[field] !== undefined)) throw new Error("Invoiced time can only be relabelled or retagged");
  const start = new Date(String(args.start ?? old?.start)).toISOString(), rawEnd = args.end === undefined ? old?.end : args.end;
  const end = rawEnd === null ? null : new Date(String(rawEnd)).toISOString();
  if (end !== null && Date.parse(end) <= Date.parse(start)) throw new Error("End must be after start");
  writable(start, end);
  const durationSec = end === null ? 0 : Math.round((Date.parse(end) - Date.parse(start)) / 1000);
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
  const resnapshot = !old || timer === "stop" || billable !== old.billable || projectId !== old.projectId;
  let financial: PlainPrivateRecord | null = null, currency = old?.currency;
  const entryId = prior?.id ?? z.uuid().parse(intent?.intentId ?? (options.newId ?? (() => crypto.randomUUID()))());
  if (!prior && [...ofKind("entries"), ...ofKind("entryMoney")].some((row) => row.id === entryId)) throw new Error("New entry identity already exists");
  if (resnapshot) {
    facts ??= billing(); currency = facts.currency;
    const stored = prior ? ofKind("entryMoney").find((row) => row.id === prior.id)! : null;
    financial = { kind: "entryMoney", id: entryId, authorId: scope.userId, value: { ...(stored?.value ?? { _id: entryId }), hourlyRate: resolveHourlyRate({ billable, ...facts }) } };
  } else if (!billable && old?.hourlyRate !== null) {
    const stored = ofKind("entryMoney").find((row) => row.id === prior!.id)!;
    financial = { ...stored, value: { ...stored.value, hourlyRate: null } };
  }
  if (timer === "reopen" && !financial) financial = ofKind("entryMoney").find(row => row.id === prior!.id)!;
  const correctedRunaway = old?.runaway && old.runaway.resolvedAt === null && (args.start !== undefined || args.end !== undefined) && durationSec <= old.runaway.limitSec;
  const body: Record<string, unknown> = prior ? { ...prior.value } : { _id: entryId, workspaceId: scope.workspaceId, authorId: scope.userId, source: args.source ?? "web", timeZone: args.timeZone ?? null, runaway: null, invoiceId: null, importId: null, createdAt: stamp };
  Object.assign(body, { description: args.description ?? old?.description ?? "", ...clientPatch, projectId, taskId, billable, start, end, durationSec, currency, ...tagPatch, updatedAt: stamp });
  if (correctedRunaway) body.runaway = { ...(value(prior!).runaway as object), resolvedAt: stamp };
  const records: PlainPrivateRecord[] = [{ kind: "entries", id: entryId, authorId: scope.userId, value: body }, ...(financial ? [financial] : [])];
  const changed = new Set(records.map((row) => JSON.stringify([row.kind, row.id]))), after = options.records.filter((row) => !changed.has(JSON.stringify([row.kind, row.id]))).concat(records);
  const next = privateEntryReader(privateViewSource({ ...options, records: after })), row = next.quick.find((row) => row.doc.id === entryId);
  if (!row) throw new Error("Prepared private entry is missing");
  const result: TimeEntry = next.detailed(row); check(); if (intent && !intent.current()) throw new Error("Private entry intent changed"); return { records: records.concat(receipt(result)), remove: [], result };
}
