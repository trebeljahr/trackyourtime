import { signedPrivateDirectorySchema, privateWorkspaceDirectorySchema, publicEncryptionKeySchema, type PrivateDirectoryMember, type PrivateWorkspaceDirectory, type SignedPrivateDirectory } from "@starter/shared";
import { canonicalJson, decodeSecret, fingerprint, signPrivateChange, type PublicKey } from "./crypto.js";
import { privateRecordDigest } from "./workspace-edits.js";
import { createPrivateStorage, type PrivateStorageKey, type PrivateStorageScope } from "./storage.js";
import type { KeyValueStorage } from "../storage.js";
import type { QueueExclusive } from "../durable-entry.js";
import { z } from "zod";
export type PrivateDirectoryTrust = { ownerId: string; signingPublicKey: PublicKey; revision: number; digest: string | null };
const verified = Symbol("verified-private-directory");
const verifiedCheckpoints = new WeakSet<object>();
export type PrivateDirectoryCheckpoint = { ownerId: string; signingPublicKey: PublicKey; revision: number; digest: string };
export type VerifiedPrivateDirectoryCheckpoint = Readonly<{ directory: VerifiedPrivateDirectory; expected: PrivateDirectoryCheckpoint; path: readonly Readonly<{ revision: number; digest: string }>[]; current: () => boolean }>;
export type PrivateDirectoryTransport = { page: (input: { after: number; through: number }) => Promise<unknown> };
export type VerifiedPrivateDirectory = { readonly [verified]: true; readonly signed: SignedPrivateDirectory; readonly digest: string; readonly trust: PrivateDirectoryTrust };
export function assertVerifiedPrivateDirectory(directory: VerifiedPrivateDirectory): void {
  if (directory?.[verified] !== true) throw new Error("Verify the private workspace directory first");
}
const coordinates = ({ kty, crv, x, y }: PublicKey) => ({ kty, crv, x, y });
export async function privateMemberKeyFingerprint(server: string, member: Pick<PrivateDirectoryMember, "userId" | "publicKey" | "signingPublicKey">): Promise<string> {
  return privateRecordDigest({ protocol: "trackyourtime-member-keys-v1", server, userId: member.userId, encryption: coordinates(member.publicKey), signing: coordinates(member.signingPublicKey) });
}
function checkDirectory(directory: PrivateWorkspaceDirectory, scope: Pick<PrivateStorageScope, "server" | "workspaceId">): void {
  if (directory.server !== scope.server || new URL(directory.server).origin !== directory.server || !["https:", "http:"].includes(new URL(directory.server).protocol) || directory.workspaceId !== scope.workspaceId) throw new Error("Private directory belongs to another server or workspace");
  const ids = directory.members.map((member) => member.userId);
  if (new Set(ids).size !== ids.length || canonicalJson(ids) !== canonicalJson([...ids].sort())) throw new Error("Private directory members must be unique and sorted");
  const owners = directory.members.filter((member) => member.role === "owner");
  if (owners.length !== 1 || owners[0]!.userId !== directory.ownerId) throw new Error("Private directory must have exactly one owner");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
async function signatureMatches(key: PublicKey, value: unknown, signature: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await crypto.subtle.importKey("jwk", key, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]), decodeSecret(signature, 64), new TextEncoder().encode(canonicalJson(value)));
  } catch { return false; }
}
export async function verifyPrivateWorkspaceDirectory(input: unknown, scope: Pick<PrivateStorageScope, "server" | "workspaceId">, previous: PrivateDirectoryTrust): Promise<VerifiedPrivateDirectory> {
  const signed = signedPrivateDirectorySchema.parse(input), directory = signed.directory;
  checkDirectory(directory, scope);
  if (signed.signerId !== previous.ownerId || directory.revision !== previous.revision + 1 || directory.previousDigest !== previous.digest) throw new Error("Private directory changed owner, skipped a revision or rolled back");
  if (!await signatureMatches(previous.signingPublicKey, { protocol: "trackyourtime-workspace-directory-v1", directory, signerId: signed.signerId }, signed.signature)) throw new Error("Private directory signature did not match the trusted owner");
  for (const member of directory.members) {
    await crypto.subtle.importKey("jwk", member.publicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
    await crypto.subtle.importKey("jwk", member.signingPublicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  }
  const digest = await privateRecordDigest(directory), owner = directory.members.find((member) => member.userId === directory.ownerId)!;
  return freeze({ [verified]: true as const, signed, digest, trust: { ownerId: owner.userId, signingPublicKey: owner.signingPublicKey, revision: directory.revision, digest } });
}
/** New or changed member keys require fingerprints obtained independently of
 * the API directory response. An unchanged verified member needs no repeat
 * confirmation. Initial owner trust comes from their unlocked account key. */
export async function signPrivateWorkspaceDirectory(input: PrivateWorkspaceDirectory, privateKey: PublicKey, previous: VerifiedPrivateDirectory | null, independentlyVerified: ReadonlyMap<string, string>): Promise<SignedPrivateDirectory> {
  const directory = privateWorkspaceDirectorySchema.parse(input);
  directory.members.sort((a, b) => a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);
  checkDirectory(directory, directory);
  if (previous && previous[verified] !== true) throw new Error("Verify the previous private directory first");
  if (previous && (previous.signed.directory.server !== directory.server || previous.signed.directory.workspaceId !== directory.workspaceId)) throw new Error("Private directory belongs to another server or workspace");
  const owner = directory.members.find((member) => member.userId === directory.ownerId)!;
  const trust: PrivateDirectoryTrust = previous?.trust ?? { ownerId: directory.ownerId, signingPublicKey: owner.signingPublicKey, revision: 0, digest: null };
  for (const member of directory.members) {
    const current = await privateMemberKeyFingerprint(directory.server, member);
    const prior = previous?.signed.directory.members.find((item) => item.userId === member.userId);
    if ((!prior || await privateMemberKeyFingerprint(directory.server, prior) !== current) && independentlyVerified.get(member.userId) !== current) throw new Error("Verify new or changed member keys before sharing private data");
  }
  const signerId = trust.ownerId;
  const signed = { directory, signerId, signature: await signPrivateChange(privateKey, { protocol: "trackyourtime-workspace-directory-v1", directory, signerId }) };
  await verifyPrivateWorkspaceDirectory(signed, directory, trust);
  return signed;
}
/** Scope-bound encrypted checkpoints make later API substitutions and directory
 * rollback detectable. The initial owner key must come from a trusted invite
 * or the owner's unlocked identity, never the same API response being checked. */
export async function createPrivateDirectoryStore(options: {
  storage: KeyValueStorage; scope: PrivateStorageScope; initialOwner: Pick<PrivateDirectoryTrust, "ownerId" | "signingPublicKey">;
  resolveStorageKey: () => PrivateStorageKey | null; capture: () => () => void; exclusive: QueueExclusive;
}) {
  const scope = { ...options.scope };
  const { server, workspaceId } = scope, initialOwner = structuredClone(options.initialOwner);
  const anchor = await privateRecordDigest({ server, workspaceId, ownerId: initialOwner.ownerId, key: await fingerprint(initialOwner.signingPublicKey) });
  const storage = await createPrivateStorage({ storage: options.storage, scope, resolveKey: options.resolveStorageKey });
  const load = async (): Promise<VerifiedPrivateDirectory | null> => {
    const raw = await storage.getItem("directory"); if (raw === null) return null;
    const value = JSON.parse(raw) as { v: number; anchor: string; signed: unknown; digest: string };
    if (value?.v !== 1 || value.anchor !== anchor || Object.keys(value).length !== 4) throw new Error("Private directory trust anchor changed");
    const signed = signedPrivateDirectorySchema.parse(value.signed); checkDirectory(signed.directory, { server, workspaceId });
    if (await privateRecordDigest(signed.directory) !== value.digest) throw new Error("Private directory checkpoint failed verification");
    const owner = signed.directory.members.find((member) => member.userId === signed.directory.ownerId)!;
    // This checkpoint was verified before being authenticated by local storage.
    return freeze({ [verified]: true as const, signed, digest: value.digest, trust: { ownerId: owner.userId, signingPublicKey: owner.signingPublicKey, revision: signed.directory.revision, digest: value.digest } });
  };
  return {
    /** The whole history was anchored to a checkpoint from trusted device or
     * account policy, never merely to its server-supplied first owner key. */
    restoreCheckpoint: async (value: VerifiedPrivateDirectoryCheckpoint) => {
      const captured = options.capture(); captured();
      return options.exclusive(async () => {
        const check = () => { captured(); if (!verifiedCheckpoints.has(value) || !value.current()) throw new Error("Use the current verified directory checkpoint"); };
        check(); checkDirectory(value.directory.signed.directory, scope);
        if (value.expected.ownerId !== initialOwner.ownerId || canonicalJson(coordinates(value.expected.signingPublicKey)) !== canonicalJson(coordinates(initialOwner.signingPublicKey))) throw new Error("Directory checkpoint owner differs from the trusted policy");
        const prior = await load(); check();
        if (prior?.digest === value.directory.digest) return prior;
        if (prior && (prior.trust.revision >= value.directory.trust.revision || !value.path.some((row) => row.revision === prior.trust.revision && row.digest === prior.digest))) throw new Error("Directory recovery cannot replace or roll back an existing trusted branch");
        await storage.setItem("directory", JSON.stringify({ v: 1, anchor, signed: value.directory.signed, digest: value.directory.digest })); check();
        const saved = await load(); check();
        if (!saved || saved.digest !== value.directory.digest) throw new Error("Could not confirm the restored directory checkpoint");
        return saved;
      });
    },
    read: () => options.exclusive(async () => { const check = options.capture(); check(); const value = await load(); check(); return value; }),
    accept: (input: unknown) => {
      const snapshot = signedPrivateDirectorySchema.parse(input);
      return options.exclusive(async () => {
        const check = options.capture(); check(); const current = await load(); check();
        if (current && snapshot.directory.revision === current.trust.revision && await privateRecordDigest(snapshot.directory) === current.digest) { check(); return current; }
        const next = await verifyPrivateWorkspaceDirectory(snapshot, { server, workspaceId }, current?.trust ?? { ...initialOwner, revision: 0, digest: null }); check();
        await storage.setItem("directory", JSON.stringify({ v: 1, anchor, signed: next.signed, digest: next.digest })); check(); return next;
      });
    },
  };
}

/** Backward binding through previousDigest lets an independently trusted final
 * checkpoint authenticate an older owner/transfer history. No directory is
 * persisted or returned to routing before the entire chain matches that pin. */
export async function loadPrivateDirectoryCheckpoint(options: {
  scope: { server: string; workspaceId: string }; expected: PrivateDirectoryCheckpoint;
  transport: PrivateDirectoryTransport; current: () => boolean;
}): Promise<VerifiedPrivateDirectoryCheckpoint> {
  const scope = { server: options.scope.server, workspaceId: options.scope.workspaceId }, current = options.current, transport = options.transport;
  const expected = z.object({ ownerId: z.string().min(1).max(100), signingPublicKey: publicEncryptionKeySchema, revision: z.number().int().positive().max(4096), digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().parse(options.expected);
  const pageSchema = z.object({ through: z.number().int().positive().max(4096), next: z.number().int().nonnegative().nullable(), directories: z.array(z.object({ digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/), signed: signedPrivateDirectorySchema }).strict()).max(10) }).strict();
  const check = () => { if (!current()) throw new Error("Private directory changed during checkpoint delivery"); };
  let after = 0, totalBytes = 0, directory: VerifiedPrivateDirectory | null = null;
  const path: { revision: number; digest: string }[] = [];
  do {
    check(); const raw = await transport.page({ after, through: expected.revision }); check();
    const bytes = new TextEncoder().encode(JSON.stringify(raw)).length; totalBytes += bytes;
    if (bytes > 3 * 1024 * 1024 || totalBytes > 16 * 1024 * 1024) throw new Error("Private directory history exceeds its supported checkpoint size");
    const page = pageSchema.parse(raw);
    if (page.through !== expected.revision || !page.directories.length) throw new Error("Private directory checkpoint feed omitted revisions or changed its boundary");
    for (const row of page.directories) {
      if (row.signed.directory.revision !== after + 1 || row.signed.directory.revision > expected.revision) throw new Error("Private directory checkpoint feed skipped a revision");
      const firstOwner = row.signed.directory.members.find((member) => member.userId === row.signed.directory.ownerId);
      if (!firstOwner) throw new Error("Private directory checkpoint has no initial owner");
      const prior = directory ? directory.trust : { ownerId: firstOwner.userId, signingPublicKey: firstOwner.signingPublicKey, revision: 0, digest: null };
      const checked = await verifyPrivateWorkspaceDirectory(row.signed, scope, prior); check();
      if (checked.digest !== row.digest) throw new Error("Private directory checkpoint digest changed");
      directory = checked; after = checked.trust.revision; path.push({ revision: after, digest: checked.digest });
    }
    if (page.next !== (after < expected.revision ? after : null)) throw new Error("Private directory checkpoint feed omitted revisions");
  } while (after < expected.revision);
  if (!directory || directory.digest !== expected.digest || directory.trust.ownerId !== expected.ownerId || canonicalJson(coordinates(directory.trust.signingPublicKey)) !== canonicalJson(coordinates(expected.signingPublicKey))) throw new Error("Private directory differs from the independently trusted checkpoint");
  check(); const result = freeze({ directory, expected, path, current }); verifiedCheckpoints.add(result); return result;
}

/** Only a verified directory may supply a replica's recipients/signers. The
 * account's unlocked private keys must still match its own directory entry. */
export function privateReplicaIdentityFromDirectory(directory: VerifiedPrivateDirectory, userId: string, secrets: { privateKey: PublicKey; signingPrivateKey: PublicKey }, current: () => boolean): import("./replica.js").PrivateReplicaIdentity {
  if (directory?.[verified] !== true) throw new Error("Verify the private workspace directory first");
  const own = directory.signed.directory.members.find((member) => member.userId === userId);
  if (!own || canonicalJson(coordinates(own.publicKey)) !== canonicalJson(coordinates(secrets.privateKey)) || canonicalJson(coordinates(own.signingPublicKey)) !== canonicalJson(coordinates(secrets.signingPrivateKey)) || !secrets.privateKey.d || !secrets.signingPrivateKey.d) throw new Error("Unlocked account keys do not match this workspace's verified directory");
  return {
    ...secrets, current, directory, directoryDigest: directory.digest,
    recipients: directory.signed.directory.members.map((member) => ({ userId: member.userId, role: member.role, canViewOthersTime: member.canViewOthersTime, canViewOthersMoney: member.canViewOthersMoney, publicKey: member.publicKey })),
    signingKey: (id) => directory.signed.directory.members.find((member) => member.userId === id)?.signingPublicKey ?? null,
  };
}
