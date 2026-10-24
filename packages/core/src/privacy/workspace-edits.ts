import { PRIVATE_EDIT_MAX_BYTES, privateWorkspaceEditSchema, privateWorkspaceChangeSchema, type PrivateWorkspaceEdit, type PrivateWorkspaceManifest, type PrivateWorkspaceChange, type SignedPrivateWorkspaceEdit } from "@starter/shared";
import { canonicalJson, encodeSecret, decodeSecret, signPrivateChange, type PublicKey } from "./crypto.js";
const encoder = new TextEncoder();
const address = (row: { kind: string; id: string }) => JSON.stringify([row.kind, row.id]);
const readers = (values: readonly string[]) => {
  if (new Set(values).size !== values.length) throw new Error("Duplicate private record recipient");
  return [...values].sort();
};
export async function privateRecordDigest(value: unknown): Promise<string> {
  return encodeSecret(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(canonicalJson(value)))));
}
/** Sign hashes of complete records so a feed can omit other people's ciphertext
 * while each reader can verify every record addressed to their own account. */
export async function privateWorkspaceManifest(input: PrivateWorkspaceEdit): Promise<PrivateWorkspaceManifest> {
  const edit = privateWorkspaceEditSchema.parse(input);
  if (encoder.encode(JSON.stringify(edit)).byteLength > PRIVATE_EDIT_MAX_BYTES) throw new Error("Private workspace edit is too large");
  if (!edit.records.length && !edit.remove.length) throw new Error("Empty private workspace edit");
  const seen = new Set<string>();
  for (const row of [...edit.records, ...edit.remove]) {
    const key = address(row); if (seen.has(key)) throw new Error("Duplicate private workspace record"); seen.add(key);
  }
  for (const row of edit.records) if (row.revision !== edit.expectedRevision + 1) throw new Error("Private record revision does not match edit");
  const records = [];
  for (const row of edit.records) records.push({ kind: row.kind, id: row.id, authorId: row.authorId, hash: await privateRecordDigest(row), readers: readers(row.grants.map((grant) => grant.userId)) });
  return { protocol: "trackyourtime-private-workspace-edit-v1", readerId: null, ...edit, records, remove: edit.remove.map((row) => ({ ...row, readers: readers(row.readers) })) };
}
/** A separate signature per reader hides other people's record identifiers,
 * kinds and counts. Even an empty projection is signed so its reader can
 * advance a checkpoint without trusting an unsigned server omission. */
export function privateWorkspaceManifestForReader(manifest: PrivateWorkspaceManifest, userId: string): PrivateWorkspaceManifest {
  if (manifest.readerId !== null) throw new Error("Expected a complete private workspace manifest");
  return { ...manifest, readerId: userId, records: manifest.records.filter((row) => row.readers.includes(userId)), remove: manifest.remove.filter((row) => row.readers.includes(userId)) };
}
export async function signPrivateWorkspaceEdit(edit: PrivateWorkspaceEdit, privateKey: PublicKey, audience: readonly string[]): Promise<SignedPrivateWorkspaceEdit> {
  const snapshot = privateWorkspaceEditSchema.parse(edit);
  const manifest = await privateWorkspaceManifest(snapshot);
  const identities = readers(audience);
  if (!identities.length || identities.length > 200) throw new Error("Invalid private workspace audience");
  const readerSignatures = [];
  for (const userId of identities) readerSignatures.push({ userId, signature: await signPrivateChange(privateKey, privateWorkspaceManifestForReader(manifest, userId)) });
  return { edit: snapshot, signature: await signPrivateChange(privateKey, manifest), readerSignatures };
}
/** The signing key must come from the caller's verified member-key directory,
 * never from this response. A valid login alone cannot manufacture edits. */
export async function verifyPrivateWorkspaceChange(input: unknown, scope: { workspaceId: string; userId: string; after: number }, signingPublicKey: PublicKey): Promise<PrivateWorkspaceChange> {
  const change = privateWorkspaceChangeSchema.parse(input), { manifest } = change;
  if (manifest.readerId !== scope.userId || manifest.workspaceId !== scope.workspaceId || manifest.expectedRevision !== scope.after || change.revision !== scope.after + 1) throw new Error("Private workspace change is out of order or belongs to another workspace");
  const key = await crypto.subtle.importKey("jwk", signingPublicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decodeSecret(change.signature, 64), encoder.encode(canonicalJson(manifest)))) throw new Error("Private workspace signature did not match");
  const seen = new Set<string>();
  for (const row of [...manifest.records, ...manifest.remove]) {
    const key = address(row); if (seen.has(key)) throw new Error("Duplicate private workspace record"); seen.add(key);
    const canonicalReaders = readers(row.readers);
    if (canonicalJson(canonicalReaders) !== canonicalJson(row.readers)) throw new Error("Invalid private record recipients");
  }
  if ([...manifest.records, ...manifest.remove].some((row) => !row.readers.includes(scope.userId))) throw new Error("Private workspace feed contains another member's private records");
  const expected = manifest.records;
  if (expected.length !== change.records.length) throw new Error("Missing or unexpected private workspace records");
  const delivered = new Set<string>();
  for (const row of change.records) {
    const key = address(row), descriptor = expected.find((item) => address(item) === key);
    if (!descriptor || delivered.has(key) || row.authorId !== descriptor.authorId || row.revision !== change.revision || canonicalJson(readers(row.grants.map((grant) => grant.userId))) !== canonicalJson(descriptor.readers) || await privateRecordDigest(row) !== descriptor.hash) throw new Error("Private workspace record did not match signed manifest");
    delivered.add(key);
  }
  return change;
}
