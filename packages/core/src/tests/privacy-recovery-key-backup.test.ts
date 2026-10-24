import assert from "node:assert/strict";
import { test } from "node:test";
import { decryptRecoveryKeyBackup, deriveRecoveryBackupKey, encryptRecoveryKeyBackup, verifyRecoveryKeyBackup } from "../privacy/recovery-backup.js";
import { emptyRecoveryCollections, recoveryDigest } from "../privacy/recovery.js";
import { encodeSecret, randomSecret } from "../privacy/crypto.js";
const scope = { server: "https://api.example.test", userId: "owner" }, expected = { server: scope.server, ownerId: scope.userId, workspaceId: "workspace" };
async function fixture() {
  const collections = emptyRecoveryCollections();
  collections.timeentries.push({ _id: { $oid: "0123456789abcdef01234567" }, workspaceId: "workspace", description: "Private archive work", amount: { $numberLong: "9223372036854775800" }, total: { $numberDecimal: "12.3400" } });
  const archive = { format: "trackyourtime-workspace-recovery-v1" as const, server: scope.server, ownerId: scope.userId, snapshot: { v: 1 as const, workspaceId: "workspace", createdAt: "2026-10-24T00:00:00.000Z", sourceRevision: await recoveryDigest(collections), collections } };
  const recovery = encodeSecret(randomSecret()), key = await deriveRecoveryBackupKey(recovery, scope);
  return { archive, recovery, key };
}
test("recovery-key backups reopen offline with exact IDs and typed values, without account envelopes", async () => {
  const f = await fixture(), before = new Uint8Array(f.key);
  const file = await encryptRecoveryKeyBackup(f.archive, f.key, () => true);
  assert.deepEqual(await decryptRecoveryKeyBackup(JSON.parse(JSON.stringify(file)), f.recovery), f.archive);
  assert.deepEqual(await verifyRecoveryKeyBackup(file, f.key, expected), f.archive);
  assert.deepEqual(f.key, before);
  assert.deepEqual(Object.keys(file).sort(), ["box", "header"]);
  assert.doesNotMatch(JSON.stringify(file), /Private archive work|numberLong|numberDecimal/);
});
test("authenticates every routing field, rejects ciphertext changes and uses purpose-separated keys", async () => {
  const f = await fixture(), file = await encryptRecoveryKeyBackup(f.archive, f.key, () => true);
  for (const header of [ { ...file.header, server: "https://other.example.test" }, { ...file.header, userId: "other" }, { ...file.header, workspaceId: "other" }, { ...file.header, createdAt: "2026-10-25T00:00:00.000Z" } ]) await assert.rejects(decryptRecoveryKeyBackup({ ...file, header }, f.recovery));
  const changed = structuredClone(file); changed.box.data = (changed.box.data[0] === "A" ? "B" : "A") + changed.box.data.slice(1);
  await assert.rejects(decryptRecoveryKeyBackup(changed, f.recovery));
  await assert.rejects(decryptRecoveryKeyBackup(file, encodeSecret(randomSecret())));
  await assert.rejects(verifyRecoveryKeyBackup(file, await deriveRecoveryBackupKey(f.recovery, { ...scope, userId: "other" }), expected));
  await assert.rejects(decryptRecoveryKeyBackup(file, f.recovery, { ...expected, workspaceId: "other" }));
});
test("rejects malformed files, unsupported versions, invalid source digests and short recovery secrets", async () => {
  const f = await fixture(), file = await encryptRecoveryKeyBackup(f.archive, f.key, () => true);
  await assert.rejects(deriveRecoveryBackupKey("password-is-not-a-recovery-key", scope));
  await assert.rejects(deriveRecoveryBackupKey(f.recovery, { ...scope, server: "https://api.example.test/path" }));
  await assert.rejects(decryptRecoveryKeyBackup({ ...file, plaintext: "unexpected" }, f.recovery));
  await assert.rejects(decryptRecoveryKeyBackup({ ...file, header: { ...file.header, format: "future-format" } }, f.recovery));
  f.archive.snapshot.collections.timeentries[0]!.description = "Altered without a new checksum";
  await assert.rejects(encryptRecoveryKeyBackup(f.archive, f.key, () => true), /checksum/);
});
test("snapshots source input before async work and refuses completion after locking", async () => {
  const f = await fixture(), original = structuredClone(f.archive);
  const promise = encryptRecoveryKeyBackup(f.archive, f.key, () => true);
  f.archive.snapshot.collections.timeentries[0]!.description = "Mutated caller input";
  assert.deepEqual(await decryptRecoveryKeyBackup(await promise, f.recovery), original);
  let current = true;
  const pending = encryptRecoveryKeyBackup(original, f.key, () => current); current = false;
  await assert.rejects(pending, /Private data changed/);
});
