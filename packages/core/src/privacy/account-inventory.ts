import { z } from "zod";
import { publicEncryptionKeySchema } from "@starter/shared";
import { canonicalJson, decodeSecret, fingerprint, signPrivateChange, type PublicKey } from "./crypto.js";
import { signedPrivateWorkspacePolicySchema, verifyPrivateWorkspacePolicy } from "./mode-policy.js";
import { privateRecordDigest } from "./workspace-edits.js";
import { createPrivateStorage, type PrivateStorageKey } from "./storage.js";
import type { KeyValueStorage } from "../storage.js";
import type { QueueExclusive } from "../durable-entry.js";
const digest = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const workspace = z.discriminatedUnion("mode", [
  z.object({ workspaceId: z.string().min(1).max(100), mode: z.literal("standard") }).strict(),
  z.object({ workspaceId: z.string().min(1).max(100), mode: z.literal("encrypted"), signedPolicy: signedPrivateWorkspacePolicySchema }).strict(),
]);
const inventorySchema = z.object({
  v: z.literal(1), protocol: z.literal("trackyourtime-account-workspace-inventory-v1"),
  server: z.string().min(1).max(2048), userId: z.string().min(1).max(100), accountFingerprint: digest,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), previousDigest: digest.nullable(), workspaces: z.array(workspace).max(1000),
}).strict();
const signedSchema = z.object({ inventory: inventorySchema, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
export type PrivateAccountWorkspace = z.infer<typeof workspace>;
export type SignedPrivateAccountInventory = z.infer<typeof signedSchema>;
export type PrivateAccountInventoryCheckpoint = { revision: number; digest: string };
type Scope = { server: string; userId: string };
export const PRIVATE_ACCOUNT_INVENTORY_SCOPE = "trackyourtime:account-inventory-v1";
const verified = new WeakSet<object>(), locallySigned = new WeakMap<object, () => boolean>();
export type VerifiedPrivateAccountInventory = Readonly<{ signed: SignedPrivateAccountInventory; checkpoint: PrivateAccountInventoryCheckpoint; current: () => boolean }>;
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
export class PrivateAccountInventoryMissingError extends Error {
  constructor() { super("Trusted account workspace inventory is missing. Restore it or explicitly enroll this device before accessing workspace data."); this.name = "PrivateAccountInventoryMissingError"; }
}
function assertCurrent(value: VerifiedPrivateAccountInventory, scope: Scope) {
  if (!verified.has(value) || !value.current() || value.signed.inventory.server !== scope.server || value.signed.inventory.userId !== scope.userId) throw new Error("Use the current verified account workspace inventory");
}
function transition(previous: VerifiedPrivateAccountInventory, next: SignedPrivateAccountInventory["inventory"]) {
  if (next.revision !== previous.checkpoint.revision + 1 || next.previousDigest !== previous.checkpoint.digest) throw new Error("Account workspace inventory skipped a revision or rolled back");
  for (const before of previous.signed.inventory.workspaces) if (before.mode === "encrypted") {
    const after = next.workspaces.find((row) => row.workspaceId === before.workspaceId);
    if (!after || after.mode !== "encrypted" || canonicalJson(after.signedPolicy.policy) !== canonicalJson(before.signedPolicy.policy)) throw new Error("Encrypted workspace policy cannot be removed, downgraded or replaced");
  }
}
async function verify(input: unknown, scope: Scope, signingPublicKey: PublicKey, current: () => boolean): Promise<VerifiedPrivateAccountInventory> {
  if (!current()) throw new Error("Private account changed during inventory verification");
  if (new TextEncoder().encode(JSON.stringify(input)).length > 512 * 1024) throw new Error("Account workspace inventory exceeds its size limit");
  const signed = signedSchema.parse(input), inventory = signed.inventory;
  if (inventory.server !== scope.server || inventory.userId !== scope.userId || new URL(inventory.server).origin !== inventory.server || !["https:", "http:"].includes(new URL(inventory.server).protocol)) throw new Error("Account workspace inventory belongs to another scope");
  const ids = inventory.workspaces.map((row) => row.workspaceId);
  if (new Set(ids).size !== ids.length || canonicalJson(ids) !== canonicalJson([...ids].sort())) throw new Error("Account workspace IDs must be unique and sorted");
  if ((inventory.revision === 1) !== (inventory.previousDigest === null) || signingPublicKey.d || inventory.accountFingerprint !== await fingerprint(signingPublicKey)) throw new Error("Account workspace inventory key or initial revision changed");
  const key = await crypto.subtle.importKey("jwk", signingPublicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decodeSecret(signed.signature, 64), new TextEncoder().encode(canonicalJson(inventory)))) throw new Error("Account workspace inventory signature did not match");
  for (const row of inventory.workspaces) if (row.mode === "encrypted") {
    const pin = row.signedPolicy.policy;
    await verifyPrivateWorkspacePolicy(row.signedPolicy, { ...scope, workspaceId: row.workspaceId }, signingPublicKey, { activationRoot: pin.activationRoot, directoryDigest: pin.directoryDigest }, current);
  }
  const checkpoint = { revision: inventory.revision, digest: await privateRecordDigest(inventory) };
  if (!current()) throw new Error("Private account changed during inventory verification");
  const result = freeze({ signed, checkpoint, current }); verified.add(result); return result;
}
/** Explicit device/account enrollment or update only. First enrollment is
 * intentionally distinguished from server replay; callers must not invoke it
 * automatically when an existing device/account inventory disappeared. */
export async function signPrivateAccountInventory(options: Scope & {
  workspaces: readonly PrivateAccountWorkspace[]; previous: VerifiedPrivateAccountInventory | null;
  signingPrivateKey: PublicKey; current: () => boolean;
}): Promise<SignedPrivateAccountInventory> {
  const scope = { server: options.server, userId: options.userId }, previous = options.previous, privateKey = structuredClone(options.signingPrivateKey);
  const check = () => { if (!options.current()) throw new Error("Private account changed during inventory signing"); if (previous) assertCurrent(previous, scope); };
  check(); if (!privateKey.d) throw new Error("The unlocked account signing key is required");
  const accountFingerprint = await fingerprint(privateKey);
  if (previous && previous.signed.inventory.accountFingerprint !== accountFingerprint) throw new Error("Account inventory key rotation requires a separate verified recovery flow");
  const workspaces = structuredClone([...options.workspaces]).sort((a, b) => a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0);
  const inventory = inventorySchema.parse({ v: 1, protocol: "trackyourtime-account-workspace-inventory-v1", ...scope, accountFingerprint, revision: (previous?.checkpoint.revision ?? 0) + 1, previousDigest: previous?.checkpoint.digest ?? null, workspaces });
  if (previous) transition(previous, inventory); check();
  const signed = signedSchema.parse({ inventory, signature: await signPrivateChange(privateKey, inventory) });
  const { kty, crv, x, y } = privateKey;
  await verify(signed, scope, { kty, crv, x, y }, options.current); check();
  const result = freeze(signed); locallySigned.set(result, options.current); return result;
}
/** Account-scoped encrypted checkpoint. Server replay can update an existing
 * inventory only consecutively. A new device requires either fresh local
 * enrollment or a checkpoint independently obtained from device/recovery. */
export async function createPrivateAccountInventoryStore(options: Scope & {
  storage: KeyValueStorage; signingPublicKey: PublicKey; exclusive: QueueExclusive;
  resolveStorageKey: () => PrivateStorageKey | null; capture: () => () => void;
}) {
  const scope = { server: options.server, userId: options.userId }, key = publicEncryptionKeySchema.parse(options.signingPublicKey);
  const storage = await createPrivateStorage({ storage: options.storage, scope: { ...scope, workspaceId: PRIVATE_ACCOUNT_INVENTORY_SCOPE }, resolveKey: options.resolveStorageKey });
  const checkValue = (signed: unknown, check: () => void) => verify(signed, scope, key, () => { try { check(); return true; } catch { return false; } });
  const load = async (check: () => void) => { const raw = await storage.getItem("signed-account-inventory"); check(); return raw === null ? null : checkValue(JSON.parse(raw), check); };
  const persist = async (value: VerifiedPrivateAccountInventory, check: () => void) => { check(); await storage.setItem("signed-account-inventory", JSON.stringify(value.signed)); check(); const saved = await load(check); check(); if (!saved || saved.checkpoint.digest !== value.checkpoint.digest) throw new Error("Could not confirm the saved account workspace inventory"); return saved; };
  const accept = (input: unknown, enrollment: boolean, expected?: PrivateAccountInventoryCheckpoint) => {
    const local = locallySigned.get(input as object)?.() === true, signed = signedSchema.parse(input), anchor = expected ? z.object({ revision: z.number().int().positive(), digest }).strict().parse(expected) : undefined;
    return options.exclusive(async () => {
      const check = options.capture(); check(); const prior = await load(check); check(); const next = await checkValue(signed, check); check();
      if (anchor && (next.checkpoint.revision !== anchor.revision || next.checkpoint.digest !== anchor.digest)) throw new Error("Account workspace inventory differs from the trusted recovery checkpoint");
      if (prior) {
        if (prior.checkpoint.digest === next.checkpoint.digest) return prior;
        if (enrollment || anchor) throw new Error("An existing account workspace inventory cannot be replaced by enrollment or recovery");
        transition(prior, next.signed.inventory);
      } else if (!anchor && (!enrollment || !local || next.checkpoint.revision !== 1)) throw new PrivateAccountInventoryMissingError();
      return persist(next, check);
    });
  };
  return {
    read: () => options.exclusive(async () => { const check = options.capture(); check(); const value = await load(check); check(); if (!value) throw new PrivateAccountInventoryMissingError(); return value; }),
    enroll: (signed: SignedPrivateAccountInventory) => accept(signed, true),
    accept: (signed: SignedPrivateAccountInventory) => accept(signed, false),
    restore: (signed: SignedPrivateAccountInventory, expected: PrivateAccountInventoryCheckpoint) => accept(signed, false, expected),
  };
}
/** Unknown membership/mode is an explicit trust/enrollment decision, never a
 * standard-mode fallback. Former encrypted IDs stay pinned in the inventory. */
export function accountWorkspacePolicy(value: VerifiedPrivateAccountInventory, scope: Scope, workspaceId: string): PrivateAccountWorkspace {
  assertCurrent(value, scope);
  const row = value.signed.inventory.workspaces.find((item) => item.workspaceId === workspaceId);
  if (!row) throw new Error("Workspace mode is absent from the trusted account inventory");
  return row;
}
