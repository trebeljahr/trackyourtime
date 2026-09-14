/**
 * Both membership records, kept in step.
 *
 * better-auth's `member` and the app's `WorkspaceMember` are separate writes.
 * The app authorizes from the mirror alone, so every lifecycle operation
 * orders its writes to make any crash in between the SAFE disagreement, and
 * every operation converges when simply run again. These tests fail the run at
 * each write in turn, check the intermediate state is safe, retry, and check
 * the end state is exactly the one an uninterrupted run produces.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  addMember,
  initialFlags,
  removeMembership,
  setRole,
  setVisibility,
  transferOwnership,
} from "../services/membership/lifecycle.js";
import { membersOf } from "../services/membership/records.js";
import {
  NOW,
  PEOPLE,
  recordsOf,
  seededStore,
} from "./support/membership-fixture.js";
import type { MemoryMembershipStore } from "./support/memory-membership-store.js";

let store: MemoryMembershipStore;

beforeEach(() => {
  store = seededStore();
});

const ownersIn = (s: MemoryMembershipStore, workspaceId: string): string[] =>
  s.rows.workspaceMembers
    .filter((r) => r.workspaceId === workspaceId && r.role === "owner")
    .map((r) => String(r.userId));

/**
 * Run `op` against a fresh store failing at write n, for every n until a run
 * completes; after each failure check `safe`, then retry and compare with a
 * clean run.
 */
async function convergesAtEveryWrite(
  op: (s: MemoryMembershipStore) => Promise<void>,
  safe: (s: MemoryMembershipStore, failedAt: number) => void,
): Promise<number> {
  const clean = seededStore();
  await op(clean);
  let failures = 0;
  for (let n = 1; n < 20; n += 1) {
    const s = seededStore();
    s.failOnWrite(n);
    try {
      await op(s);
      break;
    } catch (error) {
      assert.match(String(error), /simulated failure/);
      failures += 1;
    }
    safe(s, n);
    s.failOnWrite(null);
    await op(s);
    assert.deepEqual(
      { members: s.rows.workspaceMembers, auth: s.rows.authMembers },
      { members: clean.rows.workspaceMembers, auth: clean.rows.authMembers },
      `retry after a failure at write ${n} did not converge`,
    );
  }
  return failures;
}

describe("the role/flag rule", () => {
  it("owners open with both flags, everybody else closed — invited admins included", () => {
    assert.deepEqual(initialFlags("owner"), { canViewOthersTime: true, canViewOthersMoney: true });
    assert.deepEqual(initialFlags("admin"), { canViewOthersTime: false, canViewOthersMoney: false });
    assert.deepEqual(initialFlags("member"), { canViewOthersTime: false, canViewOthersMoney: false });
  });
});

describe("addMember", () => {
  const add = (s: MemoryMembershipStore): Promise<void> =>
    addMember(s, { workspaceId: "ws-a", userId: PEOPLE.newcomer.id, name: "Nina", role: "admin", now: NOW });

  it("writes member first and the mirror last, with closed flags", async () => {
    await add(store);
    const { mirror, member } = recordsOf(store, "newcomer", "ws-a");
    assert.equal(member?.role, "admin");
    assert.equal(mirror?.role, "admin");
    assert.equal(mirror?.canViewOthersTime, false);
    assert.equal(mirror?.canViewOthersMoney, false);
  });

  it("is idempotent and never changes an existing membership", async () => {
    await add(store);
    await add(store);
    await addMember(store, { workspaceId: "ws-a", userId: PEOPLE.olivia.id, name: "O", role: "member", now: NOW });
    assert.equal(store.rows.workspaceMembers.filter((r) => r.userId === PEOPLE.newcomer.id).length, 1);
    assert.equal(recordsOf(store, "olivia", "ws-a").mirror?.role, "owner");
  });

  it("a crash never grants access early, and a retry converges", async () => {
    const failures = await convergesAtEveryWrite(add, (s) => {
      // No mirror row means no access, whatever `member` says.
      assert.equal(recordsOf(s, "newcomer", "ws-a").mirror, undefined);
    });
    assert.equal(failures, 2);
  });
});

