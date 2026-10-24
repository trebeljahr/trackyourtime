import { z } from "zod";
import { encryptedRecordSchema, privateRecordRefSchema, signedPrivateWorkspaceEditSchema, type PrivateWorkspaceChange } from "@starter/shared";
import type { QueueExclusive } from "../durable-entry.js";
import type { KeyValueStorage } from "../storage.js";
import { canonicalJson, type PublicKey } from "./crypto.js";
import { createPrivateStorage, PrivateStorageLockedError, type PrivateStorageKey, type PrivateStorageScope } from "./storage.js";
import { decryptPrivateRecord, encryptPrivateRecord, readersForPrivateRecord, type PlainPrivateRecord, type PrivateRecipient } from "./records.js";
import { privateWorkspaceManifest, privateWorkspaceManifestForReader, signPrivateWorkspaceEdit, verifyPrivateWorkspaceChange } from "./workspace-edits.js";
const plainSchema = privateRecordRefSchema.extend({ value: z.record(z.string(), z.json()) }).strict();
const pendingSchema = z.object({ operationId: z.uuid(), basedOn: z.number().int().nonnegative(), records: z.array(plainSchema).max(100), remove: z.array(privateRecordRefSchema).max(100), submitted: signedPrivateWorkspaceEditSchema.nullable() }).strict();
const stateSchema = z.object({ v: z.literal(1), revision: z.number().int().nonnegative(), records: z.array(encryptedRecordSchema), pending: z.array(pendingSchema).max(1000) }).strict();
type State = z.infer<typeof stateSchema>;
const address = (row: { kind: string; id: string }) => JSON.stringify([row.kind, row.id]);
export class PrivateReplicaConflictError extends Error {
  constructor() { super("The workspace changed while this edit was offline. The queued edit was kept for review."); this.name = "PrivateReplicaConflictError"; }
}
export type PrivateReplicaIdentity = {
  privateKey: PublicKey; signingPrivateKey: PublicKey;
  /** Verified recipient directory, independent of the untrusted change feed. */
  recipients: readonly PrivateRecipient[];
  signingKey: (userId: string) => PublicKey | null;
  current: () => boolean;
};
export type PrivateReplicaTransport = {
  commit: (input: z.infer<typeof signedPrivateWorkspaceEditSchema>) => Promise<{ revision: number }>;
  changes: (input: { after: number; through?: number }) => Promise<{ through: number; next: number | null; changes: PrivateWorkspaceChange[] }>;
};
/** Account-scoped encrypted replica and durable outbox. The host supplies an
 * inter-window lock for the entire operation (Web Locks on web/desktop). Never
 * point this at a legacy shared queue or trust member keys from a feed response.
 * All plaintext views are returned on demand; the replica caches no unlocked
 * values between calls. The encrypted storage size bound applies to the state. */
