import { privateInventoryVersionHeaderSchema, signedPrivateInventoryVersionSchema } from "@starter/shared";
import { assertPrivateAccountInventory, checkSignedPrivateAccountInventory, type VerifiedPrivateAccountInventory } from "./account-inventory.js";
import { canonicalJson, decodeSecret, deriveSecret, fingerprint, seal, signPrivateChange, unseal, type PublicKey } from "./crypto.js";
import { privateRecordDigest } from "./workspace-edits.js";
export type PrivateInventoryTransportCheckpoint = { revision: number; root: string | null };
type Scope = { server: string; userId: string };
function checkpoint(value: PrivateInventoryTransportCheckpoint) {
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || value.revision >= Number.MAX_SAFE_INTEGER || (value.revision === 0 ? value.root !== null : typeof value.root !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.root))) throw new Error("Invalid account inventory transport checkpoint");
  return { ...value };
}
const context = (scope: Scope) => canonicalJson({ protocol: "trackyourtime-account-inventory-encryption-v1", ...scope });
export function privateInventoryVersionRoot(input: unknown): Promise<string> {
  const signed = signedPrivateInventoryVersionSchema.parse(input);
  return privateRecordDigest({ protocol: "trackyourtime-account-inventory-root-v1", header: signed.header, box: signed.box });
}
/** Blind server-side authentication needs only the account's public key and
 * current opaque checkpoint. This never decrypts or authenticates enrollment. */
export async function authenticatePrivateInventoryVersion(options: {
  signed: unknown; scope: Scope; previous: PrivateInventoryTransportCheckpoint; signingPublicKey: PublicKey; current: () => boolean;
}) {
  const scope = { ...options.scope }, prior = checkpoint(options.previous), signed = signedPrivateInventoryVersionSchema.parse(options.signed), signingKey = structuredClone(options.signingPublicKey), current = options.current;
  const check = () => { if (!current()) throw new Error("Private account changed during inventory delivery"); };
  check(); const { header, box, signature } = signed;
  if (header.server !== scope.server || header.userId !== scope.userId || header.revision !== prior.revision + 1 || header.previousRoot !== prior.root || signingKey.d || header.keyFingerprint !== await fingerprint(signingKey)) throw new Error("Account inventory transport scope, key or checkpoint changed");
  const publicKey = await crypto.subtle.importKey("jwk", signingKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, decodeSecret(signature, 64), new TextEncoder().encode(canonicalJson({ header, box })))) throw new Error("Account inventory ciphertext signature did not match"); check();
  const root = await privateInventoryVersionRoot(signed); check(); return { signed, checkpoint: { revision: header.revision, root } };
}
/** Freeze/persist this exact result before submitting it. AES-GCM binds scope,
 * revision, operation ID, key and prior ciphertext root; the public signature
 * lets a blind server enforce sequencing without reading the inventory. */
export async function encryptPrivateInventoryVersion(options: {
  inventory: VerifiedPrivateAccountInventory; previous: PrivateInventoryTransportCheckpoint; operationId: string;
  master: Uint8Array; signingPrivateKey: PublicKey; current: () => boolean;
}) {
  const inventory = options.inventory, prior = checkpoint(options.previous), operationId = options.operationId, current = options.current, scope = { server: inventory.signed.inventory.server, userId: inventory.signed.inventory.userId };
  const check = () => { if (!current()) throw new Error("Private account changed during inventory encryption"); assertPrivateAccountInventory(inventory, scope); };
  check(); const master = new Uint8Array(options.master), signingKey = structuredClone(options.signingPrivateKey); let key: Uint8Array | undefined;
  try {
    if (master.length !== 32 || !signingKey.d || inventory.checkpoint.revision !== prior.revision + 1 || inventory.signed.inventory.accountFingerprint !== await fingerprint(signingKey)) throw new Error("Inventory encryption requires current account keys and a consecutive checkpoint");
    const header = privateInventoryVersionHeaderSchema.parse({ v: 1, protocol: "trackyourtime-account-inventory-version-v1", ...scope, operationId, revision: prior.revision + 1, previousRoot: prior.root, keyFingerprint: inventory.signed.inventory.accountFingerprint }); check();
    key = await deriveSecret(master, context(scope)); check();
    const box = await seal(key, inventory.signed, canonicalJson(header)); check();
    const signature = await signPrivateChange(signingKey, { header, box }); check();
    const signed = signedPrivateInventoryVersionSchema.parse({ header, box, signature }), root = await privateInventoryVersionRoot(signed); check();
    return { signed, checkpoint: { revision: header.revision, root } };
  } finally { master.fill(0); key?.fill(0); }
}
/** Verify one consecutive ciphertext before decrypting. The returned inventory
 * stays unbranded: server-supplied history cannot silently enroll a new device
 * or overwrite a newer trusted inventory. This function performs no writes. */
export async function openPrivateInventoryVersion(options: {
  signed: unknown; scope: Scope; previous: PrivateInventoryTransportCheckpoint;
  master: Uint8Array; signingPublicKey: PublicKey; current: () => boolean;
}) {
  const scope = { ...options.scope }, prior = checkpoint(options.previous), signed = signedPrivateInventoryVersionSchema.parse(options.signed), signingKey = structuredClone(options.signingPublicKey), master = new Uint8Array(options.master), current = options.current;
  const check = () => { if (!current()) throw new Error("Private account changed during inventory delivery"); };
  let key: Uint8Array | undefined;
  try {
    check(); const authenticated = await authenticatePrivateInventoryVersion({ signed, scope, previous: prior, signingPublicKey: signingKey, current }); check();
    const { header, box } = authenticated.signed;
    key = await deriveSecret(master, context(scope)); check();
    const inventory = await checkSignedPrivateAccountInventory(await unseal<unknown>(key, box, canonicalJson(header)), scope, signingKey, current); check();
    if (inventory.inventory.revision !== header.revision) throw new Error("Encrypted inventory revision differs from its transport header");
    return { inventory, signed, checkpoint: authenticated.checkpoint };
  } finally { master.fill(0); key?.fill(0); }
}
