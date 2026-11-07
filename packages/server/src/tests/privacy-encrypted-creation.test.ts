import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createKeyPair, createSigningPair, encodeSecret, prepareEncryptedWorkspace, randomSecret, seal } from "@starter/core";
import { PrivateAccount, PrivateDirectory, PrivateProjectionReader, PrivateProjectionRoot, PrivateSnapshotChunk, PrivateWorkspace } from "../models/PrivateData.js";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { WorkspaceWriteFence } from "../models/TimesheetApproval.js";
import { createEncryptedWorkspace, encryptedWorkspacesAllowed } from "../services/privacy/encrypted-creation.js";
import { privateProjectionSnapshotPage, privateProjectionSnapshotRoot } from "../services/privacy/projection-snapshots.js";
import { clearTestDatabase, connectTestDatabase, dropTestDatabase, skipWithoutDatabase } from "./support/test-database.js";

const server = "https://api.example.test";
const owner = { id: "owner", email: "owner@encrypted.test", name: "Owner" };

/** Stands in for createTeamWorkspace: the membership row is what the private checks read. */
const createWorkspace = async (user: { id: string }, input: { clientWorkspaceId: string }) => {
  await WorkspaceMember.create({ workspaceId: input.clientWorkspaceId, userId: user.id, role: "owner", name: "Owner", canViewOthersTime: true, canViewOthersMoney: true });
};

describe("allowlist for encrypted workspaces", () => {
  it("matches an email, a domain or a user id, and nothing by default", () => {
    assert.equal(encryptedWorkspacesAllowed(owner, []), false);
    assert.equal(encryptedWorkspacesAllowed(owner, ["owner@encrypted.test"]), true);
    assert.equal(encryptedWorkspacesAllowed(owner, ["@encrypted.test"]), true);
    assert.equal(encryptedWorkspacesAllowed({ id: "x", email: "a@other.test" }, ["@encrypted.test"]), false);
    assert.equal(encryptedWorkspacesAllowed({ id: "abc" }, ["id:abc"]), true);
  });
});

describe("creating an encrypted workspace", { skip: skipWithoutDatabase }, () => {
  let keys: Awaited<ReturnType<typeof keySet>>;
  async function keySet() {
    const pair = await createKeyPair(), signing = await createSigningPair();
    return { publicKey: pair.publicKey, signingPublicKey: signing.publicKey, secrets: { v: 1 as const, master: encodeSecret(randomSecret()), privateKey: pair.privateKey, signingPrivateKey: signing.privateKey } };
  }
  const prepared = (workspaceId: string, override: Partial<typeof keys> = {}) => prepareEncryptedWorkspace({ server, workspaceId, userId: owner.id, name: "Client work", createdAt: new Date().toISOString(), reportRangeTimeZone: "UTC", currency: "EUR", weekStartsOn: 1, current: () => true, ...keys, ...override });
  const input = (workspaceId: string, p: Awaited<ReturnType<typeof prepared>>) => ({ workspaceId, currency: "EUR", weekStartsOn: 1 as const, directory: p.signedDirectory, root: p.root, records: p.records });

  before(() => connectTestDatabase("private-encrypted-creation", [PrivateAccount, PrivateDirectory, PrivateWorkspace, PrivateProjectionRoot, PrivateProjectionReader, PrivateSnapshotChunk, WorkspaceMember, WorkspaceWriteFence] as never));
  beforeEach(async () => {
    await clearTestDatabase(); keys = await keySet();
    await PrivateAccount.create({ userId: owner.id, identity: { publicKey: keys.publicKey, signingPublicKey: keys.signingPublicKey, recovery: await seal(randomSecret(), {}, "synthetic"), passkeys: [] } });
  });
  after(dropTestDatabase);

  it("stores the owner-signed directory and projection, encrypted at revision 1, and serves the projection back", async () => {
    const workspaceId = crypto.randomUUID(), p = await prepared(workspaceId);
    const { root } = await createEncryptedWorkspace(owner, input(workspaceId, p), server, createWorkspace);
    const mode = await PrivateWorkspace.findOne({ workspaceId }).lean();
    assert.equal(mode?.state, "encrypted"); assert.equal(mode?.revision, 1); assert.equal(mode?.head, root); assert.equal(mode?.directoryDigest, p.directory.digest);
    assert.equal(p.snapshot.root, root);
    assert.deepEqual(await privateProjectionSnapshotRoot({ server, workspaceId, userId: owner.id }), p.root);
    const page = await privateProjectionSnapshotPage({ server, workspaceId, userId: owner.id, migrationId: p.root.manifest.migrationId }, "shared", 0);
    assert.equal(page.records.length, 5);
    // The name is ciphertext on the server.
    assert.doesNotMatch(JSON.stringify(await PrivateSnapshotChunk.find().lean()), /Client work/);
  });

  it("refuses an account off the allowlist, and changes nothing", async () => {
    const workspaceId = crypto.randomUUID(), p = await prepared(workspaceId);
    await assert.rejects(createEncryptedWorkspace({ id: owner.id, email: "owner@elsewhere.test" }, input(workspaceId, p), server, createWorkspace), { code: "NOT_IMPLEMENTED" });
    assert.equal(await PrivateWorkspace.countDocuments(), 0);
  });

  it("refuses a projection signed by other keys, and one carrying more than the name", async () => {
    const workspaceId = crypto.randomUUID(), forged = await prepared(workspaceId, await keySet());
    await assert.rejects(createEncryptedWorkspace(owner, input(workspaceId, forged), server, createWorkspace));
    assert.equal(await PrivateWorkspace.countDocuments(), 0);
    const other = crypto.randomUUID(), p = await prepared(other);
    await assert.rejects(createEncryptedWorkspace(owner, { ...input(other, p), records: [...p.records, { ...p.records[0]!, kind: "entries", id: "e1" }] }, server, createWorkspace), { code: "BAD_REQUEST" });
  });
});