export async function createPrivateWorkspaceReplica(options: {
  storage: KeyValueStorage; scope: PrivateStorageScope; exclusive: QueueExclusive;
  resolveStorageKey: () => PrivateStorageKey | null;
  resolveIdentity: () => PrivateReplicaIdentity | null;
}) {
  const { userId, workspaceId } = options.scope;
  const storage = await createPrivateStorage({ storage: options.storage, scope: options.scope, resolveKey: options.resolveStorageKey });
  const identity = () => {
    const value = options.resolveIdentity();
    if (!value || !value.current()) throw new PrivateStorageLockedError();
    return { ...value, check: () => { if (!value.current()) throw new PrivateStorageLockedError(); } };
  };
  const load = async (): Promise<State> => {
    const raw = await storage.getItem("replica");
    return raw === null ? { v: 1, revision: 0, records: [], pending: [] } : stateSchema.parse(JSON.parse(raw));
  };
  const save = (state: State) => storage.setItem("replica", JSON.stringify(state));
  const pull = async (transport: PrivateReplicaTransport, through?: number) => {
    const access = identity(), state = await load(); access.check();
    const page = await transport.changes({ after: state.revision, ...(through === undefined ? {} : { through }) }); access.check();
    if (!Number.isSafeInteger(page.through) || page.through < state.revision || (through !== undefined && page.through !== through) || page.changes.length > 20) throw new Error("Invalid private workspace feed boundary");
    const records = new Map(state.records.map((row) => [address(row), row]));
    for (const input of page.changes) {
      const key = access.signingKey(input.manifest.userId);
      if (!key) throw new Error("Verify this member's signing key before syncing");
      const change = await verifyPrivateWorkspaceChange(input, { workspaceId, userId, after: state.revision }, key); access.check();
      if (change.revision > page.through) throw new Error("Private workspace feed exceeds its boundary");
      // Authenticate ciphertext before advancing a durable checkpoint.
      for (const row of change.records) { await decryptPrivateRecord(workspaceId, row, userId, access.privateKey); access.check(); records.set(address(row), row); }
      for (const row of change.manifest.remove) if (row.readers.includes(userId)) records.delete(address(row));
      const waiting = state.pending.find((row) => row.operationId === change.manifest.operationId && change.manifest.userId === userId);
      if (waiting) {
        if (waiting !== state.pending[0] || !waiting.submitted || canonicalJson(privateWorkspaceManifestForReader(await privateWorkspaceManifest(waiting.submitted.edit), userId)) !== canonicalJson(change.manifest)) throw new Error("Received edit does not match the durable outbox");
        state.pending.shift();
      }
      state.revision = change.revision;
    }
    if (page.next !== (state.revision < page.through ? state.revision : null) || (state.revision < page.through && !page.changes.length)) throw new Error("Private workspace feed omitted revisions");
    state.records = [...records.values()]; access.check(); await save(state); access.check();
    return { revision: state.revision, through: page.through, next: page.next, pending: state.pending.length };
  };
  return {
    namespace: storage.namespace,
    enqueue: async (input: { records: PlainPrivateRecord[]; remove?: z.infer<typeof privateRecordRefSchema>[] }) => {
      // Capture user intent synchronously, before waiting on storage or another
      // window's lock. No caller-owned nested object survives into the outbox.
      const snapshot = structuredClone(z.object({ records: z.array(plainSchema).max(100), remove: z.array(privateRecordRefSchema).max(100).optional() }).strict().parse(input));
      return options.exclusive(async () => {
        const access = identity(), state = await load(); access.check();
        const records = z.array(plainSchema).max(100).parse(snapshot.records), remove = z.array(privateRecordRefSchema).max(100).parse(snapshot.remove ?? []);
        if (!records.length && !remove.length) throw new Error("Empty private workspace edit");
        const seen = new Set<string>();
        for (const row of [...records, ...remove]) { const key = address(row); if (seen.has(key)) throw new Error("Duplicate private workspace record"); seen.add(key); }
        if (state.pending.length >= 1000) throw new Error("Sync or export pending private edits before adding more");
        const operationId = crypto.randomUUID();
        state.pending.push({ operationId, basedOn: state.revision + state.pending.length, records, remove, submitted: null });
        access.check(); await save(state); access.check(); return operationId;
      });
    },
    read: () => options.exclusive(async () => {
      const access = identity(), state = await load(); access.check();
      const values = new Map<string, PlainPrivateRecord>();
      for (const row of state.records) { values.set(address(row), await decryptPrivateRecord(workspaceId, row, userId, access.privateKey)); access.check(); }
      for (const pending of state.pending) {
        for (const row of pending.records) values.set(address(row), row);
        for (const row of pending.remove) values.delete(address(row));
      }
      return { revision: state.revision, pending: state.pending.length, conflict: !!state.pending.length && state.pending[0]!.basedOn !== state.revision, records: [...values.values()] };
    }),
    pull: (transport: PrivateReplicaTransport, through?: number) => options.exclusive(() => pull(transport, through)),
    flushOne: (transport: PrivateReplicaTransport) => options.exclusive(async () => {
      const access = identity(), state = await load(); access.check();
      const first = state.pending[0]; if (!first) return { revision: state.revision, pending: 0 };
      // No automatic rebasing: an offline edit must not silently overwrite
      // work made on another device. Keep the exact input for explicit repair.
      if (first.basedOn !== state.revision) throw new PrivateReplicaConflictError();
      if (!first.submitted) {
        const records = [];
        for (const row of first.records) { records.push(await encryptPrivateRecord(workspaceId, row, access.recipients, state.revision + 1)); access.check(); }
        const remove = first.remove.map((row) => ({ ...row, readers: readersForPrivateRecord(row.kind, row.authorId, access.recipients).map((member) => member.userId).sort() }));
        first.submitted = await signPrivateWorkspaceEdit({ v: 1, workspaceId, userId, operationId: first.operationId, expectedRevision: state.revision, records, remove }, access.signingPrivateKey, access.recipients.map((member) => member.userId)); access.check();
        await save(state); access.check();
      }
      // An uncertain HTTP reply never drops the submitted edit. Its operation
      // ID, ciphertext, timestamps and signature are reused after restart.
      const reply = await transport.commit(first.submitted); access.check();
      if (reply.revision !== first.basedOn + 1) throw new Error("Invalid private workspace receipt");
      const result = await pull(transport); access.check();
      if (result.revision < reply.revision || result.pending !== state.pending.length - 1) throw new Error("Private workspace receipt has no verified journal record");
      return { revision: result.revision, pending: result.pending };
    }),
  };
}
