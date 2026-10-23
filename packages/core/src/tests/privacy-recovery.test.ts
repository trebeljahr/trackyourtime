import assert from "node:assert/strict";
import { it } from "node:test";
import { emptyRecoveryCollections, recoveryDigest, verifyWorkspaceRecovery, verifyWorkspaceRecoveryArchive } from "../privacy/recovery.js";
import { decryptBackup, encryptBackup } from "../privacy/crypto.js";
import type { WorkspaceRecovery } from "@starter/shared";

async function fixture(): Promise<WorkspaceRecovery> {
  const collections = emptyRecoveryCollections();
  collections.invoices.push({ _id: { $oid: "00112233445566778899aabb" }, workspaceId: "workspace", entryIds: ["ffeeddccbbaa998877665544"], xml: "<Invoice>Original issued document</Invoice>", total: { $numberDecimal: "123.4500" } });
  collections.timeentries.push({ _id: { $oid: "ffeeddccbbaa998877665544" }, workspaceId: "workspace", authorId: "owner", invoiceId: "00112233445566778899aabb", start: { $date: { $numberLong: "1700000000000" } } });
  return { v: 1, workspaceId: "workspace", createdAt: "2026-10-23T00:00:00.000Z", sourceRevision: await recoveryDigest(collections), collections };
}
it("reopens an authenticated lossless backup with original IDs, links, XML and typed values", async () => {
  const snapshot = await fixture();
  const archive = { format: "trackyourtime-workspace-recovery-v1" as const, server: "https://api.example.test", ownerId: "owner", snapshot };
  const encrypted = await encryptBackup(archive, "a separate recovery backup password");
  assert.doesNotMatch(JSON.stringify(encrypted), /Original issued document/);
  const reopened = await verifyWorkspaceRecoveryArchive(await decryptBackup(encrypted, "a separate recovery backup password"));
  assert.deepEqual(reopened, archive);
  await verifyWorkspaceRecoveryArchive(reopened, { server: archive.server, ownerId: archive.ownerId, workspaceId: "workspace" });
  await assert.rejects(verifyWorkspaceRecoveryArchive(reopened, { server: "https://other.example.test", ownerId: "owner", workspaceId: "workspace" }), /another server/);
  await assert.rejects(verifyWorkspaceRecoveryArchive(reopened, { server: archive.server, ownerId: "other", workspaceId: "workspace" }), /another server/);
  await assert.rejects(verifyWorkspaceRecoveryArchive(reopened, { server: archive.server, ownerId: "owner", workspaceId: "other" }), /Invalid/);
  assert.deepEqual(await verifyWorkspaceRecovery(snapshot, "workspace"), snapshot);
  // Property order is transport formatting, not a different backup.
  const reordered = { ...snapshot, collections: Object.fromEntries(Object.entries(snapshot.collections).reverse()) };
  assert.deepEqual(await verifyWorkspaceRecovery(reordered), reordered);
});
it("refuses tampering, cross-workspace records, duplicate IDs and silently omitted collections", async () => {
  const snapshot = await fixture();
  await assert.rejects(verifyWorkspaceRecovery(snapshot, "other"), /Invalid/);
  const edited = structuredClone(snapshot); edited.collections.invoices[0]!.xml = "changed";
  await assert.rejects(verifyWorkspaceRecovery(edited), /checksum/);
  const other = structuredClone(snapshot); other.collections.timeentries[0]!.workspaceId = "other";
  await assert.rejects(verifyWorkspaceRecovery(other), /different workspace/);
  const duplicate = structuredClone(snapshot); duplicate.collections.timeentries.push(duplicate.collections.timeentries[0]!);
  await assert.rejects(verifyWorkspaceRecovery(duplicate), /Duplicate/);
  const missing = structuredClone(snapshot); delete (missing.collections as Partial<typeof missing.collections>).invoices;
  await assert.rejects(verifyWorkspaceRecovery(missing), /Invalid/);
  const invalidId = structuredClone(snapshot); invalidId.collections.invoices[0]!._id = { $oid: "not-a-valid-ID" };
  await assert.rejects(verifyWorkspaceRecovery(invalidId), /unsupported ID/);
});