describe("removeMembership", () => {
  it("deletes the mirror FIRST, stops the running entry, then member — and keeps nothing else", async () => {
    const order: string[] = [];
    await removeMembership(store, {
      workspaceId: "ws-a",
      userId: PEOPLE.mia.id,
      stopRunningEntry: async (userId, workspaceId) => {
        // By the time the timer is stopped, access is already gone.
        assert.equal(recordsOf(store, "mia", "ws-a").mirror, undefined);
        order.push(`stop ${userId} ${workspaceId}`);
      },
    });
    assert.deepEqual(order, [`stop ${PEOPLE.mia.id} ws-a`]);
    assert.deepEqual(recordsOf(store, "mia", "ws-a"), { mirror: undefined, member: undefined });
    assert.ok(recordsOf(store, "olivia", "ws-a").mirror);
  });

  it("a crash at the first write leaves nothing changed; at any later one, access is already gone", async () => {
    const op = (s: MemoryMembershipStore): Promise<void> =>
      removeMembership(s, { workspaceId: "ws-a", userId: PEOPLE.mia.id, stopRunningEntry: async () => undefined });
    const failures = await convergesAtEveryWrite(op, (s, n) => {
      const { mirror } = recordsOf(s, "mia", "ws-a");
      if (n > 1) assert.equal(mirror, undefined, "mirror must be gone before member");
    });
    assert.equal(failures, 2);
  });
});

describe("setRole and setVisibility", () => {
  it("writes one exact role string to both records, flags untouched", async () => {
    await setRole(store, { workspaceId: "ws-a", userId: PEOPLE.mia.id, role: "admin" });
    const { mirror, member } = recordsOf(store, "mia", "ws-a");
    assert.equal(mirror?.role, "admin");
    assert.equal(member?.role, "admin");
    assert.equal(mirror?.canViewOthersMoney, false);
    await assert.rejects(() =>
      setRole(store, { workspaceId: "ws-a", userId: PEOPLE.mia.id, role: "admin,owner" as never }),
    );
    assert.equal(recordsOf(store, "mia", "ws-a").member?.role, "admin");
  });

  it("stepping an owner down keeps their current flags", async () => {
    await setRole(store, { workspaceId: "ws-a", userId: PEOPLE.olivia.id, role: "admin" });
    const { mirror } = recordsOf(store, "olivia", "ws-a");
    assert.equal(mirror?.canViewOthersTime, true);
    assert.equal(mirror?.canViewOthersMoney, true);
  });

  it("promotion to owner forces both flags on", async () => {
    await setRole(store, { workspaceId: "ws-a", userId: PEOPLE.mia.id, role: "owner" });
    const { mirror, member } = recordsOf(store, "mia", "ws-a");
    assert.equal(member?.role, "owner");
    assert.equal(mirror?.canViewOthersMoney, true);
  });

  it("an owner's flags cannot be closed", async () => {
    await setVisibility(store, { workspaceId: "ws-a", userId: PEOPLE.olivia.id, canViewOthersMoney: false });
    assert.equal(recordsOf(store, "olivia", "ws-a").mirror?.canViewOthersMoney, true);
    await setVisibility(store, { workspaceId: "ws-a", userId: PEOPLE.mia.id, canViewOthersTime: true });
    assert.equal(recordsOf(store, "mia", "ws-a").mirror?.canViewOthersTime, true);
    assert.equal(recordsOf(store, "mia", "ws-a").mirror?.canViewOthersMoney, false);
  });

  it("a role change converges after a crash at any write", async () => {
    await convergesAtEveryWrite(
      (s) => setRole(s, { workspaceId: "ws-a", userId: PEOPLE.adam.id, role: "member" }),
      () => undefined,
    );
  });
});

describe("transferOwnership", () => {
  const transfer = (s: MemoryMembershipStore): Promise<void> =>
    transferOwnership(s, { workspaceId: "ws-a", fromUserId: PEOPLE.olivia.id, toUserId: PEOPLE.mia.id });

  it("never leaves zero owners at any write, and the previous owner stays an owner until the last one", async () => {
    const failures = await convergesAtEveryWrite(transfer, (s) => {
      const owners = ownersIn(s, "ws-a");
      assert.ok(owners.length >= 1, "a crash left the workspace with no owner");
      // The person who retries is the previous owner, and the middleware
      // reads their role from the mirror: they must still be able to.
      assert.ok(owners.includes(PEOPLE.olivia.id), "the retrying owner lost the right to retry");
      // better-auth's record has an owner at every step too.
      assert.ok(
        s.rows.authMembers.some((r) => r.organizationId === "ws-a" && r.role === "owner"),
        "a crash left `member` with no owner",
      );
    });
    // The merged view account deletion reads agrees once it is done.
    const merged = await membersOf(store, "ws-a");
    assert.ok(merged.some((r) => r.role === "owner"));
    assert.equal(failures, 4);
  });

  it("ends with exactly one owner in both records", async () => {
    await transfer(store);
    assert.deepEqual(ownersIn(store, "ws-a"), [PEOPLE.mia.id]);
    const authOwners = store.rows.authMembers.filter((r) => r.organizationId === "ws-a" && r.role === "owner");
    assert.deepEqual(authOwners.map((r) => r.userId), [PEOPLE.mia.id]);
  });
});
