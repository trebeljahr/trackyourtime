import { z } from "zod";
import { publicEncryptionKeySchema } from "./privacy.js";
import { privateTimerPointerSchema, signedPrivateTimerSchema } from "./private-timer.js";
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER), digest = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** Short, independently approved anchors fit inside the existing bounded device
 * envelope. The relay never chooses these checkpoints or sees account keys. */
const legacyWorkspaceTrust = z.object({
  inventory: z.object({ revision, digest }).strict(), transport: z.object({ revision, root: digest }).strict(),
}).strict();
const timerTrust = z.object({
  digest, checkpoint: z.object({ revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1), root: digest.nullable(), current: privateTimerPointerSchema.nullable() }).strict(), signed: signedPrivateTimerSchema.nullable(),
}).strict();
const workspaceTrustWithTimer = legacyWorkspaceTrust.extend({ timer: timerTrust }).strict();
export const privateDeviceWorkspaceTrustSchema = z.union([workspaceTrustWithTimer, legacyWorkspaceTrust]);
export type PrivateDeviceWorkspaceTrust = z.infer<typeof privateDeviceWorkspaceTrustSchema>;
const privateKey = publicEncryptionKeySchema.extend({ d: digest }).strict();
const legacyTransfer = z.object({
  v: z.literal(2), server: z.string().min(1).max(2048), userId: z.string().min(1).max(100),
  keys: z.object({ publicKey: publicEncryptionKeySchema, signingPublicKey: publicEncryptionKeySchema }).strict(),
  secrets: z.object({ v: z.literal(1), master: digest, privateKey, signingPrivateKey: privateKey }).strict(),
  workspaceTrust: legacyWorkspaceTrust.nullable(),
}).strict();
export const privateDeviceTransferSchema = z.discriminatedUnion("v", [legacyTransfer, legacyTransfer.extend({ v: z.literal(3), workspaceTrust: workspaceTrustWithTimer }).strict()]);
export type PrivateDeviceTransfer = z.infer<typeof privateDeviceTransferSchema>;
