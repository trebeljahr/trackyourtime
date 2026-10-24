import { z } from "zod";
import { canWritePrivateRecord, encryptedRecordSchema, privateRecordRefSchema, privateWorkspaceChainSchema, signedPrivateWorkspaceEditSchema, type PrivateWorkspaceChange, type PrivateChainedWorkspaceChange, type SignedPrivateChainedEdit } from "@starter/shared";
import type { QueueExclusive } from "../durable-entry.js";
import type { KeyValueStorage } from "../storage.js";
import { canonicalJson, type PublicKey } from "./crypto.js";
import { createPrivateStorage, PrivateStorageLockedError, type PrivateStorageKey, type PrivateStorageScope } from "./storage.js";
import { decryptPrivateRecord, encryptPrivateRecord, readersForPrivateRecord, type PlainPrivateRecord, type PrivateRecipient } from "./records.js";
import { segmentedPrivateStorage } from "./segmented-storage.js";
import { privateWorkspaceManifest, privateWorkspaceManifestForReader, signPrivateWorkspaceEdit, verifyPrivateWorkspaceChange } from "./workspace-edits.js";
import { assertPrivateInitialSnapshot, type VerifiedPrivateInitialSnapshot } from "./initial-snapshot.js";
import { privateWorkspaceChainRoot, signPrivateChainedWorkspaceEdit, verifyPrivateChainedWorkspaceChange } from "./history-chain.js";
import type { VerifiedPrivateDirectory } from "./directory.js";
const plainSchema = privateRecordRefSchema.extend({ value: z.record(z.string(), z.json()) }).strict();
const pendingSchema = z.object({ operationId: z.uuid(), basedOn: z.number().int().nonnegative(), records: z.array(plainSchema).max(100), remove: z.array(privateRecordRefSchema).max(100), submitted: signedPrivateWorkspaceEditSchema.nullable(), chain: privateWorkspaceChainSchema.nullable().default(null), directoryDigest: z.string().nullable().default(null) }).strict();
const stateSchema = z.object({ v: z.literal(1), revision: z.number().int().nonnegative(), head: z.string().regex(/^[A-Za-z0-9_-]{43}$/).nullable().default(null), records: z.array(encryptedRecordSchema), pending: z.array(pendingSchema).max(1000) }).strict();
type State = z.infer<typeof stateSchema>;
const address = (row: { kind: string; id: string }) => JSON.stringify([row.kind, row.id]);
export class PrivateReplicaConflictError extends Error {
  constructor() { super("The workspace changed while this edit was offline. The queued edit was kept for review."); this.name = "PrivateReplicaConflictError"; }
}
export class PrivateReplicaDirectoryChangedError extends Error {
  constructor() { super("Workspace sharing keys changed. The queued edit was kept for review."); this.name = "PrivateReplicaDirectoryChangedError"; }
}
export type PrivateReplicaIdentity = {
  directoryDigest: string;
  directory?: VerifiedPrivateDirectory;
  privateKey: PublicKey; signingPrivateKey: PublicKey;
  /** Verified recipient directory, independent of the untrusted change feed. */
  recipients: readonly PrivateRecipient[];
  signingKey: (userId: string) => PublicKey | null;
  current: () => boolean;
};
export type PrivateReplicaTransport = {
  commit: (input: z.infer<typeof signedPrivateWorkspaceEditSchema>) => Promise<{ revision: number }>;
  changes: (input: { after: number; through?: number }) => Promise<{ through: number; next: number | null; changes: PrivateWorkspaceChange[] }>;
  chainedCommit?: (input: SignedPrivateChainedEdit) => Promise<{ revision: number; head: string }>;
  chainedChanges?: (input: { after: number; through?: number }) => Promise<{ through: number; next: number | null; changes: PrivateChainedWorkspaceChange[] }>;
};
/** Account-scoped encrypted replica and durable outbox. The host supplies an
 * inter-window lock for the entire operation (Web Locks on web/desktop). Never
 * point this at a legacy shared queue or trust member keys from a feed response.
 * All plaintext views are returned on demand; the replica caches no unlocked
 * values between calls. Each bounded part is encrypted; the segmented state size bound applies. */
