import { openPrivateTimerActorReceipt, isPrivateStandardHandoffPayload, verifyPrivateStandardHandoffIntent, canonicalJson, readersForPrivateRecord, encryptPrivateRecord, isPrivateTimerIntentPath, preparePrivateTimerIntent, readPrivateTimerIntent, privateTimerIntentRecord, privateTimerEntryEdit, privateEntryEdit, PRIVATE_ENTRY_EDIT_KINDS, privateTimerEditBindings, signPrivateChainedWorkspaceEdit, signPrivateTimer, type PlainPrivateRecord, type PrivateTimerEntryCommand } from "@starter/core";
import { workspaceNameFor } from "./active-workspace";
import { privateTimerReplacement, stagePrivateStandardHandoff, finishPrivateStandardHandoff } from "./private-standard-timer-handoff";
import type { SignedPrivateChainedEdit, TimeEntry, StartTimerReplaced } from "@starter/shared";
import { capturePrivateRequestScope, checkPrivateRequestScope } from "./private-request-scope";
import { privateClientScope } from "./private-client-scope";
import { privateSession } from "./private-session";
import { withPrivateAccountTimerGate } from "./private-account-timer-coordinator";
import { privateAccountInventoryStorageHost } from "./private-replica";
import { privateAccountWorkspaceInventorySync } from "./private-inventory-sync";
import { openPrivateWorkspaceCoordinatorCopy } from "./private-workspace-session";
import { readPrivateAccountCurrentInGate } from "./private-account-timer-current";
import { workspaceContentRoute } from "./private-content-route";
import { privateScopedRpc } from "./private-scoped-rpc";
import { notePrivateView } from "./private-view-lifecycle";
import { markPrivateLocalResult } from "./private-local-result";
import { notifyPrivateWorkspaceEdit } from "./private-workspace-sync";
import { PrivateContentUnavailableError } from "./private-content-error";
import type { PrivateTimerAction } from "./private-timer-action";
type Copy = Awaited<ReturnType<typeof openPrivateWorkspaceCoordinatorCopy>>;
type Result = (TimeEntry & { replaced?: StartTimerReplaced | null }) | { success: true; id: string };
/** Actual SDK adapter. One durable preparing packet precedes all workspace
 * publication. Retried intents return their encrypted original result; no
 * timer body can enter the ordinary HTTP queue or plaintext running mirror. */
