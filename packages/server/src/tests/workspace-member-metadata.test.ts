import assert from "node:assert/strict";
import { it } from "node:test";
import { readWorkspaceMemberMetadata } from "../services/membership/display-metadata.js";
import { profileRouter } from "../trpc/routers/profile.js";
import type { Context } from "../trpc/context.js";
function fixture() {
  const calls: unknown[] = [], mirrors = [{ _id: "mirror-owner", userId: "owner", hourlyRate: 999 }, { _id: "mirror-peer", userId: "peer", name: "Encrypted mirror must not supply metadata", role: "owner" }];
  let allowed = true;
  const deps = {
    authorized: async (workspace: string, user: string) => { calls.push(["authorized", workspace, user]); return allowed; },
    mirrors: async (workspace: string) => { calls.push(["mirrors", workspace]); return mirrors; },
    authMembers: async (workspace: string, userIds: string[]) => { calls.push(["members", workspace, userIds]); return [{ id: "auth-owner", organizationId: "workspace", userId: "owner", role: "member" }]; },
    authUsers: async (userIds: string[]) => { calls.push(["users", userIds]); return [{ id: "owner", name: "New account name", email: "owner@example.test", passwordHash: "Never return", hourlyRate: 888 }]; },
  };
  return { deps, calls, mirrors, revoke: () => { allowed = false; } };
}
it("returns account names/email/ids only and binds every lookup to the authenticated workspace", async () => {
  const f = fixture(), result = await readWorkspaceMemberMetadata("owner", "workspace", f.deps);
  assert.deepEqual(result, { userId: "owner", workspaceId: "workspace", members: [{ userId: "owner", memberId: "auth-owner", name: "New account name", email: "owner@example.test" }, { userId: "peer", memberId: "mirror-peer", name: "", email: "" }] });
  assert.deepEqual(f.calls[0], ["authorized", "workspace", "owner"]);
  assert.deepEqual(f.calls.slice(1, 4), [["mirrors", "workspace"], ["members", "workspace", ["owner", "peer"]], ["users", ["owner", "peer"]]]);
  assert.doesNotMatch(JSON.stringify(result), /passwordHash|hourlyRate|role|Encrypted mirror/);
});
it("refuses missing membership before team reads and refuses unauthenticated route calls", async () => {
  const f = fixture(); f.revoke(); await assert.rejects(readWorkspaceMemberMetadata("owner", "workspace", f.deps), { code: "NOT_FOUND" }); assert.equal(f.calls.length, 1);
  await assert.rejects(profileRouter.createCaller({ user: null, session: null } as unknown as Context).workspaceMemberMetadata({ workspaceId: "workspace" }), { code: "UNAUTHORIZED" });
});
it("rejects duplicate, foreign and oversized metadata without a financial lookup or write path", async () => {
  const f = fixture(); f.mirrors.push(f.mirrors[0]!); await assert.rejects(readWorkspaceMemberMetadata("owner", "workspace", f.deps), /changed/);
  const foreign = fixture(); foreign.deps.authMembers = async () => [{ id: "auth-owner", organizationId: "other", userId: "owner", role: "member" }]; await assert.rejects(readWorkspaceMemberMetadata("owner", "workspace", foreign.deps), /ambiguous/);
  const large = fixture(); for (let i = 0; i < 200; i++) large.mirrors.push({ _id: `m-${i}`, userId: `u-${i}`, hourlyRate: 1 }); await assert.rejects(readWorkspaceMemberMetadata("owner", "workspace", large.deps), /limit/);
});

it("rechecks authorization after account lookup before returning team metadata", async () => {
 const f = fixture(); f.deps.authUsers = async () => { f.revoke(); return []; };
 await assert.rejects(readWorkspaceMemberMetadata("owner", "workspace", f.deps), { code: "NOT_FOUND" });
});
