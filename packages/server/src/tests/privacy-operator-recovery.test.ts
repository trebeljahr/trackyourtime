import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import mongoose from "mongoose";
import { BSON, Long, MongoClient } from "mongodb";
import { canonicalJson, createSigningPair, emptyRecoveryCollections, emptyRecoverySupplementCollections, randomSecret, recoveryDigest, recoverySupplementDigest, verifyCombinedWorkspaceRecoveryArchive, verifyCombinedRecoveryKeyBackup } from "@starter/core";
import { encryptOperatorRecoveryArchive, openOperatorRecoveryArchive, saveOperatorRecoveryCopy, signOperatorRecoveryProof, verifySavedOperatorRecoveryCopy, verifyOperatorRecoveryArchive, verifyOperatorRecoveryCopy, type OperatorRecoveryScope } from "../services/privacy/operator-recovery.js";
import { withOperatorRestoreSandbox } from "../services/privacy/operator-restore-sandbox.js";
import { connectTestDatabase, clearTestDatabase, dropTestDatabase, skipWithoutDatabase } from "./support/test-database.js";
const mongodPath = process.env.TEST_MONGOD_PATH ?? "";
const scope: OperatorRecoveryScope = { server: "https://api.example.test", workspaceId: "workspace", ownerId: "owner", migrationId: "10000000-0000-4000-8000-000000000001", modeId: "000000000000000000000001", directoryDigest: "D".repeat(43), snapshotRoot: "R".repeat(43) };
async function originals() {
  const collections = emptyRecoveryCollections(), supplement = emptyRecoverySupplementCollections(), createdAt = new Date().toISOString();
  collections.favorites = ["member", "owner"].map((userId) => ({ _id: userId, workspaceId: scope.workspaceId, userId, description: `${userId} private original` }));
  collections.invoices = [{ _id: "original-invoice", workspaceId: scope.workspaceId, xml: "<Invoice>€ — exact issued XML</Invoice>", total: BSON.EJSON.serialize(Long.fromString("9007199254740993"), { relaxed: false }) }];
  collections.timeentries = [{ _id: "original-entry", workspaceId: scope.workspaceId, authorId: "member", invoiceId: "original-invoice", start: { $date: { $numberLong: "0" } } }];
  supplement.organization = [{ _id: scope.workspaceId, name: "Original team", kind: "team" }];
  supplement.webhooksubscriptions = ["member", "owner"].map((createdBy) => ({ _id: createdBy, workspaceId: scope.workspaceId, createdBy, secret: `${createdBy} original signing secret` }));
  return verifyOperatorRecoveryArchive({ ...scope, format: "trackyourtime-operator-originals-v1", createdAt,
    snapshot: { v: 1, workspaceId: scope.workspaceId, createdAt, sourceRevision: await recoveryDigest(collections), collections },
    supplement: { v: 1, workspaceId: scope.workspaceId, createdAt, sourceRevision: await recoverySupplementDigest(supplement), collections: supplement },
  });
}
describe("operator-only encrypted originals and isolated restoration", { skip: skipWithoutDatabase || (!mongodPath && "TEST_MONGOD_PATH needs an operator-local mongod binary") }, () => {
  before(() => connectTestDatabase("privacy-operator-recovery"));
  beforeEach(clearTestDatabase); after(dropTestDatabase);
  it("owns its restore process and private socket, refuses unauthenticated reads, and cleans up callback/startup failures", async () => {
    let directory = "";
    const temporary = async () => (await readdir("/tmp")).filter((name) => name.startsWith("trackyourtime-operator-restore-"));
    const previous = await temporary();
    await assert.rejects(withOperatorRestoreSandbox(mongodPath, async (client) => {
      assert.notEqual(client, mongoose.connection.getClient());
      const options = await client.db("admin").command({ getCmdLineOpts: 1 });
      directory = dirname(options.parsed.storage.dbPath);
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      await client.db("drill").collection("records").insertOne({ description: "Disposable restore original" });
      const socket = join(directory, `mongodb-${options.parsed.net.port}.sock`);
      const unauthenticated = new MongoClient(`mongodb://${encodeURIComponent(socket)}/?directConnection=true`);
      try {
        await unauthenticated.connect();
        await assert.rejects(unauthenticated.db("drill").collection("records").findOne({}), { code: 13 });
      } finally { await unauthenticated.close(); }
      throw new Error("Injected restore callback failure");
    }), /Injected restore callback failure/);
    await assert.rejects(stat(directory), { code: "ENOENT" }); assert.deepEqual(await temporary(), previous);
    await assert.rejects(withOperatorRestoreSandbox("/usr/bin/false", async () => undefined), /did not start/);
    assert.deepEqual(await temporary(), previous);
    await assert.rejects(withOperatorRestoreSandbox("relative-mongod", async () => undefined), /absolute/);
  });
  it("saves ciphertext with restrictive permissions and restores every creator's exact originals without touching source", async () => {
    const directory = await mkdtemp("/private/tmp/trackyourtime-operator-file-test-"), key = randomSecret();
    try {
      const archive = await originals(), path = join(directory, "originals.tytoperator");
      await mongoose.connection.db!.collection("favorites").insertOne({ workspaceId: "source-sentinel", description: "Original source must remain" });
      const saved = await saveOperatorRecoveryCopy(path, archive, key, mongodPath);
      assert.equal(saved.sourceRevision, archive.snapshot.sourceRevision); assert.equal(saved.supplementRevision, archive.supplement.sourceRevision);
      assert.equal(saved.snapshotRoot, scope.snapshotRoot); assert.match(saved.fileSha256, /^[a-f0-9]{64}$/);
      const raw = await readFile(path, "utf8");
      assert.doesNotMatch(raw, /private original|signing secret|Invoice>|9007199254740993|sourceRevision/);
      assert.equal(raw.includes(Buffer.from(key).toString("base64url")), false);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      const reopened = await openOperatorRecoveryArchive(JSON.parse(raw), key, scope);
      assert.equal(canonicalJson(reopened), canonicalJson(archive));
      assert.equal(reopened.snapshot.collections.favorites.length, 2); assert.equal(reopened.supplement.collections.webhooksubscriptions.length, 2);
      assert.equal(await mongoose.connection.db!.collection("favorites").countDocuments({ workspaceId: "source-sentinel" }), 1);
      const operator = await createSigningPair();
      const signed = await signOperatorRecoveryProof(saved, operator.privateKey, operator.publicKey);
      assert.equal(signed.proof.fileSha256, saved.fileSha256); assert.equal(signed.proof.sourceRevision, saved.sourceRevision);
      await assert.rejects(signOperatorRecoveryProof(JSON.parse(JSON.stringify(saved)), operator.privateKey, operator.publicKey), /verified saved operator file/);
      await assert.rejects(signOperatorRecoveryProof(Object.freeze({ ...saved }), operator.privateKey, operator.publicKey), /verified saved operator file/);
      const rechecked = await verifySavedOperatorRecoveryCopy(path, key, scope, mongodPath);
      assert.equal((await signOperatorRecoveryProof(rechecked, operator.privateKey, operator.publicKey)).proof.fileSha256, saved.fileSha256);
      await assert.rejects(saveOperatorRecoveryCopy(path, archive, key, mongodPath), { code: "EEXIST" });
      assert.equal(await readFile(path, "utf8"), raw);
    } finally { key.fill(0); await rm(directory, { recursive: true, force: true }); }
  });
  it("binds ciphertext to the independent key and every checkpoint field, rejecting header changes and user-file formats", async () => {
    const key = randomSecret(), other = randomSecret();
    try {
      const archive = await originals(), file = await encryptOperatorRecoveryArchive(archive, key);
      await assert.rejects(openOperatorRecoveryArchive(file, other, scope));
      await assert.rejects(encryptOperatorRecoveryArchive(archive, key.slice(0, 16)), /256-bit/);
      for (const field of ["server", "workspaceId", "ownerId", "migrationId", "modeId", "directoryDigest", "snapshotRoot"] as const) {
        const changed = structuredClone(file); changed.header[field] = field === "migrationId" ? crypto.randomUUID() : `${changed.header[field]}x`;
        await assert.rejects(openOperatorRecoveryArchive(changed, key, scope));
      }
      const changedDate = structuredClone(file); changedDate.header.createdAt = new Date(0).toISOString();
      await assert.rejects(openOperatorRecoveryArchive(changedDate, key, scope));
      const corrupted = structuredClone(file); corrupted.box.data = (corrupted.box.data[0] === "A" ? "B" : "A") + corrupted.box.data.slice(1);
      await assert.rejects(openOperatorRecoveryArchive(corrupted, key, scope));
      await assert.rejects(verifyCombinedRecoveryKeyBackup(file, key, scope));
      await assert.rejects(verifyCombinedWorkspaceRecoveryArchive({ format: "trackyourtime-workspace-recovery-v2", server: scope.server, ownerId: scope.ownerId, snapshot: archive.snapshot, supplement: archive.supplement }), /another account/);
    } finally { key.fill(0); other.fill(0); }
  });
  it("refuses cross-workspace records and incomplete typed archives before creating an output file", async () => {
    const directory = await mkdtemp("/private/tmp/trackyourtime-operator-file-test-"), key = randomSecret();
    try {
      const archive = await originals(), path = join(directory, "refused.tytoperator");
      archive.snapshot.collections.favorites[0]!.workspaceId = "other-workspace";
      archive.snapshot.sourceRevision = await recoveryDigest(archive.snapshot.collections);
      await assert.rejects(saveOperatorRecoveryCopy(path, archive, key, mongodPath), /different workspace/);
      await assert.rejects(stat(path), { code: "ENOENT" });
      await assert.rejects(verifyOperatorRecoveryArchive({ ...await originals(), snapshot: {} }));
      await assert.rejects(saveOperatorRecoveryCopy("relative.tytoperator", await originals(), key, mongodPath), /absolute/);
    } finally { key.fill(0); await rm(directory, { recursive: true, force: true }); }
  });
  it("keeps existing backups and encrypted failure evidence, and removes failed isolated copies", async () => {
    const directory = await mkdtemp("/private/tmp/trackyourtime-operator-file-test-"), key = randomSecret();
    try {
      const original = join(directory, "existing.tytoperator"), alias = join(directory, "alias.tytoperator");
      await writeFile(original, "Previous encrypted backup"); await symlink(original, alias);
      await assert.rejects(saveOperatorRecoveryCopy(alias, await originals(), key, mongodPath));
      assert.equal(await readFile(original, "utf8"), "Previous encrypted backup");
      const archive = await originals();
      archive.snapshot.collections.tags = [{ _id: "noncanonical", workspaceId: scope.workspaceId, value: { $numberDouble: "1.00" } }];
      archive.snapshot.sourceRevision = await recoveryDigest(archive.snapshot.collections);
      const client = mongoose.connection.getClient(), path = join(directory, "failed-drill.tytoperator");
      const copies = async () => (await client.db("admin").admin().listDatabases({ nameOnly: true })).databases.map((row) => row.name).filter((name) => name.startsWith("trackyourtime-operator-check-"));
      const beforeCopies = await copies();
      await assert.rejects(saveOperatorRecoveryCopy(path, archive, key, mongodPath), /differs from/);
      assert.deepEqual(await copies(), beforeCopies);
      assert.doesNotMatch(await readFile(path, "utf8"), /signing secret|private original/);
      const encrypted = await encryptOperatorRecoveryArchive(archive, key);
      await assert.rejects(verifyOperatorRecoveryCopy(encrypted, key, { ...scope, workspaceId: "elsewhere" }, mongodPath));
      assert.deepEqual(await copies(), beforeCopies);
    } finally { key.fill(0); await rm(directory, { recursive: true, force: true }); }
  });
});
