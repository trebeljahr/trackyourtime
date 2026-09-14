/**
 * Which workspace a request runs in.
 *
 * Two non-member cases answered differently, on purpose (auth/workspace.ts):
 * an EXPLICIT workspace id the caller is not in is NOT_FOUND with no fallback
 * — offline replay depends on a queued row never landing somewhere else — and
 * a STALE session default falls back to the oldest membership, so a device
 * whose session still points at a workspace the person left keeps working.
 *
 * Plus the guard that makes "explicit" reachable at all: every
 * workspace-scoped procedure must accept an object input carrying
 * `workspaceId`, because a first-party client sends one on every call.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import mongoose from "mongoose";
import type { WorkspaceMemberDocLike } from "../models/WorkspaceMember.js";
import {
  resolveWorkspace,
  workspaceIdFromInput,
  type WorkspaceLookups,
} from "../auth/workspace.js";
import { appRouter } from "../trpc/router.js";
import { workspaceProcedure } from "../trpc/trpc.js";
import {
  defaultWorkspaceId,
  listWorkspaces,
  setActiveWorkspace,
} from "../services/membership/workspaces.js";
import { PEOPLE, seededStore } from "./support/membership-fixture.js";

mongoose.set("bufferCommands", false);

const MIA = { id: PEOPLE.mia.id, name: "Mia", email: PEOPLE.mia.email };

const membership = (workspaceId: string, role: "owner" | "member" = "member"): WorkspaceMemberDocLike =>
  ({
    workspaceId,
    userId: MIA.id,
    role,
    name: "Mia",
    hourlyRate: null,
    canViewOthersTime: false,
    canViewOthersMoney: false,
  }) as unknown as WorkspaceMemberDocLike;

/** Mia is in ws-a (oldest) and ws-c. Not in ws-b. */
const lookups = (): WorkspaceLookups & { fallbacks: number } => {
  const state = {
    fallbacks: 0,
    membership: async (workspaceId: string, userId: string) =>
      userId === MIA.id && (workspaceId === "ws-a" || workspaceId === "ws-c")
        ? membership(workspaceId)
        : null,
    fallbackWorkspace: async () => {
      state.fallbacks += 1;
      return "ws-a";
    },
  };
  return state;
};

describe("resolveWorkspace", () => {
  it("an explicit workspace the caller is in wins over the session default", async () => {
    const resolved = await resolveWorkspace(
      { user: MIA, requested: "ws-c", activeWorkspaceId: "ws-a" },
      lookups(),
    );
    assert.equal(resolved?.workspaceId, "ws-c");
  });

  it("an explicit workspace the caller is NOT in is null (NOT_FOUND) — never a fallback", async () => {
    const l = lookups();
    const resolved = await resolveWorkspace(
      { user: MIA, requested: "ws-b", activeWorkspaceId: "ws-a" },
      l,
    );
    assert.equal(resolved, null);
    assert.equal(l.fallbacks, 0);
  });

  it("a stale session default falls back to the oldest membership", async () => {
    const l = lookups();
    const resolved = await resolveWorkspace(
      { user: MIA, requested: null, activeWorkspaceId: "ws-b" },
      l,
    );
    assert.equal(resolved?.workspaceId, "ws-a");
    assert.equal(l.fallbacks, 1);
  });

  it("a live session default is used as is", async () => {
    const resolved = await resolveWorkspace(
      { user: MIA, requested: null, activeWorkspaceId: "ws-c" },
      lookups(),
    );
    assert.equal(resolved?.workspaceId, "ws-c");
  });

  it("reads the id only off an object input", () => {
    assert.equal(workspaceIdFromInput({ workspaceId: "ws-a" }), "ws-a");
    assert.equal(workspaceIdFromInput({ workspaceId: "" }), null);
    assert.equal(workspaceIdFromInput("ws-a"), null);
    assert.equal(workspaceIdFromInput(undefined), null);
  });
});

