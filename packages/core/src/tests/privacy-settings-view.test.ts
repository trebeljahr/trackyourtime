import assert from "node:assert/strict";
import { it } from "node:test";
import { normalizeDisplayPreferences } from "@starter/shared";
import { createKeyPair, createSigningPair } from "../privacy/crypto.js";
import { privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "../privacy/directory.js";
import { privateSettingsQuery } from "../privacy/settings-view.js";
import type { PlainPrivateRecord } from "../privacy/records.js";
const scope = { server: "https://api.example.test", workspaceId: "workspace", userId: "owner" };
async function fixture() {
 const pair = await createKeyPair(), signing = await createSigningPair(), person = { userId: scope.userId, role: "owner" as const, canViewOthersTime: true, canViewOthersMoney: true, publicKey: pair.publicKey, signingPublicKey: signing.publicKey };
 const signed = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId: scope.workspaceId, ownerId: scope.userId, revision: 1, previousDigest: null, members: [person] }, signing.privateKey, null, new Map([[scope.userId, await privateMemberKeyFingerprint(scope.server, person)]]));
 const directory = await verifyPrivateWorkspaceDirectory(signed, scope, { ownerId: scope.userId, signingPublicKey: signing.publicKey, revision: 0, digest: null });
 const records: PlainPrivateRecord[] = [], add = (kind: PlainPrivateRecord["kind"], id: string, value: Record<string, unknown>, authorId: string | null = null) => records.push({ kind, id, authorId, value: { _id: id, workspaceId: scope.workspaceId, ...value } });
 add("members", "member", { userId: scope.userId }, scope.userId); add("memberMoney", "member", { hourlyRate: 0 }, scope.userId); add("settings", "settings", { currency: "AUD", weekStartsOn: 0 }); add("settingsMoney", "settings", { defaultHourlyRate: { $numberDecimal: "123.5" } });
 let active = true;
 return { records, read: (preferences: unknown = normalizeDisplayPreferences(scope.userId), input: unknown = {}) => privateSettingsQuery({ scope, directory, records, current: () => active, input, preferences }), lock: () => { active = false; } };
}
it("joins encrypted workspace facts and the caller's exact zero rate with independent display preferences", async () => {
 const f = await fixture(), preferences = normalizeDisplayPreferences(scope.userId, { timeFormat: "12h", theme: "dark", locale: "de", idle: { enabled: true }, maxDuration: { maxHours: 0, emailReminder: true } });
 const result = f.read(preferences); assert.equal(result.currency, "AUD"); assert.equal(result.weekStartsOn, 0); assert.equal(result.defaultHourlyRate, 123.5); assert.equal(result.memberHourlyRate, 0); assert.equal(result.timeFormat, "12h"); assert.equal(result.idle.enabled, true); assert.equal(result.maxDuration.maxHours, 0); assert.equal(result.maxDuration.emailReminder, true);
 assert.throws(() => f.read({ ...preferences, defaultHourlyRate: 999, currency: "USD" }));
});
it("preserves legacy personal preference defaults without enabling reminder emails or mutating input", () => {
 const source = { theme: null, locale: null, idle: { enabled: false, thresholdMinutes: 1 }, maxDuration: { maxHours: 0, emailReminder: false } }, original = structuredClone(source), preferences = normalizeDisplayPreferences("owner", source);
 assert.equal(preferences.theme, "system"); assert.equal(preferences.locale, "system"); assert.equal(preferences.idle.thresholdMinutes, 1); assert.equal(preferences.maxDuration.maxHours, 0); assert.equal(preferences.maxDuration.emailReminder, false); assert.deepEqual(source, original);
 assert.equal(normalizeDisplayPreferences("owner").maxDuration.emailReminder, false);
});
it("uses workspace defaults only for an absent settings row and refuses ambiguous or missing membership/financial state", async () => {
 const f = await fixture(); f.records.splice(0, f.records.length, ...f.records.filter((row) => !["settings", "settingsMoney"].includes(row.kind))); assert.equal(f.read().currency, "EUR"); assert.equal(f.read().defaultHourlyRate, 0);
 f.records.splice(f.records.findIndex((row) => row.kind === "memberMoney"), 1); assert.throws(() => f.read(), /financial record/);
 const duplicate = await fixture(); duplicate.records.push({ kind: "settings", id: "second", authorId: null, value: { _id: "second", workspaceId: scope.workspaceId } }); assert.throws(() => duplicate.read(), /ambiguous/);
});
it("rejects foreign account preferences, foreign workspace input, forged members and stale reads without changing data", async () => {
 const f = await fixture(), original = structuredClone(f.records); assert.throws(() => f.read(normalizeDisplayPreferences("other")), /another account/); assert.throws(() => f.read(undefined, { workspaceId: "other" }), /filter belongs/);
 f.records.find((row) => row.kind === "members")!.value.userId = "peer"; assert.throws(() => f.read(), /original member/); f.records.splice(0, f.records.length, ...original); f.lock(); assert.throws(() => f.read(), /changed/); assert.deepEqual(f.records, original);
});
