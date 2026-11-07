/**
 * Creating an encrypted workspace from its first record (early access;
 * docs/private-workspace-protocol.md → "Creating an encrypted workspace").
 *
 * A conversion moves an existing workspace's records into ciphertext. A new
 * workspace has none, so the owner's device signs everything the converted
 * state would hold, for an empty history: the owner-only directory and the
 * initial projection (just the encrypted workspace name). The server checks
 * both, creates the team workspace in the same transaction, and stores the
 * workspace as encrypted at revision 1 with its head at the projection root,
 * which is what `readerScope` and chained edits expect of a converted one.
 *
 * Only accounts on ENCRYPTED_WORKSPACE_USERS may create one, or write to one.
 */
import { TRPCError } from "@trpc/server";
import { canonicalJson, privateInitialSnapshotProjection, privateRecordDigest, sortInitialProjectionRecords } from "@starter/core";
import { encryptedRecordSchema, signedPrivateInitialProjectionRootSchema, type EncryptedRecord, type SignedPrivateDirectory, type SignedPrivateInitialProjectionRoot } from "@starter/shared";
import { env } from "../../config/env.js";
import { PrivateAccount, PrivateDirectory, PrivateProjectionReader, PrivateProjectionRoot, PrivateSnapshotChunk, PrivateWorkspace } from "../../models/PrivateData.js";
import { withBusinessTransaction } from "../business-transaction.js";
import { createTeamWorkspace } from "../membership/workspaces.js";
import { workspaceCreationDeps } from "../membership/production.js";
import { commitPrivateDirectory } from "./directories.js";
import { isPersonalPrivateKind } from "./projection-proposal.js";
import { verifyPrivateChange } from "./signatures.js";

/** What a new encrypted workspace may start with: its encrypted name, its
 * settings and the owner's membership (each with its money half). */
const INITIAL_KINDS = new Set(["workspaceIdentity", "settings", "settingsMoney", "members", "memberMoney"]);
/** The organization row the server keeps: no name a reader could learn from. */
export const ENCRYPTED_WORKSPACE_PUBLIC_NAME = "Encrypted workspace";

export function encryptedWorkspacesAllowed(user: { id: string; email?: string | null }, allowlist: readonly string[] = env.ENCRYPTED_WORKSPACE_USERS): boolean {
  const email = (user.email ?? "").trim().toLowerCase();
  return allowlist.some((entry) =>
    entry === `id:${user.id.toLowerCase()}` || (!!email && (entry === email || (entry.startsWith("@") && email.endsWith(entry)))));
}

export function requireEncryptedWorkspaceUser(user: { id: string; email?: string | null }): void {
  if (!encryptedWorkspacesAllowed(user)) throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "Encrypted workspaces are not available for this account yet. Existing data is unchanged." });
}

export type EncryptedWorkspaceCreation = {
  workspaceId: string;
  currency: string;
  weekStartsOn: 0 | 1;
  directory: SignedPrivateDirectory;
  root: SignedPrivateInitialProjectionRoot;
  records: EncryptedRecord[];
};

type CreateWorkspace = (user: { id: string; name?: string | null; email?: string | null }, input: { name: string; currency: string; weekStartsOn: 0 | 1; clientWorkspaceId: string }) => Promise<unknown>;
const createWorkspaceRow: CreateWorkspace = async (user, input) => createTeamWorkspace(await workspaceCreationDeps(), user, input);

export async function createEncryptedWorkspace(user: { id: string; name?: string | null; email?: string | null }, input: EncryptedWorkspaceCreation, server: string, createWorkspace: CreateWorkspace = createWorkspaceRow): Promise<{ workspaceId: string; root: string }> {
  requireEncryptedWorkspaceUser(user);
  const records = input.records.map((row) => encryptedRecordSchema.parse(row));
  const signed = signedPrivateInitialProjectionRootSchema.parse(input.root), manifest = signed.manifest;
  if (records.length > 10 || records.some((row) => !INITIAL_KINDS.has(row.kind))) throw new TRPCError({ code: "BAD_REQUEST", message: "A new encrypted workspace starts with its name, settings and owner only." });
  return withBusinessTransaction(async () => {
    const account = await PrivateAccount.findOne({ userId: user.id }).lean();
    if (!account) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Set up private data keys first." });
    // The ordinary team workspace, with a public name that says nothing.
    await createWorkspace(user, { name: ENCRYPTED_WORKSPACE_PUBLIC_NAME, currency: input.currency, weekStartsOn: input.weekStartsOn, clientWorkspaceId: input.workspaceId });
    // The owner-only directory, through the same checks as any directory:
    // the caller's enrolled keys, owner role, a first revision.
    const directory = await commitPrivateDirectory({ server, workspaceId: input.workspaceId, userId: user.id }, input.directory);
    const owner = input.directory.directory.members.find((member) => member.userId === user.id);
    if (directory.revision !== 1 || input.directory.directory.members.length !== 1 || !owner) throw new TRPCError({ code: "BAD_REQUEST", message: "A new encrypted workspace starts with its owner alone." });
    // The initial projection: signed by the owner over exactly these records.
    if (manifest.server !== server || manifest.workspaceId !== input.workspaceId || manifest.directoryDigest !== directory.digest || manifest.signerId !== user.id || manifest.revision !== 1
      || manifest.readers.length !== 1 || manifest.readers[0]!.userId !== user.id) throw new TRPCError({ code: "BAD_REQUEST", message: "The initial projection does not match this workspace." });
    await verifyPrivateChange(owner.signingPublicKey, manifest, signed.signature);
    const readable = sortInitialProjectionRecords(records).filter((row) => row.grants.length === 1 && row.grants[0]!.userId === user.id);
    if (readable.length !== records.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Every initial record must be readable by the owner only." });
    const shared = readable.filter((row) => !isPersonalPrivateKind(row.kind));
    const personal = readable.filter((row) => isPersonalPrivateKind(row.kind) && row.authorId === user.id);
    const reader = manifest.readers[0]!;
    if (reader.sharedDigest !== await privateRecordDigest(privateInitialSnapshotProjection(shared, user.id)) || reader.personalDigest !== await privateRecordDigest(personal))
      throw new TRPCError({ code: "BAD_REQUEST", message: "The initial projection does not match its records." });
    const root = await privateRecordDigest(manifest), migrationId = manifest.migrationId;
    await PrivateSnapshotChunk.create({ workspaceId: input.workspaceId, migrationId, index: 0, records: readable });
    const location = (rows: readonly EncryptedRecord[]) => (rows.length ? [{ chunk: 0, before: 0, count: rows.length }] : []);
    await PrivateProjectionReader.create({ workspaceId: input.workspaceId, migrationId, userId: user.id, sharedLocations: location(shared), personalLocations: location(personal) });
    await PrivateProjectionRoot.create({ workspaceId: input.workspaceId, migrationId, root, fullRecordsDigest: (await privateRecordDigest(readable)), signed });
    await PrivateWorkspace.create({ workspaceId: input.workspaceId, ownerId: user.id, state: "encrypted", revision: 1, head: root, directoryDigest: directory.digest, migrationId, sourceRevision: "new", leaseUntil: new Date(), backupVerified: true });
    if (canonicalJson((await PrivateDirectory.findOne({ workspaceId: input.workspaceId, revision: 1 }).lean())?.digest) !== canonicalJson(directory.digest)) throw new TRPCError({ code: "CONFLICT" });
    return { workspaceId: input.workspaceId, root };
  });
}
