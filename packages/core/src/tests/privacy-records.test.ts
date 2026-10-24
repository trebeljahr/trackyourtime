import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createKeyPair, randomSecret, seal, sealForRecipient, encodeSecret } from "../privacy/crypto.js";
import { decryptPrivateRecord, encryptPrivateRecord, partitionPrivateRecovery, readersForPrivateRecord, privateRecordContext, type PrivateRecipient } from "../privacy/records.js";
import { RECOVERY_KINDS, type PrivateKind, type WorkspaceRecovery } from "@starter/shared";
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
    assert.deepEqual(records.find((r) => r.kind === "memberMoney")?.value, membership);
  });
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
