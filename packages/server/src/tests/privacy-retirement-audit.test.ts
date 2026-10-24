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
  it("requires pinned encrypted state even in an otherwise empty database", async () => {
    await assert.rejects(withBusinessTransaction(() => assertPrivateWorkspaceRetirement(db(), workspaceId, transactionSession()!)), /pinned encrypted workspace/);
    await db().collection("privateworkspaces").insertOne({ workspaceId, state: "encrypted", revision: 1, head: "A".repeat(43), directoryDigest: "B".repeat(43), backupVerified: true, sourceRevision: "retired" });
    await withBusinessTransaction(() => assertPrivateWorkspaceRetirement(db(), workspaceId, transactionSession()!));
  });

});
