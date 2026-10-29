import { canonicalJson, PrivateTimerCheckpointMissingError, privateTimerRoot, verifyPrivateTimer } from "@starter/core";
import { privateTimerAckSchema, privateTimerPageSchema, type PrivateTimerTransition } from "@starter/shared";
import { privateClientScope } from "./private-client-scope";
import { withPrivateAccountTimerGate } from "./private-account-timer-coordinator";
import { privateAccountTimerTransport } from "./private-account-timer-transport";
import { privateSession } from "./private-session";
import { openPrivateWorkspaceCoordinatorCopy, privateWorkspaceJournalTransport } from "./private-workspace-session";

type Copy = Awaited<ReturnType<typeof openPrivateWorkspaceCoordinatorCopy>>;
/** One bounded account pass under the same mutex as local publication and
 * private views. HTTP acknowledgements never retire durable packets. Accept
 * signed account history, then verify each bound workspace receipt first. */
export async function syncPrivateAccountTimer(userId: string, current: () => boolean = () => true) {
  const result = await syncAccountTimer(userId, current, false);
  if (!result) throw new PrivateTimerCheckpointMissingError();
  return result;
}
/** Legacy non-clock private copies have no account timer checkpoint. Never
 * initialize one from an empty server page or make them use a new protocol. */
export function syncPrivateAccountTimerIfPresent(userId: string, current: () => boolean) {
  return syncAccountTimer(userId, current, true);
}
function syncAccountTimer(userId: string, current: () => boolean, optional: boolean) {
  return withPrivateAccountTimerGate(userId, async ({ timer, check: scopeCheck }) => {
    const check = () => { scopeCheck(); if (!current()) throw new Error("Private timer sync scope changed"); }; check();
    if (!timer) { if (optional) return null; throw new PrivateTimerCheckpointMissingError(); }
    const scope = privateClientScope(userId); check();
    const keys = privateSession(userId)!, { kty, crv, x, y } = keys.signingPrivateKey;
    const signingPublicKey = { kty, crv, x, y }, transport = privateAccountTimerTransport(userId), copies = new Map<string, Copy>();
    const copyFor = async (workspaceId: string) => {
      let copy = copies.get(workspaceId);
      if (!copy) { copy = await openPrivateWorkspaceCoordinatorCopy(userId, workspaceId); copies.set(workspaceId, copy); check(); }
      copy.check(); return copy;
    };
    const settle = async () => {
      await timer.settle(async packet => {
        const permit = await timer.stagingPermit(packet.signed.header.operationId); check();
        if (!permit) throw new Error("Keep the confirmed timer packet before accepting workspace history");
        for (const binding of packet.signed.header.edits) {
          const copy = await copyFor(binding.workspaceId); check();
          let receipt = await copy.coordinatedReceipt(permit); check();
          if (!receipt) {
            let checkpoint = await copy.checkpoint(); check();
            if (checkpoint.revision > binding.expectedRevision + 1) throw new Error("Recover the original workspace history proof before clearing this timer packet");
            const journal = privateWorkspaceJournalTransport(userId, binding.workspaceId);
            let pages = 0;
            while (checkpoint.revision < binding.expectedRevision + 1 && pages++ < 8) {
              await copy.pull(journal, binding.expectedRevision + 1); check(); checkpoint = await copy.checkpoint(); check();
            }
            receipt = await copy.coordinatedReceipt(permit); check();
          }
          const expected = { coordinatorId: packet.signed.header.operationId, operationId: binding.operationId, revision: binding.expectedRevision + 1, head: binding.head };
          if (canonicalJson(receipt) !== canonicalJson(expected)) throw new Error("Confirmed timer history has no matching verified workspace receipt");
        }
      }); check();
    };
    /** Verify the entire page, including its fixed end boundary, before
     * advancing even its first checkpoint. Later pages must retain that root. */
    const feed = async () => {
      let through: number | undefined, root: string | null | undefined;
      for (let pages = 0; pages < 8; pages++) {
        const before = (await timer.read()).checkpoint; check();
        const page = privateTimerPageSchema.parse(await transport.versions({ after: before.revision, ...(through === undefined ? {} : { through }) })); check();
        if (page.through < before.revision || (through !== undefined && (page.through !== through || page.root !== root))) throw new Error("Account timer history changed its immutable boundary");
        through = page.through; root = page.root;
        let previous = before;
        for (const signed of page.versions) {
          const verified = await verifyPrivateTimer({ signed, scope: { server: scope.server, userId }, signingPublicKey, previous, current: () => { try { check(); return true; } catch { return false; } } }); check();
          previous = { revision: signed.header.revision, root: verified.root, current: signed.header.current };
          if (previous.revision > page.through) throw new Error("Account timer history exceeds its boundary");
        }
        if (page.next !== (previous.revision < through ? previous.revision : null) || (previous.revision < through && !page.versions.length) || (previous.revision === through && previous.root !== root)) throw new Error("Account timer history omitted or replaced its boundary");
        for (const signed of page.versions) { await timer.accept(signed); check(); await settle(); }
        if (page.next === null) return true;
      }
      return false;
    };
    const dependencies = async (packet: PrivateTimerTransition) => {
      for (const edit of packet.edits) {
        const copy = await copyFor(edit.edit.workspaceId), journal = privateWorkspaceJournalTransport(userId, edit.edit.workspaceId); check();
        let checkpoint = await copy.checkpoint(); check(); let saves = 0;
        while (checkpoint.revision < edit.edit.expectedRevision && saves++ < 8) {
          await copy.flushOne(journal); check(); const next = await copy.checkpoint(); check();
          if (next.revision <= checkpoint.revision) throw new Error("Earlier workspace work has no verified history receipt"); checkpoint = next;
        }
        if (checkpoint.revision < edit.edit.expectedRevision) return false;
        if (checkpoint.revision !== edit.edit.expectedRevision || checkpoint.head !== edit.chain.header.previousRoot) throw new Error("Pending timer packet differs from its workspace predecessor; existing work was kept");
      }
      return true;
    };
    try {
      const initial = await timer.read(); check();
      await settle();
      let caughtUp = await feed(), writes = 0;
      while (caughtUp && writes++ < 8) {
        const packet = await timer.nextPending(); check(); if (!packet) break;
        if (!await dependencies(packet)) { caughtUp = false; break; }
        const reply = privateTimerAckSchema.parse(await transport.commit(packet)); check();
        if (reply.revision !== packet.signed.header.revision || reply.root !== await privateTimerRoot(packet.signed)) throw new Error("Invalid account timer acknowledgement; saved work was kept"); check();
        caughtUp = await feed();
        const after = await timer.read(); check();
        if (after.checkpoint.revision < reply.revision) throw new Error("Account timer acknowledgement has no verified history record");
      }
      const status = await timer.read(); check();
      return { changed: initial.committed > 0 || initial.checkpoint.revision !== status.checkpoint.revision, caughtUp, revision: status.checkpoint.revision, pending: status.pending, committed: status.committed, conflict: status.conflict };
    } finally { for (const copy of copies.values()) copy.close(); }
  });
}
