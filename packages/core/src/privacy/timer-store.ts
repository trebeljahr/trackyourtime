import { privateTimerTransitionSchema, signedPrivateTimerSchema, type PrivateTimerTransition } from "@starter/shared";
import { canonicalJson, type PublicKey } from "./crypto.js";
import { createPrivateStorage, PrivateStorageIntegrityError, PrivateStorageLockedError, type PrivateStorageKey } from "./storage.js";
import { segmentedPrivateStorage } from "./segmented-storage.js";
import { privateRecordDigest } from "./workspace-edits.js";
import { verifyPrivateTimer } from "./account-timer.js";
import { PRIVATE_TIMER_STATE_MAX_BYTES, verifyPrivateTimerRecoveryState, type PrivateTimerRecoveryState } from "./timer-recovery.js";
import type { KeyValueStorage } from "../storage.js";
import type { QueueExclusive } from "../durable-entry.js";
export const PRIVATE_ACCOUNT_TIMER_SCOPE = "trackyourtime:account-timer-v1";
declare const stageBrand: unique symbol;
export type PrivateTimerStagePermit = Readonly<{ scope: { server: string; userId: string }; transition: PrivateTimerTransition; current: () => boolean }> & { readonly [stageBrand]: true };
const stagePermits = new WeakSet<object>();
function freeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
export function assertPrivateTimerStagePermit(permit: PrivateTimerStagePermit, scope: { server: string; userId: string }) {
  if (!stagePermits.has(permit) || !permit.current() || permit.scope.server !== scope.server || permit.scope.userId !== scope.userId) throw new Error("Use this account's durable timer staging permit");
}
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
  const permit = (transition: PrivateTimerTransition, current: () => boolean) => {
    const value = freeze({ scope: { ...scope }, transition: structuredClone(transition), current }) as PrivateTimerStagePermit;
    stagePermits.add(value); return value;
  };
  return {
    read: () => use(async (check, current) => {
      const value = await required(check, current);
      return { checkpoint: structuredClone(value.state.confirmed.checkpoint), local: structuredClone(value.local), pending: value.state.pending.length, committed: value.state.committed.length, conflict: value.state.conflict !== null, ...(value.state.preparing ? { preparing: true as const } : {}) };
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
    /** Persist the complete cross-workspace plan before publishing any local
     * workspace node. A later coordinator repairs this phase after a crash. */
    prepare: (input: unknown) => {
      const transition = structuredClone(privateTimerTransitionSchema.parse(input));
      return use(async (check, current) => {
        const { state } = await required(check, current);
        if (state.conflict) throw new PrivateTimerConflictError();
        if (state.committed.length) throw new Error("Accept confirmed timer packets before staging another transition");
        const prior = state.preparing ?? state.pending.find(row => row.signed.header.operationId === transition.signed.header.operationId);
        if (prior) {
          if (canonicalJson(prior) !== canonicalJson(transition)) throw new Error("Keep the original timer staging plan before starting another");
          return permit(prior, current);
        }
        if (state.pending.length >= 32) throw new Error("Sync or export pending timer transitions before staging more work");
        const saved = await save({ ...state, preparing: transition }, check, current);
        return permit(saved.state.preparing!, current);
      });
    },
    prepared: () => use(async (check, current) => { const { state } = await required(check, current); return state.preparing ? permit(state.preparing, current) : null; }),
    stagingPermit: (operationId: string) => use(async (check, current) => {
      const { state } = await required(check, current), packet = [...(state.preparing ? [state.preparing] : []), ...state.pending, ...state.committed].find(row => row.signed.header.operationId === operationId);
      return packet ? permit(packet, current) : null;
    }),
    publish: (stage: PrivateTimerStagePermit) => {
      assertPrivateTimerStagePermit(stage, scope);
      return use(async (check, current) => {
        assertPrivateTimerStagePermit(stage, scope); const { state } = await required(check, current);
        const prior = state.pending.find(row => row.signed.header.operationId === stage.transition.signed.header.operationId);
        if (prior && canonicalJson(prior) === canonicalJson(stage.transition) && !state.preparing) return;
        if (!state.preparing || canonicalJson(state.preparing) !== canonicalJson(stage.transition)) throw new Error("Timer publication differs from the saved staging plan");
        const { preparing, ...rest } = state;
        await save({ ...rest, pending: [...state.pending, preparing] }, check, current);
      });
    },
    enqueue: (input: unknown) => {
      const transition = structuredClone(privateTimerTransitionSchema.parse(input));
      return use(async (check, current) => {
        const value = await required(check, current), state = value.state;
        if (state.conflict) throw new PrivateTimerConflictError();
        if (state.preparing) throw new Error("Finish publishing the saved timer plan before adding more work");
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
      if (value.state.preparing) throw new Error("Finish publishing the saved timer plan before sending work");
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
        if (state.preparing) throw new Error("Finish publishing the saved timer plan before advancing account history");
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
