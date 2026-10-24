import assert from "node:assert/strict";
import { it } from "node:test";
import { createKeyPair, randomSecret, seal, sealForRecipient, encodeSecret } from "../privacy/crypto.js";
import { emptyRecoverySupplementCollections, partitionPrivateRecoverySupplement, privateRecordsToRecoverySupplement, recoverySupplementDigest, verifyWorkspaceRecoverySupplement } from "../privacy/recovery-supplement.js";
import { decryptPrivateRecord, encryptPrivateRecord, privateRecordContext } from "../privacy/records.js";
import { canWritePrivateRecord, type WorkspaceRecoverySupplement } from "@starter/shared";
async function fixture() {
  const owner = await createKeyPair(), author = await createKeyPair();
  const members = [{ userId: "owner", role: "owner" as const, canViewOthersTime: true, canViewOthersMoney: true, publicKey: owner.publicKey }, { userId: "author", role: "member" as const, canViewOthersTime: false, canViewOthersMoney: false, publicKey: author.publicKey }];
  const collections = emptyRecoverySupplementCollections();
  collections.organization.push({ _id: "workspace", name: "Private studio", slug: "private-studio", logo: "data:image/png;base64,original", metadata: { raw: { $numberLong: "9007199254740993" } } });
  collections.apitokens.push({ _id: { $oid: "000000000000000000000001" }, workspaceId: "workspace", userId: "author", authorId: "owner", name: "Private customer token", tokenHash: "original credential hash", unknownLegacy: { $numberDecimal: "12.3400" } });
  collections.webhooksubscriptions.push({ _id: { $oid: "000000000000000000000001" }, workspaceId: "workspace", createdBy: "author", userId: "owner", url: "https://private.example.test/events", secret: "Original webhook signing secret", enabled: true });
  const source: WorkspaceRecoverySupplement = { v: 1, workspaceId: "workspace", createdAt: "2026-10-25T00:00:00.000Z", sourceRevision: await recoverySupplementDigest(collections), collections };
  return { owner, author, members, source };
}
it("round-trips supplemental BSON, organization identity and exact integration secrets without normalized IDs or fields", async () => {
  const { source, members, author } = await fixture();
  await verifyWorkspaceRecoverySupplement(source, "workspace");
  const records = partitionPrivateRecoverySupplement(source), decrypted = [];
  assert.equal(records.length, 3); assert.notEqual(records[1]!.id, records[2]!.id);
  for (const row of records) {
    const encrypted = await encryptPrivateRecord("workspace", row, members, 1);
    assert.doesNotMatch(JSON.stringify(encrypted), /Private studio|private-studio|Original webhook|private.example|numberDecimal/);
    decrypted.push(await decryptPrivateRecord("workspace", encrypted, "author", author.privateKey));
  }
  assert.deepEqual(await privateRecordsToRecoverySupplement("workspace", decrypted, source.createdAt), source);
});
it("keeps integrations creator-only, including when unrelated legacy author fields name the owner", async () => {
  const { source, members, author, owner } = await fixture();
  for (const row of partitionPrivateRecoverySupplement(source)) {
    const encrypted = await encryptPrivateRecord("workspace", row, members, 1);
    if (row.kind === "integrations") {
      assert.deepEqual(encrypted.grants.map((grant) => grant.userId), ["author"]);
      await assert.rejects(decryptPrivateRecord("workspace", encrypted, "owner", owner.privateKey), /cannot decrypt/);
      await assert.rejects(encryptPrivateRecord("workspace", { ...row, authorId: "owner" }, members, 1), /owner does not match/);
      assert.equal(canWritePrivateRecord(row.kind, "author", members[0]!), false);
      assert.equal(canWritePrivateRecord(row.kind, "author", members[1]!), true);
    } else assert.equal((await decryptPrivateRecord("workspace", encrypted, "owner", owner.privateKey)).value.organization !== undefined, true);
  }
});
it("rejects cross-workspace source, changed checksums, duplicate originals and colliding string/ObjectId addresses", async () => {
  const { source } = await fixture();
  const changed = structuredClone(source); changed.collections.apitokens[0]!.name = "Changed original";
  await assert.rejects(verifyWorkspaceRecoverySupplement(changed), /checksum/);
  await assert.rejects(verifyWorkspaceRecoverySupplement(source, "another"));
  const duplicate = structuredClone(source); duplicate.collections.apitokens.push(duplicate.collections.apitokens[0]!); duplicate.sourceRevision = await recoverySupplementDigest(duplicate.collections);
  await assert.rejects(verifyWorkspaceRecoverySupplement(duplicate), /Duplicate/);
  const collision = structuredClone(source); collision.collections.apitokens.push({ ...collision.collections.apitokens[0]!, _id: "000000000000000000000001" }); collision.sourceRevision = await recoverySupplementDigest(collision.collections);
  await verifyWorkspaceRecoverySupplement(collision);
  assert.throws(() => partitionPrivateRecoverySupplement(collision), /IDs collide/);
  const wrongOrganization = structuredClone(source); wrongOrganization.collections.organization[0]!._id = "another";
  await assert.rejects(verifyWorkspaceRecoverySupplement(wrongOrganization), /another workspace/);
});
it("refuses orphaned creators, unsupported private namespaces and authenticated cross-owner payloads", async () => {
  const { source, members, author } = await fixture();
  const orphan = structuredClone(source); orphan.collections.webhooksubscriptions[0]!.createdBy = "";
  assert.throws(() => partitionPrivateRecoverySupplement(orphan), /owner does not match/);
  const row = partitionPrivateRecoverySupplement(source).find((record) => record.kind === "integrations")!;
  await assert.rejects(encryptPrivateRecord("workspace", { ...row, id: "unknown:record" }, members, 1), /scope does not match/);
  const secret = randomSecret(), metadata = { id: row.id, kind: row.kind, authorId: "owner", revision: 1 }, context = privateRecordContext("workspace", metadata);
  const corrupted = { ...metadata, box: await seal(secret, row.value, context), grants: [{ userId: "author", envelope: await sealForRecipient(author.publicKey, encodeSecret(secret), `${context}:author`) }] };
  await assert.rejects(decryptPrivateRecord("workspace", corrupted, "author", author.privateKey), /owner does not match/);
});

it("retains unknown organization originals in source but refuses to publish them to a broader audience", async () => {
  const { source, members } = await fixture();
  source.collections.organization[0]!.unclassifiedSecret = "Unknown legacy original";
  source.sourceRevision = await recoverySupplementDigest(source.collections);
  await verifyWorkspaceRecoverySupplement(source);
  assert.throws(() => partitionPrivateRecoverySupplement(source), /explicit private audience/);
  await assert.rejects(encryptPrivateRecord("workspace", { kind: "workspaceIdentity", id: "organization", authorId: null, value: { workspaceId: "workspace", organization: source.collections.organization[0]! } }, members, 1), /explicit private audience/);
});
