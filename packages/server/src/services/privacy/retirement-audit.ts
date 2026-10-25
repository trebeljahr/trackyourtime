import { createHash } from "node:crypto";
import { ObjectId, type ClientSession, type Db, type Document, type Filter } from "mongodb";
import { TRPCError } from "@trpc/server";
import { RECOVERY_KINDS } from "@starter/shared";

/** Clear routing placeholders carry no original workspace name, slug or logo.
 * Their originals must already exist in a verified encrypted recovery copy. */
export function privateWorkspaceRoutingIdentity(workspaceId: string) {
  if (!workspaceId || workspaceId.length > 100) throw new Error("Invalid workspace scope");
  return { name: "Private workspace", slug: `private-${createHash("sha256").update(workspaceId).digest("hex").slice(0, 24)}` };
}
type RawRow = Document & { _id: string | ObjectId };
export type PrivateRetirementLeak = { collection: string; reason: "original-records" | "integration-content" | "personal-labels" | "source-checksums" | "unknown-fields" | "unclassified-records"; records: number };
const privateFields: Record<string, string[]> = {
  privatedirectories: ["workspaceId", "revision", "digest", "signerPublicKey", "signed"],
  privatesnapshotchunks: ["workspaceId", "migrationId", "index", "records"],
  privatesnapshotreaders: ["workspaceId", "migrationId", "userId", "fullRecordsDigest", "signed", "locations"],
  privaterecords: ["workspaceId", "id", "kind", "authorId", "revision", "box", "grants", "deleted"],
  privateworkspacecommits: ["workspaceId", "userId", "operationId", "revision", "manifest", "signature", "readerSignatures", "records", "chain", "head"],
  privateworkspaces: ["workspaceId", "state", "ownerId", "revision", "head", "directoryDigest", "leaseUntil", "migrationId", "sourceRevision", "supplementRevision", "backupVerified"],
};
const privateCollections = ["privateaccounts", "privatedevicerequests", ...Object.keys(privateFields)];
const operationalCollections = ["storageusages", "storagefences", "workspacewritefences", "importbudgets", "importleases", "scheduledjobs"];
const accountCollections = ["user", "account", "session", "verification", "member", "invitation", "deviceCode", "twoFactor", "passkey", "profiles", "avatars", "userpreferences"];
const special = ["workspacemembers", "apitokens", "webhooksubscriptions", "webhookdeliveries", "privatemigrationreceipts", "privateworkspaces", "organization"];

/** Counts only; never returns original values, secrets or plaintext hashes.
 * This is a current-database check, not proof of storage-page/oplog/log/backup
 * erasure, outbound delivery drain, account-content migration or client safety.
 * The caller must fence workspace writers and use its transaction session for
 * a cutover check. Catalog enumeration is outside the transaction (MongoDB
 * does not support listCollections inside one); maintenance must also prevent
 * unclassified writers/collection creation. No live cutover is mounted yet. */
