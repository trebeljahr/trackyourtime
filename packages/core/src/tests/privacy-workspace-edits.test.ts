import assert from "node:assert/strict";
import { it } from "node:test";
import { createKeyPair, createSigningPair, signPrivateChange } from "../privacy/crypto.js";
import { encryptPrivateRecord } from "../privacy/records.js";
import { privateWorkspaceManifest, privateWorkspaceManifestForReader, signPrivateWorkspaceEdit, verifyPrivateWorkspaceChange } from "../privacy/workspace-edits.js";
import type { PrivateWorkspaceEdit } from "@starter/shared";
async function fixture() {
  const signing = await createSigningPair(), other = await createSigningPair(), recipient = await createKeyPair();
  const members = [{ userId: "owner", role: "owner" as const, canViewOthersTime: true, canViewOthersMoney: true, publicKey: recipient.publicKey }];
  const record = await encryptPrivateRecord("workspace", { kind: "entries", id: "entry", authorId: "owner", value: { description: "Private work" } }, members, 1);
  const edit: PrivateWorkspaceEdit = { v: 1, workspaceId: "workspace", userId: "owner", operationId: crypto.randomUUID(), expectedRevision: 0, records: [record], remove: [] };
  const signed = await signPrivateWorkspaceEdit(edit, signing.privateKey, ["owner"]);
  const change = { revision: 1, manifest: privateWorkspaceManifestForReader(await privateWorkspaceManifest(edit), "owner"), signature: signed.readerSignatures[0]!.signature, records: [record] };
  const scope = { workspaceId: "workspace", userId: "owner", after: 0 };
  return { signing, other, edit, signed, change, scope };
}
it("verifies complete signed records with a pinned key, and refuses substitutions, omissions, replay and cross-workspace delivery", async () => {
  const { change, scope, signing, other } = await fixture();
  assert.deepEqual(await verifyPrivateWorkspaceChange(change, scope, signing.publicKey), change);
  await assert.rejects(verifyPrivateWorkspaceChange(change, scope, other.publicKey), /signature/);
  await assert.rejects(verifyPrivateWorkspaceChange(change, { ...scope, after: 1 }, signing.publicKey), /out of order/);
  await assert.rejects(verifyPrivateWorkspaceChange(change, { ...scope, workspaceId: "elsewhere" }, signing.publicKey), /another workspace/);
  await assert.rejects(verifyPrivateWorkspaceChange({ ...change, records: [] }, scope, signing.publicKey), /Missing/);
  const tampered = structuredClone(change); tampered.records[0]!.box.nonce = "AAAAAAAAAAAAAAAA";
  await assert.rejects(verifyPrivateWorkspaceChange(tampered, scope, signing.publicKey), /did not match/);
  const changed = structuredClone(change); changed.manifest.remove.push({ kind: "entries", id: "unrelated", authorId: "owner", readers: ["owner"] });
  await assert.rejects(verifyPrivateWorkspaceChange(changed, scope, signing.publicKey), /signature/);
});
it("verifies signed deletion-only changes and filtered feeds without requiring another member's ciphertext", async () => {
  const { edit, scope, signing } = await fixture();
  const signed = await signPrivateWorkspaceEdit({ ...edit, records: [], remove: [{ kind: "entries", id: "entry", authorId: "owner", readers: ["owner"] }] }, signing.privateKey, ["owner"]);
  const change = { revision: 1, manifest: privateWorkspaceManifestForReader(await privateWorkspaceManifest(signed.edit), "owner"), signature: signed.readerSignatures[0]!.signature, records: [] };
  assert.equal((await verifyPrivateWorkspaceChange(change, scope, signing.publicKey)).manifest.remove.length, 1);
  const other = await signPrivateWorkspaceEdit(edit, signing.privateKey, ["owner", "colleague"]);
  assert.equal((await verifyPrivateWorkspaceChange({ revision: 1, manifest: privateWorkspaceManifestForReader(await privateWorkspaceManifest(edit), "colleague"), signature: other.readerSignatures.find((row) => row.userId === "colleague")!.signature, records: [] }, { ...scope, userId: "colleague" }, signing.publicKey)).records.length, 0);
});
it("refuses duplicate mutations, mismatched revisions and oversized or empty edits before signing", async () => {
  const { edit, signing } = await fixture();
  await assert.rejects(signPrivateWorkspaceEdit({ ...edit, records: [] }, signing.privateKey, ["owner"]), /Empty/);
  await assert.rejects(signPrivateWorkspaceEdit({ ...edit, records: [...edit.records, ...edit.records] }, signing.privateKey, ["owner"]), /Duplicate/);
  await assert.rejects(signPrivateWorkspaceEdit({ ...edit, expectedRevision: 1 }, signing.privateKey, ["owner"]), /revision/);
  const bad = structuredClone(edit); bad.records[0]!.grants.push(bad.records[0]!.grants[0]!);
  await assert.rejects(signPrivateWorkspaceEdit(bad, signing.privateKey, ["owner"]), /Duplicate/);
  const both = { ...edit, remove: [{ kind: "entries" as const, id: "entry", authorId: "owner", readers: ["owner"] }] };
  await assert.rejects(signPrivateWorkspaceEdit(both, signing.privateKey, ["owner"]), /Duplicate/);
  const oversized = { ...edit, records: Array.from({ length: 3 }, (_, index) => ({ ...edit.records[0]!, id: `large-${index}`, box: { ...edit.records[0]!.box, data: "A".repeat(1_500_000) } })) };
  await assert.rejects(signPrivateWorkspaceEdit(oversized, signing.privateKey, ["owner"]), /too large/);
  // A signed malformed manifest is still rejected by the receiver.
  const manifest = privateWorkspaceManifestForReader(await privateWorkspaceManifest(edit), "owner"); manifest.records[0]!.readers.push("owner");
  const signature = await signPrivateChange(signing.privateKey, manifest);
  await assert.rejects(verifyPrivateWorkspaceChange({ revision: 1, manifest, signature, records: edit.records }, { workspaceId: "workspace", userId: "owner", after: 0 }, signing.publicKey), /Duplicate/);
});
