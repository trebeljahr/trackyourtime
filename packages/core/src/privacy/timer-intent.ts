import { z } from "zod";
import { startTimerSchema, stopTimerSchema, entryIdInputSchema, continueEntrySchema, updateEntrySchema, privateStandardTimerStartInputSchema, recipientBoxSchema, type PrivateStandardTimerStartInput, type TimeEntry, type StartTimerReplaced } from "@starter/shared";
import { canonicalJson, sealForRecipient, unsealForRecipient, type PublicKey } from "./crypto.js";
import { privateRecordDigest } from "./workspace-edits.js";
import { privateEntryReader } from "./entry-view.js";
import { privateViewSource, type PrivateViewOptions, type PrivateViewScope } from "./view-source.js";
import { privateValue, type PlainPrivateRecord } from "./records.js";
const paths = ["entries.start", "entries.stop", "entries.discard", "entries.continue", "entries.update", "entries.remove"] as const;
export type PrivateTimerIntentPath = typeof paths[number];
export const isPrivateTimerIntentPath = (path: string): path is PrivateTimerIntentPath => (paths as readonly string[]).includes(path);
declare const brand: unique symbol;
export type VerifiedPrivateTimerIntent = Readonly<{ scope: PrivateViewScope; path: PrivateTimerIntentPath; operationId: string; receiptId: string; requestHash: string; input: Readonly<Record<string, unknown>>; current: () => boolean }> & { readonly [brand]: true };
const intents = new WeakSet<object>();
function freeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
/** No private input digest is published in timer metadata. This descriptor is
 * local authority only; its receipt is encrypted with the workspace records. */
export async function preparePrivateTimerIntent(options: { scope: PrivateViewScope; path: PrivateTimerIntentPath; input: unknown; operationId: string; current: () => boolean }): Promise<VerifiedPrivateTimerIntent> {
  const scope = Object.freeze({ ...options.scope }), path = options.path, operationId = z.uuid().parse(options.operationId), current = options.current;
  if (!isPrivateTimerIntentPath(path)) throw new Error("Unsupported private timer intent");
  const raw = structuredClone(z.record(z.string(), z.unknown()).parse(options.input));
  if (raw.workspaceId !== undefined && raw.workspaceId !== scope.workspaceId) throw new Error("Private timer intent belongs to another workspace");
  if (raw.operationId !== undefined && raw.operationId !== operationId) throw new Error("Private timer operation identity changed");
  const { workspaceId, operationId: operation, ...body } = raw; void workspaceId; void operation;
  const schema = path === "entries.start" ? startTimerSchema : path === "entries.stop" ? stopTimerSchema : path === "entries.discard" ? stopTimerSchema.omit({ end: true }) : path === "entries.continue" ? continueEntrySchema : path === "entries.update" ? updateEntrySchema : entryIdInputSchema;
  const input = schema.strict().parse(body);
  if (!current()) throw new Error("Private timer intent scope changed");
  const requestHash = await privateRecordDigest([scope.server, scope.userId, scope.workspaceId, path, input]);
  if (!current()) throw new Error("Private timer intent scope changed");
  const intent = Object.freeze({ scope, path, operationId, receiptId: `entryoperations:${operationId}`, requestHash, input: freeze(input), current }) as VerifiedPrivateTimerIntent;
  intents.add(intent); return intent;
}
function checkIntent(options: PrivateViewOptions, intent: VerifiedPrivateTimerIntent) {
  if (!intents.has(intent) || !intent.current() || canonicalJson(intent.scope) !== canonicalJson(options.scope)) throw new Error("Private timer intent changed");
}
type Result = (TimeEntry & { replaced?: StartTimerReplaced | null }) | { success: true; id: string };
function result(options: PrivateViewOptions, raw: unknown): Result {
  const body = z.record(z.string(), z.unknown()).parse(raw), id = z.string().min(1).max(100).parse(body.id);
  if (body.success === true) return z.object({ success: z.literal(true), id: z.string().min(1).max(100) }).strict().parse(body);
  if (body.workspaceId !== options.scope.workspaceId || body.authorId !== options.scope.userId || !Object.hasOwn(body, "hourlyRate")) throw new Error("Private timer result differs from its original account");
  const source = privateViewSource({ ...options, records: [{ kind: "entries", id, authorId: options.scope.userId, value: { ...body, _id: id } }, { kind: "entryMoney", id, authorId: options.scope.userId, value: { _id: id, hourlyRate: body.hourlyRate } }] });
  const reader = privateEntryReader(source), decoded = reader.detailed(reader.quick[0]!);
  if (!Object.hasOwn(body, "replaced")) return decoded;
  const replaced = z.object({ entryId: z.string().min(1).max(100), workspaceId: z.string().min(1).max(100), workspaceName: z.string().max(512), end: z.iso.datetime({ offset: true }) }).strict().nullable().parse(body.replaced);
  return { ...decoded, replaced };
}
function checkedResult(options: PrivateViewOptions, intent: VerifiedPrivateTimerIntent, raw: unknown): Result {
  const decoded = result(options, raw), deleting = intent.path === "entries.discard" || intent.path === "entries.remove";
  if (deleting !== ("success" in decoded) || (typeof intent.input.id === "string" && decoded.id !== intent.input.id && intent.path !== "entries.continue") || (["entries.start", "entries.continue"].includes(intent.path) && (decoded.id !== intent.operationId || !("end" in decoded) || decoded.end !== null)) || (intent.path === "entries.stop" && (!("end" in decoded) || decoded.end === null))) throw new Error("Private timer result differs from its original intent");
  return decoded;
}
const actorReceiptProtocol = "trackyourtime-private-timer-operation-v2";
const actorContext = (scope: PrivateViewScope, operationId: string) => canonicalJson([actorReceiptProtocol, scope.server, scope.workspaceId, scope.userId, operationId]);
/** Workspace owners can open an imports record, but only its author can open
 * this inner envelope. Cross-workspace notices and future handoff intent must
 * never disclose another workspace's content to the receipt's outer readers. */
