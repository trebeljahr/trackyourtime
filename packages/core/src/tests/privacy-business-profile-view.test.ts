import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { emptyBusinessProfile, inspectBusinessLogoBytes, type WorkspaceRole } from "@starter/shared";
import { createKeyPair, createSigningPair } from "../privacy/crypto.js";
import { privateMemberKeyFingerprint, signPrivateWorkspaceDirectory, verifyPrivateWorkspaceDirectory } from "../privacy/directory.js";
import { privateBusinessProfileQuery, privateStoredBusinessLogo } from "../privacy/business-profile-view.js";
import type { PlainPrivateRecord } from "../privacy/records.js";
const scope = { server: "https://api.example.test", workspaceId: "workspace", userId: "viewer" }, stamp = "2026-10-27T00:00:00.000Z";
const png = readFileSync(new URL("../../../server/src/tests/fixtures/logo/rgba.png", import.meta.url));
const logo = () => { const header = inspectBusinessLogoBytes(png); assert.equal(header.ok, true); if (!header.ok) throw new Error(); return { ...header.logo, data: { $binary: { base64: png.toString("base64"), subType: "00" as const } }, sha256: createHash("sha256").update(png).digest("hex") }; };
async function fixture(role: WorkspaceRole = "owner", money = true) {
 const pair = await createKeyPair(), signing = await createSigningPair(), member = { userId: scope.userId, role, canViewOthersTime: false, canViewOthersMoney: money, publicKey: pair.publicKey, signingPublicKey: signing.publicKey };
 const members = role === "owner" ? [member] : [{ ...member, userId: "owner", role: "owner" as const, canViewOthersTime: true, canViewOthersMoney: true }, member];
 const ownerId = role === "owner" ? scope.userId : "owner";
 const signed = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId: scope.workspaceId, ownerId, revision: 1, previousDigest: null, members }, signing.privateKey, null, new Map(await Promise.all(members.map(async (person) => [person.userId, await privateMemberKeyFingerprint(scope.server, person)] as const))));
 const directory = await verifyPrivateWorkspaceDirectory(signed, scope, { ownerId, signingPublicKey: signing.publicKey, revision: 0, digest: null });
 const records: PlainPrivateRecord[] = [{ kind: "businessProfile", id: "profile", authorId: null, value: { _id: "profile", workspaceId: scope.workspaceId, legalName: " Studio ", addressLines: [" One street "], country: "DE", paymentDetails: "Bank details", smallBusiness: false, defaultTaxRate: 19, updatedAt: { $date: stamp }, logo: logo(), unknownLegacyField: "Do not expose" } }];
 let active = true;
 return { records, read: (input: unknown = {}) => privateBusinessProfileQuery({ scope, directory, records, current: () => active, input }), lock: () => { active = false; } };
}
it("reads original issuer fields and authenticated BSON logo bytes locally, without unknown fields", async () => {
 const f = await fixture(), original = structuredClone(f.records), row = await f.read(); assert.equal(row.legalName, "Studio"); assert.deepEqual(row.addressLines, ["One street"]); assert.equal(row.paymentDetails, "Bank details"); assert.equal(row.defaultTaxRate, 19); assert.equal(row.updatedAt, stamp); assert.equal(row.logo!.dataUrl, `data:image/png;base64,${png.toString("base64")}`); assert.equal("unknownLegacyField" in row, false); assert.deepEqual(f.records, original);
});
it("preserves the existing role and money-read matrix even for an empty profile", async () => {
 for (const role of ["owner", "admin", "member"] as const) for (const money of [false, true]) {
  const f = await fixture(role, money); f.records.splice(0);
  if (role === "member" && !money) await assert.rejects(f.read(), /cannot see/); else assert.deepEqual(await f.read(), emptyBusinessProfile(scope.workspaceId));
 }
});
it("handles logo-only profiles without timestamps and legacy profiles without a logo", async () => {
 const f = await fixture(); f.records[0]!.value = { _id: "profile", workspaceId: scope.workspaceId, logo: logo() }; const onlyLogo = await f.read(); assert.equal(onlyLogo.updatedAt, null); assert.equal(onlyLogo.legalName, null); assert.ok(onlyLogo.logo);
 delete f.records[0]!.value.logo; assert.deepEqual(await f.read(), emptyBusinessProfile(scope.workspaceId));
});
it("refuses changed hashes, false dimensions, wrong formats and noncanonical binary before rendering", async () => {
 await assert.rejects(privateStoredBusinessLogo({ ...logo(), sha256: "0".repeat(64) }), /saved hash/);
 await assert.rejects(privateStoredBusinessLogo({ ...logo(), width: logo().width + 1 }), /dimensions/);
 await assert.rejects(privateStoredBusinessLogo({ ...logo(), mime: "image/jpeg" }), /format/);
 await assert.rejects(privateStoredBusinessLogo({ ...logo(), data: { $binary: { base64: "AAAA ", subType: "00" } } }));
 await assert.rejects(privateStoredBusinessLogo({ ...logo(), data: { $binary: { base64: logo().data.$binary.base64, subType: "04" } } }));
});
it("refuses stale async logo reads, foreign scope, duplicate profiles and malformed issuer fields without changing originals", async () => {
 const f = await fixture(), original = structuredClone(f.records); await assert.rejects(f.read({ workspaceId: "other" }), /filter belongs/);
 f.records.push({ ...f.records[0]!, id: "duplicate", value: { _id: "duplicate", workspaceId: scope.workspaceId } }); await assert.rejects(f.read(), /ambiguous/); f.records.splice(0, f.records.length, ...structuredClone(original));
 f.records[0]!.value.paymentTermsDays = -1; await assert.rejects(f.read()); f.records.splice(0, f.records.length, ...structuredClone(original)); const pending = f.read(); f.lock(); await assert.rejects(pending, /changed/); assert.deepEqual(f.records, original);
});
it("uses portable header inspection for offset Uint8Array views without modifying bytes", () => {
 const backing = new Uint8Array(png.length + 10); backing.set(png, 5); const view = backing.subarray(5, 5 + png.length), before = view.slice(); assert.deepEqual(inspectBusinessLogoBytes(view), inspectBusinessLogoBytes(png)); assert.deepEqual(view, before);
});
