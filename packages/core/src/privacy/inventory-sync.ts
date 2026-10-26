import { z } from "zod";
import { signedPrivateInventoryVersionSchema, type SignedPrivateInventoryVersion } from "@starter/shared";
import { canonicalJson, type PublicKey } from "./crypto.js";
import { createPrivateStorage, PrivateStorageIntegrityError, PrivateStorageLockedError, type PrivateStorageKey } from "./storage.js";
import { segmentedPrivateStorage } from "./segmented-storage.js";
import { encryptPrivateInventoryVersion, openPrivateInventoryVersion, type PrivateInventoryTransportCheckpoint } from "./inventory-version.js";
import { PRIVATE_ACCOUNT_INVENTORY_SCOPE, PrivateAccountInventoryMissingError, signedPrivateAccountInventorySchema, signPrivateAccountInventory, verifyPrivateAccountInventoryCheckpoint, verifyPrivateAccountInventoryEnrollment, verifyPrivateAccountInventoryUpdate, type PrivateAccountInventoryCheckpoint, type PrivateAccountWorkspace, type SignedPrivateAccountInventory, type VerifiedPrivateAccountInventory } from "./account-inventory.js";
import { privateRecordDigest } from "./workspace-edits.js";
import type { QueueExclusive } from "../durable-entry.js";
import type { KeyValueStorage } from "../storage.js";
const checkpointSchema = z.object({ revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), root: z.string().regex(/^[A-Za-z0-9_-]{43}$/).nullable() }).strict();
const stateSchema = z.object({
  v: z.literal(1), local: signedPrivateAccountInventorySchema,
  confirmed: z.object({ checkpoint: checkpointSchema, version: signedPrivateInventoryVersionSchema.nullable() }).strict(),
  pending: z.array(signedPrivateInventoryVersionSchema).max(8), conflict: signedPrivateInventoryVersionSchema.nullable(),
}).strict();
type State = z.infer<typeof stateSchema>;
type Scope = { server: string; userId: string };
export type PrivateInventorySyncIdentity = { master: Uint8Array; signingPrivateKey: PublicKey; signingPublicKey: PublicKey; current: () => boolean; release?: () => void };
export type PrivateInventoryTransport = {
  commit: (signed: SignedPrivateInventoryVersion) => Promise<{ revision: number; root: string }>;
  versions: (input: { after: number; through?: number }) => Promise<{ through: number; root: string | null; next: number | null; versions: SignedPrivateInventoryVersion[] }>;
};
export class PrivateInventoryConflictError extends Error {
  constructor() { super("Account workspace inventory needs review. Existing data and pending encrypted versions were kept."); this.name = "PrivateInventoryConflictError"; }
}
const MAX_STATE_BYTES = 12 * 1024 * 1024;
/** Current checks returned with verified values must not retain private keys. */
function checks(capture: () => void, current: () => boolean) {
  const check = () => { capture(); if (!current()) throw new PrivateStorageLockedError(); };
  return { check, alive: () => { try { check(); return true; } catch { return false; } } };
}
/** One atomically published encrypted state contains local intent, exact pending
 * envelopes and confirmed checkpoint. No legacy queue or memory fallback. The
 * account-wide host lock must cover every method, across workspace windows. */
