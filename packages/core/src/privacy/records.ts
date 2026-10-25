import { emptyRecoveryCollections, compareRecoveryRecordIds, recoveryDigest, recoveryRecordId, verifyWorkspaceRecovery } from "./recovery.js";
import { encryptedRecordSchema, PRIVATE_USER_ONLY_KINDS, canSeeEntry, canSeeMoneyFor, canUseInvoices, type EncryptedRecord, type PrivateKind, type WorkspaceRecovery, type RecoveryKind } from "@starter/shared";
import { canonicalJson, decodeSecret, encodeSecret, randomSecret, seal, sealForRecipient, unseal, unsealForRecipient, type PublicKey } from "./crypto.js";
import { assertPrivateSupplementRecord } from "./recovery-supplement.js";
const userOnlyKinds = new Set<string>(PRIVATE_USER_ONLY_KINDS);
export type PrivateRecipient = { userId: string; role: "owner" | "admin" | "member"; canViewOthersTime: boolean; canViewOthersMoney: boolean; publicKey: PublicKey };
export type PlainPrivateRecord = { id: string; kind: PrivateKind; authorId: string | null; value: Record<string, unknown> };
export function readersForPrivateRecord(kind: PrivateKind, authorId: string | null, members: readonly PrivateRecipient[]): PrivateRecipient[] {
  return members.filter((m) => {
    const visibility = { userId: m.userId, canViewOthersTime: m.role === "owner" || m.canViewOthersTime, canViewOthersMoney: m.role === "owner" || m.canViewOthersMoney };
    if (userOnlyKinds.has(kind)) return m.userId === authorId;
    if (kind === "invoices") return canUseInvoices(m.role, visibility);
    if (kind === "businessProfile") return m.role !== "member" || visibility.canViewOthersMoney;
    if (kind === "entries" || kind === "approvals") return authorId !== null && canSeeEntry(visibility, authorId);
    if (kind === "entryMoney") return authorId !== null && canSeeEntry(visibility, authorId) && canSeeMoneyFor(visibility, authorId);
    if (kind === "memberMoney") return authorId !== null && canSeeMoneyFor(visibility, authorId);
    if (kind === "imports") return m.userId === authorId || m.role === "owner";
    // Catalog rates, budgets and workspace policy are shared configuration
    // in the existing app. Aggregate colleague time/money stays per entry.
    return true;
  });
}
type RecordContext = Pick<EncryptedRecord, "kind" | "id" | "revision" | "authorId" | "keyCommitment">;
export const privateRecordContext = (workspace: string, row: RecordContext): string => row.keyCommitment
  ? JSON.stringify(["trackyourtime-record-v2", workspace, row.kind, row.id, row.authorId, row.revision, row.keyCommitment])
  : JSON.stringify(["trackyourtime-record-v1", workspace, row.kind, row.id, row.authorId, row.revision]);
/** Commit to the random 256-bit record key and its scope before wrapping it
 * for multiple readers. This digest is not a password/plaintext checksum. */
