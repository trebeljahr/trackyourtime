import { canonicalJson, decryptPrivateRecord, privateEntryQuery, privateTimerWitnessFromPacket, verifyPrivateTimerCurrentWitness, type PlainPrivateRecord } from "@starter/core";
import { standardCurrentTimerSchema, type TimeEntry } from "@starter/shared";
import { capturePrivateRequestScope, checkPrivateRequestScope } from "./private-request-scope";
import { privateSession } from "./private-session";
import { privateClientScope } from "./private-client-scope";
import { privateScopedRpc } from "./private-scoped-rpc";
import { withPrivateAccountTimerGate } from "./private-account-timer-coordinator";
import { privateAccountInventoryStorageHost } from "./private-replica";
import { privateAccountWorkspaceInventorySync } from "./private-inventory-sync";
import { openPrivateWorkspaceCoordinatorCopy, privateWorkspaceJournalTransport } from "./private-workspace-session";
import { workspaceContentRoute } from "./private-content-route";
import { notePrivateView } from "./private-view-lifecycle";
import { markPrivateLocalResult } from "./private-local-result";
import { PrivateContentUnavailableError } from "./private-content-error";
function validateInput(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "workspaceId")) throw new PrivateContentUnavailableError("Unsupported current timer input");
  const workspaceId = (input as { workspaceId?: unknown }).workspaceId;
  if (workspaceId !== undefined && (typeof workspaceId !== "string" || !workspaceId || workspaceId.length > 100)) throw new PrivateContentUnavailableError("Unsupported current timer workspace");
}
type CurrentResult = { handled: false } | { handled: true; value: TimeEntry | null };
/** Account-wide SDK read. Nothing private enters the ordinary HTTP channel or
 * timer mirror. A missing account pin remains a legacy refusal, never zero.
 * Saved signed witnesses keep confirmed clock bodies available offline. */
export async function readPrivateAccountCurrent(userId: string, raw: unknown): Promise<CurrentResult> {
  if (!privateSession(userId)) return { handled: false };
  const input = structuredClone(raw ?? {});
  const original = capturePrivateRequestScope(), binding = privateClientScope(userId);
  return withPrivateAccountTimerGate(userId, async ({ timer, check: scopeCheck }) => {
    const check = () => { scopeCheck(); checkPrivateRequestScope(original); };
    binding.check(); check(); if (!timer) return { handled: false };
    const snapshot = (await timer.exportRecovery())!; check();
    if (snapshot.state.conflict) throw new PrivateContentUnavailableError("The account timer needs conflict review. Pending time was kept.");
    const lastPacket = snapshot.state.preparing ?? snapshot.state.pending.at(-1), pointer = snapshot.local.current;
    const signed = lastPacket?.signed ?? snapshot.state.confirmed.signed;
    if (!pointer) {
      if (lastPacket) {
        validateInput(input);
        if (lastPacket.signed.header.standardStart) throw new PrivateContentUnavailableError("The standard timer handoff is saved locally and is waiting to sync.");
        return { handled: true, value: null };
      }
      const host = await privateAccountInventoryStorageHost(userId);
      try {
        const inventories = await privateAccountWorkspaceInventorySync(userId, host.storage, host.exclusive), profile = await inventories.read(); check();
        if (profile.inventory.signed.inventory.workspaces.every(row => row.mode === "standard")) return { handled: false };
      } finally { host.close(); }
      validateInput(input);
      const { rpc, supported } = privateScopedRpc(userId, "privacy.accountCurrentTimer", 20_000); supported();
      const result = standardCurrentTimerSchema.nullable().parse(await rpc.privacy.standardCurrentTimer.mutate()); supported(); check();
      if (result) {
        if (result.authorId !== userId) throw new PrivateContentUnavailableError("The current timer belongs to another account");
        const route = await workspaceContentRoute(userId, result.workspaceId, binding.server); check(); route.check();
        if (route.mode !== "standard") throw new PrivateContentUnavailableError("Private time cannot use the standard timer response");
      }
      return { handled: true, value: result };
    }
    validateInput(input);
    if (!signed) throw new PrivateContentUnavailableError("Current private time has no signed account checkpoint");
    const copy = await openPrivateWorkspaceCoordinatorCopy(userId, pointer.workspaceId);
    try {
      check(); const { kty, crv, x, y } = privateSession(userId)!.signingPrivateKey, signingPublicKey = { kty, crv, x, y };
      const retained = lastPacket ?? snapshot.state.committed.find(packet => packet.signed.header.operationId === signed.header.operationId);
      let witness = retained ? await privateTimerWitnessFromPacket(retained) : snapshot.state.currentWitness;
      if (!witness) {
        const target = signed.header.edits.find(edit => edit.workspaceId === pointer.workspaceId);
        if (!target) throw new PrivateContentUnavailableError("Current time has no workspace history binding");
        const journal = privateWorkspaceJournalTransport(userId, pointer.workspaceId), page = await journal.chainedChanges!({ after: target.expectedRevision, through: target.expectedRevision + 1 }); check();
        if (page.through !== target.expectedRevision + 1 || page.next !== null || page.changes.length !== 1) throw new PrivateContentUnavailableError("Current timer history is incomplete");
        witness = await verifyPrivateTimerCurrentWitness(page.changes[0], signed, { scope: binding, signingPublicKey, current: binding.current }); check();
        await timer.saveCurrentWitness(witness); check();
      }
      witness = await verifyPrivateTimerCurrentWitness(witness, signed, { scope: binding, signingPublicKey, current: binding.current }); check();
      if (witness.chain.header.directoryDigest !== copy.directory.digest) throw new PrivateContentUnavailableError("Current timer sharing differs from the verified workspace directory");
      const clock = witness.records.find(row => row.kind === "entries" && row.id === pointer.entryId)!;
      const original = await decryptPrivateRecord(pointer.workspaceId, clock, userId, privateSession(userId)!.privateKey); check();
      const target = signed.header.edits.find(edit => edit.workspaceId === pointer.workspaceId)!;
      let checkpoint = await copy.checkpoint(); check();
      if (!retained) {
        const journal = privateWorkspaceJournalTransport(userId, pointer.workspaceId);
        for (let pages = 0; checkpoint.revision < target.expectedRevision + 1 && pages < 8; pages++) { await copy.pull(journal, target.expectedRevision + 1); check(); checkpoint = await copy.checkpoint(); check(); }
        if (checkpoint.revision < target.expectedRevision + 1 || (checkpoint.revision === target.expectedRevision + 1 && checkpoint.head !== target.head)) throw new PrivateContentUnavailableError("Current time is waiting for its verified workspace history");
      }
      const view = await copy.readKinds(["entries", "entryMoney"]); check();
      const own = view.records.filter(row => row.kind === "entries" && row.authorId === userId && row.value.end == null), current = own.find(row => row.id === pointer.entryId);
      if (own.length !== 1 || !current || canonicalJson(current) !== canonicalJson(original)) throw new PrivateContentUnavailableError("The workspace timer differs from its account checkpoint. Refresh account history before continuing.");
      const options = { scope: copy.scope, directory: copy.directory, records: view.records as PlainPrivateRecord[], current: binding.current, path: "entries.get" as const, input: { id: pointer.entryId } };
      const result = privateEntryQuery(options) as TimeEntry; check();
      if (result.id !== pointer.entryId || result.authorId !== userId || result.end !== null || result.workspaceId !== pointer.workspaceId) throw new PrivateContentUnavailableError("The current private timer could not be verified");
      notePrivateView(binding); check(); return { handled: true, value: markPrivateLocalResult(result) };
    } finally { copy.close(); }
  });
}