export async function auditPrivateWorkspaceRetirement(db: Db, workspaceId: string, session?: ClientSession): Promise<{ leaks: PrivateRetirementLeak[] }> {
  const routing = privateWorkspaceRoutingIdentity(workspaceId);
  const catalog = await db.listCollections({}, { nameOnly: true }).toArray();
  if (catalog.length > 256) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Storage inventory exceeds its audit limit. Source data was kept." });
  const names = new Set(catalog.map((row) => row.name)), leaks: PrivateRetirementLeak[] = [];
  const count = async (collection: string, reason: PrivateRetirementLeak["reason"], filter: Filter<RawRow>) => {
    if (!names.has(collection)) return;
    const records = await db.collection<RawRow>(collection).countDocuments(filter, { session });
    if (records) leaks.push({ collection, reason, records });
  };
  const unknownFields = async (collection: string, filter: Filter<RawRow>, allowed: string[]) => {
    if (!names.has(collection)) return;
    const rows = await db.collection(collection).aggregate<{ records: number }>([
      { $match: filter },
      { $project: { unknown: { $setDifference: [{ $map: { input: { $objectToArray: "$$ROOT" }, as: "field", in: "$$field.k" } }, allowed] } } },
      { $match: { "unknown.0": { $exists: true } } }, { $count: "records" },
    ], { session }).toArray();
    if (rows[0]?.records) leaks.push({ collection, reason: "unknown-fields", records: rows[0].records });
  };
  for (const collection of RECOVERY_KINDS) if (collection !== "workspacemembers") await count(collection, "original-records", { workspaceId });
  for (const collection of ["webhooksubscriptions", "webhookdeliveries"]) await count(collection, "integration-content", { workspaceId });
  await count("apitokens", "personal-labels", { workspaceId, name: { $exists: true, $nin: [null, ""] } });
  await unknownFields("apitokens", { workspaceId }, ["_id", "workspaceId", "userId", "name", "prefix", "tokenHash", "scopes", "grantedVisibility", "expiresAt", "lastUsedAt", "revokedAt", "createdAt", "updatedAt", "__v"]);
  await count("workspacemembers", "personal-labels", { workspaceId, $or: [{ name: { $exists: true, $nin: [null, ""] } }, { hourlyRate: { $exists: true, $ne: null } }] });
  await unknownFields("workspacemembers", { workspaceId }, ["_id", "workspaceId", "userId", "role", "name", "hourlyRate", "canViewOthersTime", "canViewOthersMoney", "createdAt", "updatedAt", "__v"]);
  await count("privatemigrationreceipts", "source-checksums", { workspaceId });
  await count("privateworkspaces", "source-checksums", { workspaceId, $or: [{ sourceRevision: { $ne: "retired" } }, { supplementRevision: { $exists: true, $nin: [null, "retired"] } }] });
  for (const [collection, fields] of Object.entries(privateFields)) await unknownFields(collection, { workspaceId }, ["_id", "createdAt", "updatedAt", "__v", ...fields]);
  const ids: (string | ObjectId)[] = [workspaceId];
  if (ObjectId.isValid(workspaceId)) ids.push(new ObjectId(workspaceId));
  const organization = { $or: [{ _id: { $in: ids } }, { id: workspaceId }] };
  await count("organization", "personal-labels", { $and: [organization, { $or: [
    { name: { $ne: routing.name } }, { slug: { $ne: routing.slug } },
    { logo: { $exists: true, $nin: [null, ""] } }, { metadata: { $exists: true, $nin: [null, "", "{}"] } },
  ] }] });
  await unknownFields("organization", organization, ["_id", "id", "name", "slug", "logo", "metadata", "createdAt", "updatedAt", "__v"]);
  const classified = new Set<string>([...RECOVERY_KINDS, ...privateCollections, ...operationalCollections, ...accountCollections, ...special]);
  for (const collection of [...names].sort()) if (!classified.has(collection) && !collection.startsWith("system.")) await count(collection, "unclassified-records", { $or: [{ workspaceId }, { organizationId: workspaceId }] });
  return { leaks: leaks.sort((a, b) => a.collection < b.collection ? -1 : a.collection > b.collection ? 1 : a.reason < b.reason ? -1 : 1) };
}

/** Future cutover must call this after its planned source retirement, inside
 * the same transaction. A failure must abort that transaction, keeping source.
 * Never interpret a clean report as authorization to enable the rollout. */
export async function assertPrivateWorkspaceRetirement(db: Db, workspaceId: string, session: ClientSession): Promise<void> {
  if (!session.inTransaction()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Retirement verification requires the cutover transaction." });
  const pinned = await db.collection("privateworkspaces").countDocuments({ workspaceId, state: "encrypted", revision: { $gte: 1 }, head: /^[A-Za-z0-9_-]{43}$/, directoryDigest: /^[A-Za-z0-9_-]{43}$/, backupVerified: true, sourceRevision: "retired" }, { session });
  if (pinned !== 1) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Retirement requires a pinned encrypted workspace and verified backup." });
  if ((await auditPrivateWorkspaceRetirement(db, workspaceId, session)).leaks.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Residual plaintext workspace data or temporary source checksums remain. Source retirement was not verified." });
}