export async function createPrivateAccountInventorySync(options: Scope & {
  storage: KeyValueStorage; exclusive: QueueExclusive; capture: () => () => void;
  resolveStorageKey: () => PrivateStorageKey | null; resolveIdentity: () => PrivateInventorySyncIdentity | null;
}) {
  const scope = { server: options.server, userId: options.userId };
  const encrypted = await createPrivateStorage({ storage: options.storage, scope: { ...scope, workspaceId: PRIVATE_ACCOUNT_INVENTORY_SCOPE }, resolveKey: options.resolveStorageKey });
  const storage = segmentedPrivateStorage(encrypted, options.capture);
  type Access = { master: Uint8Array; signingPrivateKey: PublicKey; signingPublicKey: PublicKey; check: () => void; alive: () => boolean };
  const use = async <T>(work: (access: Access) => Promise<T>) => {
    // Capture before waiting for another window. Locking and unlocking while
    // queued must not revive intent from the previous unlock session.
    const captured = options.capture(); captured();
    return options.exclusive(async () => {
      captured();
      const identity = options.resolveIdentity(); if (!identity) throw new PrivateStorageLockedError();
      const current = checks(captured, identity.current), master = new Uint8Array(identity.master);
      try {
        current.check(); if (master.length !== 32) throw new PrivateStorageLockedError();
        return await work({ master, signingPrivateKey: structuredClone(identity.signingPrivateKey), signingPublicKey: structuredClone(identity.signingPublicKey), ...current });
      } finally { master.fill(0); identity.release?.(); }
    });
  };
  const open = (signed: SignedPrivateInventoryVersion, previous: PrivateInventoryTransportCheckpoint, access: Access) =>
    openPrivateInventoryVersion({ signed, previous, scope, master: access.master, signingPublicKey: access.signingPublicKey, current: access.alive });
  const anchoredLocal = async (signed: SignedPrivateAccountInventory, access: Access) => verifyPrivateAccountInventoryCheckpoint(signed, scope, access.signingPublicKey,
    { revision: signed.inventory.revision, digest: await privateRecordDigest(signed.inventory) }, access.alive);
  async function decode(state: State, access: Access) {
    let confirmed: VerifiedPrivateAccountInventory | null = null, previous = { ...state.confirmed.checkpoint };
    if (previous.revision === 0) { if (previous.root !== null || state.confirmed.version !== null) throw new PrivateStorageIntegrityError(); }
    else {
      const version = state.confirmed.version;
      if (!version || version.header.revision !== previous.revision) throw new PrivateStorageIntegrityError();
      const opened = await open(version, { revision: version.header.revision - 1, root: version.header.previousRoot }, access);
      if (opened.checkpoint.root !== previous.root) throw new PrivateStorageIntegrityError();
      // This anchor comes from authenticated account-scoped local storage,
      // never directly from an API response.
      confirmed = await anchoredLocal(opened.inventory, access);
    }
    let profile = confirmed;
    for (const version of state.pending) {
      const opened = await open(version, previous, access);
      profile = profile ? await verifyPrivateAccountInventoryUpdate(opened.inventory, profile, scope, access.signingPublicKey, access.alive) : await anchoredLocal(opened.inventory, access);
      if (!confirmed && previous.revision === 0 && profile.checkpoint.revision !== 1) throw new PrivateStorageIntegrityError();
      previous = opened.checkpoint;
    }
    const local = await anchoredLocal(state.local, access);
    if (!profile || local.checkpoint.digest !== profile.checkpoint.digest || local.checkpoint.revision !== state.confirmed.checkpoint.revision + state.pending.length) throw new PrivateStorageIntegrityError();
    if (state.conflict) await open(state.conflict, state.confirmed.checkpoint, access);
    access.check(); return { state, profile: local, confirmed, tail: previous };
  }
  async function load(access: Access) {
    if (await encrypted.getItem("signed-account-inventory") !== null) throw new Error("A local account inventory already exists. Keep or recover it before enabling durable sync.");
    access.check();
    const raw = await storage.getItem("inventory-sync"); access.check();
    if (raw === null) return null;
    if (new TextEncoder().encode(raw).length > MAX_STATE_BYTES) throw new PrivateStorageIntegrityError();
    return decode(stateSchema.parse(JSON.parse(raw)), access);
  }
  async function save(state: State, access: Access) {
    const checked = stateSchema.parse(state), raw = JSON.stringify(checked);
    if (new TextEncoder().encode(raw).length > MAX_STATE_BYTES) throw new Error("Pending account inventory exceeds local storage limits. Existing versions were kept.");
    await decode(checked, access); access.check(); await storage.setItem("inventory-sync", raw); access.check();
    const saved = await load(access);
    if (!saved || canonicalJson(saved.state) !== canonicalJson(checked)) throw new PrivateStorageIntegrityError();
    return saved;
  }
  const required = async (access: Access) => { const value = await load(access); if (!value) throw new PrivateAccountInventoryMissingError(); return value; };
  async function receive(transport: PrivateInventoryTransport, access: Access, through?: number) {
    const loaded = await required(access), state = loaded.state;
    if (state.conflict) throw new PrivateInventoryConflictError();
    const before = state.confirmed.checkpoint.revision;
    const page = await transport.versions({ after: before, ...(through === undefined ? {} : { through }) }); access.check();
    if (!Number.isSafeInteger(page.through) || page.through < before || (through !== undefined && through !== page.through) || !Array.isArray(page.versions) || page.versions.length > 4 || (page.through === 0 ? page.root !== null : typeof page.root !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(page.root))) throw new Error("Invalid account inventory feed boundary");
    let confirmed = loaded.confirmed;
    for (const raw of page.versions) {
      const opened = await open(signedPrivateInventoryVersionSchema.parse(raw), state.confirmed.checkpoint, access);
      if (opened.checkpoint.revision > page.through) throw new Error("Account inventory feed exceeds its boundary");
      const own = state.pending[0];
      const matches = own?.header.operationId === opened.signed.header.operationId && canonicalJson({ header: own.header, box: own.box }) === canonicalJson({ header: opened.signed.header, box: opened.signed.box });
      if (state.pending.length && !matches) {
        state.conflict = opened.signed; await save(state, access); throw new PrivateInventoryConflictError();
      }
      if (!confirmed && !matches) throw new PrivateAccountInventoryMissingError();
      let next: VerifiedPrivateAccountInventory;
      try { next = confirmed ? await verifyPrivateAccountInventoryUpdate(opened.inventory, confirmed, scope, access.signingPublicKey, access.alive) : await anchoredLocal(opened.inventory, access); }
      catch { access.check(); state.conflict = opened.signed; await save(state, access); throw new PrivateInventoryConflictError(); }
      if (matches) state.pending.shift(); else state.local = next.signed;
      state.confirmed = { checkpoint: opened.checkpoint, version: opened.signed }; confirmed = next;
    }
    const after = state.confirmed.checkpoint.revision;
    if (page.next !== (after < page.through ? after : null) || (after < page.through && !page.versions.length) || (after === page.through && state.confirmed.checkpoint.root !== page.root)) throw new Error("Account inventory feed omitted revisions or changed its root");
    const saved = page.versions.length ? await save(state, access) : loaded;
    return { revision: after, root: state.confirmed.checkpoint.root, through: page.through, next: page.next, pending: saved.state.pending.length };
  }
  return {
    read: () => use(async (access) => { const value = await required(access); if (value.state.conflict) throw new PrivateInventoryConflictError(); return { inventory: value.profile, checkpoint: value.state.confirmed.checkpoint, pending: value.state.pending.length }; }),
    status: () => use(async (access) => { const value = await required(access); return { checkpoint: value.state.confirmed.checkpoint, pending: value.state.pending.length, conflict: value.state.conflict !== null }; }),
    enroll: (signed: SignedPrivateAccountInventory) => use(async (access) => {
      const profile = await verifyPrivateAccountInventoryEnrollment(signed, scope, access.signingPublicKey, access.alive);
      const prior = await load(access);
      if (prior) {
        if (!prior.state.conflict && prior.profile.checkpoint.digest === profile.checkpoint.digest) return { inventory: prior.profile, pending: prior.state.pending.length };
        throw new Error("Existing account inventory must be kept or recovered before enrollment");
      }
      const version = await encryptPrivateInventoryVersion({ inventory: profile, previous: { revision: 0, root: null }, operationId: crypto.randomUUID(), master: access.master, signingPrivateKey: access.signingPrivateKey, current: access.alive });
      const saved = await save({ v: 1, local: profile.signed, confirmed: { checkpoint: { revision: 0, root: null }, version: null }, pending: [version.signed], conflict: null }, access);
      return { inventory: saved.profile, pending: 1 };
    }),
    update: (input: readonly PrivateAccountWorkspace[]) => {
      const workspaces = structuredClone([...input]);
      return use(async (access) => {
        const value = await required(access); if (value.state.conflict) throw new PrivateInventoryConflictError();
        if (value.state.pending.length >= 8) throw new Error("Account inventory queue is full. Pending versions were kept; connect or review them first.");
        const signed = await signPrivateAccountInventory({ ...scope, workspaces, previous: value.profile, signingPrivateKey: access.signingPrivateKey, current: access.alive });
        const next = await verifyPrivateAccountInventoryUpdate(signed, value.profile, scope, access.signingPublicKey, access.alive);
        const version = await encryptPrivateInventoryVersion({ inventory: next, previous: value.tail, operationId: crypto.randomUUID(), master: access.master, signingPrivateKey: access.signingPrivateKey, current: access.alive });
        const saved = await save({ ...value.state, local: next.signed, pending: [...value.state.pending, version.signed] }, access);
        return { inventory: saved.profile, pending: saved.state.pending.length };
      });
    },
    restore: (input: unknown, expected: { inventory: PrivateAccountInventoryCheckpoint; transport: PrivateInventoryTransportCheckpoint }) => {
      const version = signedPrivateInventoryVersionSchema.parse(input), anchor = structuredClone(expected);
      return use(async (access) => {
        const opened = await open(version, { revision: version.header.revision - 1, root: version.header.previousRoot }, access);
        if (canonicalJson(opened.checkpoint) !== canonicalJson(anchor.transport)) throw new Error("Account inventory differs from its trusted transport checkpoint");
        const profile = await verifyPrivateAccountInventoryCheckpoint(opened.inventory, scope, access.signingPublicKey, anchor.inventory, access.alive);
        const prior = await load(access);
        if (prior) {
          if (!prior.state.pending.length && !prior.state.conflict && prior.profile.checkpoint.digest === profile.checkpoint.digest && canonicalJson(prior.state.confirmed.checkpoint) === canonicalJson(opened.checkpoint)) return { inventory: prior.profile, pending: 0 };
          throw new Error("Keep or export existing account inventory and pending work before restoration");
        }
        const saved = await save({ v: 1, local: profile.signed, confirmed: { checkpoint: opened.checkpoint, version: opened.signed }, pending: [], conflict: null }, access);
        return { inventory: saved.profile, pending: 0 };
      });
    },
    pull: (transport: PrivateInventoryTransport, through?: number) => use((access) => receive(transport, access, through)),
    flushOne: (transport: PrivateInventoryTransport) => use(async (access) => {
      const value = await required(access); if (value.state.conflict) throw new PrivateInventoryConflictError();
      const pending = value.state.pending[0]; if (!pending) return { ...value.state.confirmed.checkpoint, pending: 0 };
      const checked = await open(pending, value.state.confirmed.checkpoint, access);
      const ack = await transport.commit(structuredClone(pending)); access.check();
      if (ack.revision !== checked.checkpoint.revision || ack.root !== checked.checkpoint.root) throw new Error("Inventory acknowledgement differs from the durable pending version");
      const verified = await receive(transport, access, checked.checkpoint.revision);
      return { revision: verified.revision, root: verified.root, pending: verified.pending };
    }),
    exportPending: () => use(async (access) => { const value = await required(access); return { pending: structuredClone(value.state.pending), conflict: value.state.conflict ? structuredClone(value.state.conflict) : null }; }),
  };
}
