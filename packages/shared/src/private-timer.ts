import { z } from "zod";
import { startTimerSchema, entrySourceSchema } from "./schemas.js";
import { privateSignatureSchema, signedPrivateChainedEditSchema } from "./private-workspace.js";
const id = z.string().min(1).max(100), root = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const privateTimerPointerSchema = z.object({ workspaceId: id, entryId: z.union([z.uuid(), z.string().regex(/^[a-f0-9]{24}$/)]) }).strict();
const standardPointer = z.object({ workspaceId: id, entryId: z.string().regex(/^[a-f0-9]{24}$/) }).strict();
export const privateStandardTimerStartInputSchema = startTimerSchema.omit({ operationId: true }).extend({ start: z.iso.datetime({ offset: true }) }).strict();
export const privateStandardTimerResultInputSchema = z.object({ operationId: z.uuid(), workspaceId: id, entryId: z.string().regex(/^[a-f0-9]{24}$/), input: privateStandardTimerStartInputSchema }).strict();
export type PrivateStandardTimerResultInput = z.infer<typeof privateStandardTimerResultInputSchema>;
export type PrivateStandardTimerStartInput = z.infer<typeof privateStandardTimerStartInputSchema>;
export const privateTimerHeaderSchema = z.object({
  v: z.literal(1), protocol: z.literal("trackyourtime-private-account-timer-v1"),
  server: z.url().max(2048).regex(/^https?:\/\/[^/?#]+$/),
  userId: id, operationId: z.uuid(), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1), previousRoot: root.nullable(),
  previous: privateTimerPointerSchema.nullable(), current: privateTimerPointerSchema.nullable(),
  standardStop: standardPointer.nullable(),
  standardStart: standardPointer.optional(),
  edits: z.array(z.object({ workspaceId: id, operationId: z.uuid(), expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1), head: root }).strict()).min(1).max(2),
}).strict().superRefine((header, ctx) => {
  if (!header.previous && !header.current) ctx.addIssue({ code: "custom", message: "A timer transition needs an active target" });
  if ((header.revision === 1) !== (header.previousRoot === null)) ctx.addIssue({ code: "custom", message: "Timer history checkpoint is inconsistent" });
  if (header.revision === 1 && header.previous !== null) ctx.addIssue({ code: "custom", message: "Initial timer history cannot replace a private predecessor" });
  if (header.previous && header.standardStop) ctx.addIssue({ code: "custom", message: "Two timer sources cannot be replaced together" });
  if (header.standardStart && (!header.previous || header.current || header.standardStop || header.edits.some(edit => edit.workspaceId === header.standardStart!.workspaceId))) ctx.addIssue({ code: "custom", message: "A standard start can only replace its private predecessor in another workspace" });
  const needed = new Set([header.previous?.workspaceId, header.current?.workspaceId].filter((value): value is string => value !== undefined));
  if (new Set(header.edits.map(row => row.workspaceId)).size !== header.edits.length || header.edits.length !== needed.size || header.edits.some((row, index) => !needed.has(row.workspaceId) || (index > 0 && row.workspaceId <= header.edits[index - 1]!.workspaceId))) ctx.addIssue({ code: "custom", message: "Timer workspace edits must match the ordered targets" });
});
export const signedPrivateTimerSchema = z.object({ header: privateTimerHeaderSchema, signature: privateSignatureSchema }).strict();
export const privateTimerTransitionSchema = z.object({ signed: signedPrivateTimerSchema, edits: z.array(signedPrivateChainedEditSchema).min(1).max(2), standardStopEnd: z.iso.datetime({ offset: true }).optional(), standardStartInput: privateStandardTimerStartInputSchema.optional() }).strict().superRefine((input, ctx) => {
  if ((input.signed.header.standardStart !== undefined) !== (input.standardStartInput !== undefined)) ctx.addIssue({ code: "custom", message: "A standard timer body belongs only to its declared start" });
  if ((input.signed.header.standardStop !== null) !== (input.standardStopEnd !== undefined)) ctx.addIssue({ code: "custom", message: "A standard timer end belongs only to its declared stop" });
});
export type PrivateTimerPointer = z.infer<typeof privateTimerPointerSchema>;
export type PrivateTimerHeader = z.infer<typeof privateTimerHeaderSchema>;
export type SignedPrivateTimer = z.infer<typeof signedPrivateTimerSchema>;
export type PrivateTimerTransition = z.infer<typeof privateTimerTransitionSchema>;
const timerRevision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
export const privateTimerAckSchema = z.object({ revision: timerRevision.min(1), root }).strict();
export const privateTimerVersionsInputSchema = z.object({ after: timerRevision, through: timerRevision.optional() }).strict().refine(input => input.through === undefined || input.through >= input.after, "Timer history range moved backward");
export const privateTimerPageSchema = z.object({ through: timerRevision, root: root.nullable(), next: timerRevision.nullable(), versions: z.array(signedPrivateTimerSchema).max(16) }).strict().refine(page => (page.through === 0) === (page.root === null), "Timer history boundary is inconsistent");
export type PrivateTimerPage = z.infer<typeof privateTimerPageSchema>;

const currentInstant = z.iso.datetime({ offset: true }), currentId = z.string().min(1).max(100);
export const standardCurrentTimerSchema = z.object({
  id: currentId, workspaceId: currentId, authorId: currentId, description: z.string().max(500),
  clientId: currentId.nullable().optional(), projectId: currentId.nullable(), taskId: currentId.nullable(), billable: z.boolean(),
  start: currentInstant, end: z.null(), durationSec: z.number().finite().nonnegative(), hourlyRate: z.number().finite().nonnegative().nullable(), currency: z.string().regex(/^[A-Z]{3}$/),
  source: entrySourceSchema, timeZone: z.string().max(100).nullable(), tagIds: z.array(currentId).max(1000), invoiceId: currentId.nullable(), importId: currentId.nullable(), createdAt: currentInstant, updatedAt: currentInstant,
  runaway: z.object({ detectedAt: currentInstant, elapsedSec: z.number().finite().nonnegative(), limitSec: z.number().finite().nonnegative(), action: z.enum(["flagged", "capped", "stopped"]), resolvedAt: currentInstant.nullable() }).strict().nullable(),
}).strict();
