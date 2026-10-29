import { z } from "zod";
import { canWritePrivateRecord, encryptedRecordSchema, privateKindSchema, PRIVATE_KINDS, type PrivateKind, privateRecordRefSchema, privateWorkspaceChainSchema, signedPrivateWorkspaceEditSchema, type PrivateWorkspaceChange, type PrivateChainedWorkspaceChange, type SignedPrivateChainedEdit } from "@starter/shared";
import type { QueueExclusive } from "../durable-entry.js";
import type { KeyValueStorage } from "../storage.js";
import { canonicalJson, type PublicKey } from "./crypto.js";
import { createPrivateStorage, PrivateStorageLockedError, type PrivateStorageKey, type PrivateStorageScope } from "./storage.js";
import { decryptPrivateRecord, encryptPrivateRecord, readersForPrivateRecord, type PlainPrivateRecord, type PrivateRecipient } from "./records.js";
import { segmentedPrivateStorage } from "./segmented-storage.js";
import { privateWorkspaceManifest, privateWorkspaceManifestForReader, signPrivateWorkspaceEdit, verifyPrivateWorkspaceChange } from "./workspace-edits.js";
import { assertPrivateProjectionSnapshot, type VerifiedPrivateProjectionSnapshot } from "./projection-snapshot.js";
import { assertPrivateInitialSnapshot, type VerifiedPrivateInitialSnapshot } from "./initial-snapshot.js";
import { privateWorkspaceChainRoot, signPrivateChainedWorkspaceEdit, verifyPrivateChainedWorkspaceChange } from "./history-chain.js";
import type { VerifiedPrivateDirectory } from "./directory.js";
import { assertPrivateTimerStagePermit, type PrivateTimerStagePermit } from "./timer-store.js";
const plainSchema = privateRecordRefSchema.extend({ value: z.record(z.string(), z.json()) }).strict();
const pendingSchema = z.object({ operationId: z.uuid(), basedOn: z.number().int().nonnegative(), records: z.array(plainSchema).max(100), remove: z.array(privateRecordRefSchema).max(100), submitted: signedPrivateWorkspaceEditSchema.nullable(), chain: privateWorkspaceChainSchema.nullable().default(null), directoryDigest: z.string().nullable().default(null), coordinatorId: z.uuid().optional() }).strict();
const coordinatedReceiptSchema = z.object({ coordinatorId: z.uuid(), operationId: z.uuid(), revision: z.number().int().positive(), head: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const coordinatedProofSchema = coordinatedReceiptSchema.omit({ revision: true, head: true }).extend({ expectedRevision: z.number().int().positive(), previousRoot: z.string().regex(/^[A-Za-z0-9_-]{43}$/), bindingHead: z.string().regex(/^[A-Za-z0-9_-]{43}$/), revision: z.number().int().positive(), head: z.string().regex(/^[A-Za-z0-9_-]{43}$/), through: z.number().int().positive(), throughHead: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const stateSchema = z.object({ v: z.literal(1), revision: z.number().int().nonnegative(), head: z.string().regex(/^[A-Za-z0-9_-]{43}$/).nullable().default(null), activationRoot: z.string().regex(/^[A-Za-z0-9_-]{43}$/).nullable().default(null), records: z.array(encryptedRecordSchema), pending: z.array(pendingSchema).max(1000), coordinatedReceipts: z.array(coordinatedReceiptSchema).max(1000).optional(), coordinatedProofs: z.array(coordinatedProofSchema).max(32).optional(), coordinatedReceiptPins: z.array(z.uuid()).max(32).optional() }).strict().refine((state) => state.revision !== 0 || (state.head === null && state.records.length === 0), "Private replica zero checkpoint contains committed data").refine((state) => !state.activationRoot || (!!state.head && state.revision >= 1 && (state.revision !== 1 || state.head === state.activationRoot)), "Private replica activation checkpoint is inconsistent")
  .refine(state => (state.coordinatedReceipts ?? []).every((row, index, rows) => row.revision <= state.revision && (row.revision !== state.revision || row.head === state.head) && (index === 0 || rows[index - 1]!.revision < row.revision)) && new Set((state.coordinatedReceipts ?? []).map(row => row.coordinatorId)).size === (state.coordinatedReceipts?.length ?? 0), "Coordinated receipts differ from the confirmed workspace history")
  .refine(state => (state.coordinatedProofs ?? []).every(row => row.revision > row.expectedRevision && row.revision < row.through && row.through <= state.revision && (row.through !== state.revision || row.throughHead === state.head)) && new Set((state.coordinatedProofs ?? []).map(row => row.coordinatorId)).size === (state.coordinatedProofs?.length ?? 0), "Coordinated proof differs from its saved workspace checkpoint")
  .refine(state => new Set(state.coordinatedReceiptPins ?? []).size === (state.coordinatedReceiptPins?.length ?? 0), "Duplicate coordinated receipt pins");
export const privateReplicaRecoveryStateSchema = stateSchema;
export type PrivateReplicaRecoveryState = z.infer<typeof stateSchema>;
type State = PrivateReplicaRecoveryState;
type PrivateMutationPlan<T> = { records: PlainPrivateRecord[]; remove?: z.infer<typeof privateRecordRefSchema>[]; result: T };
/** Outstanding account packets may be older than the rolling receipt tail.
 * Keep their bounded receipts until the account gate replaces its pin set. */
function retainCoordinatedReceipts(state: State, incoming: z.infer<typeof coordinatedReceiptSchema>) {
  const rows = [...(state.coordinatedReceipts ?? []).filter(row => row.coordinatorId !== incoming.coordinatorId), incoming];
  const pins = new Set(state.coordinatedReceiptPins ?? []), retained = rows.filter(row => pins.has(row.coordinatorId) || row.coordinatorId === incoming.coordinatorId);
  const selected = new Set(retained.map(row => row.coordinatorId));
  retained.push(...rows.filter(row => !selected.has(row.coordinatorId)).slice(-(1000 - retained.length)));
  return retained.sort((a, b) => a.revision - b.revision);
}
const address = (row: { kind: string; id: string }) => JSON.stringify([row.kind, row.id]);
export class PrivateReplicaConflictError extends Error {
  constructor() { super("The workspace changed while this edit was offline. The queued edit was kept for review."); this.name = "PrivateReplicaConflictError"; }
}
export class PrivateReplicaDirectoryChangedError extends Error {
  constructor() { super("Workspace sharing keys changed. The queued edit was kept for review."); this.name = "PrivateReplicaDirectoryChangedError"; }
}
export class PrivateTimerHistoryProofPendingError extends Error {
  constructor() { super("Verifying retained timer history; existing work was kept"); this.name = "PrivateTimerHistoryProofPendingError"; }
}
export class PrivateReplicaCoordinatedEditError extends Error {
  constructor() { super("This timer packet must commit through the account coordinator"); this.name = "PrivateReplicaCoordinatedEditError"; }
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
  /** Root-specific staging uses the final slot before any irreversible pin.
   * The default remains readable for earlier local-only replicas. */
  storageKey?: string;
  resolveStorageKey: () => PrivateStorageKey | null;
  resolveIdentity: () => PrivateReplicaIdentity | null;
}) {
  const scope = { ...options.scope };
  const { userId, workspaceId } = scope;
  const storageKey = options.storageKey ?? "replica";
  if (!/^replica(?::[A-Za-z0-9_-]{43})?$/.test(storageKey)) throw new Error("Invalid private replica storage slot");
  const encrypted = await createPrivateStorage({ storage: options.storage, scope, resolveKey: options.resolveStorageKey });
  const storage = segmentedPrivateStorage(encrypted, () => identity().check);
  const identity = () => {
    const value = options.resolveIdentity();
    if (!value || !value.current()) throw new PrivateStorageLockedError();
    return { ...value, check: () => { if (!value.current()) throw new PrivateStorageLockedError(); } };
  };
  const withAccess = async <T>(work: (access: ReturnType<typeof identity>) => Promise<T>) => {
    const access = identity();
    return options.exclusive(async () => { access.check(); const result = await work(access); access.check(); return result; });
  };
  const load = async (): Promise<State> => {
    const raw = await storage.getItem(storageKey);
    const state = raw === null ? { v: 1 as const, revision: 0, head: null, activationRoot: null, records: [], pending: [] } : stateSchema.parse(JSON.parse(raw));
    if (state.activationRoot && storageKey !== "replica" && storageKey !== `replica:${state.activationRoot}`) throw new Error("Private history differs from its storage root; the copy was kept");
    return state;
  };
  const save = (state: State) => storage.setItem(storageKey, JSON.stringify(state));
  const pull = async (transport: PrivateReplicaTransport, through: number | undefined, access: ReturnType<typeof identity>) => {
    const state = await load(); access.check();
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
        if (waiting.coordinatorId) {
          if (!chained) throw new PrivateReplicaCoordinatedEditError();
          state.coordinatedReceipts = retainCoordinatedReceipts(state, { coordinatorId: waiting.coordinatorId, operationId: waiting.operationId, revision: change.revision, head: chained.head });
        }
        state.pending.shift();
      }
      state.revision = change.revision;
      if (chained) state.head = chained.head;
    }
    if (page.next !== (state.revision < page.through ? state.revision : null) || (state.revision < page.through && !page.changes.length)) throw new Error("Private workspace feed omitted revisions");
    state.records = [...records.values()]; access.check(); await save(state); access.check();
    return { revision: state.revision, through: page.through, next: page.next, pending: state.pending.length };
  };
  const installInitial = async (state: State, root: string, records: readonly z.infer<typeof encryptedRecordSchema>[]) => {
    const access = identity(); access.check();
    if (storageKey !== "replica" && storageKey !== `replica:${root}`) throw new Error("Initial snapshot differs from its private storage root");
    if (state.pending.length) throw new Error("Keep or export pending edits before installing an initial snapshot");
    if (state.revision === 1 && state.head === root && canonicalJson(state.records) === canonicalJson(records)) {
      if (!state.activationRoot) { await save({ ...state, activationRoot: root }); access.check(); }
      return { revision: 1 as const };
    }
    if (state.revision !== 0 || state.records.length) throw new Error("An initial snapshot cannot replace an existing private checkpoint");
    await save({ v: 1, revision: 1, head: root, activationRoot: root, records: [...records], pending: [] }); access.check();
    return { revision: 1 as const };
  };
  const materialize = async (state: State, access: ReturnType<typeof identity>, kinds?: ReadonlySet<PrivateKind>) => {
    const values = new Map<string, PlainPrivateRecord>();
    for (const row of state.records) { if (kinds && !kinds.has(row.kind)) continue; values.set(address(row), await decryptPrivateRecord(workspaceId, row, userId, access.privateKey)); access.check(); }
    for (const pending of state.pending) {
      for (const row of pending.records) if (!kinds || kinds.has(row.kind)) values.set(address(row), row);
      for (const row of pending.remove) if (!kinds || kinds.has(row.kind)) values.delete(address(row));
    }
    access.check(); return { revision: state.revision, head: state.head, pending: state.pending.length, conflict: !!state.pending.length && (state.pending[0]!.basedOn !== state.revision || (!!state.pending[0]!.submitted && state.pending[0]!.directoryDigest !== access.directoryDigest)), records: structuredClone([...values.values()]) };
  };
  const append = async (state: State, access: ReturnType<typeof identity>, snapshot: { records: PlainPrivateRecord[]; remove?: z.infer<typeof privateRecordRefSchema>[] }, coordinated?: { permit: PrivateTimerStagePermit; signed: SignedPrivateChainedEdit }) => {
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
    const operationId = coordinated?.signed.edit.operationId ?? crypto.randomUUID();
    const signed = coordinated ? (({ chain: _chain, ...edit }) => { void _chain; return edit; })(coordinated.signed) : null;
    state.pending.push({ operationId, basedOn: state.revision + state.pending.length, records, remove, submitted: signed, chain: coordinated?.signed.chain ?? null, directoryDigest: coordinated ? access.directoryDigest : null, ...(coordinated ? { coordinatorId: coordinated.permit.transition.signed.header.operationId } : {}) });
    access.check(); await save(state); access.check(); return operationId;
  };
  const sealPending = async (node: State["pending"][number], access: ReturnType<typeof identity>, revision: number, previousRoot: string | null) => {
    if (node.basedOn !== revision) throw new PrivateReplicaConflictError();
    if (node.submitted && node.directoryDigest !== access.directoryDigest) throw new PrivateReplicaDirectoryChangedError();
    if (!node.submitted) {
      const records = [];
      for (const row of node.records) { records.push(await encryptPrivateRecord(workspaceId, row, access.recipients, revision + 1)); access.check(); }
      const remove = node.remove.map(row => ({ ...row, readers: readersForPrivateRecord(row.kind, row.authorId, access.recipients).map(member => member.userId).sort() }));
      const edit = { v: 1 as const, workspaceId, userId, operationId: node.operationId, expectedRevision: revision, records, remove };
      if (previousRoot === null) node.submitted = await signPrivateWorkspaceEdit(edit, access.signingPrivateKey, access.recipients.map(member => member.userId));
      else {
        if (!access.directory) throw new Error("Private timer staging needs its verified directory");
        const { chain, ...submitted } = await signPrivateChainedWorkspaceEdit({ edit, previousRoot, directory: access.directory, secrets: access, current: access.current });
        node.submitted = submitted; node.chain = chain;
      }
      node.directoryDigest = access.directoryDigest; access.check();
    }
    if (node.submitted.edit.operationId !== node.operationId || node.submitted.edit.workspaceId !== workspaceId || node.submitted.edit.userId !== userId || node.submitted.edit.expectedRevision !== revision || (previousRoot !== null && (!node.chain || node.chain.header.previousRoot !== previousRoot))) throw new Error("Pending private packet differs from its original checkpoint");
    return node.chain ? privateWorkspaceChainRoot(node.chain) : null;
  };
  const coordinatedReceipt = async (state: State, permit: PrivateTimerStagePermit) => {
    assertPrivateTimerStagePermit(permit, scope);
    const edit = permit.transition.edits.find(row => row.edit.workspaceId === workspaceId);
    if (!edit) throw new Error("Timer staging does not include this workspace");
    const expected = { coordinatorId: permit.transition.signed.header.operationId, operationId: edit.edit.operationId, revision: edit.edit.expectedRevision + 1, head: await privateWorkspaceChainRoot(edit.chain) };
    if (state.pending.some(row => row.operationId === expected.operationId)) return null;
    const found = state.coordinatedReceipts?.find(row => row.coordinatorId === expected.coordinatorId);
    if (found && canonicalJson(found) !== canonicalJson(expected)) throw new Error("Timer workspace receipt differs from its signed account binding");
    return found ?? (state.revision === expected.revision && state.head === expected.head ? expected : null);
  };
  /** Capture before waiting: a queued read cannot revive after lock/re-unlock.
   * Narrow views decrypt only selected kinds, including their optimistic edits. */
  const readView = async (kinds?: ReadonlySet<PrivateKind>) => {
    const access = identity();
    return options.exclusive(async () => {
      access.check(); const state = await load(); access.check();
      return materialize(state, access, kinds);
    });
  };
  return {
    namespace: encrypted.namespace,
    exportRecovery: () => withAccess(async (access) => { const state = await load(); access.check(); return structuredClone(state); }),
    checkpoint: () => withAccess(async (access) => {
      const state = await load(); access.check();
      return { activationRoot: state.activationRoot, revision: state.revision, head: state.head, pending: state.pending.length };
    }),
    status: () => withAccess(async (access) => {
      const state = await load(); access.check();
      return { activationRoot: state.activationRoot, revision: state.revision, head: state.head, pending: state.pending.length,
        conflict: !!state.pending.length && (state.pending[0]!.basedOn !== state.revision || (!!state.pending[0]!.submitted && state.pending[0]!.directoryDigest !== access.directoryDigest)) };
    }),
    bootstrap: (snapshot: VerifiedPrivateInitialSnapshot) => withAccess(async (access) => {
      const state = await load(); access.check();
      assertPrivateInitialSnapshot(snapshot, scope, access.directoryDigest);
      return installInitial(state, snapshot.signed.manifest.root, snapshot.records);
    }),
    bootstrapProjection: (snapshot: VerifiedPrivateProjectionSnapshot) => withAccess(async (access) => {
      const state = await load(); access.check();
      assertPrivateProjectionSnapshot(snapshot, scope, access.directoryDigest);
      const records = [...snapshot.sharedRecords, ...snapshot.personalRecords].sort((a, b) => address(a) < address(b) ? -1 : address(a) > address(b) ? 1 : 0);
      return installInitial(state, snapshot.root, records);
    }),
    enqueue: async (input: { records: PlainPrivateRecord[]; remove?: z.infer<typeof privateRecordRefSchema>[] }) => {
      // Capture user intent synchronously, before waiting on storage or another
      // window's lock. No caller-owned nested object survives into the outbox.
      const snapshot = structuredClone(z.object({ records: z.array(plainSchema).max(100), remove: z.array(privateRecordRefSchema).max(100).optional() }).strict().parse(input));
      return withAccess(async (access) => {
        const state = await load(); access.check();
        return append(state, access, snapshot);
      });
    },
    /** Validate domain intent against the latest confirmed + optimistic view
     * and save it under the same cross-window lock. A separate read/enqueue
     * would lose order/uniqueness checks when two tabs edit simultaneously. Async
     * validation retains that lock; its original key epoch is checked afterward. */
    transact: <T>(kinds: readonly PrivateKind[], build: (view: { records: PlainPrivateRecord[]; directory: VerifiedPrivateDirectory }) => PrivateMutationPlan<T> | Promise<PrivateMutationPlan<T>>) => {
      const selected = new Set(z.array(privateKindSchema).min(1).max(PRIVATE_KINDS.length).parse(kinds));
      return withAccess(async (access) => {
        const state = await load(); access.check();
        if (!state.activationRoot || !state.head || !access.directory) throw new Error("Atomic private edits require a verified activation and directory");
        const view = await materialize(state, access, selected); access.check();
        if (view.conflict) throw new PrivateReplicaConflictError();
        const plan = await build({ records: view.records, directory: access.directory }); access.check();
        const frozen = structuredClone(plan);
        if ([...frozen.records, ...(frozen.remove ?? [])].some((row) => !selected.has(row.kind))) throw new Error("Private edit exceeds its validated domain view");
        const operationId = !frozen.records.length && !frozen.remove?.length ? null : await append(state, access, frozen);
        access.check(); return { operationId, result: frozen.result };
      });
    },
    read: () => readView(),
    readKinds: async (kinds: readonly PrivateKind[]) => readView(new Set(z.array(privateKindSchema).min(1).max(PRIVATE_KINDS.length).parse(kinds))),
    /** Seal earlier local work without sending it, so a later account packet
     * can bind its exact future workspace predecessor while still offline. */
    prepareTail: () => withAccess(async access => {
      const state = await load(); access.check();
      if (!state.activationRoot || !state.head || !access.directory) throw new Error("Coordinated timers require an activated private workspace");
      let revision = state.revision, head: string | null = state.head;
      for (const node of state.pending) { head = await sealPending(node, access, revision++, head); access.check(); }
      if (state.pending.length) { await save(state); access.check(); }
      return { revision, head: head!, activationRoot: state.activationRoot, pending: state.pending.length, directoryDigest: access.directoryDigest };
    }),
    stageCoordinated: (permit: PrivateTimerStagePermit) => {
      assertPrivateTimerStagePermit(permit, scope);
      const signed = structuredClone(permit.transition.edits.find(row => row.edit.workspaceId === workspaceId));
      if (!signed) throw new Error("Timer staging does not include this workspace");
      return withAccess(async access => {
        assertPrivateTimerStagePermit(permit, scope); const state = await load(); access.check();
        if (!state.activationRoot || !state.head || !access.directory) throw new Error("Coordinated timers require an activated private workspace");
        const prior = state.pending.find(row => row.operationId === signed.edit.operationId);
        if (prior) {
          if (prior.directoryDigest !== access.directoryDigest) throw new PrivateReplicaDirectoryChangedError();
          if (prior.coordinatorId !== permit.transition.signed.header.operationId || !prior.submitted || !prior.chain || canonicalJson({ ...prior.submitted, chain: prior.chain }) !== canonicalJson(signed)) throw new Error("Timer staging conflicts with the existing workspace outbox");
          return { operationId: prior.operationId, accepted: false };
        }
        if (await coordinatedReceipt(state, permit)) { access.check(); return { operationId: signed.edit.operationId, accepted: true }; }
        let revision = state.revision, head: string | null = state.head;
        for (const node of state.pending) { head = await sealPending(node, access, revision++, head); access.check(); }
        if (signed.edit.expectedRevision !== revision || signed.chain.header.previousRoot !== head) throw new PrivateReplicaConflictError();
        const { header } = permit.transition.signed;
        const targets = [header.previous, header.current].filter(row => row?.workspaceId === workspaceId).map(row => row!.entryId);
        if (signed.edit.records.some(row => row.authorId !== userId || !((row.kind === "imports" && row.id === `entryoperations:${header.operationId}`) || (["entries", "entryMoney"].includes(row.kind) && targets.includes(row.id)))) || signed.edit.remove.some(row => row.authorId !== userId || !["entries", "entryMoney"].includes(row.kind) || !targets.includes(row.id))) throw new Error("Timer staging contains unrelated records");
        const manifest = await privateWorkspaceManifest(signed.edit), reader = signed.readerSignatures.find(row => row.userId === userId);
        if (!reader) throw new Error("Timer staging is missing its author's signed projection");
        await verifyPrivateChainedWorkspaceChange({ revision: revision + 1, manifest: privateWorkspaceManifestForReader(manifest, userId), signature: reader.signature, records: signed.edit.records.filter(row => row.grants.some(grant => grant.userId === userId)), chain: signed.chain }, { ...scope, after: revision, previousRoot: head!, directory: access.directory }); access.check();
        const records = [];
        for (const row of signed.edit.records) { records.push(await decryptPrivateRecord(workspaceId, row, userId, access.privateKey)); access.check(); }
        const remove = signed.edit.remove.map(({ kind, id, authorId }) => ({ kind, id, authorId }));
        const operationId = await append(state, access, { records, remove }, { permit, signed });
        assertPrivateTimerStagePermit(permit, scope); return { operationId, accepted: false };
      });
    },
    /** Internal host operation under the account publication mutex. Supply
     * all retained packet IDs for this workspace from authenticated local
     * account state, never an API response. This pins metadata only. */
    pinCoordinatedReceipts: (operationIds: readonly string[]) => {
      const pins = z.array(z.uuid()).max(32).parse([...operationIds]).sort();
      if (new Set(pins).size !== pins.length) throw new Error("Duplicate coordinated receipt pins");
      return withAccess(async access => {
        const state = await load(); access.check();
        if (canonicalJson(state.coordinatedReceiptPins ?? []) === canonicalJson(pins)) return;
        if (pins.length) state.coordinatedReceiptPins = pins; else delete state.coordinatedReceiptPins;
        await save(state); access.check();
      });
    },
    coordinatedReceipt: (permit: PrivateTimerStagePermit) => {
      assertPrivateTimerStagePermit(permit, scope);
      return withAccess(async access => { const state = await load(); access.check(); const receipt = await coordinatedReceipt(state, permit); access.check(); return receipt ? structuredClone(receipt) : null; });
    },
    /** Recover a missing local receipt after restoring workspace history
     * ahead of the account outbox. Authenticate the exact packet, then every
     * link to an already saved workspace root. Never replace that checkpoint
     * or replay the old edit. Progress is encrypted and resumes after restart. */
    recoverCoordinatedReceipt: (permit: PrivateTimerStagePermit, transport: PrivateReplicaTransport) => {
      assertPrivateTimerStagePermit(permit, scope);
      const signed = structuredClone(permit.transition.edits.find(row => row.edit.workspaceId === workspaceId));
      if (!signed) throw new Error("Timer recovery does not include this workspace");
      return withAccess(async access => {
        assertPrivateTimerStagePermit(permit, scope); const state = await load(); access.check();
        const existing = await coordinatedReceipt(state, permit); access.check();
        if (existing) return { receipt: existing, next: null };
        if (!state.activationRoot || !state.head || !access.directory || !transport.chainedChanges) throw new Error("Timer receipt recovery requires verified chained workspace history");
        if (state.pending.some(row => row.operationId === signed.edit.operationId)) throw new Error("Pull the original coordinated workspace packet before recovering its receipt");
        const expected = { coordinatorId: permit.transition.signed.header.operationId, operationId: signed.edit.operationId, revision: signed.edit.expectedRevision + 1, head: await privateWorkspaceChainRoot(signed.chain) }; access.check();
        if (state.revision <= expected.revision) throw new PrivateReplicaConflictError();
        const anchor = { coordinatorId: expected.coordinatorId, operationId: expected.operationId, expectedRevision: signed.edit.expectedRevision, previousRoot: signed.chain.header.previousRoot, bindingHead: expected.head };
        let proof = state.coordinatedProofs?.find(row => row.coordinatorId === expected.coordinatorId);
        if (proof && Object.entries(anchor).some(([key, value]) => proof![key as keyof NonNullable<typeof proof>] !== value)) throw new Error("Keep the original timer history recovery binding");
        if (!proof && (state.coordinatedProofs?.length ?? 0) >= 32) throw new Error("Finish existing timer history proofs before recovering another");
        let revision = proof?.revision ?? signed.edit.expectedRevision, head = proof?.head ?? signed.chain.header.previousRoot;
        const through = proof?.through ?? state.revision, throughHead = proof?.throughHead ?? state.head;
        const projected = privateWorkspaceManifestForReader(await privateWorkspaceManifest(signed.edit), userId); access.check();
        for (let pages = 0; pages < 8; pages++) {
          const page = structuredClone(await transport.chainedChanges({ after: revision, through })); access.check(); assertPrivateTimerStagePermit(permit, scope);
          if (page.through !== through || !Array.isArray(page.changes) || !page.changes.length || page.changes.length > 20) throw new Error("Invalid timer history proof boundary");
          for (const input of page.changes) {
            const change = await verifyPrivateChainedWorkspaceChange(input, { ...scope, after: revision, previousRoot: head, directory: access.directory }); access.check();
            if (change.revision > through) throw new Error("Timer history proof exceeds its saved boundary");
            if (change.revision === expected.revision && (change.head !== expected.head || canonicalJson(change.manifest) !== canonicalJson(projected) || canonicalJson(change.chain.header) !== canonicalJson(signed.chain.header))) throw new Error("Timer history proof omitted its exact original packet");
            revision = change.revision; head = change.head;
          }
          if (page.next !== (revision < through ? revision : null)) throw new Error("Timer history proof omitted revisions");
          if (revision === through) {
            if (head !== throughHead) throw new Error("Timer history proof differs from the saved workspace root");
            state.coordinatedReceipts = retainCoordinatedReceipts(state, expected);
            if (state.coordinatedProofs) { state.coordinatedProofs = state.coordinatedProofs.filter(row => row.coordinatorId !== expected.coordinatorId); if (!state.coordinatedProofs.length) delete state.coordinatedProofs; }
            access.check(); await save(state); access.check(); assertPrivateTimerStagePermit(permit, scope);
            return { receipt: expected, next: null };
          }
          proof = { ...anchor, revision, head, through, throughHead };
          state.coordinatedProofs = [...(state.coordinatedProofs ?? []).filter(row => row.coordinatorId !== expected.coordinatorId), proof];
          access.check(); await save(state); access.check();
        }
        return { receipt: null, next: revision };
      });
    },
    pull: (transport: PrivateReplicaTransport, through?: number) => withAccess((access) => pull(transport, through, access)),
    flushOne: (transport: PrivateReplicaTransport) => withAccess(async (access) => {
      const state = await load(); access.check();
      const first = state.pending[0]; if (!first) return { revision: state.revision, pending: 0 };
      if (first.coordinatorId) throw new PrivateReplicaCoordinatedEditError();
      // No automatic rebasing: an offline edit must not silently overwrite
      // work made on another device. Keep the exact input for explicit repair.
      if (first.basedOn !== state.revision) throw new PrivateReplicaConflictError();
      if (first.submitted && first.directoryDigest !== access.directoryDigest) throw new PrivateReplicaDirectoryChangedError();
      if (state.head !== null && (!transport.chainedCommit || !transport.chainedChanges || !access.directory)) throw new Error("This workspace requires verified chained history; stored data was kept");
      if (!first.submitted) {
        await sealPending(first, access, state.revision, state.head);
        access.check();
        await save(state); access.check();
      }
      if (!first.submitted) throw new Error("The pending private edit was not durably sealed");
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
      const result = await pull(transport, undefined, access); access.check();
      if (result.revision < reply.revision || result.pending !== state.pending.length - 1) throw new Error("Private workspace receipt has no verified journal record");
      return { revision: result.revision, pending: result.pending };
    }),
  };
}
