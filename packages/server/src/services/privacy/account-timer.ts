import { TRPCError } from "@trpc/server";
import { canonicalJson, privateTimerEditBindings, privateTimerRoot } from "@starter/core";
import { PRIVATE_EDIT_MAX_BYTES, privateTimerTransitionSchema, type PrivateTimerTransition } from "@starter/shared";
import { PrivateAccount, PrivateWorkspaceCommit } from "../../models/PrivateData.js";
import { PrivateTimerVersion } from "../../models/PrivateTimer.js";
import { TimeEntry } from "../../models/TimeEntry.js";
import { fenceWorkspace, supportsBusinessTransactions, withBusinessTransaction } from "../business-transaction.js";
import { withEntryOperation } from "../entries/operation.js";
import { finalizeStop } from "../entry-stop.js";
import { publishSync } from "../../ws/sync.js";
import { emitWebhookEvent } from "../webhooks/emit.js";
import { fencePrivateAccount } from "./account-erasure-fence.js";
import { assertStandardWorkspace } from "./access.js";
import { verifyPrivateChange } from "./signatures.js";
import { privateTimerCheckpoint } from "./timer-state.js";
import { commitPrivateChainedWorkspaceEdit } from "./workspace-edits.js";
const MAX_HISTORY_BYTES = 128 * 1024 * 1024;
const conflict = () => new TRPCError({ code: "CONFLICT", message: "The account timer changed. Existing time and the pending transition were kept." });
const invalid = () => new TRPCError({ code: "BAD_REQUEST", message: "Private timer ciphertext does not match its signed transition." });
function coverage(input: PrivateTimerTransition) {
  const { header } = input.signed;
  for (const signed of input.edits) {
    const { edit } = signed;
    if (edit.userId !== header.userId) throw invalid();
    const targets = [header.previous, header.current].filter(pointer => pointer?.workspaceId === edit.workspaceId).map(pointer => pointer!.entryId);
    for (const row of edit.records) {
      if (row.authorId !== header.userId || (!["entries", "entryMoney"].includes(row.kind) || !targets.includes(row.id))) throw invalid();
    }
    for (const row of edit.remove) if (row.authorId !== header.userId || !["entries", "entryMoney"].includes(row.kind) || row.id !== header.previous?.entryId || edit.workspaceId !== header.previous.workspaceId || (header.current?.entryId === row.id && header.current.workspaceId === edit.workspaceId)) throw invalid();
  }
  const same = canonicalJson(header.previous) === canonicalJson(header.current);
  for (const [key, pointer] of [["previous", header.previous], ["current", header.current]] as const) {
    if (!pointer) continue;
    const edit = input.edits.find(row => row.edit.workspaceId === pointer.workspaceId)?.edit;
    if (!edit) throw invalid();
    const removed = edit.remove.some(row => row.kind === "entries" && row.id === pointer.entryId);
    if (removed) {
      if (key !== "previous" || !edit.remove.some(row => row.kind === "entryMoney" && row.id === pointer.entryId)) throw invalid();
    } else if (!edit.records.some(row => row.kind === "entries" && row.id === pointer.entryId) || (!same && !edit.records.some(row => row.kind === "entryMoney" && row.id === pointer.entryId))) throw invalid();
    if (edit.remove.some(row => row.kind === "entryMoney" && row.id === pointer.entryId) && !removed) throw invalid();
  }
}
/** Internal atomic engine. Public activation and generic private writes stay
 * guarded until the client timer outbox, pinned recovery and all-device
 * protocol are integrated. Never publish timer packets through a normal
 * workspace-only flush: the account checkpoint and edits commit together. */
