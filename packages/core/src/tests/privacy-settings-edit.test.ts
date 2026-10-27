import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { normalizeDisplayPreferences, type WorkspaceRole } from "@starter/shared";
import { createKeyPair, createSigningPair } from "../privacy/crypto.js";
import { privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "../privacy/directory.js";
import { privateSettingsEdit } from "../privacy/settings-edit.js";
import { privateBusinessProfileEdit, type PrivateBusinessProfileEditPath } from "../privacy/business-profile-edit.js";
import type { PlainPrivateRecord } from "../privacy/records.js";
const scope = { server: "https://api.example.test", workspaceId: "workspace", userId: "viewer" }, stamp = "2026-10-28T00:00:00.000Z";
const png = readFileSync(new URL("../../../server/src/tests/fixtures/logo/rgba.png", import.meta.url)), upload = { mime: "image/png", base64: png.toString("base64") };
async function fixture(role: WorkspaceRole = "owner") {
  const pair = await createKeyPair(), signing = await createSigningPair(), actor = { userId: scope.userId, role, canViewOthersTime: true, canViewOthersMoney: true, publicKey: pair.publicKey, signingPublicKey: signing.publicKey };
  const owner = role === "owner" ? actor : { ...actor, userId: "owner", role: "owner" as const }, members = role === "owner" ? [actor] : [owner, actor];
  const signed = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId: scope.workspaceId, ownerId: owner.userId, revision: 1, previousDigest: null, members }, signing.privateKey, null, new Map(await Promise.all(members.map(async person => [person.userId, await privateMemberKeyFingerprint(scope.server, person)] as const))));
  const directory = await verifyPrivateWorkspaceDirectory(signed, scope, { ownerId: owner.userId, signingPublicKey: signing.publicKey, revision: 0, digest: null });
  const records: PlainPrivateRecord[] = [], add = (kind: PlainPrivateRecord["kind"], id: string, fields: Record<string, unknown>, authorId: string | null = null) => { const row = { kind, id, authorId, value: { _id: id, workspaceId: scope.workspaceId, ...fields } }; records.push(row); return row; };
  add("settings", "settings", { currency: "AUD", weekStartsOn: 0, legacy: "keep" }); add("settingsMoney", "settings", { defaultHourlyRate: 90, legacyMoney: "keep" });
  add("members", "member", { userId: scope.userId }, scope.userId); add("memberMoney", "member", { hourlyRate: 0 }, scope.userId);
  let active = true;
  const options = () => ({ scope, directory, records, current: () => active, now: Date.parse(stamp) });
  const apply = <T extends { records: PlainPrivateRecord[] }>(plan: T): T => { const ids = new Set(plan.records.map(r => `${r.kind}:${r.id}`)); records.splice(0, records.length, ...records.filter(r => !ids.has(`${r.kind}:${r.id}`)), ...plan.records); return plan; };
  const settings = (input: unknown, preferences = normalizeDisplayPreferences(scope.userId), newId?: () => string) => privateSettingsEdit({ ...options(), input, preferences, newId });
  const profile = (path: PrivateBusinessProfileEditPath, input: unknown) => privateBusinessProfileEdit({ ...options(), path, input });
  return { records, add, settings, profile, apply, lock: () => { active = false; } };
}
it("edits shared calendar and money facts atomically, retaining personal zero rates and original unknown fields", async () => {
  const f = await fixture(), before = structuredClone(f.records), first = f.settings({ currency: "USD", weekStartsOn: 1 }); assert.equal(first.records.length, 1); assert.deepEqual(f.records, before);
  f.apply(first); const money = f.settings({ defaultHourlyRate: 0 }); f.apply(money);
  assert.equal(money.result.currency, "USD"); assert.equal(money.result.defaultHourlyRate, 0); assert.equal(money.result.memberHourlyRate, 0);
  assert.equal(f.records.find(r => r.kind === "settings")!.value.legacy, "keep"); assert.equal(f.records.find(r => r.kind === "settingsMoney")!.value.legacyMoney, "keep");
  assert.deepEqual(f.settings({}).records, []);
});
it("creates absent workspace settings with defaults and rejects orphan identity collisions", async () => {
  const f = await fixture(); f.records.splice(0, 2); const plan = f.settings({ currency: "NZD" }); assert.equal(plan.records.length, 2); assert.equal(plan.result.defaultHourlyRate, 0); assert.equal(plan.result.weekStartsOn, 1); assert.equal(plan.result.currency, "NZD");
  const identity = crypto.randomUUID(); f.add("settingsMoney", identity, { defaultHourlyRate: 50 }); assert.throws(() => f.settings({ currency: "USD" }, undefined, () => identity), /already exists/);
});
it("refuses member, mixed personal/workspace patches, foreign scopes and malformed originals before changing state", async () => {
  const member = await fixture("member"); assert.throws(() => member.settings({ currency: "USD" }), /owner or admin/);
  const admin = await fixture("admin"); assert.equal(admin.settings({ defaultHourlyRate: 1 }).result.defaultHourlyRate, 1);
  const f = await fixture(), before = structuredClone(f.records);
  for (const input of [{ currency: "USD", theme: "dark" }, { locale: "de" }, { hourlyRate: 10 }, { currency: "usd" }, { defaultHourlyRate: -1 }, { workspaceId: "foreign", currency: "USD" }]) assert.throws(() => f.settings(input));
  assert.throws(() => f.settings({ currency: "USD" }, normalizeDisplayPreferences("other"))); assert.deepEqual(f.records, before);
  f.records[0]!.authorId = scope.userId; f.records[1]!.authorId = scope.userId; assert.throws(() => f.settings({ currency: "USD" }), /unexpected author/);
});
it("merges issuer fields with explicit clears while preserving omitted originals and rejecting merged tax conflicts", async () => {
  const f = await fixture(); f.add("businessProfile", "profile", { legalName: "Original", paymentDetails: "Keep bank", unknownLegacy: { keep: true }, defaultTaxCategory: "S", defaultTaxRate: 19 });
  const before = structuredClone(f.records), plan = await f.profile("settings.updateBusinessProfile", { legalName: " Renamed ", paymentTermsDays: 0 }); assert.deepEqual(f.records, before); f.apply(plan);
  assert.equal(plan.result.legalName, "Renamed"); assert.equal(plan.result.paymentDetails, "Keep bank"); assert.equal(plan.result.paymentTermsDays, 0); assert.equal(plan.result.updatedAt, stamp); assert.deepEqual(plan.records[0]!.value.unknownLegacy, { keep: true });
  f.apply(await f.profile("settings.updateBusinessProfile", { paymentDetails: null })); assert.equal((await f.profile("settings.updateBusinessProfile", {})).result.paymentDetails, null);
  await assert.rejects(f.profile("settings.updateBusinessProfile", { smallBusiness: true }));
});
it("stores inspected canonical logo bytes with hashes without changing identity timestamps, and clears idempotently", async () => {
  const f = await fixture(); assert.deepEqual((await f.profile("settings.clearBusinessLogo", {})).records, []);
  const first = f.apply(await f.profile("settings.setBusinessLogo", upload)); assert.equal(first.result.updatedAt, null); assert.equal(first.result.logo!.dataUrl, `data:image/png;base64,${upload.base64}`);
  assert.equal(first.records[0]!.value.createdAt, undefined); assert.match((first.records[0]!.value.logo as { sha256: string }).sha256, /^[a-f0-9]{64}$/);
  const identity = f.apply(await f.profile("settings.updateBusinessProfile", { legalName: "Private issuer" })); const savedAt = identity.result.updatedAt;
  const replacement = f.apply(await f.profile("settings.setBusinessLogo", upload)); assert.equal(replacement.result.updatedAt, savedAt); assert.equal(replacement.result.legalName, "Private issuer");
  const cleared = f.apply(await f.profile("settings.clearBusinessLogo", {})); assert.equal(cleared.result.updatedAt, savedAt); assert.equal(cleared.result.logo, null); assert.deepEqual((await f.profile("settings.clearBusinessLogo", {})).records, []);
});
it("rejects forged or stale profile/logo writes without publishing data", async () => {
  const member = await fixture("member"); await assert.rejects(member.profile("settings.updateBusinessProfile", { legalName: "Forbidden" }), /owner or admin/);
  const f = await fixture(), before = structuredClone(f.records);
  for (const input of [{ ...upload, mime: "image/jpeg" }, { ...upload, base64: "AAAA" }, { ...upload, base64: `${upload.base64} ` }, { ...upload, workspaceId: "other" }, { ...upload, legalName: "Smuggled" }]) await assert.rejects(f.profile("settings.setBusinessLogo", input));
  await assert.rejects(f.profile("settings.updateBusinessProfile", { logo: "Smuggled" })); assert.deepEqual(f.records, before);
  const pending = f.profile("settings.setBusinessLogo", upload); f.lock(); await assert.rejects(pending, /changed/); assert.deepEqual(f.records, before);
});