describe("workspaces.list / setActive", () => {
  it("lists every membership with role, count, permissions and the default marked", async () => {
    const store = seededStore();
    // Adam is also in Zeta, joined later.
    store.rows.workspaceMembers.push({
      workspaceId: "ws-b", userId: PEOPLE.adam.id, role: "member",
      canViewOthersTime: false, canViewOthersMoney: false, createdAt: new Date(Date.UTC(2026, 5, 1)),
    });
    const stale = await listWorkspaces(store, { userId: PEOPLE.adam.id, activeWorkspaceId: "ws-gone" });
    assert.deepEqual(
      stale.map((w) => [w.id, w.name, w.role, w.memberCount, w.isDefault]),
      [
        ["ws-a", "Acme", "admin", 4, true],
        ["ws-b", "Zeta", "member", 3, false],
      ],
    );
    assert.equal(stale[0]?.permissions.inviteMembers, true);
    assert.equal(stale[1]?.permissions.inviteMembers, false);
    const active = await listWorkspaces(store, { userId: PEOPLE.adam.id, activeWorkspaceId: "ws-b" });
    assert.equal(active.find((w) => w.isDefault)?.id, "ws-b");
    assert.equal(defaultWorkspaceId([{ workspaceId: "a" }], "zzz"), "a");
  });

  it("setActive writes the session row for a member, NOT_FOUND for anybody else", async () => {
    const store = seededStore();
    await setActiveWorkspace(store, { userId: PEOPLE.mia.id, sessionId: "s-mia", workspaceId: "ws-a" });
    await assert.rejects(
      () => setActiveWorkspace(store, { userId: PEOPLE.mia.id, sessionId: "s-mia", workspaceId: "ws-b" }),
      (error: unknown) => (error as { code?: string }).code === "NOT_FOUND",
    );
    assert.equal(store.rows.authSessions.find((s) => s.id === "s-mia")?.activeOrganizationId, "ws-a");
    // Another person's session id is not writable either.
    await setActiveWorkspace(store, { userId: PEOPLE.mia.id, sessionId: "s-olivia", workspaceId: "ws-a" });
    assert.equal(store.rows.authSessions.find((s) => s.id === "s-olivia")?.activeOrganizationId, "ws-a");
    store.rows.authSessions.find((s) => s.id === "s-olivia")!.activeOrganizationId = "ws-x";
    await setActiveWorkspace(store, { userId: PEOPLE.mia.id, sessionId: "s-olivia", workspaceId: "ws-a" });
    assert.equal(store.rows.authSessions.find((s) => s.id === "s-olivia")?.activeOrganizationId, "ws-x");
  });
});

// ── Every workspaceProcedure accepts an explicit workspaceId ──────────────

type ProcedureDef = {
  _def: {
    middlewares: readonly unknown[];
    inputs: readonly unknown[];
    type: string;
  };
};

type Issue = { code?: string; path?: readonly PropertyKey[]; keys?: readonly string[] };
type SafeParser = { safeParse: (value: unknown) => { success: boolean; error?: { issues: Issue[] } } };

const procedures = (appRouter as unknown as { _def: { procedures: Record<string, ProcedureDef> } })._def
  .procedures;
const workspaceMiddleware = (workspaceProcedure as unknown as ProcedureDef)._def.middlewares.at(-1);

describe("workspace-scoped procedures and an explicit workspaceId", () => {
  const scoped = Object.entries(procedures).filter(([, p]) =>
    p._def.middlewares.includes(workspaceMiddleware),
  );

  it("finds the workspace-scoped procedures", () => {
    assert.ok(scoped.length > 40, `only ${scoped.length} found — did the walk break?`);
    const names = scoped.map(([name]) => name);
    for (const name of ["entries.current", "settings.get", "favorites.list", "apiTokens.list", "webhooks.list", "members.list"]) {
      assert.ok(names.includes(name), `${name} is not workspace-scoped`);
    }
    assert.equal(names.includes("workspaces.list"), false);
    assert.equal(names.includes("invitations.accept"), false);
  });

  it("each one declares an object input that does not reject a workspaceId key", () => {
    for (const [name, procedure] of scoped) {
      const { inputs } = procedure._def;
      assert.ok(
        inputs.length > 0,
        `${name} has no input, so a client cannot name a workspace — add .input(workspaceScopeSchema)`,
      );
      for (const parser of inputs) {
        assert.ok(
          typeof (parser as Partial<SafeParser>).safeParse === "function",
          `${name}: expected a zod input`,
        );
        const result = (parser as SafeParser).safeParse({ workspaceId: "ws-a" });
        if (result.success) continue;
        for (const issue of result.error?.issues ?? []) {
          assert.notEqual(
            issue.code,
            "unrecognized_keys",
            `${name} rejects workspaceId as an unknown key (.strict()?)`,
          );
          assert.ok(
            !(issue.code === "invalid_type" && (issue.path ?? []).length === 0),
            `${name} does not take an object input`,
          );
          assert.notDeepEqual(issue.path, ["workspaceId"], `${name} refuses a string workspaceId`);
        }
      }
    }
  });
});
