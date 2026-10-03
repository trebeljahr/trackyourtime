import assert from "node:assert/strict";
import { it, mock } from "node:test";
import { z } from "zod";
import { createRequestWorkspaceResolver, resolveWorkspace, type WorkspaceLookups } from "../auth/workspace.js";
import { WorkspaceMember, type WorkspaceMemberDocLike } from "../models/WorkspaceMember.js";
import type { Context } from "../trpc/context.js";
import { router, workspaceProcedure } from "../trpc/trpc.js";

const user = { id: "user", name: "User", email: "user@example.test" };
const member = (workspaceId: string, money = false): WorkspaceMemberDocLike => ({
  workspaceId, userId: user.id, role: "member", name: user.name,
  hourlyRate: null, canViewOthersTime: false, canViewOthersMoney: money,
  createdAt: new Date(), updatedAt: new Date(),
});
function fixture() {
  const rows = new Map([["a", member("a")], ["b", member("b", true)]]);
  const counts = { memberships: 0, fallbacks: 0 };
  const lookups: WorkspaceLookups = {
    membership: async (id) => {
      counts.memberships++;
      // Yield so concurrent operations must share the in-flight promise.
      await Promise.resolve();
      return rows.get(id) ?? null;
    },
    fallbackWorkspace: async () => { counts.fallbacks++; return rows.keys().next().value ?? null; },
  };
  const scope = { user, activeWorkspaceId: "gone" };
  return { rows, counts, lookups, scope,
    request: (type = "query") => createRequestWorkspaceResolver(scope, type, lookups) };
}

it("reduces five concurrent explicit resolutions from five membership queries to one", async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 5 }, () => resolveWorkspace({ ...f.scope, requested: "a" }, f.lookups)));
  assert.equal(f.counts.memberships, 5);
  f.counts.memberships = 0;
  const resolve = f.request();
  const results = await Promise.all(Array.from({ length: 5 }, () => resolve("a")));
  await resolve("a"); // Settled results are reused too.
  assert.equal(f.counts.memberships, 1);
  assert.ok(results.every((r) => r?.workspaceId === "a"));
});

it("deduplicates fallback work and keeps implicit scope distinct from denied explicit IDs", async () => {
  const f = fixture();
  const resolve = f.request();
  const results = await Promise.all([resolve(null), resolve(null), resolve(null), resolve("gone"), resolve("gone")]);
  assert.deepEqual(results.map((r) => r?.workspaceId ?? null), ["a", "a", "a", null, null]);
  assert.deepEqual(f.counts, { memberships: 3, fallbacks: 1 });
});

it("keeps mixed workspace visibility separate and returns NOT_FOUND through middleware", async () => {
  const f = fixture();
  const api = router({ read: workspaceProcedure.input(z.object({ workspaceId: z.string() })).query(({ ctx }) => ({
    id: ctx.workspaceId, money: ctx.visibility.canViewOthersMoney,
  })) });
  const caller = api.createCaller({
    user, session: { user }, activeWorkspaceId: "gone", resolveRequestWorkspace: f.request(),
  } as unknown as Context);
  const results = await Promise.all(["a", "b", "a", "b"].map((workspaceId) => caller.read({ workspaceId })));
  assert.deepEqual(results, [{ id: "a", money: false }, { id: "b", money: true }, { id: "a", money: false }, { id: "b", money: true }]);
  for (let i = 0; i < 2; i++) {
    await assert.rejects(caller.read({ workspaceId: "gone" }), { code: "NOT_FOUND" });
  }
  assert.equal(f.counts.memberships, 3);
  assert.equal(f.counts.fallbacks, 0);
});

it("a later request sees revoked membership, changed permissions and fallback membership", async () => {
  const f = fixture();
  const first = f.request();
  assert.equal((await first("a"))?.workspaceId, "a");
  assert.equal((await first("b"))?.visibility.canViewOthersMoney, true);
  f.rows.delete("a");
  f.rows.set("b", member("b", false));
  const later = f.request();
  assert.equal(await later("a"), null);
  assert.equal((await later("b"))?.visibility.canViewOthersMoney, false);
  assert.equal((await later(null))?.workspaceId, "b");
});

for (const type of ["mutation", "subscription", "unknown"]) {
  it(`${type} requests never retain membership or fallback decisions`, async () => {
    const f = fixture();
    const resolve = f.request(type);
    await Promise.all([resolve("a"), resolve("a")]);
    assert.equal(f.counts.memberships, 2);
    assert.equal((await resolve(null))?.workspaceId, "a");
    f.rows.delete("a");
    assert.equal(await resolve("a"), null);
    assert.equal((await resolve(null))?.workspaceId, "b");
    f.rows.set("b", member("b", false));
    assert.equal((await resolve("b"))?.visibility.canViewOthersMoney, false);
    assert.equal(f.counts.fallbacks, 2);
  });
}

it("lookup failures remain failures for all concurrent callers", async () => {
  const f = fixture();
  const error = new Error("database unavailable");
  f.lookups.membership = async () => { f.counts.memberships++; throw error; };
  const resolve = f.request();
  const results = await Promise.allSettled([resolve("a"), resolve("a")]);
  assert.ok(results.every((result) => result.status === "rejected" && result.reason === error));
  assert.equal(f.counts.memberships, 1);
});

it("mutation middleware rechecks after a membership-changing operation in the same context", async () => {
  const f = fixture();
  const findOne = mock.method(WorkspaceMember, "findOne", (filter: { workspaceId: string }) => ({
    lean: () => f.lookups.membership(filter.workspaceId, user.id),
  }));
  try {
    const api = router({
      change: workspaceProcedure.input(z.object({ workspaceId: z.string() })).mutation(({ ctx }) => {
        f.rows.delete(ctx.workspaceId);
      }),
    });
    const caller = api.createCaller({
      user, session: { user }, activeWorkspaceId: "gone",
      resolveRequestWorkspace: f.request("mutation"),
    } as unknown as Context);
    await caller.change({ workspaceId: "a" });
    await assert.rejects(caller.change({ workspaceId: "a" }), { code: "NOT_FOUND" });
    assert.equal(f.counts.memberships, 2);
  } finally {
    findOne.mock.restore();
  }
});
