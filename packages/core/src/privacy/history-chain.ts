import { canWritePrivateRecord, privateChainedWorkspaceChangeSchema, privateWorkspaceChainHeaderSchema, privateWorkspaceChainSchema, signedPrivateChainedEditSchema, type PrivateWorkspaceEdit, type PrivateWorkspaceChain, type SignedPrivateChainedEdit } from "@starter/shared";
import { canonicalJson, decodeSecret, signPrivateChange, type PublicKey } from "./crypto.js";
import { assertVerifiedPrivateDirectory, privateReplicaIdentityFromDirectory, type VerifiedPrivateDirectory } from "./directory.js";
import { readersForPrivateRecord } from "./records.js";
import { privateRecordDigest, privateWorkspaceManifest, privateWorkspaceManifestForReader, signPrivateWorkspaceEdit, verifyPrivateWorkspaceChange } from "./workspace-edits.js";

/** Opaque full-manifest and per-reader digests bind every projection to one
 * global history without revealing other readers' private record metadata. */
export async function privateWorkspaceChainHeader(options: {
  edit: PrivateWorkspaceEdit; directory: VerifiedPrivateDirectory; previousRoot: string;
}) {
  const { directory } = options;
  assertVerifiedPrivateDirectory(directory);
  const manifest = await privateWorkspaceManifest(options.edit);
  if (manifest.workspaceId !== directory.signed.directory.workspaceId) throw new Error("Private edit belongs to another workspace");
  const actor = directory.signed.directory.members.find((member) => member.userId === manifest.userId);
  if (!actor) throw new Error("Private writer is not in the verified directory");
  for (const row of [...manifest.records, ...manifest.remove]) {
    if (!canWritePrivateRecord(row.kind, row.authorId, actor)) throw new Error("Verified workspace permissions forbid this private edit");
    const expected = readersForPrivateRecord(row.kind, row.authorId, directory.signed.directory.members).map((member) => member.userId).sort();
    if (canonicalJson(expected) !== canonicalJson(row.readers)) throw new Error("Private edit recipients differ from the verified directory");
  }
  const readers = [];
  for (const member of directory.signed.directory.members) readers.push({ userId: member.userId, digest: await privateRecordDigest(privateWorkspaceManifestForReader(manifest, member.userId)) });
  return privateWorkspaceChainHeaderSchema.parse({
    v: 1, protocol: "trackyourtime-private-workspace-chain-v1", server: directory.signed.directory.server,
    workspaceId: manifest.workspaceId, userId: manifest.userId, operationId: manifest.operationId,
    expectedRevision: manifest.expectedRevision, directoryDigest: directory.digest, previousRoot: options.previousRoot,
    manifestDigest: await privateRecordDigest(manifest), readers,
  });
}
export async function signPrivateChainedWorkspaceEdit(options: {
  edit: PrivateWorkspaceEdit; directory: VerifiedPrivateDirectory; previousRoot: string;
  secrets: { privateKey: PublicKey; signingPrivateKey: PublicKey }; current: () => boolean;
}): Promise<SignedPrivateChainedEdit> {
  const { directory, previousRoot, secrets, current } = options;
  const edit = structuredClone(options.edit);
  const check = () => { if (!current()) throw new Error("Private history changed during signing"); };
  check();
  const access = privateReplicaIdentityFromDirectory(directory, edit.userId, secrets, current);
  const header = await privateWorkspaceChainHeader({ directory, previousRoot, edit }); check();
  const signed = await signPrivateWorkspaceEdit(edit, access.signingPrivateKey, header.readers.map((reader) => reader.userId)); check();
  const signature = await signPrivateChange(access.signingPrivateKey, header); check();
  return signedPrivateChainedEditSchema.parse({ ...signed, chain: { header, signature } });
}
/** Signature-independent roots make exact requests stable across retry, and
 * prevent a server from mixing a different valid snapshot or prior commit. */
export async function privateWorkspaceChainRoot(input: PrivateWorkspaceChain): Promise<string> {
  return privateRecordDigest(privateWorkspaceChainSchema.parse(input).header);
}
export async function verifyPrivateChainedWorkspaceChange(input: unknown, options: {
  server: string; workspaceId: string; userId: string; after: number; previousRoot: string;
  directory: VerifiedPrivateDirectory;
}) {
  options = { ...options };
  const change = privateChainedWorkspaceChangeSchema.parse(input), { chain } = change, { header } = chain;
  const { directory } = options;
  assertVerifiedPrivateDirectory(directory);
  if (header.server !== options.server || header.workspaceId !== options.workspaceId || header.directoryDigest !== directory.digest || directory.signed.directory.server !== options.server || directory.signed.directory.workspaceId !== options.workspaceId || header.previousRoot !== options.previousRoot || header.expectedRevision !== options.after) throw new Error("Private history does not extend this verified checkpoint");
  const audience = directory.signed.directory.members.map((member) => member.userId);
  if (canonicalJson(header.readers.map((reader) => reader.userId)) !== canonicalJson(audience)) throw new Error("Private history does not cover the verified audience");
  const actor = directory.signed.directory.members.find((member) => member.userId === header.userId);
  if (!actor || header.operationId !== change.manifest.operationId || header.userId !== change.manifest.userId || header.expectedRevision !== change.manifest.expectedRevision) throw new Error("Private history writer or operation did not match");
  const key = await crypto.subtle.importKey("jwk", actor.signingPublicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decodeSecret(chain.signature, 64), new TextEncoder().encode(canonicalJson(header)))) throw new Error("Private history signature did not match");
  const { chain: _chain, ...projected } = change;
  const verified = await verifyPrivateWorkspaceChange(projected, options, actor.signingPublicKey);
  const descriptor = header.readers.find((reader) => reader.userId === options.userId);
  if (!descriptor || descriptor.digest !== await privateRecordDigest(verified.manifest)) throw new Error("Private reader projection did not match its history binding");
  for (const row of [...verified.manifest.records, ...verified.manifest.remove]) {
    if (!canWritePrivateRecord(row.kind, row.authorId, actor)) throw new Error("Verified workspace permissions forbid this private change");
    const expected = readersForPrivateRecord(row.kind, row.authorId, directory.signed.directory.members).map((member) => member.userId).sort();
    if (canonicalJson(expected) !== canonicalJson(row.readers)) throw new Error("Private history recipients differ from the verified directory");
  }
  return { ...change, head: await privateWorkspaceChainRoot(chain) };
}
