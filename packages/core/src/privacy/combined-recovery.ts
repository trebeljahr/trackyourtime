import { RECOVERY_MAX_BYTES, RECOVERY_MAX_RECORDS, type CombinedWorkspaceRecoveryArchive } from "@starter/shared";
import { verifyWorkspaceRecoveryArchive } from "./recovery.js";
import { verifyWorkspaceRecoverySupplement } from "./recovery-supplement.js";
/** Both typed datasets, one scope and one aggregate bound. Creator-only values
 * from a complete server capture must never accidentally enter an owner's file.
 * This file does not claim to contain other members' private favorites/secrets. */
export async function verifyCombinedWorkspaceRecoveryArchive(input: unknown, expected?: { server: string; ownerId: string; workspaceId: string }): Promise<CombinedWorkspaceRecoveryArchive> {
  const value = structuredClone(input);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 5 || !("format" in value) || value.format !== "trackyourtime-workspace-recovery-v2" || !("server" in value) || !("ownerId" in value) || !("snapshot" in value) || !("supplement" in value)) throw new Error("Invalid combined recovery archive");
  if (new TextEncoder().encode(JSON.stringify(value)).length > RECOVERY_MAX_BYTES) throw new Error("Combined recovery archive is too large");
  const source = await verifyWorkspaceRecoveryArchive({ format: "trackyourtime-workspace-recovery-v1", server: value.server, ownerId: value.ownerId, snapshot: value.snapshot }, expected);
  const supplement = await verifyWorkspaceRecoverySupplement(value.supplement, source.snapshot.workspaceId);
  const records = [...Object.values(source.snapshot.collections), ...Object.values(supplement.collections)].reduce((count, rows) => count + rows.length, 0);
  if (records > RECOVERY_MAX_RECORDS) throw new Error("Combined recovery record limit exceeded");
  if (source.snapshot.collections.favorites.some((row) => row.userId !== source.ownerId) || supplement.collections.apitokens.some((row) => row.userId !== source.ownerId) || supplement.collections.webhooksubscriptions.some((row) => row.createdBy !== source.ownerId)) throw new Error("Combined recovery contains another account's private originals");
  return { format: "trackyourtime-workspace-recovery-v2", server: source.server, ownerId: source.ownerId, snapshot: source.snapshot, supplement };
}