export async function privateTimerActorReceipt(options: PrivateViewOptions & { operationId: string; payload: Record<string, unknown>; now: number }): Promise<PlainPrivateRecord> {
  const source = privateViewSource(options), scope = { ...options.scope }, operationId = z.uuid().parse(options.operationId), payload = structuredClone(options.payload), current = options.current;
  const publicKey = structuredClone(source.actor.publicKey), stamp = new Date(options.now).toISOString(); source.check();
  const box = await sealForRecipient(publicKey, payload, actorContext(scope, operationId));
  if (!current()) throw new Error("Private timer receipt scope changed"); source.check();
  return { kind: "imports", id: `entryoperations:${operationId}`, authorId: scope.userId, value: { _id: operationId, workspaceId: scope.workspaceId, userId: scope.userId, protocol: actorReceiptProtocol, box, createdAt: stamp, updatedAt: stamp } };
}
export async function openPrivateTimerActorReceipt(options: PrivateViewOptions & { record: PlainPrivateRecord; privateKey: PublicKey }): Promise<Record<string, unknown>> {
  const source = privateViewSource(options), scope = { ...options.scope }, record = structuredClone(options.record), privateKey = structuredClone(options.privateKey), current = options.current;
  source.check(); const value = z.record(z.string(), z.unknown()).parse(privateValue(record.value)), operationId = z.uuid().parse(value._id);
  if (record.kind !== "imports" || record.id !== `entryoperations:${operationId}` || record.authorId !== scope.userId || value.workspaceId !== scope.workspaceId || value.userId !== scope.userId || value.protocol !== actorReceiptProtocol) throw new Error("Private timer receipt belongs to another scope");
  const box = recipientBoxSchema.parse(value.box), opened = await unsealForRecipient<unknown>(privateKey, box, actorContext(scope, operationId));
  if (!current()) throw new Error("Private timer receipt scope changed"); source.check();
  return z.record(z.string(), z.unknown()).parse(opened);
}
export async function readPrivateTimerIntent(options: PrivateViewOptions & { intent: VerifiedPrivateTimerIntent; privateKey: PublicKey }): Promise<Result | null> {
  const { intent } = options; checkIntent(options, intent);
  const source = privateViewSource(options), row = source.ofKind("imports").find(row => row.id === intent.receiptId);
  if (!row) { source.check(); return null; }
  const outer = z.record(z.string(), z.unknown()).parse(privateValue(row.value));
  if (outer._id !== intent.operationId || outer.workspaceId !== options.scope.workspaceId || row.authorId !== options.scope.userId || outer.userId !== options.scope.userId) throw new Error("Private timer operation belongs to another scope");
  // Preserve older local receipts. New writers use the author-only envelope.
  const value = outer.protocol === actorReceiptProtocol ? await openPrivateTimerActorReceipt({ ...options, record: row }) : outer;
  if ((outer.protocol !== actorReceiptProtocol && outer.protocol !== "trackyourtime-private-timer-operation-v1") || value.operation !== intent.path || value.requestHash !== intent.requestHash) throw new Error("Private timer operation identity was reused for a different request");
  const decoded = checkedResult(options, intent, value.result); source.check(); checkIntent(options, intent); return decoded;
}
export async function privateTimerIntentRecord(options: PrivateViewOptions & { intent: VerifiedPrivateTimerIntent; result: Result; now: number }): Promise<PlainPrivateRecord> {
  const { intent } = options; checkIntent(options, intent); const source = privateViewSource(options); source.check();
  if (source.ofKind("imports").some(row => row.id === intent.receiptId)) throw new Error("Keep the original timer receipt instead of replacing it");
  const decoded = checkedResult(options, intent, structuredClone(options.result));
  const record = await privateTimerActorReceipt({ ...options, operationId: intent.operationId, payload: { operation: intent.path, requestHash: intent.requestHash, result: decoded } });
  checkIntent(options, intent); return record;
}

