// Migration 2 against a real MongoDB, with ids stored the way each writer
// stores them: better-auth's as ObjectIds, `WorkspaceMember`'s as strings.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { ObjectId, type Db } from "mongodb";
import { personalWorkspaces, SIGNUP_WINDOW_MS } from "../services/migrations/002-personal-workspaces.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  dropTestDatabase,
  skipWithoutDatabase,
} from "./support/test-database.js";

const database = (): Db => {
  const db = mongoose.connection.db;
  if (!db) throw new Error("not connected");
  return db;
};

const signup = new Date("2026-01-01T09:00:00.000Z");
const later = (ms: number): Date => new Date(signup.getTime() + ms);

type Seed = { name: string; createdAt: Date; kind?: string; members: Array<{ user: ObjectId; role: string }> };

async function seed(users: ObjectId[], orgs: Seed[]): Promise<Map<string, ObjectId>> {
  const db = database();
  await db.collection("user").insertMany(users.map((_id) => ({ _id, createdAt: signup })));
  const ids = new Map<string, ObjectId>();
  for (const org of orgs) {
    const _id = new ObjectId();
    ids.set(org.name, _id);
    await db.collection("organization").insertOne({
      _id,
      name: org.name,
      createdAt: org.createdAt,
      ...(org.kind ? { kind: org.kind } : {}),
    });
    for (const member of org.members) {
      await db.collection("member").insertOne({ organizationId: _id, userId: member.user, role: member.role });
      await db.collection("workspacemembers").insertOne({
        workspaceId: String(_id),
        userId: String(member.user),
        role: member.role,
      });
    }
  }
  return ids;
}

async function kinds(): Promise<Record<string, unknown>> {
  const rows = await database().collection("organization").find({}).toArray();
  return Object.fromEntries(rows.map((row) => [String(row.name), row.kind]));
}

describe("migration 2: personal workspaces", { skip: skipWithoutDatabase }, () => {
  before(() => connectTestDatabase("personal-workspaces"));
  after(() => dropTestDatabase());
  beforeEach(() => clearTestDatabase());

  it("marks the signup workspace personal and everything else team, idempotently", async () => {
    const [rico, ole, solo, shared] = [new ObjectId(), new ObjectId(), new ObjectId(), new ObjectId()];
    await seed([rico, ole, solo, shared], [
      // Rico: his signup workspace plus a team one he made later and is alone in.
      { name: "rico-signup", createdAt: later(150), members: [{ user: rico, role: "owner" }] },
      { name: "rico-later", createdAt: later(30 * SIGNUP_WINDOW_MS), members: [{ user: rico, role: "owner" }] },
      // Ole: his signup workspace, where Rico was later invited.
      { name: "ole-shared", createdAt: later(80), members: [{ user: ole, role: "owner" }, { user: rico, role: "member" }] },
      // Ole's personal one, repaired by the read path a day after signup.
      { name: "ole-repaired", createdAt: later(24 * 60 * 60 * 1000), members: [{ user: ole, role: "owner" }] },
      // Somebody whose only workspace is already marked.
      { name: "solo-marked", createdAt: later(10), kind: "personal", members: [{ user: solo, role: "owner" }] },
      // A shared signup workspace with no solo fallback: no personal one at all.
      {
        name: "shared-signup",
        createdAt: later(20),
        members: [{ user: shared, role: "owner" }, { user: ole, role: "admin" }],
      },
    ]);

    await personalWorkspaces.up(database());
    const expected = {
      "rico-signup": "personal",
      "rico-later": "team",
      "ole-shared": "team",
      "ole-repaired": "personal",
      "solo-marked": "personal",
      "shared-signup": "team",
    };
    assert.deepEqual(await kinds(), expected);

    // A second run (a boot that died before recording the first) changes nothing.
    await personalWorkspaces.up(database());
    assert.deepEqual(await kinds(), expected);
  });

  it("finishes a run cut off between the two passes", async () => {
    const [a, b] = [new ObjectId(), new ObjectId()];
    await seed([a, b], [
      { name: "a-signup", createdAt: later(5), kind: "personal", members: [{ user: a, role: "owner" }] },
      { name: "a-extra", createdAt: later(10 * SIGNUP_WINDOW_MS), members: [{ user: a, role: "owner" }] },
      { name: "b-signup", createdAt: later(5), members: [{ user: b, role: "owner" }] },
    ]);
    await personalWorkspaces.up(database());
    assert.deepEqual(await kinds(), { "a-signup": "personal", "a-extra": "team", "b-signup": "personal" });
  });

  it("never counts a half-added member's workspace as solo", async () => {
    const [owner, joining] = [new ObjectId(), new ObjectId()];
    const ids = await seed([owner, joining], [
      { name: "half-added", createdAt: later(5), members: [{ user: owner, role: "owner" }] },
    ]);
    // `member` written, mirror not yet: an accept a crash cut in half.
    await database().collection("member").insertOne({
      organizationId: ids.get("half-added"),
      userId: joining,
      role: "member",
    });
    await personalWorkspaces.up(database());
    assert.deepEqual(await kinds(), { "half-added": "team" });
  });
});
