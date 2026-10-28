import { privateTimerTransitionSchema, signedPrivateTimerSchema } from "@starter/shared";
import { canonicalJson, type PublicKey } from "./crypto.js";
import { createPrivateStorage, PrivateStorageIntegrityError, PrivateStorageLockedError, type PrivateStorageKey } from "./storage.js";
import { segmentedPrivateStorage } from "./segmented-storage.js";
import { privateRecordDigest } from "./workspace-edits.js";
import { verifyPrivateTimer } from "./account-timer.js";
import { PRIVATE_TIMER_STATE_MAX_BYTES, verifyPrivateTimerRecoveryState, type PrivateTimerRecoveryState } from "./timer-recovery.js";
import type { KeyValueStorage } from "../storage.js";
import type { QueueExclusive } from "../durable-entry.js";
export const PRIVATE_ACCOUNT_TIMER_SCOPE = "trackyourtime:account-timer-v1";
export class PrivateTimerCheckpointMissingError extends Error {
  constructor() { super("Restore the trusted account timer checkpoint before using private timers"); this.name = "PrivateTimerCheckpointMissingError"; }
}
export class PrivateTimerConflictError extends Error {
  constructor() { super("The account timer changed on another device. Pending time was kept for review."); this.name = "PrivateTimerConflictError"; }
}
/** The account timer has its own mutex, separate from inventory/workspace
 * locks. No missing checkpoint becomes an empty timer. Hosts explicitly enroll
 * a newly generated identity or restore an independently authenticated digest.
 * Network requests and workspace reconciliation stay outside this mutex. */