export async function createPrivateWorkspaceReplica(options: {
  storage: KeyValueStorage; scope: PrivateStorageScope; exclusive: QueueExclusive;
  resolveStorageKey: () => PrivateStorageKey | null;
  resolveIdentity: () => PrivateReplicaIdentity | null;
}) {
  const scope = { ...options.scope };
  const { userId, workspaceId } = scope;
  const encrypted = await createPrivateStorage({ storage: options.storage, scope, resolveKey: options.resolveStorageKey });
  const storage = segmentedPrivateStorage(encrypted, () => identity().check);
  const identity = () => {
    const value = options.resolveIdentity();
    if (!value || !value.current()) throw new PrivateStorageLockedError();
    return { ...value, check: () => { if (!value.current()) throw new PrivateStorageLockedError(); } };
  };
  const load = async (): Promise<State> => {
    const raw = await storage.getItem("replica");
    return raw === null ? { v: 1, revision: 0, head: null, records: [], pending: [] } : stateSchema.parse(JSON.parse(raw));
  };
  const save = (state: State) => storage.setItem("replica", JSON.stringify(state));
  const pull = async (transport: PrivateReplicaTransport, through?: number) => {
    const access = identity(), state = await load(); access.check();
    if (state.head !== null && (!transport.chainedChanges || !access.directory)) throw new Error("This workspace requires verified chained history; stored data was kept");
    const query = { after: state.revision, ...(through === undefined ? {} : { through }) };
    const page = state.head === null ? await transport.changes(query) : await transport.chainedChanges!(query); access.check();
    if (!Number.isSafeInteger(page.through) || page.through < state.revision || (through !== undefined && page.through !== through) || page.changes.length > 20) throw new Error("Invalid private workspace feed boundary");
    const records = new Map(state.records.map((row) => [address(row), row]));
    for (const input of page.changes) {
      const key = access.signingKey(input.manifest.userId);
      if (!key) throw new Error("Verify this member's signing key before syncing");
      const chained = state.head === null ? null : await verifyPrivateChainedWorkspaceChange(input, { ...scope, after: state.revision, previousRoot: state.head, directory: access.directory! }); access.check();
      const change = chained ?? await verifyPrivateWorkspaceChange(input, { workspaceId, userId, after: state.revision }, key); access.check();
      if (change.revision > page.through) throw new Error("Private workspace feed exceeds its boundary");
      // Authenticate ciphertext before advancing a durable checkpoint.
      for (const row of [...change.records, ...change.manifest.remove]) {
        const prior = records.get(address(row));
        if (prior && prior.authorId !== row.authorId) throw new Error("Private history cannot replace or remove another author's record");
      }
      for (const row of change.records) { await decryptPrivateRecord(workspaceId, row, userId, access.privateKey); access.check(); records.set(address(row), row); }
      for (const row of change.manifest.remove) if (row.readers.includes(userId)) records.delete(address(row));
      const waiting = state.pending.find((row) => row.operationId === change.manifest.operationId && change.manifest.userId === userId);
      if (waiting) {
        if (waiting !== state.pending[0] || !waiting.submitted || canonicalJson(privateWorkspaceManifestForReader(await privateWorkspaceManifest(waiting.submitted.edit), userId)) !== canonicalJson(change.manifest)) throw new Error("Received edit does not match the durable outbox");
        if (chained && (!waiting.chain || canonicalJson(waiting.chain.header) !== canonicalJson(chained.chain.header))) throw new Error("Received history binding does not match the durable outbox");
        state.pending.shift();
      }
      state.revision = change.revision;
      if (chained) state.head = chained.head;
    }
    if (page.next !== (state.revision < page.through ? state.revision : null) || (state.revision < page.through && !page.changes.length)) throw new Error("Private workspace feed omitted revisions");
    state.records = [...records.values()]; access.check(); await save(state); access.check();
    return { revision: state.revision, through: page.through, next: page.next, pending: state.pending.length };
  };
  return {
    namespace: encrypted.namespace,
    bootstrap: (snapshot: VerifiedPrivateInitialSnapshot) => options.exclusive(async () => {
      const access = identity(), state = await load(); access.check();
      assertPrivateInitialSnapshot(snapshot, scope, access.directoryDigest);
      if (state.pending.length) throw new Error("Keep or export pending edits before installing an initial snapshot");
      if (state.revision === 1 && state.head === snapshot.signed.manifest.root && canonicalJson(state.records) === canonicalJson(snapshot.records)) return { revision: 1 as const };
      if (state.revision !== 0 || state.records.length) throw new Error("An initial snapshot cannot replace an existing private checkpoint");
      await save({ v: 1, revision: 1, head: snapshot.signed.manifest.root, records: [...snapshot.records], pending: [] }); access.check();
      return { revision: 1 as const };
    }),
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
        if (state.head !== null) {
          const actor = access.directory?.signed.directory.members.find((member) => member.userId === userId);
          if (!actor || [...records, ...remove].some((row) => !canWritePrivateRecord(row.kind, row.authorId, actor))) throw new Error("Verified workspace permissions forbid this private edit");
          const known = new Map(state.records.map((row) => [address(row), row.authorId]));
          for (const pending of state.pending) {
            for (const row of pending.records) known.set(address(row), row.authorId);
            for (const row of pending.remove) known.delete(address(row));
          }
          for (const row of [...records, ...remove]) if (known.has(address(row)) && known.get(address(row)) !== row.authorId) throw new Error("A private edit cannot replace another author's record");
        }
        if (state.pending.length >= 1000) throw new Error("Sync or export pending private edits before adding more");
        const operationId = crypto.randomUUID();
        state.pending.push({ operationId, basedOn: state.revision + state.pending.length, records, remove, submitted: null, chain: null, directoryDigest: null });
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
      return { revision: state.revision, head: state.head, pending: state.pending.length, conflict: !!state.pending.length && (state.pending[0]!.basedOn !== state.revision || (!!state.pending[0]!.submitted && state.pending[0]!.directoryDigest !== access.directoryDigest)), records: [...values.values()] };
    }),
    pull: (transport: PrivateReplicaTransport, through?: number) => options.exclusive(() => pull(transport, through)),
    flushOne: (transport: PrivateReplicaTransport) => options.exclusive(async () => {
      const access = identity(), state = await load(); access.check();
      const first = state.pending[0]; if (!first) return { revision: state.revision, pending: 0 };
      // No automatic rebasing: an offline edit must not silently overwrite
      // work made on another device. Keep the exact input for explicit repair.
      if (first.basedOn !== state.revision) throw new PrivateReplicaConflictError();
      if (first.submitted && first.directoryDigest !== access.directoryDigest) throw new PrivateReplicaDirectoryChangedError();
      if (state.head !== null && (!transport.chainedCommit || !transport.chainedChanges || !access.directory)) throw new Error("This workspace requires verified chained history; stored data was kept");
      if (!first.submitted) {
        const records = [];
        for (const row of first.records) { records.push(await encryptPrivateRecord(workspaceId, row, access.recipients, state.revision + 1)); access.check(); }
        const remove = first.remove.map((row) => ({ ...row, readers: readersForPrivateRecord(row.kind, row.authorId, access.recipients).map((member) => member.userId).sort() }));
        const edit = { v: 1 as const, workspaceId, userId, operationId: first.operationId, expectedRevision: state.revision, records, remove };
        if (state.head === null) first.submitted = await signPrivateWorkspaceEdit(edit, access.signingPrivateKey, access.recipients.map((member) => member.userId));
        else {
          const { chain, ...submitted } = await signPrivateChainedWorkspaceEdit({ edit, previousRoot: state.head, directory: access.directory!, secrets: access, current: access.current });
          first.submitted = submitted; first.chain = chain;
        }
        access.check();
        first.directoryDigest = access.directoryDigest;
        await save(state); access.check();
      }
      // An uncertain HTTP reply never drops the submitted edit. Its operation
      // ID, ciphertext, timestamps and signature are reused after restart.
      let reply: { revision: number; head?: string };
      if (state.head === null) reply = await transport.commit(first.submitted);
      else {
        if (!first.chain || first.chain.header.previousRoot !== state.head) throw new Error("Queued history does not extend this checkpoint; the edit was kept");
        reply = await transport.chainedCommit!({ ...first.submitted, chain: first.chain }); access.check();
        if (reply.head !== await privateWorkspaceChainRoot(first.chain)) throw new Error("Invalid private workspace history receipt");
      }
      access.check();
      if (reply.revision !== first.basedOn + 1) throw new Error("Invalid private workspace receipt");
      const result = await pull(transport); access.check();
      if (result.revision < reply.revision || result.pending !== state.pending.length - 1) throw new Error("Private workspace receipt has no verified journal record");
      return { revision: result.revision, pending: result.pending };
    }),
  };
}