const standardHandoffProtocol = "trackyourtime-private-standard-start-intent-v1";
const standardHandoffSchema = z.object({
  protocol: z.literal(standardHandoffProtocol), operation: z.enum(["entries.start", "entries.continue"]), requestHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  workspaceId: z.string().min(1).max(100), entryId: z.string().regex(/^[a-f0-9]{24}$/), accountRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1),
  input: privateStandardTimerStartInputSchema,
  replaced: z.object({ entryId: z.string().min(1).max(100), workspaceId: z.string().min(1).max(100), workspaceName: z.string().max(512), end: z.iso.datetime({ offset: true }) }).strict().nullable(),
}).strict();
export type PrivateStandardHandoffIntent = z.infer<typeof standardHandoffSchema>;
function checkStandardIntent(options: PrivateViewOptions, intent: VerifiedPrivateTimerIntent) {
  if (!intents.has(intent) || !intent.current() || !["entries.start", "entries.continue"].includes(intent.path) || intent.scope.server !== options.scope.server || intent.scope.userId !== options.scope.userId || intent.scope.workspaceId === options.scope.workspaceId) throw new Error("Private standard timer intent changed");
  privateViewSource(options).check();
}
/** The standard target/body and old workspace notice are sealed only to the
 * account author. The source workspace's owner receives no new target content. */
export async function privateStandardHandoffRecord(options: PrivateViewOptions & { intent: VerifiedPrivateTimerIntent; accountRevision: number; replaced: StartTimerReplaced | null; now: number; standardInput?: PrivateStandardTimerStartInput }) {
  checkStandardIntent(options, options.intent);
  if (privateViewSource(options).ofKind("imports").some(row => row.id === options.intent.receiptId)) throw new Error("Keep the original timer receipt instead of replacing it");
  if (options.intent.path === "entries.start" && options.standardInput !== undefined) throw new Error("A standard start must keep its original input");
  const input = privateStandardTimerStartInputSchema.parse(options.intent.path === "entries.continue" ? options.standardInput : { ...options.intent.input, start: options.intent.input.start ?? new Date(options.now).toISOString() });
  if (options.intent.path === "entries.continue" && (Date.parse(input.start) !== options.now || (input.timeZone ?? null) !== (options.intent.input.timeZone ?? null) || input.originId !== options.intent.input.originId)) throw new Error("Standard continuation preparation differs from its original request");
  if (options.replaced && (options.replaced.workspaceId !== options.scope.workspaceId || Date.parse(options.replaced.end) !== Date.parse(input.start))) throw new Error("Private timer replacement notice differs from its source");
  const payload = standardHandoffSchema.parse({ protocol: standardHandoffProtocol, operation: options.intent.path, requestHash: options.intent.requestHash, workspaceId: options.intent.scope.workspaceId, entryId: options.intent.operationId.replaceAll("-", "").slice(0, 24).toLowerCase(), accountRevision: options.accountRevision, input, replaced: structuredClone(options.replaced) });
  const record = await privateTimerActorReceipt({ ...options, operationId: options.intent.operationId, payload }); checkStandardIntent(options, options.intent);
  return { record, payload };
}
export function verifyPrivateStandardHandoffIntent(options: PrivateViewOptions & { intent: VerifiedPrivateTimerIntent; payload: unknown }): PrivateStandardHandoffIntent {
  checkStandardIntent(options, options.intent);
  const payload = standardHandoffSchema.parse(options.payload);
  const expected = options.intent.path === "entries.start" ? privateStandardTimerStartInputSchema.parse({ ...options.intent.input, start: options.intent.input.start ?? payload.input.start }) : payload.input;
  if (payload.operation !== options.intent.path || (options.intent.path === "entries.continue" && ((payload.input.timeZone ?? null) !== (options.intent.input.timeZone ?? null) || payload.input.originId !== options.intent.input.originId))) throw new Error("Private standard timer continuation differs from its original request");
  if (payload.workspaceId !== options.intent.scope.workspaceId || payload.entryId !== options.intent.operationId.replaceAll("-", "").slice(0, 24).toLowerCase() || payload.requestHash !== options.intent.requestHash || canonicalJson(payload.input) !== canonicalJson(expected)) throw new Error("Private standard timer operation identity was reused for a different request");
  return payload;
}
export const isPrivateStandardHandoffPayload = (payload: Record<string, unknown>) => payload.protocol === standardHandoffProtocol;
