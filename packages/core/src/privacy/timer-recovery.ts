import { z } from "zod";
import { privateTimerPointerSchema, privateTimerTransitionSchema, signedPrivateTimerSchema } from "@starter/shared";
import { canonicalJson, type PublicKey } from "./crypto.js";
import { privateTimerEditBindings, verifyPrivateTimer } from "./account-timer.js";
import { decryptPrivateRecord, privateValue, type PlainPrivateRecord } from "./records.js";
import type { PrivateReplicaRecoveryState } from "./replica.js";

export const privateTimerCheckpointSchema = z.object({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  root: z.string().regex(/^[A-Za-z0-9_-]{43}$/).nullable(), current: privateTimerPointerSchema.nullable(),
}).strict().refine(value => value.revision !== 0 || (value.root === null && value.current === null), "An empty account timer cannot contain a current pointer")
  .refine(value => (value.revision === 0) === (value.root === null), "Account timer root differs from its revision");
export type PrivateTimerCheckpoint = z.infer<typeof privateTimerCheckpointSchema>;
export const privateTimerRecoveryStateSchema = z.object({
  v: z.literal(1), confirmed: z.object({ checkpoint: privateTimerCheckpointSchema, signed: signedPrivateTimerSchema.nullable() }).strict(),
  pending: z.array(privateTimerTransitionSchema).max(32),
  // Keep exact packets after server confirmation until the workspace replicas
  // have accepted their changes. A crash between these steps must lose no work.
  committed: z.array(privateTimerTransitionSchema).max(32), conflict: signedPrivateTimerSchema.nullable(),
}).strict();
export type PrivateTimerRecoveryState = z.infer<typeof privateTimerRecoveryStateSchema>;
export const PRIVATE_TIMER_STATE_MAX_BYTES = 64 * 1024 * 1024;
export const emptyPrivateTimerCheckpoint = (): PrivateTimerCheckpoint => ({ revision: 0, root: null, current: null });
/** Only for authenticated local storage or a user-held recovery container.
 * This validates an existing anchor; it cannot establish trust in an API
 * checkpoint or prove that no newer history exists on another device. */
export async function verifyPrivateTimerRecoveryState(input: unknown, options: { scope: { server: string; userId: string }; signingPublicKey: PublicKey; current: () => boolean }) {
  const scope = { ...options.scope }, signingPublicKey = structuredClone(options.signingPublicKey), current = options.current;
  const check = () => { if (!current()) throw new Error("Private account changed during timer recovery"); }; check();
  if (new TextEncoder().encode(JSON.stringify(input)).length > PRIVATE_TIMER_STATE_MAX_BYTES) throw new Error("Account timer recovery exceeds its size limit");
  const state = privateTimerRecoveryStateSchema.parse(structuredClone(input));
  const verify = (signed: unknown, previous: PrivateTimerCheckpoint) => verifyPrivateTimer({ signed, previous, scope, signingPublicKey, current });
  const point = (row: Awaited<ReturnType<typeof verify>>) => ({ revision: row.signed.header.revision, root: row.root, current: row.signed.header.current });
  let confirmed = state.confirmed.checkpoint;
  if (confirmed.revision === 0) {
    if (state.confirmed.signed !== null || state.committed.length) throw new Error("Empty timer checkpoint contains retained history");
  } else {
    const signed = state.confirmed.signed;
    if (!signed) throw new Error("Timer recovery is missing its signed checkpoint");
    const row = await verify(signed, { revision: signed.header.revision - 1, root: signed.header.previousRoot, current: signed.header.previous });
    if (canonicalJson(point(row)) !== canonicalJson(confirmed)) throw new Error("Timer recovery differs from its authenticated checkpoint");
  }
  const operations = new Set<string>();
  const packet = async (transition: PrivateTimerRecoveryState["pending"][number]) => {
    const { header } = transition.signed;
    if (operations.has(header.operationId) || canonicalJson(await privateTimerEditBindings(transition.edits)) !== canonicalJson(header.edits) || transition.edits.some(edit => edit.edit.userId !== scope.userId)) throw new Error("Timer recovery packet differs from its signed bindings");
    operations.add(header.operationId); check();
  };
  let delivered: PrivateTimerCheckpoint | null = null;
  for (const transition of state.committed) {
    const { header } = transition.signed;
    const row = await verify(transition.signed, delivered ?? { revision: header.revision - 1, root: header.previousRoot, current: header.previous });
    delivered = point(row); await packet(transition);
  }
  if (delivered && canonicalJson(delivered) !== canonicalJson(confirmed)) throw new Error("Retained timer packets do not reach the confirmed checkpoint");
  for (const transition of state.pending) {
    const row = await verify(transition.signed, confirmed); await packet(transition); confirmed = point(row);
  }
  if (state.conflict) await verify(state.conflict, state.confirmed.checkpoint);
  check(); return { state, local: confirmed };
}

