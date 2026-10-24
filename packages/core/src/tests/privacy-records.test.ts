import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createKeyPair, randomSecret, seal, sealForRecipient, encodeSecret } from "../privacy/crypto.js";
import { decryptPrivateRecord, encryptPrivateRecord, partitionPrivateRecovery, readersForPrivateRecord, privateRecordContext, type PrivateRecipient } from "../privacy/records.js";
import { canWritePrivateRecord, RECOVERY_KINDS, type PrivateKind, type WorkspaceRecovery } from "@starter/shared";
const pair = await createKeyPair();
const member = (userId: string, role: PrivateRecipient["role"], time: boolean, money: boolean): PrivateRecipient => ({ userId, role, canViewOthersTime: time, canViewOthersMoney: money, publicKey: pair.publicKey });
const members = [member("owner", "owner", false, false), member("author", "member", false, false), member("restricted-admin", "admin", false, false), member("time", "member", true, false), member("money", "member", false, true), member("both", "member", true, true), member("manager", "admin", true, true)];
const readers = (kind: PrivateKind) => readersForPrivateRecord(kind, "author", members).map((m) => m.userId).sort();
describe("private record boundaries", () => {
  it("keeps time, money, invoices and personal favorites within existing permissions", () => {
    assert.deepEqual(readers("entries"), ["author", "both", "manager", "owner", "time"]);
    assert.deepEqual(readers("entryMoney"), ["author", "both", "manager", "owner"]);
    assert.deepEqual(readers("memberMoney"), ["author", "both", "manager", "money", "owner"]);
    assert.deepEqual(readers("invoices"), ["manager", "owner"]);
    assert.deepEqual(readers("businessProfile"), ["both", "manager", "money", "owner", "restricted-admin"]);
    assert.deepEqual(readers("favorites"), ["author"]);
    assert.deepEqual(readers("projects"), members.map((m) => m.userId).sort());
  });
  it("authenticates workspace, record, author, revision and recipient", async () => {
    const plain = { id: "entry", kind: "entries" as const, authorId: "author", value: { description: "Sensitive client meeting" } };
    const record = await encryptPrivateRecord("workspace", plain, members, 7);
    assert.doesNotMatch(JSON.stringify(record), /Sensitive client meeting/);
    assert.deepEqual(await decryptPrivateRecord("workspace", record, "author", pair.privateKey), plain);
    await assert.rejects(decryptPrivateRecord("other", record, "author", pair.privateKey));
    await assert.rejects(decryptPrivateRecord("workspace", { ...record, revision: 8 }, "author", pair.privateKey));
    await assert.rejects(decryptPrivateRecord("workspace", { ...record, authorId: "owner" }, "author", pair.privateKey));
    await assert.rejects(decryptPrivateRecord("workspace", record, "restricted-admin", pair.privateKey));
  });
  it("preserves original BSON fields and splits amounts without losing budget or member data", () => {
    const collections = Object.fromEntries(RECOVERY_KINDS.map((k) => [k, []])) as unknown as WorkspaceRecovery["collections"];
    const original = { _id: { $oid: "00112233445566778899aabb" }, hourlyRate: { $numberInt: "100" }, budgetAmount: { $numberDouble: "8500" }, budgetCurrency: "EUR", estimatedHours: { $numberInt: "80" }, name: "Private project" };
    collections.projects.push(original);
    const membership = { _id: "member", userId: "author", name: "Member", role: "member", hourlyRate: 75, createdAt: { $date: { $numberLong: "1700000000000" } } };
    collections.workspacemembers.push(membership);
    const records = partitionPrivateRecovery({ v: 1, workspaceId: "workspace", createdAt: "now", sourceRevision: "hash", collections });
    const project = records.find((r) => r.kind === "projects")!, money = records.find((r) => r.kind === "projectMoney")!;
    assert.deepEqual({ ...project.value, ...money.value }, original);
    assert.equal(project.id, "00112233445566778899aabb");
    assert.equal(project.value.hourlyRate, undefined); assert.equal(project.value.budgetAmount, undefined);
    const details = records.find((r) => r.kind === "members")!, rate = records.find((r) => r.kind === "memberMoney")!;
    assert.deepEqual({ ...details.value, ...rate.value }, membership);
    assert.equal(details.value.hourlyRate, undefined);
    assert.deepEqual(rate.value, { _id: "member", hourlyRate: 75 });
  });
});

it("keeps invoice and member-rate write gates aligned with existing financial visibility", () => {
  const restricted = member("restricted-admin", "admin", false, false);
  assert.equal(canWritePrivateRecord("invoices", "author", restricted), false);
  assert.equal(canWritePrivateRecord("memberMoney", "author", restricted), false);
  assert.equal(canWritePrivateRecord("businessProfile", null, restricted), true);
  const moneyOnly = member("money-admin", "admin", false, true);
  assert.equal(canWritePrivateRecord("invoices", "author", moneyOnly), false);
  assert.equal(canWritePrivateRecord("memberMoney", "author", moneyOnly), true);
  assert.equal(canWritePrivateRecord("invoices", "author", member("manager", "admin", true, true)), true);
  assert.equal(canWritePrivateRecord("invoices", "owner", member("owner", "owner", false, false)), true);
});

