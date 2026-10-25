import { RECOVERY_MAX_BYTES, RECOVERY_MAX_RECORDS, RECOVERY_SUPPLEMENT_KINDS, type RecoverySupplementKind, type WorkspaceRecoverySupplement } from "@starter/shared";
import { canonicalJson } from "./crypto.js";
import { compareRecoveryRecordIds, recoveryRecordId } from "./recovery.js";
import type { PlainPrivateRecord } from "./records.js";
const encoder = new TextEncoder();
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const logicalId = (row: Record<string, unknown>) => recoveryRecordId(row).slice(2);
function organizationScope(row: Record<string, unknown>, workspaceId: string): void {
  const mongoId = logicalId(row);
  const id = row.id === undefined ? mongoId : row.id;
  if (id !== workspaceId) throw new Error("Organization recovery belongs to another workspace");
}
/** Existing organization identity fields were shared with members. Unknown
 * legacy additions need an explicit audience decision before publication. */
export function assertSharedOrganizationSupplement(row: Record<string, unknown>, workspaceId: string): void {
  organizationScope(row, workspaceId);
  const allowed = new Set(["_id", "id", "name", "slug", "logo", "metadata", "kind", "createdAt", "updatedAt", "__v"]);
  if (row.kind !== undefined && row.kind !== "personal" && row.kind !== "team") throw new Error("Unknown workspace kind requires an explicit migration decision");
  if (Object.keys(row).some((key) => !allowed.has(key))) throw new Error("Unknown organization fields require an explicit private audience");
}
export function emptyRecoverySupplementCollections(): WorkspaceRecoverySupplement["collections"] {
  return { organization: [], apitokens: [], webhooksubscriptions: [] };
}
export async function recoverySupplementDigest(collections: WorkspaceRecoverySupplement["collections"]): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(canonicalJson(collections))))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** Typed raw originals, including integration secrets and unknown legacy
 * fields. No export normalization, ID remapping or cross-creator grant. */
export async function verifyWorkspaceRecoverySupplement(value: unknown, workspaceId?: string): Promise<WorkspaceRecoverySupplement> {
  if (!object(value) || !exact(value, ["v", "workspaceId", "createdAt", "sourceRevision", "collections"]) || value.v !== 1 || typeof value.workspaceId !== "string" || !value.workspaceId || value.workspaceId.length > 100 || (workspaceId !== undefined && workspaceId !== value.workspaceId) || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.sourceRevision !== "string" || !/^[0-9a-f]{64}$/.test(value.sourceRevision) || !object(value.collections) || !exact(value.collections, RECOVERY_SUPPLEMENT_KINDS)) throw new Error("Invalid recovery supplement");
  let count = 0;
  for (const kind of RECOVERY_SUPPLEMENT_KINDS) {
    const rows = value.collections[kind];
    if (!Array.isArray(rows) || (kind === "organization" && rows.length > 1)) throw new Error("Invalid recovery supplement collection");
    count += rows.length; if (count > RECOVERY_MAX_RECORDS) throw new Error("Recovery supplement record limit exceeded");
    const seen = new Set<string>();
    for (const row of rows) {
      if (!object(row)) throw new Error("Invalid supplemental original record");
      const id = recoveryRecordId(row); if (seen.has(id)) throw new Error("Duplicate supplemental original record"); seen.add(id);
      if (kind === "organization") organizationScope(row, value.workspaceId);
      else if (row.workspaceId !== value.workspaceId) throw new Error("Integration recovery belongs to another workspace");
    }
  }
  if (encoder.encode(JSON.stringify(value)).length > RECOVERY_MAX_BYTES) throw new Error("Recovery supplement is too large");
  const supplement = value as WorkspaceRecoverySupplement;
  if (await recoverySupplementDigest(supplement.collections) !== supplement.sourceRevision) throw new Error("Recovery supplement checksum does not match");
  return supplement;
}
export function assertPrivateSupplementRecord(workspaceId: string, row: PlainPrivateRecord): void {
  if (!object(row.value)) throw new Error("Invalid supplemental private payload");
  if (row.kind === "workspaceIdentity") {
    if (row.id !== "organization" || row.authorId !== null || !exact(row.value, ["workspaceId", "organization"]) || row.value.workspaceId !== workspaceId || !object(row.value.organization)) throw new Error("Invalid encrypted workspace identity");
    assertSharedOrganizationSupplement(row.value.organization, workspaceId); return;
  }
  if (row.kind !== "integrations") throw new Error("Unsupported supplemental private kind");
  const kind = row.id.startsWith("apitokens:") ? "apitokens" : row.id.startsWith("webhooksubscriptions:") ? "webhooksubscriptions" : null;
  if (!kind || row.value.workspaceId !== workspaceId || row.id !== `${kind}:${logicalId(row.value)}`) throw new Error("Integration private payload scope does not match");
  const author = row.value[kind === "apitokens" ? "userId" : "createdBy"];
  if (typeof author !== "string" || !author || author.length > 100 || author !== row.authorId) throw new Error("Integration private payload owner does not match");
}
export function partitionPrivateRecoverySupplement(source: WorkspaceRecoverySupplement): PlainPrivateRecord[] {
  const records: PlainPrivateRecord[] = [];
  for (const kind of RECOVERY_SUPPLEMENT_KINDS) for (const raw of source.collections[kind]) {
    const row: PlainPrivateRecord = kind === "organization"
      ? { kind: "workspaceIdentity", id: "organization", authorId: null, value: { workspaceId: source.workspaceId, organization: structuredClone(raw) } }
      : { kind: "integrations", id: `${kind}:${logicalId(raw)}`, authorId: raw[kind === "apitokens" ? "userId" : "createdBy"] as string, value: structuredClone(raw) };
    assertPrivateSupplementRecord(source.workspaceId, row);
    if (row.id.length > 100) throw new Error("Supplemental record ID exceeds the encrypted namespace limit");
    records.push(row);
  }
  if (new Set(records.map((row) => JSON.stringify([row.kind, row.id]))).size !== records.length) throw new Error("Supplemental record IDs collide in the encrypted namespace");
  return records;
}
export async function privateRecordsToRecoverySupplement(workspaceId: string, input: readonly PlainPrivateRecord[], createdAt = new Date().toISOString()): Promise<WorkspaceRecoverySupplement> {
  const collections = emptyRecoverySupplementCollections(), seen = new Set<string>();
  for (const row of structuredClone(input)) {
    assertPrivateSupplementRecord(workspaceId, row);
    const address = JSON.stringify([row.kind, row.id]); if (seen.has(address)) throw new Error("Duplicate supplemental private record"); seen.add(address);
    const kind: RecoverySupplementKind = row.kind === "workspaceIdentity" ? "organization" : row.id.startsWith("apitokens:") ? "apitokens" : "webhooksubscriptions";
    collections[kind].push(row.kind === "workspaceIdentity" ? row.value.organization as Record<string, unknown> : row.value);
  }
  for (const rows of Object.values(collections)) rows.sort(compareRecoveryRecordIds);
  return verifyWorkspaceRecoverySupplement({ v: 1, workspaceId, createdAt, sourceRevision: await recoverySupplementDigest(collections), collections }, workspaceId);
}
