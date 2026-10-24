import assert from "node:assert/strict";
import { before, after, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { Binary, Decimal128, Double, Int32, Long, ObjectId } from "mongodb";
import { createKeyPair, createSigningPair, deriveRecoveryBackupKey, encryptRecoveryKeyBackup, decryptRecoveryKeyBackup, encodeSecret, randomSecret, createPrivateMigrationProof, decryptPrivateRecord, encryptPrivateRecord, partitionPrivateRecovery, privateRecordsToRecovery, privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory, decryptBackup, encryptBackup } from "@starter/core";
import { PRIVATE_WORKSPACE_REQUIRED, RECOVERY_KINDS } from "@starter/shared";
import { workspaceRecovery } from "../services/privacy/recovery.js";
import { verifyRecoveryCopy } from "../services/privacy/restore-copy.js";
import { connectTestDatabase, clearTestDatabase, dropTestDatabase, skipWithoutDatabase, testDatabaseTransactions } from "./support/test-database.js";

describe("lossless workspace recovery", { skip: skipWithoutDatabase }, () => {
  before(() => connectTestDatabase("private-recovery"));
  beforeEach(clearTestDatabase);
  after(dropTestDatabase);
  async function seed() {
    const db = mongoose.connection.db!;
    for (const kind of RECOVERY_KINDS) await db.collection(kind).insertOne({
      _id: kind === "entryoperations" ? "durable-operation-receipt" as never : new ObjectId(),
      workspaceId: "workspace", userId: "owner", authorId: "owner", role: "owner",
      name: "Synthetic private name", xml: "<Invoice>Original issued XML</Invoice>",
      entryIds: ["00112233445566778899aabb"], invoiceId: "ffeeddccbbaa998877665544",
      wholeDouble: new Double(1), integer: new Int32(7), largeInteger: Long.fromString("9007199254740993"), smallLong: Long.fromNumber(42),
      amount: Decimal128.fromString("123.4500"), binary: new Binary(Buffer.from([1, 2, 3])), createdAt: new Date("2026-10-23T00:00:00.000Z"),
    });
    await db.collection("favorites").insertOne({ workspaceId: "workspace", userId: "other", name: "Another member's private preference" });
  }
  it("refuses a plaintext recovery request after workspace conversion rather than returning an empty backup", async () => {
    await seed();
    await mongoose.connection.db!.collection("privateworkspaces").insertOne({ workspaceId: "workspace", state: "encrypted" });
    await assert.rejects(workspaceRecovery("workspace", "owner"), { code: "PRECONDITION_FAILED", message: PRIVATE_WORKSPACE_REQUIRED });
    assert.equal(await mongoose.connection.db!.collection("invoices").countDocuments(), 1);
  });
  it("restores the decrypted archive into a fresh Mongo database with exact BSON types, IDs, links and XML", async (t) => {
    if (!await testDatabaseTransactions()) return t.skip("Consistent recovery needs a replica set");
    await seed();
    const snapshot = await workspaceRecovery("workspace", "owner");
    assert.equal(snapshot.collections.favorites.length, 1);
    const invoice = snapshot.collections.invoices[0]!;
    assert.deepEqual(invoice.wholeDouble, { $numberDouble: "1.0" });
    assert.deepEqual(invoice.smallLong, { $numberLong: "42" });
    assert.deepEqual(invoice.largeInteger, { $numberLong: "9007199254740993" });
    assert.deepEqual(invoice.amount, { $numberDecimal: "123.4500" });
    const encrypted = await encryptBackup(snapshot, "a separate synthetic recovery password");
    assert.doesNotMatch(JSON.stringify(encrypted), /Original issued XML|Synthetic private name/);
    const reopened = await decryptBackup(encrypted, "a separate synthetic recovery password");
    const recoveryKey = encodeSecret(randomSecret()), key = await deriveRecoveryBackupKey(recoveryKey, { server: "https://api.example.test", userId: "owner" });
    const file = await encryptRecoveryKeyBackup({ format: "trackyourtime-workspace-recovery-v1", server: "https://api.example.test", ownerId: "owner", snapshot }, key, () => true); key.fill(0);
    const local = await decryptRecoveryKeyBackup(JSON.parse(JSON.stringify(file)), recoveryKey);
    assert.deepEqual(local.snapshot, snapshot);
    const localRestore = await verifyRecoveryCopy(mongoose.connection.getClient(), local.snapshot);
    assert.equal(localRestore.sourceRevision, snapshot.sourceRevision);
    const result = await verifyRecoveryCopy(mongoose.connection.getClient(), reopened);
    assert.equal(result.records, RECOVERY_KINDS.length);
    assert.equal(result.sourceRevision, snapshot.sourceRevision);
    for (const kind of RECOVERY_KINDS) assert.equal(result.counts[kind], 1);
    assert.equal(await mongoose.connection.db!.collection("favorites").countDocuments(), 2);
    assert.equal((await mongoose.connection.getClient().db().admin().listDatabases()).databases.filter((db) => db.name.startsWith("trackyourtime-recovery-check-")).length, 0);
    const full = await workspaceRecovery("workspace", "owner", true);
    assert.equal(full.collections.favorites.length, 2);
    assert.equal((await verifyRecoveryCopy(mongoose.connection.getClient(), full)).records, RECOVERY_KINDS.length + 1);
  });
  it("restores a client-verified encrypted migration copy with all original BSON types intact", async (t) => {
    if (!await testDatabaseTransactions()) return t.skip("Consistent recovery needs a replica set");
    await seed();
    const source = await workspaceRecovery("workspace", "owner"), pair = await createKeyPair(), signing = await createSigningPair();
    const member = { userId: "owner", role: "owner" as const, canViewOthersTime: true, canViewOthersMoney: true, publicKey: pair.publicKey, signingPublicKey: signing.publicKey };
    const directory = { v: 1 as const, server: "https://api.example.test", workspaceId: "workspace", revision: 1, previousDigest: null, ownerId: "owner", members: [member] };
    const signed = await signPrivateWorkspaceDirectory(directory, signing.privateKey, null, new Map([["owner", await privateMemberKeyFingerprint(directory.server, member)]]));
    const verified = await verifyPrivateWorkspaceDirectory(signed, directory, { ownerId: "owner", signingPublicKey: signing.publicKey, revision: 0, digest: null });
    const records = [];
    for (const plain of partitionPrivateRecovery(source)) records.push(await encryptPrivateRecord("workspace", plain, verified.signed.directory.members, 1));
    const { proof } = await createPrivateMigrationProof({ source, records, directory: verified, userId: "owner", migrationId: crypto.randomUUID(), secrets: { privateKey: pair.privateKey, signingPrivateKey: signing.privateKey }, current: () => true });
    assert.equal(proof.sourceRevision, source.sourceRevision); assert.equal(proof.opaqueRecords, 0);
    const plaintext = [];
    for (const row of records) plaintext.push(await decryptPrivateRecord("workspace", row, "owner", pair.privateKey));
    const recovered = await privateRecordsToRecovery("workspace", plaintext, source.createdAt);
    assert.deepEqual(recovered, source);
    const encrypted = await encryptBackup(recovered, "separate synthetic migration backup password");
    const reopened = await decryptBackup(encrypted, "separate synthetic migration backup password");
    const recoveryKey = encodeSecret(randomSecret()), key = await deriveRecoveryBackupKey(recoveryKey, { server: "https://api.example.test", userId: "owner" });
    const file = await encryptRecoveryKeyBackup({ format: "trackyourtime-workspace-recovery-v1", server: "https://api.example.test", ownerId: "owner", snapshot: recovered }, key, () => true); key.fill(0);
    const local = await decryptRecoveryKeyBackup(JSON.parse(JSON.stringify(file)), recoveryKey);
    assert.deepEqual(local.snapshot, recovered);
    const localRestore = await verifyRecoveryCopy(mongoose.connection.getClient(), local.snapshot);
    assert.equal(localRestore.sourceRevision, source.sourceRevision);
    const result = await verifyRecoveryCopy(mongoose.connection.getClient(), reopened);
    assert.equal(result.records, RECOVERY_KINDS.length); assert.equal(result.sourceRevision, source.sourceRevision);
    assert.equal(await mongoose.connection.db!.collection("favorites").countDocuments(), 2);
  });
  it("refuses another member's recovery request and a modified archive without changing source records", async (t) => {
    if (!await testDatabaseTransactions()) return t.skip("Consistent recovery needs a replica set");
    await seed();
    await assert.rejects(workspaceRecovery("workspace", "other"), { code: "FORBIDDEN" });
    const snapshot = await workspaceRecovery("workspace", "owner");
    snapshot.collections.invoices[0]!.xml = "modified";
    await assert.rejects(verifyRecoveryCopy(mongoose.connection.getClient(), snapshot), /checksum/);
    const original = await mongoose.connection.db!.collection("invoices").findOne({ workspaceId: "workspace" });
    assert.equal(original?.xml, "<Invoice>Original issued XML</Invoice>");
  });
});