export async function privateRecordKeyCommitment(secret: Uint8Array, workspace: string, row: RecordContext): Promise<string> {
  if (secret.length !== 32) throw new Error("A 256-bit record key is required");
  const context = new TextEncoder().encode(JSON.stringify(["trackyourtime-record-key-v1", workspace, row.kind, row.id, row.authorId, row.revision]));
  const input = new Uint8Array(context.length + secret.length); input.set(context); input.set(secret, context.length);
  try { return encodeSecret(new Uint8Array(await crypto.subtle.digest("SHA-256", input))); }
  finally { input.fill(0); }
}
function privateAuthorField(kind: PrivateKind, id: string): string | null {
  if (["entries", "entryMoney", "approvals"].includes(kind)) return "authorId";
  if (kind === "favorites" || kind === "members" || kind === "memberMoney") return "userId";
  if (kind === "invoices") return "createdBy";
  if (kind === "imports") return id.startsWith("entryoperations:") ? "userId" : id.startsWith("importbatches:") ? "createdBy" : null;
  return null;
}
// Only these existing member fields become readable by all colleagues.
// Unknown legacy fields retain the original restricted memberMoney audience.
const MEMBER_DETAILS = new Set(["_id", "workspaceId", "userId", "name", "role", "canViewOthersTime", "canViewOthersMoney", "createdAt", "updatedAt", "__v"]);
function assertPrivateValueBinding(workspace: string, plain: PlainPrivateRecord): void {
  const value = plain.value;
  if (plain.kind === "workspaceIdentity" || plain.kind === "integrations") assertPrivateSupplementRecord(workspace, plain);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Private record value must be an object");
  if (Object.hasOwn(value, "workspaceId") && value.workspaceId !== workspace) throw new Error("Private payload belongs to another workspace");
  for (const rawId of [value._id === undefined ? undefined : privateValue(value._id), value.id]) if (rawId !== undefined) {
    const prefixed = (plain.kind === "imports" && /^(entryoperations|importbatches):/.test(plain.id)) || (plain.kind === "integrations" && /^(apitokens|webhooksubscriptions):/.test(plain.id));
    const logicalId = prefixed ? plain.id.slice(plain.id.indexOf(":") + 1) : plain.id;
    if (typeof rawId !== "string" || rawId !== logicalId) throw new Error("Private payload ID does not match its signed record");
  }
  if (plain.kind === "members" && Object.keys(value).some((key) => !MEMBER_DETAILS.has(key))) throw new Error("Member details contain private or unknown fields");
  if (plain.kind === "memberMoney" && Object.keys(value).some((key) => key !== "_id" && MEMBER_DETAILS.has(key))) throw new Error("Member money overlaps shared member details");
  const authorField = privateAuthorField(plain.kind, plain.id);
  if (authorField) {
    const author = privateValue(value[authorField]);
    if (typeof author === "string" && author.length > 0 && author !== plain.authorId) throw new Error("Private payload author does not match its signed record");
  }
}
export async function encryptPrivateRecord(workspace: string, input: PlainPrivateRecord, members: readonly PrivateRecipient[], revision: number): Promise<EncryptedRecord> {
  const plain = structuredClone(input);
  assertPrivateValueBinding(workspace, plain);
  const recipients = readersForPrivateRecord(plain.kind, plain.authorId, members);
  if (!recipients.length) throw new Error("No authorized recipient for private data");
  const secret = randomSecret();
  try {
    const base = { id: plain.id, kind: plain.kind, authorId: plain.authorId, revision };
    const record = { ...base, keyCommitment: await privateRecordKeyCommitment(secret, workspace, base) };
    const context = privateRecordContext(workspace, record);
    const box = await seal(secret, plain.value, context);
    const grants = [];
    for (const recipient of recipients) grants.push({ userId: recipient.userId, envelope: await sealForRecipient(recipient.publicKey, encodeSecret(secret), `${context}:${recipient.userId}`) });
    return { ...record, box, grants };
  } finally { secret.fill(0); }
}
export async function decryptPrivateRecord(workspace: string, input: EncryptedRecord, userId: string, privateKey: PublicKey): Promise<PlainPrivateRecord> {
  const row = encryptedRecordSchema.parse(input);
  const grant = row.grants.find((g) => g.userId === userId);
  if (!grant) throw new Error("This account cannot decrypt this record");
  const context = privateRecordContext(workspace, row);
  const secret = decodeSecret(await unsealForRecipient<string>(privateKey, grant.envelope, `${context}:${userId}`), 32);
  try {
    if (row.keyCommitment && await privateRecordKeyCommitment(secret, workspace, row) !== row.keyCommitment) throw new Error("Recipient key does not match the record key commitment");
    const plain = { id: row.id, kind: row.kind, authorId: row.authorId, value: await unseal<Record<string, unknown>>(secret, row.box, context) };
    assertPrivateValueBinding(workspace, plain); return plain;
  } finally { secret.fill(0); }
}
/** Decode Mongo Extended JSON only at the client boundary; ciphertext and
 * recovery archives keep the complete typed representation. */
