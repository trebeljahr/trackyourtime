import assert from "node:assert/strict";
import { before, beforeEach, after, describe, it } from "node:test";
import mongoose from "mongoose";
import { auditPrivateWorkspaceRetirement, assertPrivateWorkspaceRetirement, privateWorkspaceRoutingIdentity } from "../services/privacy/retirement-audit.js";
import { transactionSession, withBusinessTransaction } from "../services/business-transaction.js";
import { clearTestDatabase, connectTestDatabase, dropTestDatabase, skipWithoutDatabase } from "./support/test-database.js";
const workspaceId = "0123456789abcdef01234567";
const db = () => mongoose.connection.db!;
describe("private workspace residual plaintext audit", { skip: skipWithoutDatabase }, () => {
  before(() => connectTestDatabase("privacy-retirement"));
  beforeEach(clearTestDatabase);
  after(dropTestDatabase);
  it("reports only counts for legacy data, secrets, labels, source hashes and an unknown content collection", async () => {
    for (const collection of ["timeentries", "entryoperations", "favorites", "webhooksubscriptions", "webhookdeliveries", "apitokens", "privatemigrationreceipts", "privateworkspaces", "futurefeature"]) await db().collection(collection).insertOne({ workspaceId, name: "Secret client name", secret: "Secret signing key", sourceRevision: "1".repeat(64), envelope: { description: "Sensitive work" } });
    await db().collection("organization").insertOne({ id: workspaceId, name: "Secret organization", slug: "secret-customer", logo: "data:private", metadata: "private" });
    const result = await auditPrivateWorkspaceRetirement(db(), workspaceId);
    assert.ok(result.leaks.some((row) => row.collection === "webhooksubscriptions" && row.reason === "integration-content"));
    assert.ok(result.leaks.some((row) => row.collection === "entryoperations" && row.reason === "original-records"));
    assert.ok(result.leaks.some((row) => row.collection === "futurefeature" && row.reason === "unclassified-records"));
    assert.ok(result.leaks.some((row) => row.collection === "organization"));
    assert.doesNotMatch(JSON.stringify(result), /Secret|Sensitive|customer|signing key|1111111111111111|data:private/);
    assert.equal(await db().collection("timeentries").countDocuments(), 1);
  });
  it("accepts only routing placeholders, credential hashes and ciphertext metadata while excluding other workspaces", async () => {
    await db().collection("privateworkspaces").insertOne({ workspaceId, state: "encrypted", sourceRevision: "retired", revision: 1 });
    await db().collection("workspacemembers").insertOne({ workspaceId, userId: "member", role: "member", name: "", hourlyRate: null });
    await db().collection("apitokens").insertOne({ workspaceId, userId: "member", name: "", prefix: "opaque", tokenHash: "hash-of-random-token", scopes: ["entries:read"] });
    await db().collection("organization").insertOne({ id: workspaceId, ...privateWorkspaceRoutingIdentity(workspaceId), logo: null });
    await db().collection("privaterecords").insertOne({ workspaceId, kind: "tags", box: { data: "ciphertext" } });
    await db().collection("futurefeature").insertOne({ workspaceId: "other", original: "Other workspace original" });
    assert.deepEqual(await auditPrivateWorkspaceRetirement(db(), workspaceId), { leaks: [] });
  });
  it("preserves validated personal/team routing without inventing a kind for legacy workspaces", async () => {
    assert.equal("kind" in privateWorkspaceRoutingIdentity(workspaceId), false);
    for (const kind of ["personal", "team"]) {
      const routing = privateWorkspaceRoutingIdentity(workspaceId, kind);
      assert.equal(routing.kind, kind);
      await db().collection("organization").replaceOne({ id: workspaceId }, { id: workspaceId, ...routing, logo: null }, { upsert: true });
      assert.deepEqual(await auditPrivateWorkspaceRetirement(db(), workspaceId), { leaks: [] });
    }
  });
  it("refuses arbitrary, null and non-string workspace kinds without exposing their values", async () => {
    for (const kind of ["Private customer label", null, false, ["personal"], { name: "Secret team" }]) {
      assert.throws(() => privateWorkspaceRoutingIdentity(workspaceId, kind), /Unknown workspace kind/);
      await db().collection("organization").replaceOne({ id: workspaceId }, { id: workspaceId, ...privateWorkspaceRoutingIdentity(workspaceId), kind }, { upsert: true });
      const report = await auditPrivateWorkspaceRetirement(db(), workspaceId);
      assert.deepEqual(report.leaks, [{ collection: "organization", reason: "personal-labels", records: 1 }]);
      assert.doesNotMatch(JSON.stringify(report), /customer|Secret|team|personal"/);
    }
    await db().collection("organization").updateOne({ id: workspaceId }, { $set: { kind: "team", privateNote: "Original note" } });
    assert.deepEqual((await auditPrivateWorkspaceRetirement(db(), workspaceId)).leaks, [{ collection: "organization", reason: "unknown-fields", records: 1 }]);
  });
  it("compares complete retained values so arrays cannot hide labels or original source hashes", async () => {
    const routing = privateWorkspaceRoutingIdentity(workspaceId);
    await db().collection("organization").insertOne({ id: workspaceId, ...routing });
    for (const [field, allowed] of [["name", routing.name], ["slug", routing.slug], ["logo", ""], ["metadata", "{}"]]) {
      await db().collection("organization").replaceOne({ id: workspaceId }, { id: workspaceId, ...routing, [field!]: [allowed, "Sensitive retained content"] });
      assert.deepEqual((await auditPrivateWorkspaceRetirement(db(), workspaceId)).leaks, [{ collection: "organization", reason: "personal-labels", records: 1 }]);
    }
    await db().collection("organization").replaceOne({ id: workspaceId }, { id: workspaceId, ...routing });
    await db().collection("apitokens").insertOne({ workspaceId, name: ["", "Sensitive token label"] });
    await db().collection("workspacemembers").insertOne({ workspaceId, name: [null, "Sensitive member label"], hourlyRate: [null, 999] });
    await db().collection("privateworkspaces").insertOne({ workspaceId, state: "encrypted", sourceRevision: ["retired", "Sensitive source checksum"], supplementRevision: [null, "retired", "Supplemental source checksum"] });
    const report = await auditPrivateWorkspaceRetirement(db(), workspaceId);
    assert.deepEqual(report.leaks, [{ collection: "apitokens", reason: "personal-labels", records: 1 }, { collection: "privateworkspaces", reason: "source-checksums", records: 1 }, { collection: "workspacemembers", reason: "personal-labels", records: 1 }]);
    assert.doesNotMatch(JSON.stringify(report), /Sensitive|Supplemental|999/);
  });
  it("refuses new retained plaintext fields instead of silently treating them as routing metadata", async () => {
    await db().collection("workspacemembers").insertOne({ workspaceId, userId: "member", role: "member", name: "", note: "Private manager note" });
    await db().collection("apitokens").insertOne({ workspaceId, name: "", customLabel: "Customer project" });
    await db().collection("privaterecords").insertOne({ workspaceId, box: { data: "ciphertext" }, originalDescription: "Accidental plaintext" });
    const report = await auditPrivateWorkspaceRetirement(db(), workspaceId);
    assert.deepEqual(report.leaks.map((row) => [row.collection, row.reason]), [["apitokens", "unknown-fields"], ["privaterecords", "unknown-fields"], ["workspacemembers", "unknown-fields"]]);
  });
  it("aborts partial retirement atomically when one forgotten plaintext collection remains", async () => {
    await db().collection("privateworkspaces").insertOne({ workspaceId, state: "migrating", revision: 0, sourceRevision: "temporary plaintext checksum" });
    await db().collection("timeentries").insertOne({ workspaceId, description: "Original work" });
    await db().collection("webhooksubscriptions").insertOne({ workspaceId, secret: "Private webhook secret" });
    await assert.rejects(withBusinessTransaction(async () => {
      const session = transactionSession()!;
      await db().collection("privateworkspaces").updateOne({ workspaceId }, { $set: { state: "encrypted", revision: 1, head: "A".repeat(43), directoryDigest: "B".repeat(43), backupVerified: true, sourceRevision: "retired" } }, { session });
      await db().collection("timeentries").deleteMany({ workspaceId }, { session });
      await assertPrivateWorkspaceRetirement(db(), workspaceId, session);
    }), { code: "PRECONDITION_FAILED", message: "Residual plaintext workspace data or temporary source checksums remain. Source retirement was not verified." });
    assert.equal((await db().collection("privateworkspaces").findOne({ workspaceId }))!.state, "migrating");
    assert.equal(await db().collection("timeentries").countDocuments(), 1);
    assert.equal(await db().collection("webhooksubscriptions").countDocuments(), 1);
  });
  it("detects private content embedded in receipts owned by another workspace without exposing its values", async () => {
    for (const [index, result] of [
      { workspaceId, description: "Retained private timer description" },
      { workspaceId: "standard", replaced: { workspaceId, workspaceName: "Retained private workspace name" } },
      { entry: { workspaceId, description: "Retained entry snapshot" } },
      { stopped: { workspaceId, description: "Retained stopped snapshot" } },
    ].entries()) await db().collection("entryoperations").insertOne({ workspaceId: "other", result, requestHash: `private receipt checksum ${index}` });
    await db().collection("entryoperations").insertOne({ workspaceId: "other", result: { workspaceId: "unrelated", replaced: null } });
    const report = await auditPrivateWorkspaceRetirement(db(), workspaceId);
    assert.deepEqual(report.leaks, [{ collection: "entryoperations", reason: "cross-workspace-content", records: 4 }]);
    assert.doesNotMatch(JSON.stringify(report), /Retained|checksum|description|other|unrelated/);
  });
  it("requires pinned encrypted state even in an otherwise empty database", async () => {
    await assert.rejects(withBusinessTransaction(() => assertPrivateWorkspaceRetirement(db(), workspaceId, transactionSession()!)), /pinned encrypted workspace/);
    await db().collection("privateworkspaces").insertOne({ workspaceId, state: "encrypted", revision: 1, head: "A".repeat(43), directoryDigest: "B".repeat(43), backupVerified: true, sourceRevision: "retired" });
    await withBusinessTransaction(() => assertPrivateWorkspaceRetirement(db(), workspaceId, transactionSession()!));
  });

  it("requires temporary original-stage authorization to retire after source checksums are cleared", async () => {
    await db().collection("privateworkspaces").insertOne({ workspaceId, state: "encrypted", revision: 1, head: "A".repeat(43), directoryDigest: "B".repeat(43), backupVerified: true, sourceRevision: "retired", supplementRevision: "retired", originalStage: { cursor: 50, complete: true, signed: { request: "temporary original-conversion authorization" } } });
    assert.deepEqual((await auditPrivateWorkspaceRetirement(db(), workspaceId)).leaks, [{ collection: "privateworkspaces", reason: "source-checksums", records: 1 }]);
    await assert.rejects(withBusinessTransaction(() => assertPrivateWorkspaceRetirement(db(), workspaceId, transactionSession()!)), /Residual plaintext/);
    await db().collection("privateworkspaces").updateOne({ workspaceId }, { $unset: { originalStage: "" } });
    await withBusinessTransaction(() => assertPrivateWorkspaceRetirement(db(), workspaceId, transactionSession()!));
  });

  it("refuses a supplemental plaintext checksum after the primary checksum was retired", async () => {
    await db().collection("privateworkspaces").insertOne({ workspaceId, state: "encrypted", revision: 1, head: "A".repeat(43), directoryDigest: "B".repeat(43), backupVerified: true, sourceRevision: "retired", supplementRevision: "c".repeat(64) });
    const report = await auditPrivateWorkspaceRetirement(db(), workspaceId);
    assert.deepEqual(report.leaks, [{ collection: "privateworkspaces", reason: "source-checksums", records: 1 }]);
    assert.doesNotMatch(JSON.stringify(report), /cccccccc/);
    await assert.rejects(withBusinessTransaction(() => assertPrivateWorkspaceRetirement(db(), workspaceId, transactionSession()!)), /Residual plaintext/);
    await db().collection("privateworkspaces").updateOne({ workspaceId }, { $set: { supplementRevision: "retired" } });
    await withBusinessTransaction(() => assertPrivateWorkspaceRetirement(db(), workspaceId, transactionSession()!));
  });
  it("requires temporary operator proofs containing original checksums to retire without exposing their values", async () => {
    await db().collection("privateworkspaces").insertOne({ workspaceId, state: "encrypted", revision: 1, head: "A".repeat(43), directoryDigest: "B".repeat(43), backupVerified: true, sourceRevision: "retired", supplementRevision: "retired", operatorBackup: { proof: { sourceRevision: "c".repeat(64), fileSha256: "d".repeat(64) }, signature: "temporary operator signature" } });
    const report = await auditPrivateWorkspaceRetirement(db(), workspaceId);
    assert.deepEqual(report.leaks, [{ collection: "privateworkspaces", reason: "source-checksums", records: 1 }]);
    assert.doesNotMatch(JSON.stringify(report), /cccccccc|dddddddd|operator signature/);
    await assert.rejects(withBusinessTransaction(() => assertPrivateWorkspaceRetirement(db(), workspaceId, transactionSession()!)), /Residual plaintext/);
    await db().collection("privateworkspaces").updateOne({ workspaceId }, { $set: { operatorBackup: null } });
    await withBusinessTransaction(() => assertPrivateWorkspaceRetirement(db(), workspaceId, transactionSession()!));
  });

});
