import assert from "node:assert/strict";
import test from "node:test";
import { resolveHourlyRate, projectBillableByDefault } from "@starter/shared/rates";
import { listMembers, updateMemberRate } from "../services/membership/members.js";
import { actor, memberId, membershipDepsFor, PEOPLE, recorder, recordsOf, seededStore } from "./support/membership-fixture.js";

test("rate precedence distinguishes null inheritance from deliberate zero", () => {
  const base = { billable: true, defaultRate: 60 };
  assert.equal(resolveHourlyRate({ ...base, projectRate: 120, memberRate: 90 }), 120);
  assert.equal(resolveHourlyRate({ ...base, projectRate: null, memberRate: 90 }), 90);
  assert.equal(resolveHourlyRate({ ...base, projectRate: null, memberRate: null }), 60);
  assert.equal(resolveHourlyRate({ ...base, projectRate: null, memberRate: 0 }), 0);
  assert.equal(resolveHourlyRate({ ...base, projectRate: 0, memberRate: 90 }), 0);
  assert.equal(resolveHourlyRate({ ...base, projectRate: null, memberRate: NaN }), 60);
  assert.equal(resolveHourlyRate({ ...base, billable: false, projectRate: 120, memberRate: 90 }), null);
  assert.equal(projectBillableByDefault({ billableDefault: true, hourlyRate: null }, 0, 90), true);
  assert.equal(projectBillableByDefault({ billableDefault: true, hourlyRate: null }, 60, 0), false);
});

test("member rate editor requires management plus money visibility and scopes targets first", async () => {
  const store = seededStore();
  const deps = membershipDepsFor(store, recorder());
  const input = { memberId: memberId("mia", "ws-a"), hourlyRate: 90 };
  await assert.rejects(updateMemberRate(deps, actor(store, "adam", "ws-a"), input), { message: "member-rate-permission-required" });
  await assert.rejects(updateMemberRate(deps, actor(store, "mia", "ws-a"), input), { message: "member-rate-permission-required" });
  await assert.rejects(updateMemberRate(deps, actor(store, "mia", "ws-a"), { ...input, memberId: memberId("ben", "ws-b") }), { code: "NOT_FOUND" });
  await store.updateMany("workspaceMembers", { workspaceId: "ws-a", userId: PEOPLE.adam.id }, { canViewOthersMoney: true });
  const saved = await updateMemberRate(deps, actor(store, "adam", "ws-a"), input);
  assert.equal(saved.hourlyRate, 90);
  assert.equal(recordsOf(store, "mia", "ws-a").mirror?.hourlyRate, 90);
  const zero = await updateMemberRate(deps, actor(store, "olivia", "ws-a"), { ...input, hourlyRate: 0 });
  assert.equal(zero.hourlyRate, 0);
  const inherited = await updateMemberRate(deps, actor(store, "olivia", "ws-a"), { ...input, hourlyRate: null });
  assert.equal(inherited.hourlyRate, null);
});

test("every member response redacts colleague rates but keeps own rates", async () => {
  const store = seededStore();
  const deps = membershipDepsFor(store, recorder());
  await updateMemberRate(deps, actor(store, "olivia", "ws-a"), { memberId: memberId("mia", "ws-a"), hourlyRate: 125 });
  const rows = await listMembers(deps, actor(store, "mia", "ws-a"));
  assert.equal(rows.find((row) => row.isSelf)?.hourlyRate, 125);
  assert.ok(rows.filter((row) => !row.isSelf).every((row) => !("hourlyRate" in row)));
  const ownerRows = await listMembers(deps, actor(store, "olivia", "ws-a"));
  assert.equal(ownerRows.find((row) => row.userId === PEOPLE.mia.id)?.hourlyRate, 125);
});

test("rate input accepts inheritance/zero but refuses negative and non-finite rates", async () => {
  const { updateMemberRateSchema } = await import("@starter/shared");
  const base = { memberId: "member" };
  assert.equal(updateMemberRateSchema.safeParse({ ...base, hourlyRate: null }).success, true);
  assert.equal(updateMemberRateSchema.safeParse({ ...base, hourlyRate: 0 }).success, true);
  for (const hourlyRate of [-1, Infinity, NaN, 1_000_001]) {
    assert.equal(updateMemberRateSchema.safeParse({ ...base, hourlyRate }).success, false);
  }
});