export async function mutatePrivateAccountTimer(userId: string, path: string, raw: unknown, action: PrivateTimerAction) {
  if (!isPrivateTimerIntentPath(path) || !privateSession(userId)) return { handled: false as const };
  const original = capturePrivateRequestScope(), binding = privateClientScope(userId), input = structuredClone(raw) as Record<string, unknown>;
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.workspaceId !== "string") throw new PrivateContentUnavailableError("Choose the original timer workspace before saving time");
  if (input.__privateIntentId !== undefined) return { handled: false as const };
  const workspaceId = input.workspaceId, captured = Object.freeze({ ...action });
  const outcome = await withPrivateAccountTimerGate(userId, async context => {
    const check = () => { context.check(); checkPrivateRequestScope(original); }; check();
    if (!context.timer) return { handled: false as const };
    const snapshot = (await context.timer.exportRecovery())!; check();
    if (snapshot.state.conflict) throw new PrivateContentUnavailableError("The account timer needs conflict review. Pending work was kept.");
    const route = await workspaceContentRoute(userId, workspaceId, binding.server); check(); route.check();
    const copies = new Map<string, Copy>();
    const copyFor = async (id: string) => { let copy = copies.get(id); if (!copy) { copy = await openPrivateWorkspaceCoordinatorCopy(userId, id); copies.set(id, copy); check(); } return copy; };
    const { __durableScope, __durableTempId, workspaceId: addressed, ...body } = input; void addressed;
    if (__durableScope !== undefined) { const scope = __durableScope as { owner?: unknown; server?: unknown; workspaceId?: unknown } | null; if (!scope || scope.owner !== userId || scope.server !== binding.server || scope.workspaceId !== workspaceId) throw new PrivateContentUnavailableError("Original timer scope changed"); }
    try {
      const host = await privateAccountInventoryStorageHost(userId);
      let privateIds: string[];
      try { const inventories = await privateAccountWorkspaceInventorySync(userId, host.storage, host.exclusive), profile = await inventories.read(); check(); privateIds = profile.inventory.signed.inventory.workspaces.filter(row => row.mode === "encrypted").map(row => row.workspaceId); } finally { host.close(); }
      // A person-scoped stop may have originated while another workspace was
      // selected. Find its own encrypted receipt before inspecting a new clock.
      const candidates = privateIds;
      for (const id of candidates) {
        const copy = await copyFor(id), intent = await preparePrivateTimerIntent({ scope: copy.scope, path, input: body, operationId: captured.operationId, current: binding.current }); check();
        const view = await copy.readKinds(["imports"]); check();
        const stored = view.records.find(row => row.kind === "imports" && row.id === `entryoperations:${captured.operationId}`);
        if (stored?.value.protocol === "trackyourtime-private-timer-operation-v2") {
          const payload = await openPrivateTimerActorReceipt({ scope: copy.scope, directory: copy.directory, records: view.records, current: binding.current, record: stored, privateKey: privateSession(userId)!.privateKey }); check();
          if (isPrivateStandardHandoffPayload(payload)) {
            if (route.mode !== "standard") throw new PrivateContentUnavailableError("The original standard timer workspace is now private. Its saved handoff was kept.");
            const targetIntent = await preparePrivateTimerIntent({ scope: { ...copy.scope, workspaceId }, path, input: body, operationId: captured.operationId, current: binding.current }); check();
            const verified = verifyPrivateStandardHandoffIntent({ scope: copy.scope, directory: copy.directory, records: view.records, current: binding.current, intent: targetIntent, payload });
            return { handoff: { operationId: captured.operationId, payload: verified } };
          }
        }
        const receipt = await readPrivateTimerIntent({ scope: copy.scope, directory: copy.directory, records: view.records, current: binding.current, intent, privateKey: privateSession(userId)!.privateKey });
        if (receipt) { if (id !== workspaceId && !["entries.stop", "entries.discard"].includes(path)) throw new PrivateContentUnavailableError("Private timer operation identity was reused for another workspace"); notePrivateView(binding); check(); return { handled: true as const, value: markPrivateLocalResult(receipt) }; }
      }
      const unresolvedStandard = [...snapshot.state.pending, ...snapshot.state.committed, ...(snapshot.state.preparing ? [snapshot.state.preparing] : [])].filter(packet => packet.signed.header.standardStart);
      if (unresolvedStandard.length && (["entries.start", "entries.continue", "entries.stop", "entries.discard"].includes(path) || (path === "entries.update" && input.end === null) || unresolvedStandard.some(packet => packet.signed.header.standardStart?.entryId === input.id))) throw new PrivateContentUnavailableError("Confirm the saved timer handoff before changing time");
      if (["entries.update", "entries.remove"].includes(path) && !(path === "entries.update" && input.end === null && snapshot.local.current?.entryId !== input.id) && !(snapshot.local.current?.workspaceId === workspaceId && snapshot.local.current.entryId === input.id)) return { handled: false as const };
      if (route.mode === "standard" && !snapshot.local.current) return { handled: false as const };
      const current = await readPrivateAccountCurrentInGate(userId, {}, context, { original, binding }); check();
      if (!current.handled) return { handled: false as const };
      const pointer = snapshot.local.current, targetId = path === "entries.stop" || path === "entries.discard" ? pointer?.workspaceId ?? workspaceId : workspaceId;
      const targetRoute = targetId === workspaceId ? route : await workspaceContentRoute(userId, targetId, binding.server); check(); targetRoute.check();
      if (targetRoute.mode === "standard") {
        if (pointer && path === "entries.start") {
          const source = await copyFor(pointer.workspaceId);
          return { handoff: await stagePrivateStandardHandoff({ userId, workspaceId, body, action: captured, timer: context.timer, local: snapshot.local, copy: source, check }) };
        }
        if (pointer && ["entries.start", "entries.continue"].includes(path)) throw new PrivateContentUnavailableError("Private-to-standard timer starts are not available in this client yet. Current time was kept.");
        return { handled: false as const };
      }
      if (__durableTempId !== undefined && (typeof __durableTempId !== "string" || !__durableTempId || __durableTempId.length > 200 || !["entries.start", "entries.continue"].includes(path))) throw new PrivateContentUnavailableError("Resolve the original timer identity before changing private time");
      const copy = await copyFor(targetId), intent = await preparePrivateTimerIntent({ scope: copy.scope, path, input: body, operationId: captured.operationId, current: binding.current }); check();
      const view = await copy.readKinds(PRIVATE_ENTRY_EDIT_KINDS); check();
      const args = intent.input, starting = path === "entries.start" || path === "entries.continue" || (path === "entries.update" && args.end === null && pointer?.entryId !== args.id);
      if (["entries.update", "entries.remove"].includes(path) && !starting && !(pointer?.workspaceId === targetId && pointer.entryId === args.id)) return { handled: false as const };
      const { supported } = privateScopedRpc(userId, "privacy.timerIntentReceipts", 20_000); supported();
      const plans = new Map<string, { copy: Copy; records: PlainPrivateRecord[]; remove: Pick<PlainPrivateRecord, "kind" | "id" | "authorId">[] }>();
      const views = new Map<string, PlainPrivateRecord[]>([[targetId, view.records]]);
      const apply = (id: string, owner: Copy, plan: { records: PlainPrivateRecord[]; remove: Pick<PlainPrivateRecord, "kind" | "id" | "authorId">[] }) => {
        const old = plans.get(id), changed = new Set([...plan.records, ...plan.remove].map(row => canonicalJson([row.kind, row.id])));
        const remaining = (views.get(id) ?? []).filter(row => !changed.has(canonicalJson([row.kind, row.id]))); views.set(id, [...remaining, ...plan.records]);
        plans.set(id, { copy: owner, records: [...(old?.records ?? []).filter(row => !changed.has(canonicalJson([row.kind, row.id]))), ...plan.records], remove: [...(old?.remove ?? []).filter(row => !changed.has(canonicalJson([row.kind, row.id]))), ...plan.remove] });
      };
      const stamp = new Date(captured.now).toISOString(), switchingEnd = path === "entries.start" && typeof args.start === "string" ? args.start : stamp;
      if (starting && pointer) {
        const old = await copyFor(pointer.workspaceId);
        if (!views.has(pointer.workspaceId)) views.set(pointer.workspaceId, (await old.readKinds(PRIVATE_ENTRY_EDIT_KINDS)).records); check();
        apply(pointer.workspaceId, old, privateTimerEntryEdit({ scope: old.scope, directory: old.directory, records: views.get(pointer.workspaceId)!, current: binding.current, command: { kind: "stop", id: pointer.entryId, end: switchingEnd }, expectedRunningId: pointer.entryId, now: captured.now }));
      }
      let command: PrivateTimerEntryCommand;
      if (path === "entries.start") command = { kind: "start", entryId: captured.operationId, input: { ...args } };
      else if (path === "entries.continue") command = { kind: "continue", entryId: captured.operationId, input: { id: String(args.id), ...(args.timeZone !== undefined ? { timeZone: args.timeZone as string } : {}), ...(args.originId !== undefined ? { originId: args.originId as string } : {}) } };
      else if (starting) {
        const { end, ...fields } = args; void end;
        if (Object.keys(fields).some(field => !["id", "originId"].includes(field))) apply(targetId, copy, privateEntryEdit({ scope: copy.scope, directory: copy.directory, records: views.get(targetId)!, current: binding.current, path: "entries.update", input: fields, now: captured.now }));
        command = { kind: "reopen", id: String(args.id) };
      } else {
        if (!pointer || pointer.workspaceId !== targetId || (args.id !== undefined && args.id !== pointer.entryId)) throw new PrivateContentUnavailableError("The original private timer is no longer running");
        if (path === "entries.discard" || path === "entries.remove") command = { kind: "discard", id: pointer.entryId };
        else if (path === "entries.stop" || (path === "entries.update" && typeof args.end === "string")) {
          if (path === "entries.update") { const { end, ...fields } = args; void end; if (Object.keys(fields).some(field => !["id", "originId"].includes(field))) apply(targetId, copy, privateTimerEntryEdit({ scope: copy.scope, directory: copy.directory, records: views.get(targetId)!, current: binding.current, command: { kind: "update", input: { ...fields, id: pointer.entryId } }, expectedRunningId: pointer.entryId, now: captured.now })); }
          command = { kind: "stop", id: pointer.entryId, end: typeof args.end === "string" ? args.end : stamp };
        } else { const { end, ...fields } = args; void end; command = { kind: "update", input: { ...fields, id: pointer.entryId } }; }
      }
      const plan = privateTimerEntryEdit({ scope: copy.scope, directory: copy.directory, records: views.get(targetId)!, current: binding.current, command, expectedRunningId: starting ? null : pointer!.entryId, now: captured.now });
      apply(targetId, copy, plan); check();
      let result: Result = plan.result;
      if (["entries.start", "entries.continue"].includes(path) && "end" in result) {
        let replaced: StartTimerReplaced | null = null;
        if (pointer && pointer.workspaceId !== targetId) replaced = await privateTimerReplacement(await copyFor(pointer.workspaceId), pointer.entryId, switchingEnd);
        else if (!pointer && current.value && current.value.workspaceId !== targetId) replaced = { entryId: current.value.id, workspaceId: current.value.workspaceId, workspaceName: workspaceNameFor(current.value.workspaceId), end: switchingEnd };
        result = { ...result, replaced };
      }
      check();
      const receipt = await privateTimerIntentRecord({ scope: copy.scope, directory: copy.directory, records: view.records, current: binding.current, intent, result: result as Result, now: captured.now });
      plans.get(targetId)!.records.push(receipt);
      const secrets = privateSession(userId)!, edits: SignedPrivateChainedEdit[] = [];
      for (const [id, draft] of [...plans].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        const tail = await draft.copy.prepareTail(); check(); const records = [];
        for (const row of draft.records) { records.push(await encryptPrivateRecord(id, row, draft.copy.directory.signed.directory.members, tail.revision + 1)); check(); }
        edits.push(await signPrivateChainedWorkspaceEdit({ edit: { v: 1, workspaceId: id, userId, operationId: crypto.randomUUID(), expectedRevision: tail.revision, records, remove: draft.remove.map(row => ({ ...row, readers: readersForPrivateRecord(row.kind, row.authorId, draft.copy.directory.signed.directory.members).map(member => member.userId).sort() })) }, directory: draft.copy.directory, previousRoot: tail.head, secrets, current: binding.current })); check();
      }
      const standard = starting && !pointer && current.value ? current.value : null;
      const signed = await signPrivateTimer({ v: 1, protocol: "trackyourtime-private-account-timer-v1", server: binding.server, userId, operationId: captured.operationId, revision: snapshot.local.revision + 1, previousRoot: snapshot.local.root, previous: pointer, current: plan.current, standardStop: standard ? { workspaceId: standard.workspaceId, entryId: standard.id } : null, edits: await privateTimerEditBindings(edits) }, secrets.signingPrivateKey, binding.current); check(); supported();
      const permit = await context.timer.prepare({ signed, edits, ...(standard ? { standardStopEnd: switchingEnd } : {}) }); check();
      for (const draft of plans.values()) { await draft.copy.stageCoordinated(permit); check(); }
      await context.timer.publish(permit); check(); notePrivateView(binding); check();
      for (const draft of plans.values()) notifyPrivateWorkspaceEdit(draft.copy.scope);
      return { handled: true as const, value: markPrivateLocalResult(result) };
    } finally { for (const copy of copies.values()) copy.close(); }
  });
  if ("handoff" in outcome && outcome.handoff) return finishPrivateStandardHandoff(userId, outcome.handoff, original);
  if ("handled" in outcome && outcome.handled) return outcome;
  return { handled: false as const };
}