it("binds decrypted payload identities to the signed routing metadata even for an authenticated ciphertext", async () => {
  const row = { id: "entry", kind: "entries" as const, authorId: "author", revision: 1 };
  const secret = randomSecret(), context = privateRecordContext("workspace", row);
  for (const value of [{ workspaceId: "other", authorId: "author" }, { workspaceId: "workspace", authorId: "impersonated" }, { workspaceId: "workspace", authorId: "author", _id: "wrong-record" }]) {
    const ciphertext = { ...row, box: await seal(secret, value, context), grants: [{ userId: "author", envelope: await sealForRecipient(pair.publicKey, encodeSecret(secret), `${context}:author`) }] };
    await assert.rejects(decryptPrivateRecord("workspace", ciphertext, "author", pair.privateKey), /Private payload/);
    await assert.rejects(encryptPrivateRecord("workspace", { ...row, value }, members, 1), /Private payload/);
  }
  secret.fill(0);
});

it("uses authoritative collection fields rather than unrelated legacy author metadata for recipient selection", async () => {
  const collections = Object.fromEntries(RECOVERY_KINDS.map((kind) => [kind, []])) as unknown as WorkspaceRecovery["collections"];
  const preference = { _id: "private-pin", workspaceId: "workspace", userId: "author", authorId: "owner", createdBy: "owner", description: "Only its actual user may read this" };
  collections.favorites.push(preference);
  collections.workspacemembers.push({ _id: "membership", workspaceId: "workspace", userId: "author", authorId: "owner" });
  collections.entryoperations.push({ _id: "receipt", workspaceId: "workspace", userId: "author", authorId: "owner" });
  collections.importbatches.push({ _id: "batch", workspaceId: "workspace", createdBy: "author", authorId: "owner", userId: "owner" });
  const records = partitionPrivateRecovery({ v: 1, workspaceId: "workspace", createdAt: "now", sourceRevision: "synthetic", collections });
  assert.ok(records.every((row) => row.authorId === "author"));
  const favorite = records.find((row) => row.kind === "favorites")!;
  const encrypted = await encryptPrivateRecord("workspace", favorite, members, 1);
  assert.deepEqual(encrypted.grants.map((grant) => grant.userId), ["author"]);
  assert.deepEqual((await decryptPrivateRecord("workspace", encrypted, "author", pair.privateKey)).value, preference);
  await assert.rejects(decryptPrivateRecord("workspace", encrypted, "owner", pair.privateKey), /cannot decrypt/);
  await assert.rejects(encryptPrivateRecord("workspace", { ...favorite, authorId: "owner" }, members, 1), /Private payload author/);
});

it("shares member details without disclosing rates to colleagues without money access", async () => {
  const collections = Object.fromEntries(RECOVERY_KINDS.map((kind) => [kind, []])) as unknown as WorkspaceRecovery["collections"];
  collections.workspacemembers.push({ _id: "membership", workspaceId: "workspace", userId: "author", name: "Private colleague name", legacyPrivateField: "Old restricted metadata", hourlyRate: { $numberDecimal: "123.4500" } });
  const records = partitionPrivateRecovery({ v: 1, workspaceId: "workspace", createdAt: "now", sourceRevision: "synthetic", collections });
  const details = await encryptPrivateRecord("workspace", records.find((row) => row.kind === "members")!, members, 1);
  const money = await encryptPrivateRecord("workspace", records.find((row) => row.kind === "memberMoney")!, members, 1);
  const read = await decryptPrivateRecord("workspace", details, "time", pair.privateKey);
  assert.equal(read.value.name, "Private colleague name"); assert.equal(read.value.hourlyRate, undefined);
  assert.doesNotMatch(JSON.stringify(read), /123\.4500|Old restricted metadata/);
  await assert.rejects(decryptPrivateRecord("workspace", money, "time", pair.privateKey), /cannot decrypt/);
  const rate = await decryptPrivateRecord("workspace", money, "author", pair.privateKey);
  assert.deepEqual(rate.value.hourlyRate, { $numberDecimal: "123.4500" });
  assert.equal(rate.value.legacyPrivateField, "Old restricted metadata");
  const original = records.find((row) => row.kind === "members")!;
  await assert.rejects(encryptPrivateRecord("workspace", { ...original, value: { ...original.value, hourlyRate: 100 } }, members, 1), /private or unknown fields/);
  await assert.rejects(encryptPrivateRecord("workspace", { ...original, value: { ...original.value, unknownNote: "Do not share this" } }, members, 1), /private or unknown fields/);
});
