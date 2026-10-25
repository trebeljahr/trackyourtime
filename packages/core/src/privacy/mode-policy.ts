import { z } from "zod";
import { publicEncryptionKeySchema } from "@starter/shared";
import { canonicalJson, decodeSecret, fingerprint, signPrivateChange, type PublicKey } from "./crypto.js";
import { privateReplicaIdentityFromDirectory, type VerifiedPrivateDirectory } from "./directory.js";
import { assertPrivateProjectionSnapshot, type VerifiedPrivateProjectionSnapshot } from "./projection-snapshot.js";
import { createPrivateStorage, type PrivateStorageKey, type PrivateStorageScope } from "./storage.js";
import type { KeyValueStorage } from "../storage.js";
import type { QueueExclusive } from "../durable-entry.js";
const digest = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const policySchema = z.object({
  v: z.literal(1), protocol: z.literal("trackyourtime-private-workspace-policy-v1"), mode: z.literal("encrypted"),
  server: z.string().min(1).max(2048), userId: z.string().min(1).max(100), workspaceId: z.string().min(1).max(100),
  accountFingerprint: digest, activationRoot: digest, directoryDigest: digest,
  ownerId: z.string().min(1).max(100), ownerSigningPublicKey: publicEncryptionKeySchema,
  directoryRevision: z.number().int().positive(), createdAt: z.iso.datetime(),
}).strict();
const signedSchema = z.object({ policy: policySchema, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
export type SignedPrivateWorkspacePolicy = z.infer<typeof signedSchema>;
export type PrivateWorkspacePolicyCheckpoint = { activationRoot: string; directoryDigest: string };
const verified = Symbol("verified-private-workspace-policy");
export type VerifiedPrivateWorkspacePolicy = Readonly<{ [verified]: true; signed: SignedPrivateWorkspacePolicy; current: () => boolean }>;
const verifiedPolicies = new WeakSet<object>();
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
export class PrivateWorkspacePolicyMissingError extends Error {
  constructor() { super("Trusted workspace policy is missing. Restore it from a trusted device or recovery copy before choosing a data adapter."); this.name = "PrivateWorkspacePolicyMissingError"; }
}
/** A device signs its own no-downgrade pin only after complete projection
 * verification. This does not claim source/backup approval or activate mode. */
export async function signPrivateWorkspacePolicy(options: {
  snapshot: VerifiedPrivateProjectionSnapshot; directory: VerifiedPrivateDirectory;
  secrets: { privateKey: PublicKey; signingPrivateKey: PublicKey }; current: () => boolean;
}): Promise<SignedPrivateWorkspacePolicy> {
  const { snapshot, directory, secrets, current } = options, scope = { ...snapshot.scope };
  const check = () => { if (!current()) throw new Error("Private workspace policy changed during signing"); assertPrivateProjectionSnapshot(snapshot, scope, directory.digest); };
  check(); privateReplicaIdentityFromDirectory(directory, scope.userId, secrets, current);
  const owner = directory.signed.directory.members.find((member) => member.userId === directory.signed.directory.ownerId)!;
  const policy = policySchema.parse({ v: 1, protocol: "trackyourtime-private-workspace-policy-v1", mode: "encrypted", ...scope,
    accountFingerprint: await fingerprint(secrets.signingPrivateKey), activationRoot: snapshot.root, directoryDigest: directory.digest,
    ownerId: owner.userId, ownerSigningPublicKey: owner.signingPublicKey, directoryRevision: directory.signed.directory.revision, createdAt: new Date().toISOString(),
  }); check();
  const signature = await signPrivateChange(secrets.signingPrivateKey, policy); check();
  return signedSchema.parse({ policy, signature });
}
async function verifyPolicy(input: unknown, scope: PrivateStorageScope, signingPublicKey: PublicKey, expected: PrivateWorkspacePolicyCheckpoint, current: () => boolean): Promise<VerifiedPrivateWorkspacePolicy> {
  const signed = signedSchema.parse(input), { policy } = signed;
  if (!current()) throw new Error("Private workspace policy changed during verification");
  if (policy.server !== scope.server || policy.userId !== scope.userId || policy.workspaceId !== scope.workspaceId || new URL(policy.server).origin !== policy.server || !["https:", "http:"].includes(new URL(policy.server).protocol)) throw new Error("Private workspace policy belongs to another scope");
  if (policy.activationRoot !== expected.activationRoot || policy.directoryDigest !== expected.directoryDigest) throw new Error("Private workspace policy differs from the trusted activation checkpoint");
  if (signingPublicKey.d || policy.accountFingerprint !== await fingerprint(signingPublicKey)) throw new Error("Private workspace policy account key changed");
  const key = await crypto.subtle.importKey("jwk", signingPublicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decodeSecret(signed.signature, 64), new TextEncoder().encode(canonicalJson(policy)))) throw new Error("Private workspace policy signature does not match the unlocked account");
  await crypto.subtle.importKey("jwk", policy.ownerSigningPublicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!current()) throw new Error("Private workspace policy changed during verification");
  const result = freeze({ [verified]: true as const, signed, current }); verifiedPolicies.add(result); return result;
}
/** expected must come from verified activation, a trusted device or recovery,
 * not the same API response being checked. Missing/locked/corrupt storage never
 * means standard mode. There is no remove/downgrade API. A full filesystem
 * rollback and a new device without a trusted profile require separate policy. */
export async function createPrivateWorkspacePolicyStore(options: {
  storage: KeyValueStorage; scope: PrivateStorageScope; signingPublicKey: PublicKey; expected: PrivateWorkspacePolicyCheckpoint;
  exclusive: QueueExclusive; resolveStorageKey: () => PrivateStorageKey | null; capture: () => () => void;
}) {
  const scope = { ...options.scope }, signingPublicKey = publicEncryptionKeySchema.parse(options.signingPublicKey);
  const expected = z.object({ activationRoot: digest, directoryDigest: digest }).strict().parse(options.expected);
  const storage = await createPrivateStorage({ storage: options.storage, scope, resolveKey: options.resolveStorageKey });
  const checked = (raw: string, check: () => void) => verifyPolicy(JSON.parse(raw), scope, signingPublicKey, expected, () => { try { check(); return true; } catch { return false; } });
  return {
    read: () => options.exclusive(async () => {
      const check = options.capture(); check(); const raw = await storage.getItem("mode-policy"); check();
      if (raw === null) throw new PrivateWorkspacePolicyMissingError();
      const value = await checked(raw, check); check(); return value;
    }),
    accept: (input: unknown) => {
      const signed = signedSchema.parse(input);
      return options.exclusive(async () => {
        const check = options.capture(); check();
        const next = await verifyPolicy(signed, scope, signingPublicKey, expected, () => { try { check(); return true; } catch { return false; } }); check();
        const prior = await storage.getItem("mode-policy"); check();
        if (prior !== null) { const value = await checked(prior, check); check(); return value; }
        await storage.setItem("mode-policy", JSON.stringify(next.signed)); check();
        const saved = await storage.getItem("mode-policy"); check();
        if (saved === null) throw new PrivateWorkspacePolicyMissingError();
        const value = await checked(saved, check); check(); return value;
      });
    },
  };
}
/** A known-private workspace cannot select a plaintext adapter because the API
 * omitted/reverted its mode. Call before any content/legacy-queue work. */
export function requirePrivateWorkspacePolicy(policy: VerifiedPrivateWorkspacePolicy, scope: PrivateStorageScope, reportedMode: unknown): PrivateWorkspacePolicyCheckpoint {
  if (!verifiedPolicies.has(policy) || !policy.current()) throw new Error("Use the current verified workspace policy");
  const pin = policy.signed.policy;
  if (pin.server !== scope.server || pin.userId !== scope.userId || pin.workspaceId !== scope.workspaceId) throw new Error("Private workspace policy belongs to another scope");
  if (reportedMode !== "encrypted") throw new Error("The server omitted or downgraded this workspace's private mode. Plaintext access is refused.");
  return { activationRoot: pin.activationRoot, directoryDigest: pin.directoryDigest };
}