export function privateValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(privateValue);
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, unknown>, keys = Object.keys(row);
  if (keys.length === 1) {
    if (typeof row.$oid === "string") return row.$oid;
    for (const key of ["$numberInt", "$numberLong", "$numberDouble", "$numberDecimal"]) if (typeof row[key] === "string") return Number(row[key]);
    if (row.$date !== undefined) return new Date(typeof row.$date === "string" ? row.$date : Number((row.$date as Record<string, unknown>).$numberLong)).toISOString();
  }
  return Object.fromEntries(Object.entries(row).map(([key, entry]) => [key, privateValue(entry)]));
}
export function partitionPrivateRecovery(snapshot: WorkspaceRecovery): PlainPrivateRecord[] {
  const records: PlainPrivateRecord[] = [];
  const add = (kind: PrivateKind, raw: Record<string, unknown>, authorId: string | null, id?: string) => {
    const decoded = privateValue(raw) as Record<string, unknown>;
    records.push({ kind, id: id ?? String(decoded._id), authorId, value: raw });
  };
  const split = (base: PrivateKind, money: PrivateKind, raw: Record<string, unknown>, fields: string[], author: string | null) => {
    const first = { ...raw }, second: Record<string, unknown> = { _id: raw._id };
    for (const field of fields) if (Object.hasOwn(first, field)) { second[field] = first[field]; delete first[field]; }
    add(base, first, author); add(money, second, author);
  };
  for (const [kind, rows] of Object.entries(snapshot.collections)) for (const raw of rows) {
    const decoded = privateValue(raw) as Record<string, unknown>;
    // Authority comes from the collection's actual owner field. An unrelated
    // legacy authorId/createdBy must not redirect a private preference's key.
    const authorField = kind === "favorites" || kind === "workspacemembers" || kind === "entryoperations" ? "userId"
      : kind === "invoices" || kind === "importbatches" ? "createdBy" : "authorId";
    const author = typeof decoded[authorField] === "string" && decoded[authorField] ? decoded[authorField] as string : null;
    switch (kind) {
      case "timeentries": split("entries", "entryMoney", raw, ["hourlyRate"], author); break;
      case "clients": split("clients", "clientMoney", raw, ["billing"], null); break;
      case "projects": split("projects", "projectMoney", raw, ["hourlyRate", "budgetAmount", "budgetCurrency"], null); break;
      case "workspacesettings": split("settings", "settingsMoney", raw, ["defaultHourlyRate"], null); break;
      case "workspacemembers": {
        const details = Object.fromEntries(Object.entries(raw).filter(([key]) => MEMBER_DETAILS.has(key)));
        const money = { _id: raw._id, ...Object.fromEntries(Object.entries(raw).filter(([key]) => !MEMBER_DETAILS.has(key))) };
        add("members", details, author); add("memberMoney", money, author); break;
      }
      case "tasks": add("tasks", raw, null); break;
      case "tags": add("tags", raw, null); break;
      case "favorites": add("favorites", raw, author); break;
      case "invoices": add("invoices", raw, author); break;
      case "businessprofiles": add("businessProfile", raw, null); break;
      case "timesheetapprovals": add("approvals", raw, author); break;
      case "timesheetpolicies": add("approvalPolicy", raw, null); break;
      case "importbatches": case "entryoperations": add("imports", raw, author, `${kind}:${String(decoded._id)}`); break;
      default: throw new Error(`Unsupported recovery collection: ${kind}`);
    }
  }
  const addresses = records.map((row) => JSON.stringify([row.kind, row.id]));
  if (new Set(addresses).size !== addresses.length) throw new Error("Recovery IDs collide in the encrypted record namespace");
  if (records.some((row) => !row.id || row.id.length > 100)) throw new Error("Recovery ID exceeds the encrypted record namespace limit");
  return records;
}

/** Rebuild an owner-readable lossless recovery copy from a complete decrypted
 * replica. Other members' private favorites remain outside the owner's copy.
 * Every money/base pair must be present; a restricted/partial view must never
 * masquerade as a lossless backup. Raw BSON EJSON remains untouched. */