export async function createPrivateAccountTimerStore(options: {
  scope: { server: string; userId: string }; storage: KeyValueStorage; exclusive: QueueExclusive;
  signingPublicKey: PublicKey; resolveStorageKey: () => PrivateStorageKey | null; capture: () => () => void;
}) {
  const scope = { ...options.scope }, signingPublicKey = structuredClone(options.signingPublicKey), capture = options.capture, exclusive = options.exclusive;
  const encrypted = await createPrivateStorage({ storage: options.storage, scope: { ...scope, workspaceId: PRIVATE_ACCOUNT_TIMER_SCOPE }, resolveKey: options.resolveStorageKey });
  const storage = segmentedPrivateStorage(encrypted, capture);
  const use = <T>(work: (check: () => void, current: () => boolean) => Promise<T>) => {
    const check = capture(); check();
    return exclusive(async () => {
      check(); const current = () => { try { check(); return true; } catch { return false; } };
      const result = await work(check, current); check(); return result;
    });
  };
  const decode = (input: unknown, current: () => boolean) => verifyPrivateTimerRecoveryState(input, { scope, signingPublicKey, current });
  const load = async (check: () => void, current: () => boolean) => {
    const raw = await storage.getItem("timer-state"); check();
    if (raw === null) return null;
    if (new TextEncoder().encode(raw).length > PRIVATE_TIMER_STATE_MAX_BYTES) throw new PrivateStorageIntegrityError();
    return decode(JSON.parse(raw), current);
  };
  const required = async (check: () => void, current: () => boolean) => { const value = await load(check, current); if (!value) throw new PrivateTimerCheckpointMissingError(); return value; };
  const save = async (input: PrivateTimerRecoveryState, check: () => void, current: () => boolean) => {
    const value = await decode(input, current); check();
    await storage.setItem("timer-state", JSON.stringify(value.state)); check();
    const saved = await required(check, current);
    if (canonicalJson(saved.state) !== canonicalJson(value.state)) throw new PrivateStorageIntegrityError();
    return saved;
  };
  return {
    read: () => use(async (check, current) => {
      const value = await required(check, current);
      return { checkpoint: structuredClone(value.state.confirmed.checkpoint), local: structuredClone(value.local), pending: value.state.pending.length, committed: value.state.committed.length, conflict: value.state.conflict !== null };
    }),
    exportRecovery: () => use(async (check, current) => { const value = await load(check, current); return value ? { ...value, digest: await privateRecordDigest(value.state) } : null; }),
    /** expectedDigest must come from fresh local identity setup, a verified
     * recovery file, or a trusted-device handoff; never from this API server. */
    restore: (input: unknown, expectedDigest: string) => {
      const snapshot = structuredClone(input), anchor = expectedDigest;
      return use(async (check, current) => {
        const value = await decode(snapshot, current);
        if (await privateRecordDigest(value.state) !== anchor) throw new Error("Account timer differs from its trusted recovery digest"); check();
        const prior = await load(check, current);
        if (prior && canonicalJson(prior.state) !== canonicalJson(value.state)) throw new Error("Keep or export the existing account timer and pending time before restoration");
        return structuredClone((prior ?? await save(value.state, check, current)).local);
      });
    },
    enqueue: (input: unknown) => {
      const transition = structuredClone(privateTimerTransitionSchema.parse(input));
      return use(async (check, current) => {
        const value = await required(check, current), state = value.state;
        if (state.conflict) throw new PrivateTimerConflictError();
        if (state.committed.length) throw new Error("Finish accepting confirmed timer packets before planning another transition");
        const prior = state.pending.find(row => row.signed.header.operationId === transition.signed.header.operationId);
        if (prior) {
          if (canonicalJson(prior) !== canonicalJson(transition)) throw new Error("Timer operation identity was reused for different work");
          return { local: value.local, pending: state.pending.length };
        }
        const next = await save({ ...state, pending: [...state.pending, transition] }, check, current);
        return { local: next.local, pending: next.state.pending.length };
      });
    },
    nextPending: () => use(async (check, current) => {
      const value = await required(check, current);
      if (value.state.conflict) throw new PrivateTimerConflictError();
      if (value.state.committed.length) throw new Error("Accept the confirmed timer packets before sending another transition");
      return structuredClone(value.state.pending[0] ?? null);
    }),
    /** Consume only a consecutive authenticated feed item. A matching HTTP
     * acknowledgement alone never removes a durable timer request. */
    accept: (input: unknown) => {
      const signed = structuredClone(signedPrivateTimerSchema.parse(input));
      return use(async (check, current) => {
        const { state } = await required(check, current);
        if (state.conflict) throw new PrivateTimerConflictError();
        if (state.committed.length) throw new Error("Accept the confirmed timer packets before advancing account history");
        const verified = await verifyPrivateTimer({ signed, scope, signingPublicKey, previous: state.confirmed.checkpoint, current });
        const pending = state.pending[0];
        if (pending && canonicalJson(pending.signed.header) !== canonicalJson(signed.header)) {
          await save({ ...state, conflict: signed }, check, current); throw new PrivateTimerConflictError();
        }
        const checkpoint = { revision: signed.header.revision, root: verified.root, current: signed.header.current };
        const next = await save({ ...state, confirmed: { signed, checkpoint }, pending: pending ? state.pending.slice(1) : [], committed: pending ? [pending] : [] }, check, current);
        return structuredClone(next.state.confirmed.checkpoint);
      });
    },
    /** The coordinator verifies/applies every bound workspace packet before
     * returning. Keep exact packets on a thrown error, closure or uncertain
     * save. The callback acquires workspace locks without this mutex held. */
    settle: async (reconcile: (packet: PrivateTimerRecoveryState["pending"][number]) => Promise<void>) => {
      const captured = capture(); captured();
      const packet = await use(async (check, current) => { const { state } = await required(check, current); return structuredClone(state.committed[0] ?? null); });
      if (!packet) return;
      captured(); await reconcile(structuredClone(packet)); captured();
      return use(async (check, current) => {
        captured(); const { state } = await required(check, current), first = state.committed[0];
        if (!first) return;
        if (canonicalJson(first) !== canonicalJson(packet)) throw new PrivateStorageLockedError();
        await save({ ...state, committed: state.committed.slice(1) }, check, current);
      });
    },
  };
}
