import assert from "node:assert/strict";
import { it } from "node:test";
import { createKeyPair, createSigningPair } from "../privacy/crypto.js";
import { privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "../privacy/directory.js";
import { privateCatalogQuery, type PrivateCatalogQueryPath } from "../privacy/catalog-view.js";
import type { PlainPrivateRecord } from "../privacy/records.js";
const scope = { server: "https://api.example.test", workspaceId: "workspace", userId: "viewer" };
const stamp = "2026-10-26T00:00:00.000Z";
async function fixture(time = true, money = true, owner = false) {
  const pair = await createKeyPair(), signing = await createSigningPair();
  const member = { userId: "viewer", role: owner ? "owner" as const : "member" as const, canViewOthersTime: time, canViewOthersMoney: money, publicKey: pair.publicKey, signingPublicKey: signing.publicKey };
  const ownerMember = { ...member, userId: "owner", role: "owner" as const, canViewOthersTime: true, canViewOthersMoney: true };
  const members = owner ? [member] : [ownerMember, member];
  const signed = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId: scope.workspaceId, ownerId: owner ? "viewer" : "owner", revision: 1, previousDigest: null, members }, signing.privateKey, null, new Map(await Promise.all(members.map(async (person) => [person.userId, await privateMemberKeyFingerprint(scope.server, person)] as const))));
  const directory = await verifyPrivateWorkspaceDirectory(signed, scope, { ownerId: signed.directory.ownerId, signingPublicKey: signing.publicKey, revision: 0, digest: null });
  const records: PlainPrivateRecord[] = [];
  const add = (kind: PlainPrivateRecord["kind"], id: string, value: Record<string, unknown>, authorId: string | null = null) => { records.push({ kind, id, authorId, value: { _id: id, workspaceId: "workspace", ...value } }); };
  const base = (name: string, extras: Record<string, unknown> = {}) => ({ name, createdBy: "viewer", color: "#112233", archived: false, createdAt: { $date: { $numberLong: String(Date.parse(stamp)) } }, updatedAt: { $date: stamp }, ...extras });
  add("clients", "client", base("Studio", { archived: true })); add("clientMoney", "client", { billing: { legalName: "Original legal name", email: "private@example.test" } });
  add("clients", "other-client", base("Other studio")); add("clientMoney", "other-client", {});
  add("projects", "project", base("Design", { clientId: "client", billableDefault: true, estimatedHours: 4 }));
  add("projectMoney", "project", { hourlyRate: null, budgetAmount: 500, budgetCurrency: "EUR" });
  add("projects", "zero-rate", base("Free work", { clientId: null, billableDefault: true })); add("projectMoney", "zero-rate", { hourlyRate: 0 });
  add("tasks", "task", { ...base("Draft"), color: undefined, projectId: "legacy-project" });
  add("tags", "tag", base("Focused")); add("tags", "hidden", base("Automation", { hidden: true }));
  add("settings", "settings", { currency: "EUR", weekStartsOn: 1 }); add("settingsMoney", "settings", { defaultHourlyRate: 90 });
  add("members", "member", { userId: "viewer", name: "Viewer" }, "viewer"); add("memberMoney", "member", { hourlyRate: 0 }, "viewer");
  const entry = (id: string, author: string, duration: number, clientId: string | null | undefined, rate: number) => {
    add("entries", id, { authorId: author, projectId: "project", taskId: "task", ...(clientId === undefined ? {} : { clientId }), tagIds: ["tag", "hidden"], start: stamp, end: new Date(Date.parse(stamp) + duration * 1000).toISOString(), durationSec: { $numberInt: String(duration) }, billable: true, currency: "EUR" }, author);
    if (author === "viewer" || money || owner) add("entryMoney", id, { hourlyRate: { $numberDecimal: String(rate) } }, author);
  };
  entry("own", "viewer", 3600, undefined, 100);
  if (time || owner) entry("peer", "peer", 7200, "other-client", 50);
  let open = true;
  const read = (path: PrivateCatalogQueryPath, input: unknown = {}) => privateCatalogQuery({ path, input, scope, directory, records, current: () => open, now: Date.parse(stamp) + 10800000 }) as any;
  return { records, directory, read, add, lock: () => { open = false; } };
}
it("projects original BSON records to local catalog shapes, preserving client snapshots, zero rates and historical budget spend", async () => {
  const f = await fixture(), projects = f.read("projects.list"), project = projects.find((row: any) => row.id === "project");
  assert.equal(project.clientName, "Studio"); assert.equal(project.clientColor, "#112233"); assert.equal(project.createdAt, stamp);
  assert.equal(project.billableDefault, false); assert.equal(project.hourlyRate, null); assert.equal(project.entryCount, 2); assert.equal(project.totalSec, 10800);
  assert.equal(project.progress.spentAmount, 200); assert.equal(project.progress.trackedSec, 10800);
  assert.equal(projects.find((row: any) => row.id === "zero-rate").billableDefault, false);
  const clients = f.read("clients.list", { includeArchived: true });
  assert.equal(clients.find((row: any) => row.id === "client").totalSec, 3600); assert.equal(clients.find((row: any) => row.id === "other-client").totalSec, 7200);
  assert.equal(clients.find((row: any) => row.id === "client").billing.legalName, "Original legal name");
  const snapshot = f.records.find((row) => row.id === "own" && row.kind === "entries")!.value;
  snapshot.clientId = null;
  assert.equal(f.read("clients.list", { includeArchived: true }).find((row: any) => row.id === "client").totalSec, 0);
});
it("retains normal archived/hidden filters and produces metadata options without touching entries", async () => {
  const f = await fixture();
  assert.deepEqual(f.read("clients.options").map((row: any) => row.id), ["other-client"]);
  assert.deepEqual(f.read("tags.list").map((row: any) => row.id), ["tag"]);
  assert.equal(f.read("tags.list", { includeHidden: true }).length, 2);
  f.records.find((row) => row.kind === "entries")!.value.durationSec = "invalid";
  assert.equal(f.read("projects.options").length, 2); assert.equal(f.read("clients.options", { includeArchived: true }).length, 2); assert.equal(f.read("tasks.options").length, 1);
  assert.throws(() => f.read("projects.list"));
});
it("keeps colleague totals withheld unless both visibility flags are open, using the directory rather than API claims", async () => {
  for (const [time, money] of [[true, false], [false, true], [false, false]]) {
    const f = await fixture(time, money), project = f.read("projects.list").find((row: any) => row.id === "project");
    assert.equal(project.totalSec, 3600); assert.equal(project.entryCount, 1); assert.equal(project.progress, null); assert.equal(project.budgetAmount, 500);
    assert.equal(f.read("tasks.list")[0].totalSec, 3600); assert.equal(f.read("tags.list")[0].totalSec, 3600);
  }
  const owner = await fixture(false, false, true); assert.equal(owner.read("projects.list").find((row: any) => row.id === "project").totalSec, 10800);
});
it("preserves legacy task associations, ignores peer-only activity in restricted rollups, and keeps options free of statistics", async () => {
  const f = await fixture(), tasks = f.read("tasks.list"); assert.deepEqual(tasks[0].projectIds, ["legacy-project", "project"]); assert.equal(tasks[0].entryCount, 2); assert.equal(tasks[0].color.startsWith("#"), true);
  assert.deepEqual(f.read("tasks.projectLinks"), { task: ["legacy-project", "project"] });
  const options = f.read("tasks.options")[0]; assert.equal("legacyProjectId" in options, false); assert.equal("entryCount" in options, false); assert.equal("projectIds" in options, false);
  const project = f.read("projects.options")[0]; assert.equal("progress" in project, false); assert.equal("entryCount" in project, false);
});
it("counts tag occurrences like the stored unwind and derives running budgets against a captured clock", async () => {
  const f = await fixture();
  const own = f.records.find((row) => row.kind === "entries" && row.id === "own")!; own.value.tagIds = ["tag", "tag"]; own.value.end = null; own.value.durationSec = 0;
  const tags = f.read("tags.list"); assert.equal(tags[0].entryCount, 3); assert.equal(tags[0].totalSec, 7200);
  const project = f.read("projects.list").find((row: any) => row.id === "project"); assert.equal(project.totalSec, 7200); assert.equal(project.progress.trackedSec, 18000); assert.equal(project.progress.spentAmount, 400);
});
it("refuses partial money pairs, wrong record scope, duplicate IDs, ungranted time and stale sessions without changing the source", async () => {
  const f = await fixture(), before = structuredClone(f.records);
  f.records.splice(f.records.findIndex((row) => row.kind === "projectMoney" && row.id === "project"), 1);
  assert.throws(() => f.read("projects.options"), /financial record/); f.records.splice(0, f.records.length, ...structuredClone(before));
  f.records.find((row) => row.kind === "clients")!.value.workspaceId = "other"; assert.throws(() => f.read("clients.options"), /identity differs/);
  f.records.splice(0, f.records.length, ...structuredClone(before)); f.records.push(f.records[0]!); assert.throws(() => f.read("clients.options"), /Duplicate/);
  f.records.splice(0, f.records.length, ...structuredClone(before)); assert.throws(() => f.read("clients.options", { workspaceId: "other" }), /filter belongs/);
  assert.throws(() => f.read("projects.options", { unsupportedFilter: "secret" }));
  f.lock(); assert.throws(() => f.read("clients.options"), /changed/); assert.deepEqual(f.records, before);
  const restricted = await fixture(false, false); restricted.add("entries", "ungranted", { authorId: "peer", projectId: "project", taskId: null, durationSec: 0, start: stamp, end: null, billable: false, currency: "EUR" }, "peer");
  assert.throws(() => restricted.read("tags.list"), /ungranted time/);
});
