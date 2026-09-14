/**
 * A personal workspace can be created again for somebody who already had one.
 *
 * Slugs are global and never freed. A person who hands their personal
 * workspace to a colleague and leaves it is in no workspace at all, and the
 * fallback (`ensurePersonalWorkspace`) creates a new one — with the same
 * deterministic slug, which better-auth refuses. Without a retry that refusal
 * was `null`, `members.leave` answered NOT_FOUND after the person had already
 * left, and every workspace-scoped request after it did the same, forever.
 *
 * Runs the real organization plugin on the in-memory adapter; only the
 * mongoose mirror is stubbed, as in admin-cli.test.ts.
 */
import { after, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { organization } from "better-auth/plugins/organization";

import { WorkspaceMember } from "../models/WorkspaceMember.js";
import {
  createPersonalWorkspace,
  personalWorkspaceSlug,
} from "../auth/personal-workspace.js";

type Row = Record<string, unknown> & { id: string };

let db: Record<"user" | "session" | "account" | "verification" | "organization" | "member" | "invitation", Row[]>;
let mirrored: string[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let auth: any;

mock.method(WorkspaceMember, "updateOne", async (filter: { workspaceId: string }) => {
  mirrored.push(filter.workspaceId);
  return { acknowledged: true };
});
after(() => mock.restoreAll());

beforeEach(() => {
  db = { user: [], session: [], account: [], verification: [], organization: [], member: [], invitation: [] };
  mirrored = [];
  auth = betterAuth({
    database: memoryAdapter(db as never),
    secret: "personal-workspace-slug-secret-0123456789abcdef",
    baseURL: "http://localhost:3000",
    logger: { disabled: true },
    emailAndPassword: { enabled: true },
    plugins: [organization({ creatorRole: "owner" })],
  });
});

describe("createPersonalWorkspace", () => {
  it("creates a second personal workspace when the first one's slug is still taken", async () => {
    const context = await auth.$context;
    const user = await context.internalAdapter.createUser({
      email: "olivia@example.com",
      name: "Olivia",
      emailVerified: true,
    });
    const owner = { id: String(user.id), email: "olivia@example.com", name: "Olivia" };

    const first = await createPersonalWorkspace(auth.api, owner);
    assert.ok(first);
    assert.equal(db.organization[0]?.slug, personalWorkspaceSlug(owner));

    // She handed it over and left: no membership left, the slug still in use.
    db.member = db.member.filter((row) => row.userId !== owner.id);

    const second = await createPersonalWorkspace(auth.api, owner);
    assert.ok(second, "a taken slug must not leave the person without a workspace");
    assert.notEqual(second, first);
    assert.equal(db.organization.length, 2);
    const slugs = db.organization.map((row) => row.slug);
    assert.equal(new Set(slugs).size, 2);
    assert.ok(String(slugs[1]).startsWith(personalWorkspaceSlug(owner).slice(0, 20)));
    assert.ok(String(slugs[1]).length <= 48);
    assert.deepEqual(mirrored, [first, second]);
    assert.equal(
      db.member.find((row) => row.organizationId === second)?.role,
      "owner",
    );
  });
});
