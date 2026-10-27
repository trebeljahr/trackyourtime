import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { randomUUID, randomBytes } from "node:crypto";
import type { BetterAuthOptions } from "better-auth";
import type { SyncEvent } from "@starter/shared";
import type { WorkspaceCreationDeps } from "../services/membership/workspaces.js";

process.env.STORAGE_QUOTA_BYTES = "262144";
const { default: mongoose } = await import("mongoose");
const { betterAuth } = await import("better-auth");
const { mongodbAdapter } = await import("better-auth/adapters/mongodb");
const { organization } = await import("better-auth/plugins/organization");
const { organizationPluginOptions } = await import("../services/membership/organization-lockdown.js");
const { allModels } = await import("../models/registry.js");
const { TimeEntry } = await import("../models/TimeEntry.js");
const { WorkspaceMember } = await import("../models/WorkspaceMember.js");
const { WorkspaceSettingsModel } = await import("../models/Settings.js");
const { StorageUsage } = await import("../models/StorageUsage.js");
const { authMembershipStore, withWorkspaceCreationTransaction } = await import("../services/membership/stores.js");
const { createTeamWorkspace, MAX_OWNED_WORKSPACES } = await import("../services/membership/workspaces.js");
const { transactionSession } = await import("../services/business-transaction.js");
const { clearTestDatabase, connectTestDatabase, dropTestDatabase, skipWithoutDatabase, testDatabaseTransactions } = await import("./support/test-database.js");

const USER = "000000000000000000000001";
const EXISTING = "existing-workspace";
const person = { id: USER, name: "Owner", email: "owner@example.test" };
const input = { name: "New team", currency: "EUR", weekStartsOn: 1 as const };
const owner = (workspaceId: string) => ({ workspaceId, userId: USER, role: "owner" as const, name: "Owner" });
const entry = (n: number) => ({ workspaceId: EXISTING, authorId: USER, description: `Work ${n}`, start: new Date("2026-01-01T09:00:00Z"), end: new Date("2026-01-01T10:00:00Z"), durationSec: 3600 });
const isQuota = (error: unknown) => error instanceof Error && "code" in error && error.code === "PRECONDITION_FAILED" && error.message.startsWith("Storage limit reached");
let authOptions: BetterAuthOptions;
const published: Array<{ userId: string; event: SyncEvent }> = [];

const dependencies = (): WorkspaceCreationDeps => ({
  transaction: (userId, work) => withWorkspaceCreationTransaction(authOptions, userId, work),
  now: () => new Date("2026-01-01T00:00:00Z"),
  slugTail: () => randomBytes(4).toString("hex"),
  seedSettings: async (workspaceId, settings) => {
    await WorkspaceSettingsModel.updateOne({ workspaceId }, { $setOnInsert: { workspaceId, ...settings } }, { upsert: true });
  },
  publishUser: (userId, event) => {
    assert.equal(transactionSession(), undefined, "creation must publish after its transaction commits");
    published.push({ userId, event });
  },
});

async function counts(): Promise<Record<string, number>> {
  const db = mongoose.connection.db!;
  const result: Record<string, number> = {};
  for (const name of ["organization", "member", "workspacesettings", "workspacemembers", "storageusages", "storagefences"]) {
    result[name] = await db.collection(name).countDocuments();
  }
  return result;
}