/** Materialize account packets alongside ordinary local edits in their actual
 * workspace order. Retained packets already accepted by the replica must not
 * overwrite later changes. Missing dependencies refuse export, never drop time. */
export async function privateTimerRecoveryWorkspaceOverlay(options: {
  state: PrivateTimerRecoveryState; replica: PrivateReplicaRecoveryState; records: readonly PlainPrivateRecord[];
  scope: { server: string; userId: string; workspaceId: string }; privateKey: PublicKey; current: () => boolean;
}) {
  const state = structuredClone(options.state), replica = structuredClone(options.replica), scope = { ...options.scope }, privateKey = structuredClone(options.privateKey), current = options.current;
  const check = () => { if (!current()) throw new Error("Private account changed during timer recovery"); }; check();
  const address = (row: { kind: string; id: string }) => JSON.stringify([row.kind, row.id]);
  const records = new Map(options.records.map(row => [address(row), structuredClone(row)]));
  const packets = [...state.committed, ...state.pending];
  const confirmedEdit = state.confirmed.signed?.header.edits.find(edit => edit.workspaceId === scope.workspaceId);
  if (confirmedEdit && confirmedEdit.expectedRevision >= replica.revision && !state.committed.some(packet => packet.signed.header.operationId === state.confirmed.signed!.header.operationId)) throw new Error("Private backup is missing confirmed timer workspace changes");
  const events = [
    ...replica.pending.map(pending => ({ basedOn: pending.basedOn, plain: pending.records, encrypted: [], remove: pending.remove })),
    ...packets.flatMap(packet => packet.edits.filter(edit => edit.edit.workspaceId === scope.workspaceId && edit.edit.expectedRevision >= replica.revision).map(({ edit }) => ({ basedOn: edit.expectedRevision, plain: [], encrypted: edit.records, remove: edit.remove }))),
  ].sort((a, b) => a.basedOn - b.basedOn);
  let revision = replica.revision;
  for (const event of events) {
    if (event.basedOn !== revision++) throw new Error("Private backup timer dependencies are missing or overlap");
    for (const row of event.plain) records.set(address(row), row);
    for (const row of event.encrypted) { const opened = await decryptPrivateRecord(scope.workspaceId, row, scope.userId, privateKey); check(); records.set(address(opened), opened); }
    for (const row of event.remove) records.delete(address(row));
  }
  const local = state.pending.length ? state.pending.at(-1)!.signed.header.current : state.confirmed.checkpoint.current;
  const ownRunning = [...records.values()].filter(row => {
    if (row.kind !== "entries" || row.authorId !== scope.userId) return false;
    const value = privateValue(row.value) as Record<string, unknown>;
    if (value.authorId !== scope.userId) throw new Error("Private timer recovery author differs from its signed record");
    return value.end == null;
  });
  const expected = local?.workspaceId === scope.workspaceId ? local.entryId : null;
  if (ownRunning.length !== (expected ? 1 : 0) || (expected && ownRunning[0]!.id !== expected)) throw new Error("Private backup timer differs from its account checkpoint");
  if (expected && records.get(address({ kind: "entryMoney", id: expected }))?.authorId !== scope.userId) throw new Error("Private backup timer is missing its financial snapshot");
  check(); return [...records.values()];
}
