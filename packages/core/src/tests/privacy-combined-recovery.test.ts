import assert from "node:assert/strict";
import { it } from "node:test";
import { canonicalJson, encodeSecret, randomSecret } from "../privacy/crypto.js";
import { emptyRecoveryCollections, recoveryDigest } from "../privacy/recovery.js";
import { emptyRecoverySupplementCollections, recoverySupplementDigest } from "../privacy/recovery-supplement.js";
import { verifyCombinedWorkspaceRecoveryArchive } from "../privacy/combined-recovery.js";
import { decryptCombinedRecoveryKeyBackup, encryptCombinedRecoveryKeyBackup, verifyCombinedRecoveryKeyBackup } from "../privacy/combined-recovery-backup.js";
import { decryptRecoveryKeyBackup, deriveRecoveryBackupKey, encryptRecoveryKeyBackup } from "../privacy/recovery-backup.js";
import type { CombinedWorkspaceRecoveryArchive } from "@starter/shared";
const scope = { server: "https://api.example.test", ownerId: "owner", workspaceId: "workspace" };
async function fixture() {
  const collections = emptyRecoveryCollections();
  collections.timeentries.push({ _id: "entry", workspaceId: "workspace", authorId: "owner", integer: { $numberLong: "9007199254740993" }, total: { $numberDecimal: "12.3400" } });
  collections.invoices.push({ _id: "invoice", workspaceId: "workspace", createdBy: "owner", xml: '<Invoice id="original">€ — exact XML</Invoice>' });
  const supplemental = emptyRecoverySupplementCollections();
  supplemental.organization.push({ _id: "workspace", name: "Original studio", slug: "original-studio", logo: "data:original" });
  supplemental.apitokens.push({ _id: "token", workspaceId: "workspace", userId: "owner", name: "Private API label", tokenHash: "original random token hash" });
  supplemental.webhooksubscriptions.push({ _id: "hook", workspaceId: "workspace", createdBy: "owner", url: "https://private.example.test/events", secret: "Original webhook secret" });
  const createdAt = "2026-10-25T00:00:00.000Z";
  const archive: CombinedWorkspaceRecoveryArchive = { format: "trackyourtime-workspace-recovery-v2", server: scope.server, ownerId: scope.ownerId, snapshot: { v: 1, workspaceId: "workspace", createdAt, sourceRevision: await recoveryDigest(collections), collections }, supplement: { v: 1, workspaceId: "workspace", createdAt, sourceRevision: await recoverySupplementDigest(supplemental), collections: supplemental } };
  const recovery = encodeSecret(randomSecret()), key = await deriveRecoveryBackupKey(recovery, { server: scope.server, userId: scope.ownerId });
  return { archive, recovery, key };
}
it("opens both exact typed datasets offline while keeping secrets, XML and source checksums inside ciphertext", async () => {
  const f = await fixture(), before = new Uint8Array(f.key);
  const file = await encryptCombinedRecoveryKeyBackup(f.archive, f.key, () => true);
  assert.equal(file.header.format, "trackyourtime-recovery-key-backup-v2");
  assert.doesNotMatch(JSON.stringify(file), /Original webhook|Private API|original-studio|numberLong|sourceRevision|Invoice/);
  assert.deepEqual(await decryptCombinedRecoveryKeyBackup(JSON.parse(JSON.stringify(file)), f.recovery), f.archive);
  assert.deepEqual(await verifyCombinedRecoveryKeyBackup(file, f.key, scope), f.archive);
  assert.deepEqual(f.key, before);
});
it("keeps v1 files readable and refuses format downgrades instead of dropping the supplemental dataset", async () => {
  const f = await fixture(), v1 = { format: "trackyourtime-workspace-recovery-v1" as const, server: scope.server, ownerId: scope.ownerId, snapshot: f.archive.snapshot };
  const original = await encryptRecoveryKeyBackup(v1, f.key, () => true);
  assert.deepEqual(await decryptRecoveryKeyBackup(original, f.recovery), v1);
  const combined = await encryptCombinedRecoveryKeyBackup(f.archive, f.key, () => true);
  await assert.rejects(decryptRecoveryKeyBackup(combined, f.recovery));
  await assert.rejects(decryptCombinedRecoveryKeyBackup(original, f.recovery));
  await assert.rejects(decryptRecoveryKeyBackup({ ...combined, header: { ...combined.header, format: "trackyourtime-recovery-key-backup-v1" } }, f.recovery));
});
it("authenticates routing and ciphertext, refuses wrong keys and rejects unverified source checksums", async () => {
  const f = await fixture(), file = await encryptCombinedRecoveryKeyBackup(f.archive, f.key, () => true);
  await assert.rejects(decryptCombinedRecoveryKeyBackup(file, encodeSecret(randomSecret())));
  await assert.rejects(verifyCombinedRecoveryKeyBackup(file, f.key, { ...scope, workspaceId: "another" }));
  await assert.rejects(decryptCombinedRecoveryKeyBackup({ ...file, header: { ...file.header, createdAt: "2026-10-26T00:00:00.000Z" } }, f.recovery));
  const corrupted = structuredClone(file); corrupted.box.data = (corrupted.box.data[0] === "A" ? "B" : "A") + corrupted.box.data.slice(1);
  await assert.rejects(decryptCombinedRecoveryKeyBackup(corrupted, f.recovery));
  const changed = structuredClone(f.archive); changed.supplement.collections.webhooksubscriptions[0]!.secret = "Changed secret";
  await assert.rejects(encryptCombinedRecoveryKeyBackup(changed, f.key, () => true), /checksum/);
});
it("refuses another creator's private originals and cross-workspace supplemental data", async () => {
  const f = await fixture();
  for (const kind of ["apitokens", "webhooksubscriptions"] as const) {
    const bad = structuredClone(f.archive); bad.supplement.collections[kind][0]![kind === "apitokens" ? "userId" : "createdBy"] = "another";
    bad.supplement.sourceRevision = await recoverySupplementDigest(bad.supplement.collections);
    await assert.rejects(verifyCombinedWorkspaceRecoveryArchive(bad), /another account/);
  }
  const wrong = structuredClone(f.archive); wrong.supplement.workspaceId = "another";
  await assert.rejects(verifyCombinedWorkspaceRecoveryArchive(wrong));
  await assert.rejects(verifyCombinedWorkspaceRecoveryArchive({ ...f.archive, ignoredSource: {} }));
});
it("captures the source before awaiting and cannot finish after locking", async () => {
  const f = await fixture(), original = structuredClone(f.archive);
  const pending = encryptCombinedRecoveryKeyBackup(f.archive, f.key, () => true);
  f.archive.supplement.collections.webhooksubscriptions[0]!.secret = "Mutated caller data";
  assert.equal(canonicalJson(await decryptCombinedRecoveryKeyBackup(await pending, f.recovery)), canonicalJson(original));
  let current = true; const locked = encryptCombinedRecoveryKeyBackup(original, f.key, () => current); current = false;
  await assert.rejects(locked, /Private data changed/);
});