export async function commitPrivateTimerTransition(scope: { server: string; userId: string }, raw: unknown) {
  scope = Object.freeze({ ...scope });
  let input: PrivateTimerTransition;
  try { input = structuredClone(privateTimerTransitionSchema.parse(raw)); } catch { throw invalid(); }
  const { signed } = input, { header } = signed;
  if (header.server !== scope.server || header.userId !== scope.userId || new URL(scope.server).origin !== scope.server) throw new TRPCError({ code: "FORBIDDEN" });
  if (Buffer.byteLength(JSON.stringify(input)) > PRIVATE_EDIT_MAX_BYTES * 2) throw invalid();
  coverage(input);
  try { if (canonicalJson(await privateTimerEditBindings(input.edits)) !== canonicalJson(header.edits)) throw invalid(); } catch { throw invalid(); }
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Private timer coordination requires MongoDB transactions." });
  const root = await privateTimerRoot(signed);
  const standardStopInput = header.standardStop ? { operationId: header.operationId, id: header.standardStop.entryId, end: input.standardStopEnd } : null;
  return withBusinessTransaction(async () => {
    await fencePrivateAccount(scope.userId);
    const checkpoint = await privateTimerCheckpoint(scope.userId), account = checkpoint.account;
    if (!account) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Enroll the private account identity before starting a private timer." });
    await verifyPrivateChange(account.identity.signingPublicKey, header, signed.signature);
    const prior = await PrivateTimerVersion.findOne({ userId: scope.userId, operationId: header.operationId }).lean();
    if (prior) {
      if (prior.root !== root || canonicalJson(prior.signed.header) !== canonicalJson(header) || prior.revision !== header.revision) throw conflict();
      await verifyPrivateChange(account.identity.signingPublicKey, prior.signed.header, prior.signed.signature);
      if (header.standardStop) await withEntryOperation({ userId: scope.userId, workspaceId: header.standardStop.workspaceId }, "private:timer:standardStop", standardStopInput!, async () => { throw conflict(); });
      return { revision: prior.revision, root: prior.root };
    }
    if (header.revision !== checkpoint.revision + 1 || header.previousRoot !== checkpoint.root || canonicalJson(header.previous) !== canonicalJson(checkpoint.current)) throw conflict();
    const bytes = Buffer.byteLength(JSON.stringify(signed)), used = account.timerBytes ?? 0;
    if (!Number.isSafeInteger(used) || used < 0 || used + bytes > MAX_HISTORY_BYTES) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Account timer history reached its metadata budget. Existing history and pending work were kept." });
    const workspaces = new Set(header.edits.map(row => row.workspaceId)); if (header.standardStop) workspaces.add(header.standardStop.workspaceId);
    for (const workspaceId of [...workspaces].sort()) await fenceWorkspace(workspaceId);
    const standard = await TimeEntry.findOne({ authorId: scope.userId, end: null }).lean();
    if (header.standardStop) {
      const expected = header.standardStop;
      if (!standard || String(standard._id) !== expected.entryId || standard.workspaceId !== expected.workspaceId) throw conflict();
      await assertStandardWorkspace(standard.workspaceId);
      const end = new Date(input.standardStopEnd!); if (end <= standard.start) throw invalid();
      const stopped = await withEntryOperation({ userId: scope.userId, workspaceId: expected.workspaceId }, "private:timer:standardStop", standardStopInput!, async () => {
        const result = await finalizeStop(standard, end); if (!result) throw conflict(); return result;
      });
      void publishSync(standard.workspaceId, { kind: "timer.stopped", entry: stopped });
      emitWebhookEvent(standard.workspaceId, "entry.stopped", { kind: "entry", entry: stopped });
    } else if (standard) throw conflict();
    for (const edit of [...input.edits].sort((a, b) => a.edit.workspaceId < b.edit.workspaceId ? -1 : 1)) {
      if (await PrivateWorkspaceCommit.exists({ workspaceId: edit.edit.workspaceId, userId: scope.userId, operationId: edit.edit.operationId })) throw conflict();
      const committed = await commitPrivateChainedWorkspaceEdit(scope.userId, edit, scope.server), expected = header.edits.find(row => row.workspaceId === edit.edit.workspaceId)!;
      if (committed.revision !== expected.expectedRevision + 1 || committed.head !== expected.head) throw invalid();
    }
    await PrivateTimerVersion.create({ userId: scope.userId, operationId: header.operationId, revision: header.revision, root, signed });
    await PrivateAccount.updateOne({ _id: account._id }, { $set: { timerRevision: header.revision, timerRoot: root, timerSigned: signed }, $inc: { timerBytes: bytes } });
    return { revision: header.revision, root };
  });
}
