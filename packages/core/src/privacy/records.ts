import { canSeeEntry, canSeeMoneyFor, canUseInvoices, type EncryptedRecord, type PrivateKind, type WorkspaceRecovery } from "@starter/shared";
import { decodeSecret, encodeSecret, randomSecret, seal, sealForRecipient, unseal, unsealForRecipient, type PublicKey } from "./crypto.js";
export type PrivateRecipient = { userId: string; role: "owner" | "admin" | "member"; canViewOthersTime: boolean; canViewOthersMoney: boolean; publicKey: PublicKey };
export type PlainPrivateRecord = { id: string; kind: PrivateKind; authorId: string | null; value: Record<string, unknown> };
export function readersForPrivateRecord(kind: PrivateKind, authorId: string | null, members: readonly PrivateRecipient[]): PrivateRecipient[] {
  return members.filter((m) => {
    const visibility = { userId: m.userId, canViewOthersTime: m.role === "owner" || m.canViewOthersTime, canViewOthersMoney: m.role === "owner" || m.canViewOthersMoney };
    if (kind === "favorites") return m.userId === authorId;
    if (kind === "invoices" || kind === "businessProfile") return canUseInvoices(m.role, visibility);
    if (kind === "entries" || kind === "approvals") return authorId !== null && canSeeEntry(visibility, authorId);
    if (kind === "entryMoney") return authorId !== null && canSeeEntry(visibility, authorId) && canSeeMoneyFor(visibility, authorId);
    if (kind === "memberMoney") return authorId !== null && canSeeMoneyFor(visibility, authorId);
    if (kind === "imports") return m.userId === authorId || m.role === "owner";
    // Catalog rates, budgets and workspace policy are shared configuration
    // in the existing app. Aggregate colleague time/money stays per entry.
    return true;
  });
}
export const privateRecordContext = (workspace: string, row: Pick<EncryptedRecord, "kind" | "id" | "revision" | "authorId">): string => JSON.stringify(["trackyourtime-record-v1", workspace, row.kind, row.id, row.authorId, row.revision]);
export async function encryptPrivateRecord(workspace: string, plain: PlainPrivateRecord, members: readonly PrivateRecipient[], revision: number): Promise<EncryptedRecord> {
  const recipients = readersForPrivateRecord(plain.kind, plain.authorId, members);
  if (!recipients.length) throw new Error("No authorized recipient for private data");
  const secret = randomSecret();
  const record = { id: plain.id, kind: plain.kind, authorId: plain.authorId, revision };
  const context = privateRecordContext(workspace, record);
  try {
    const box = await seal(secret, plain.value, context);
    const grants = [];
    for (const recipient of recipients) grants.push({ userId: recipient.userId, envelope: await sealForRecipient(recipient.publicKey, encodeSecret(secret), `${context}:${recipient.userId}`) });
    return { ...record, box, grants };
  } finally { secret.fill(0); }
}
export async function decryptPrivateRecord(workspace: string, row: EncryptedRecord, userId: string, privateKey: PublicKey): Promise<PlainPrivateRecord> {
  const grant = row.grants.find((g) => g.userId === userId);
  if (!grant) throw new Error("This account cannot decrypt this record");
  const context = privateRecordContext(workspace, row);
  const secret = decodeSecret(await unsealForRecipient<string>(privateKey, grant.envelope, `${context}:${userId}`), 32);
  try { return { id: row.id, kind: row.kind, authorId: row.authorId, value: await unseal<Record<string, unknown>>(secret, row.box, context) }; } finally { secret.fill(0); }
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
    const author = typeof decoded.authorId === "string" ? decoded.authorId : typeof decoded.userId === "string" ? decoded.userId : typeof decoded.createdBy === "string" ? decoded.createdBy : null;
    switch (kind) {
      case "timeentries": split("entries", "entryMoney", raw, ["hourlyRate"], author); break;
      case "clients": split("clients", "clientMoney", raw, ["billing"], null); break;
      case "projects": split("projects", "projectMoney", raw, ["hourlyRate", "budgetAmount", "budgetCurrency"], null); break;
      case "workspacesettings": split("settings", "settingsMoney", raw, ["defaultHourlyRate"], null); break;
      case "workspacemembers": add("memberMoney", raw, author); break;
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
  return records;
}
