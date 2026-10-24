import assert from "node:assert/strict";
import { it } from "node:test";
import { createKeyPair, createSigningPair, signPrivateChange } from "../privacy/crypto.js";
import { privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "../privacy/directory.js";
import { privateInitialSnapshotRoot } from "../privacy/initial-snapshot.js";
import { privateWorkspaceChainRoot, signPrivateChainedWorkspaceEdit, verifyPrivateChainedWorkspaceChange } from "../privacy/history-chain.js";
import { encryptPrivateRecord } from "../privacy/records.js";
import { privateRecordDigest, privateWorkspaceManifest, privateWorkspaceManifestForReader, signPrivateWorkspaceEdit } from "../privacy/workspace-edits.js";
import type { PrivateDirectoryMember, SignedPrivateChainedEdit } from "@starter/shared";
const scope = { server: "https://api.example.test", workspaceId: "workspace", userId: "owner" };
async function fixture() {
  const ownerPair = await createKeyPair(), ownerSigning = await createSigningPair(), memberPair = await createKeyPair(), memberSigning = await createSigningPair();
  const owner = { privateKey: ownerPair.privateKey, signingPrivateKey: ownerSigning.privateKey }, member = { privateKey: memberPair.privateKey, signingPrivateKey: memberSigning.privateKey };
  const people: PrivateDirectoryMember[] = [
    { userId: "member", role: "member", canViewOthersTime: false, canViewOthersMoney: false, publicKey: memberPair.publicKey, signingPublicKey: memberSigning.publicKey },
    { userId: "owner", role: "owner", canViewOthersTime: true, canViewOthersMoney: true, publicKey: ownerPair.publicKey, signingPublicKey: ownerSigning.publicKey },
  ];
  const confirmation = new Map(await Promise.all(people.map(async (p) => [p.userId, await privateMemberKeyFingerprint(scope.server, p)] as const)));
  const signedDirectory = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId: scope.workspaceId, ownerId: "owner", revision: 1, previousDigest: null, members: people }, owner.signingPrivateKey, null, confirmation);
  const directory = await verifyPrivateWorkspaceDirectory(signedDirectory, scope, { ownerId: "owner", signingPublicKey: ownerSigning.publicKey, revision: 0, digest: null });
  const previousRoot = await privateInitialSnapshotRoot({ ...scope, migrationId: crypto.randomUUID(), directoryDigest: directory.digest }, await privateRecordDigest([]));
  async function edit(id = "shared", privateFavorite = false) {
    const row = await encryptPrivateRecord(scope.workspaceId, { kind: privateFavorite ? "favorites" : "tags", id, authorId: privateFavorite ? "owner" : null, value: { name: `secret-${id}` } }, people, 2);
    return { v: 1 as const, workspaceId: scope.workspaceId, userId: "owner", operationId: crypto.randomUUID(), expectedRevision: 1, records: [row], remove: [] };
  }
  const sign = async (id?: string, privateFavorite?: boolean) => signPrivateChainedWorkspaceEdit({ edit: await edit(id, privateFavorite), directory, previousRoot, secrets: owner, current: () => true });
  async function projection(input: SignedPrivateChainedEdit, userId = "owner") {
    return { revision: input.edit.expectedRevision + 1, manifest: privateWorkspaceManifestForReader(await privateWorkspaceManifest(input.edit), userId), signature: input.readerSignatures.find((r) => r.userId === userId)!.signature, records: input.edit.records.filter((row) => row.grants.some((g) => g.userId === userId)), chain: input.chain };
  }
  const options = (userId = "owner") => ({ ...scope, userId, after: 1, previousRoot, directory });
  return { directory, owner, member, people, previousRoot, edit, sign, projection, options };
}
it("binds every reader projection to the same signature-independent global history root", async () => {
  const f = await fixture(), signed = await f.sign();
  const owner = await verifyPrivateChainedWorkspaceChange(await f.projection(signed), f.options());
  const member = await verifyPrivateChainedWorkspaceChange(await f.projection(signed, "member"), f.options("member"));
  assert.equal(owner.head, member.head);
  assert.equal(owner.head, await privateWorkspaceChainRoot({ ...signed.chain, signature: "A".repeat(86) }));
  assert.notEqual(owner.head, f.previousRoot);
});
it("refuses mixing a valid alternate snapshot or independently signed commit with this checkpoint", async () => {
  const f = await fixture(), signed = await f.sign(), change = await f.projection(signed);
  const otherRoot = await privateInitialSnapshotRoot({ ...scope, migrationId: crypto.randomUUID(), directoryDigest: f.directory.digest }, await privateRecordDigest([]));
  await assert.rejects(verifyPrivateChainedWorkspaceChange(change, { ...f.options(), previousRoot: otherRoot }), /does not extend/);
  const accepted = await verifyPrivateChainedWorkspaceChange(change, f.options());
  const alternate = await f.projection(await f.sign("alternate"));
  await assert.rejects(verifyPrivateChainedWorkspaceChange(alternate, { ...f.options(), after: 2, previousRoot: accepted.head }), /does not extend/);
});
it("hides another reader's private IDs, kinds and counts behind projection digests", async () => {
  const f = await fixture(), signed = await f.sign("private-pin", true), change = await f.projection(signed, "member");
  assert.equal(change.records.length, 0);
  assert.doesNotMatch(JSON.stringify(change), /private-pin|favorites|secret-/);
  assert.equal((await verifyPrivateChainedWorkspaceChange(change, f.options("member"))).revision, 2);
});
it("refuses changed roots/directories, forged signatures and substituted reader bindings", async () => {
  const f = await fixture(), signed = await f.sign();
  const forged = await f.projection(signed); forged.chain = structuredClone(forged.chain); forged.chain.signature = await signPrivateChange(f.member.signingPrivateKey, forged.chain.header);
  await assert.rejects(verifyPrivateChainedWorkspaceChange(forged, f.options()), /signature did not match/);
  const substituted = await f.projection(signed); substituted.chain = structuredClone(substituted.chain); substituted.chain.header.readers.find((r) => r.userId === "owner")!.digest = "A".repeat(43);
  substituted.chain.signature = await signPrivateChange(f.owner.signingPrivateKey, substituted.chain.header);
  await assert.rejects(verifyPrivateChainedWorkspaceChange(substituted, f.options()), /reader projection/);
  await assert.rejects(verifyPrivateChainedWorkspaceChange(await f.projection(signed), { ...f.options(), server: "https://other.test" }), /does not extend/);
});
it("enforces verified member write rights even for otherwise valid signatures accepted by a hostile API", async () => {
  const f = await fixture(), edit = await f.edit(); edit.userId = "member";
  await assert.rejects(signPrivateChainedWorkspaceEdit({ edit, directory: f.directory, previousRoot: f.previousRoot, secrets: f.member, current: () => true }), /permissions forbid/);
  const signed = await signPrivateWorkspaceEdit(edit, f.member.signingPrivateKey, f.people.map((p) => p.userId));
  const full = await privateWorkspaceManifest(edit), template = (await f.sign()).chain.header;
  const header = { ...template, userId: "member", operationId: edit.operationId, manifestDigest: await privateRecordDigest(full), readers: await Promise.all(f.people.map(async (p) => ({ userId: p.userId, digest: await privateRecordDigest(privateWorkspaceManifestForReader(full, p.userId)) }))) };
  const malicious = { ...signed, chain: { header, signature: await signPrivateChange(f.member.signingPrivateKey, header) } };
  await assert.rejects(verifyPrivateChainedWorkspaceChange(await f.projection(malicious), f.options()), /permissions forbid/);
});
it("cannot resume signing after an unlock generation becomes stale", async () => {
  const f = await fixture(); let current = true;
  const signing = signPrivateChainedWorkspaceEdit({ edit: await f.edit(), directory: f.directory, previousRoot: f.previousRoot, secrets: f.owner, current: () => current });
  current = false;
  await assert.rejects(signing, /changed during signing/);
});