describe("atomic workspace creation with storage limits", { skip: skipWithoutDatabase }, () => {
  before(async () => {
    await connectTestDatabase("workspace-creation-quota", allModels() as never);
    assert.equal(await testDatabaseTransactions(), true, "workspace creation tests require a replica set");
    const db = mongoose.connection.db!;
    await db.createCollection("organization");
    await db.createCollection("member");
    const auth = betterAuth({
      database: mongodbAdapter(db as Parameters<typeof mongodbAdapter>[0]),
      secret: "workspace-creation-test-secret-at-least-32-characters",
      baseURL: "https://workspace-creation.example.test",
      plugins: [organization(organizationPluginOptions)],
    });
    authOptions = (await auth.$context).options;
  });
  beforeEach(async () => {
    await clearTestDatabase();
    await WorkspaceMember.create(owner(EXISTING));
    published.length = 0;
  });
  after(dropTestDatabase);

  it("commits compatible auth rows, settings and owner membership before publication", async () => {
    const { workspaceId } = await createTeamWorkspace(dependencies(), person, input);
    const adapter = mongodbAdapter(mongoose.connection.db! as Parameters<typeof mongodbAdapter>[0])(authOptions);
    const authStore = authMembershipStore(adapter);
    const [org] = await authStore.find("authOrganizations", { id: workspaceId });
    const [member] = await authStore.find("authMembers", { organizationId: workspaceId, userId: USER });
    assert.equal(org?.kind, "team");
    assert.equal(org?.name, input.name);
    assert.equal(member?.userId, USER);
    assert.equal(member?.organizationId, workspaceId);
    assert.equal(member?.role, "owner");
    const rawMember = await mongoose.connection.db!.collection("member").findOne({});
    assert.equal(String(rawMember?.organizationId), workspaceId, "the official adapter keeps ObjectId references compatible");
    assert.equal(typeof rawMember?.organizationId.toHexString, "function");
    assert.equal((await WorkspaceMember.findOne({ workspaceId, userId: USER }).lean())?.role, "owner");
    assert.equal((await WorkspaceSettingsModel.findOne({ workspaceId }).lean())?.currency, "EUR");
    assert.equal((await StorageUsage.findById(workspaceId).lean())?.bytes, 8192);
    assert.deepEqual(published, [{ userId: USER, event: { kind: "membership.changed", workspaceId, reason: "joined" } }]);
  });

  it("preserves a client UUID through the official auth adapter and all business rows", async () => {
    const clientWorkspaceId = randomUUID(), result = await createTeamWorkspace(dependencies(), person, { ...input, clientWorkspaceId });
    assert.equal(result.workspaceId, clientWorkspaceId);
    const db = mongoose.connection.db!, adapter = mongodbAdapter(db as Parameters<typeof mongodbAdapter>[0])(authOptions), store = authMembershipStore(adapter);
    assert.equal((await store.find("authOrganizations", { id: clientWorkspaceId }))[0]?.name, input.name);
    assert.equal((await store.find("authMembers", { organizationId: clientWorkspaceId }))[0]?.userId, USER);
    assert.equal((await db.collection("organization").findOne({ _id: clientWorkspaceId as never }))?.name, input.name);
    assert.equal((await db.collection("member").findOne({}))?.organizationId, clientWorkspaceId);
    assert.equal((await WorkspaceMember.findOne({ workspaceId: clientWorkspaceId }).lean())?.role, "owner");
    assert.equal((await WorkspaceSettingsModel.findOne({ workspaceId: clientWorkspaceId }).lean())?.currency, "EUR");
    assert.equal((await StorageUsage.findById(clientWorkspaceId).lean())?.bytes, 8192);
    const before = await counts();
    await assert.rejects(createTeamWorkspace(dependencies(), person, { ...input, name: "Must not replace", clientWorkspaceId }), (error: unknown) => error instanceof Error && "code" in error && error.code === "CONFLICT");
    assert.deepEqual(await counts(), before);
    assert.equal((await store.find("authOrganizations", { id: clientWorkspaceId }))[0]?.name, input.name);
    assert.equal(published.length, 1);
  });

  it("leaves no auth, settings or accounting rows after repeated full-quota refusals", async () => {
    await TimeEntry.insertMany(Array.from({ length: 63 }, (_, n) => entry(n)));
    const before = await counts();
    for (let n = 0; n < 3; n++) {
      await assert.rejects(createTeamWorkspace(dependencies(), person, input), isQuota);
      assert.deepEqual(await counts(), before);
    }
    assert.equal((await StorageUsage.findById(EXISTING).lean())?.bytes, 262144);
    assert.deepEqual(published, []);
  });

  it("rolls back auth writes and seeded settings when a later creation step fails", async () => {
    const deps = dependencies();
    const seed = deps.seedSettings;
    deps.seedSettings = async (workspaceId, settings) => {
      await seed(workspaceId, settings);
      throw new Error("Simulated creation interruption");
    };
    const before = await counts();
    await assert.rejects(createTeamWorkspace(deps, person, input), /Simulated creation interruption/);
    assert.deepEqual(await counts(), before);
    assert.deepEqual(published, []);
  });

  it("serializes simultaneous creates against the last available storage", async () => {
    await TimeEntry.insertMany(Array.from({ length: 61 }, (_, n) => entry(n)));
    const results = await Promise.allSettled([
      createTeamWorkspace(dependencies(), person, input),
      createTeamWorkspace(dependencies(), person, input),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const failure = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    assert.ok(isQuota(failure.reason));
    assert.equal(await mongoose.connection.db!.collection("organization").countDocuments(), 1);
    assert.equal(await mongoose.connection.db!.collection("member").countDocuments(), 1);
    assert.equal(await WorkspaceSettingsModel.countDocuments(), 1);
    assert.equal(await WorkspaceMember.countDocuments(), 2);
    assert.equal((await StorageUsage.find().lean()).reduce((sum, row) => sum + row.bytes, 0), 262144);
    assert.equal(published.length, 1);
  });

  it("serializes simultaneous creates against the final workspace slot", async () => {
    await WorkspaceMember.insertMany(Array.from({ length: MAX_OWNED_WORKSPACES - 2 }, (_, n) => owner(`existing-${n}`)));
    const results = await Promise.allSettled([
      createTeamWorkspace(dependencies(), person, input),
      createTeamWorkspace(dependencies(), person, input),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const failure = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    assert.equal(failure.reason.message, "workspace-limit-reached");
    assert.equal(await WorkspaceMember.countDocuments({ userId: USER, role: "owner" }), MAX_OWNED_WORKSPACES);
    assert.equal(await mongoose.connection.db!.collection("organization").countDocuments(), 1);
    assert.equal(await mongoose.connection.db!.collection("member").countDocuments(), 1);
    assert.equal(await WorkspaceSettingsModel.countDocuments(), 1);
    assert.equal(published.length, 1);
  });
});
