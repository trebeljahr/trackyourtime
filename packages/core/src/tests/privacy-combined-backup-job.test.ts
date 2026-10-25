import assert from "node:assert/strict";
import { it } from "node:test";
import { writeRecoveryBackup, RecoveryBackupPausedError, type RecoveryBackupFolder } from "../privacy/recovery-backup-job.js";
import { emptyRecoveryCollections, recoveryDigest } from "../privacy/recovery.js";
import { emptyRecoverySupplementCollections, recoverySupplementDigest } from "../privacy/recovery-supplement.js";
import { decryptCombinedRecoveryKeyBackup, encryptCombinedRecoveryKeyBackup } from "../privacy/combined-recovery-backup.js";
import { deriveRecoveryBackupKey, encryptRecoveryKeyBackup } from "../privacy/recovery-backup.js";
import { encodeSecret, randomSecret } from "../privacy/crypto.js";

const scope = { server: "https://api.example.test", ownerId: "owner", workspaceId: "workspace" };
async function fixture() {
  const collections = emptyRecoveryCollections(), supplement = emptyRecoverySupplementCollections(), createdAt = "2026-10-25T00:00:00.000Z";
  collections.invoices.push({ _id: "invoice", workspaceId: scope.workspaceId, xml: "<Invoice>Exact original XML</Invoice>", total: { $numberDecimal: "12.3400" } });
  supplement.organization.push({ _id: scope.workspaceId, name: "Private workspace name" });
  supplement.webhooksubscriptions.push({ _id: "hook", workspaceId: scope.workspaceId, createdBy: "owner", secret: "Private original webhook secret" });
  const archive = { format: "trackyourtime-workspace-recovery-v2" as const, server: scope.server, ownerId: scope.ownerId, snapshot: { v: 1 as const, workspaceId: scope.workspaceId, createdAt, collections, sourceRevision: await recoveryDigest(collections) }, supplement: { v: 1 as const, workspaceId: scope.workspaceId, createdAt, collections: supplement, sourceRevision: await recoverySupplementDigest(supplement) } };
  const recovery = encodeSecret(randomSecret()), key = await deriveRecoveryBackupKey(recovery, { server: scope.server, userId: scope.ownerId });
  const files = new Map<string, string>([["previous.tytrecovery", "previous encrypted backup"]]);
  const folder: RecoveryBackupFolder = { granted: async () => true, write: async (name, value) => { files.set(name, value); }, read: async (name) => files.get(name)!, remove: async (name) => { files.delete(name); } };
  return { archive, recovery, key, files, options: { scope, key, folder, snapshot: async () => archive, current: () => true } };
}
it("writes and reopens both exact typed datasets without exposing content or changing caller keys", async () => {
  const f = await fixture(), key = new Uint8Array(f.key), result = await writeRecoveryBackup(f.options);
  assert.equal(result.sourceRevision, f.archive.snapshot.sourceRevision); assert.equal(result.supplementRevision, f.archive.supplement.sourceRevision);
  const raw = f.files.get(result.fileName)!; assert.doesNotMatch(raw, /Exact original XML|Private workspace|Private original webhook|numberDecimal/);
  assert.equal(JSON.parse(raw).header.format, "trackyourtime-recovery-key-backup-v2");
  assert.deepEqual(await decryptCombinedRecoveryKeyBackup(JSON.parse(raw), f.recovery), f.archive);
  assert.deepEqual(f.key, key); assert.equal(f.files.get("previous.tytrecovery"), "previous encrypted backup");
});
it("rejects a valid different supplemental copy after reopening and keeps previous backups", async () => {
  const f = await fixture(), changed = structuredClone(f.archive); changed.supplement.collections.webhooksubscriptions[0]!.secret = "Different valid original secret";
  changed.supplement.sourceRevision = await recoverySupplementDigest(changed.supplement.collections);
  const substitute = JSON.stringify(await encryptCombinedRecoveryKeyBackup(changed, f.key, () => true));
  f.options.folder.read = async () => substitute;
  await assert.rejects(writeRecoveryBackup(f.options), /does not match/);
  assert.deepEqual([...f.files.keys()], ["previous.tytrecovery"]);
});
it("refuses an old fourteen-collection file in place of a new combined backup", async () => {
  const f = await fixture(), old = { format: "trackyourtime-workspace-recovery-v1" as const, server: scope.server, ownerId: scope.ownerId, snapshot: f.archive.snapshot };
  const substitute = JSON.stringify(await encryptRecoveryKeyBackup(old, f.key, () => true));
  f.options.folder.read = async () => substitute;
  await assert.rejects(writeRecoveryBackup(f.options)); assert.deepEqual([...f.files.keys()], ["previous.tytrecovery"]);
});
it("does not fetch originals without folder permission or accept a locked late source", async () => {
  const f = await fixture(); let fetched = false;
  f.options.folder.granted = async () => false;
  await assert.rejects(writeRecoveryBackup({ ...f.options, snapshot: async () => { fetched = true; return f.archive; } }), RecoveryBackupPausedError);
  assert.equal(fetched, false);
  f.options.folder.granted = async () => true; let current = true;
  await assert.rejects(writeRecoveryBackup({ ...f.options, current: () => current, snapshot: async () => { current = false; return f.archive; } }), /Private data changed/);
  assert.deepEqual([...f.files.keys()], ["previous.tytrecovery"]);
});
