import { RECOVERY_KINDS, RECOVERY_MAX_BYTES, RECOVERY_MAX_RECORDS, type RecoveryKind, type WorkspaceRecovery, type WorkspaceRecoveryArchive } from "@starter/shared";
import { canonicalJson } from "./crypto.js";
const encoder = new TextEncoder();
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (row: Record<string, unknown>, keys: readonly string[]) => keys.length === Object.keys(row).length && keys.every((key) => Object.hasOwn(row, key));
/** Digest the complete typed representation, including IDs and issued XML. */
export async function recoveryDigest(collections: WorkspaceRecovery["collections"]): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(canonicalJson(collections)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function recoveryRecordId(row: Record<string, unknown>): string {
  if (typeof row._id === "string" && row._id.length > 0 && row._id.length <= 200) return `s:${row._id}`;
  if (isRecord(row._id) && exactKeys(row._id, ["$oid"]) && typeof row._id.$oid === "string" && /^[a-f0-9]{24}$/.test(row._id.$oid)) return `o:${row._id.$oid}`;
  throw new Error("Recovery record has an unsupported ID");
}
/** Match MongoDB's explicit simple-collation BSON ID order: strings precede
 * ObjectIds, and strings compare as UTF-8 bytes rather than JS UTF-16 units. */
export function compareRecoveryRecordIds(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const left = recoveryRecordId(a), right = recoveryRecordId(b);
  if (left[0] !== right[0]) return left[0] === "s" ? -1 : 1;
  const x = encoder.encode(left.slice(2)), y = encoder.encode(right.slice(2));
  for (let index = 0; index < Math.min(x.length, y.length); index++) if (x[index] !== y[index]) return x[index]! - y[index]!;
  return x.length - y.length;
}
/** Validate before restoring anything. Extended JSON stays intact; ordinary
 * export/import normalization would lose IDs, BSON types and invoice links. */
export async function verifyWorkspaceRecovery(value: unknown, workspaceId?: string): Promise<WorkspaceRecovery> {
  if (!isRecord(value) || !exactKeys(value, ["v", "workspaceId", "createdAt", "sourceRevision", "collections"]) || value.v !== 1 ||
      typeof value.workspaceId !== "string" || !value.workspaceId || value.workspaceId.length > 100 || (workspaceId !== undefined && value.workspaceId !== workspaceId) ||
      typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
      typeof value.sourceRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceRevision) || !isRecord(value.collections) || !exactKeys(value.collections, RECOVERY_KINDS)) throw new Error("Invalid workspace recovery snapshot");
  let total = 0;
  for (const kind of RECOVERY_KINDS) {
    const rows = value.collections[kind];
    if (!Array.isArray(rows) || rows.length > RECOVERY_MAX_RECORDS) throw new Error("Recovery record limit exceeded");
    total += rows.length;
    if (total > RECOVERY_MAX_RECORDS) throw new Error("Recovery record limit exceeded");
    const seen = new Set<string>();
    for (const row of rows) {
      if (!isRecord(row) || row.workspaceId !== value.workspaceId) throw new Error("Recovery record belongs to a different workspace");
      const id = recoveryRecordId(row);
      if (seen.has(id)) throw new Error("Duplicate recovery record");
      seen.add(id);
    }
  }
  const snapshot = value as WorkspaceRecovery;
  if (encoder.encode(JSON.stringify(snapshot)).byteLength > RECOVERY_MAX_BYTES) throw new Error("Recovery snapshot is too large");
  if (await recoveryDigest(snapshot.collections) !== snapshot.sourceRevision) throw new Error("Recovery snapshot checksum does not match");
  return snapshot;
}
export async function verifyWorkspaceRecoveryArchive(value: unknown, expected?: { server: string; ownerId: string; workspaceId: string }): Promise<WorkspaceRecoveryArchive> {
  if (!isRecord(value) || !exactKeys(value, ["format", "server", "ownerId", "snapshot"]) || value.format !== "trackyourtime-workspace-recovery-v1" || typeof value.server !== "string" ||
      typeof value.ownerId !== "string" || !value.ownerId || value.ownerId.length > 100) throw new Error("Invalid workspace recovery archive");
  const server = new URL(value.server);
  if (!["http:", "https:"].includes(server.protocol) || server.origin !== value.server) throw new Error("Invalid recovery server origin");
  if (expected && (value.server !== expected.server || value.ownerId !== expected.ownerId)) throw new Error("Recovery archive belongs to another server or account");
  await verifyWorkspaceRecovery(value.snapshot, expected?.workspaceId);
  return value as WorkspaceRecoveryArchive;
}
export function emptyRecoveryCollections(): WorkspaceRecovery["collections"] {
  const collections = {} as Record<RecoveryKind, Record<string, unknown>[]>;
  for (const kind of RECOVERY_KINDS) collections[kind] = [];
  return collections;
}
