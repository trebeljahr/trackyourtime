import assert from "node:assert/strict";
import { before, beforeEach, after, describe, it } from "node:test";
import mongoose from "mongoose";
import { Long } from "mongodb";
import { workspaceRecoverySupplement, capturePrivateMigrationSupplement } from "../services/privacy/recovery-supplement.js";
import { partitionPrivateRecoverySupplement, verifyWorkspaceRecoverySupplement } from "@starter/core";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { PrivateWorkspace } from "../models/PrivateData.js";
import { WorkspaceWriteFence } from "../models/TimesheetApproval.js";
import { clearTestDatabase, connectTestDatabase, dropTestDatabase, skipWithoutDatabase } from "./support/test-database.js";
const workspaceId = "workspace";
const db = () => mongoose.connection.db!;
describe("supplemental private recovery source", { skip: skipWithoutDatabase }, () => {
  before(() => connectTestDatabase("privacy-recovery-supplement", [WorkspaceMember, PrivateWorkspace, WorkspaceWriteFence] as never));
  beforeEach(async () => {
    await clearTestDatabase();
    await WorkspaceMember.create([{ workspaceId, userId: "owner", role: "owner", name: "Owner" }, { workspaceId, userId: "member", role: "member", name: "Member" }]);
    await db().collection<{ _id: string } & Record<string, unknown>>("organization").insertOne({ _id: workspaceId, name: "Original organization", slug: "original-name", metadata: { integer: Long.fromString("9007199254740993") } });
    for (const userId of ["owner", "member"]) {
      await db().collection("apitokens").insertOne({ workspaceId, userId, authorId: "another", name: `${userId} private token`, tokenHash: `${userId}-original-hash` });
      await db().collection("webhooksubscriptions").insertOne({ workspaceId, createdBy: userId, userId: "another", url: `https://${userId}.example.test/events`, secret: `${userId}-original-signing-secret` });
    }
    await db().collection("webhooksubscriptions").insertOne({ workspaceId: "other", createdBy: "member", secret: "Unrelated workspace secret" });
  });
  after(dropTestDatabase);
  it("returns exact shared organization originals and only the caller's private integration originals", async () => {
    const member = await workspaceRecoverySupplement(workspaceId, "member"), owner = await workspaceRecoverySupplement(workspaceId, "owner");
    assert.equal(member.collections.organization.length, 1);
    assert.deepEqual((member.collections.organization[0]!.metadata as Record<string, unknown>).integer, { $numberLong: "9007199254740993" });
    assert.equal(member.collections.apitokens.length, 1); assert.equal(member.collections.webhooksubscriptions.length, 1);
    assert.match(JSON.stringify(member), /member-original-signing-secret/); assert.doesNotMatch(JSON.stringify(member), /owner-original|owner private|Unrelated/);
    assert.doesNotMatch(JSON.stringify(owner), /member-original|member private|Unrelated/);
    await verifyWorkspaceRecoverySupplement(member);
    assert.deepEqual(partitionPrivateRecoverySupplement(member).filter((row) => row.kind === "integrations").map((row) => row.authorId), ["member", "member"]);
  });
  it("reserves complete-source capture for the internal owner engine and refuses non-members", async () => {
    const full = await capturePrivateMigrationSupplement(workspaceId, "owner");
    assert.equal(full.collections.apitokens.length, 2); assert.equal(full.collections.webhooksubscriptions.length, 2);
    await assert.rejects(capturePrivateMigrationSupplement(workspaceId, "member"), { code: "FORBIDDEN" });
    await assert.rejects(workspaceRecoverySupplement(workspaceId, "stranger"), { code: "NOT_FOUND" });
    assert.equal(await db().collection("webhooksubscriptions").countDocuments(), 3);
  });
  it("never backs up an empty plaintext source after conversion", async () => {
    await PrivateWorkspace.create({ workspaceId, ownerId: "owner", state: "encrypted", migrationId: crypto.randomUUID(), sourceRevision: "retired", leaseUntil: new Date(0) });
    await assert.rejects(workspaceRecoverySupplement(workspaceId, "owner"), { code: "PRECONDITION_FAILED" });
    await assert.rejects(workspaceRecoverySupplement(workspaceId, "member"), { code: "PRECONDITION_FAILED" });
    assert.equal(await db().collection("apitokens").countDocuments(), 2);
  });
  it("preserves unknown organization data for internal recovery but refuses ordinary publication without a defined audience", async () => {
    await db().collection("organization").updateOne({}, { $set: { unclassifiedSecret: "Original unknown private field" } });
    await assert.rejects(workspaceRecoverySupplement(workspaceId, "member"), /explicit private audience/);
    const full = await capturePrivateMigrationSupplement(workspaceId, "owner");
    assert.equal(full.collections.organization[0]!.unclassifiedSecret, "Original unknown private field");
  });

});