export async function privateRecordsToRecovery(workspaceId: string, input: readonly PlainPrivateRecord[], createdAt = new Date().toISOString()): Promise<WorkspaceRecovery> {
  const rows = structuredClone(input), seen = new Set<string>();
  const splits = {
    entries: { money: "entryMoney", collection: "timeentries", fields: ["hourlyRate"] },
    clients: { money: "clientMoney", collection: "clients", fields: ["billing"] },
    projects: { money: "projectMoney", collection: "projects", fields: ["hourlyRate", "budgetAmount", "budgetCurrency"] },
    members: { money: "memberMoney", collection: "workspacemembers", fields: ["hourlyRate"] },
    settings: { money: "settingsMoney", collection: "workspacesettings", fields: ["defaultHourlyRate"] },
  } as const;
  const whole: Partial<Record<PrivateKind, RecoveryKind>> = { tasks: "tasks", tags: "tags", favorites: "favorites", invoices: "invoices", businessProfile: "businessprofiles", approvals: "timesheetapprovals", approvalPolicy: "timesheetpolicies" };
  const collectionRows = emptyRecoveryCollections();
  const moneyKinds = new Set<string>(Object.values(splits).map((split) => split.money));
  const usedMoney = new Set<string>();
  const byAddress = new Map(rows.map((row) => [JSON.stringify([row.kind, row.id]), row]));
  for (const row of rows) {
    const address = JSON.stringify([row.kind, row.id]);
    if (seen.has(address)) throw new Error("Duplicate private recovery record"); seen.add(address);
    assertPrivateValueBinding(workspaceId, row);
  }
  const idOf = (raw: Record<string, unknown>) => recoveryRecordId(raw).slice(2);
  for (const row of rows) {
    if (moneyKinds.has(row.kind)) continue;
    const split = Object.hasOwn(splits, row.kind) ? splits[row.kind as keyof typeof splits] : undefined;
    let collection: RecoveryKind | undefined = split?.collection ?? (Object.hasOwn(whole, row.kind) ? whole[row.kind] : undefined);
    if (row.kind === "imports") {
      collection = row.id.startsWith("entryoperations:") ? "entryoperations" : row.id.startsWith("importbatches:") ? "importbatches" : undefined;
      if (!collection || row.id !== `${collection}:${idOf(row.value)}`) throw new Error("Invalid private operation/import receipt ID");
    } else if (row.id !== idOf(row.value)) throw new Error("Private record ID differs from its BSON ID");
    if (!collection || row.value.workspaceId !== workspaceId) throw new Error("Private recovery record belongs to another workspace or kind");
    let raw = row.value;
    if (split) {
      const money = byAddress.get(JSON.stringify([split.money, row.id]));
      if (!money || money.authorId !== row.authorId || canonicalJson(money.value._id) !== canonicalJson(raw._id)) throw new Error("Private recovery is missing its matching money record");
      if (row.kind === "members") {
        if (Object.keys(money.value).some((key) => key !== "_id" && MEMBER_DETAILS.has(key))) throw new Error("Private recovery member fields overlap");
      } else if (Object.keys(money.value).some((key) => key !== "_id" && !(split.fields as readonly string[]).includes(key)) || split.fields.some((key) => Object.hasOwn(raw, key))) throw new Error("Private recovery money fields overlap or contain unexpected data");
      usedMoney.add(JSON.stringify([money.kind, money.id])); raw = { ...raw, ...money.value };
    }
    collectionRows[collection].push(raw);
  }
  for (const row of rows) if (moneyKinds.has(row.kind) && !usedMoney.has(JSON.stringify([row.kind, row.id]))) throw new Error("Private recovery contains an orphaned money record");
  for (const records of Object.values(collectionRows)) records.sort(compareRecoveryRecordIds);
  const sourceRevision = await recoveryDigest(collectionRows);
  return verifyWorkspaceRecovery({ v: 1, workspaceId, createdAt, sourceRevision, collections: collectionRows }, workspaceId);
}
