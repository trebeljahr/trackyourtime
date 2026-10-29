import { encryptPrivateRecord, privateTimerEntryEdit, PRIVATE_ENTRY_EDIT_KINDS, preparePrivateTimerIntent, privateStandardHandoffRecord, privateTimerEditBindings, signPrivateChainedWorkspaceEdit, signPrivateTimer, privateWorkspaceSummary, PrivateTimerConflictError, type PrivateStandardHandoffIntent, type PrivateTimerCheckpoint } from "@starter/core";
import { standardCurrentTimerSchema, type StartTimerReplaced } from "@starter/shared";
import type { PrivateTimerAction } from "./private-timer-action";
import type { privateAccountTimerStore } from "./private-replica";
import type { openPrivateWorkspaceCoordinatorCopy } from "./private-workspace-session";
import { privateClientScope } from "./private-client-scope";
import { privateSession } from "./private-session";
import { checkPrivateRequestScope, type PrivateRequestScope } from "./private-request-scope";
import { workspaceContentRoute } from "./private-content-route";
import { privateBoundRpc, privateScopedRpc } from "./private-scoped-rpc";
import { syncPrivateAccountTimer } from "./private-account-timer-sync";
import { notePrivateView } from "./private-view-lifecycle";
import { markPrivateLocalResult } from "./private-local-result";
import { notifyPrivateWorkspaceEdit } from "./private-workspace-sync";
import { PrivateContentUnavailableError } from "./private-content-error";
type Copy = Awaited<ReturnType<typeof openPrivateWorkspaceCoordinatorCopy>>;
export type SavedPrivateStandardHandoff = { operationId: string; payload: PrivateStandardHandoffIntent };
export async function privateTimerReplacement(copy: Copy, entryId: string, end: string): Promise<StartTimerReplaced | null> {
  const view = await copy.readKinds(["workspaceIdentity"]); copy.check();
  if (!view.records.length) return null;
  const workspace = privateWorkspaceSummary({ scope: copy.scope, directory: copy.directory, records: view.records, current: copy.current, isDefault: false });
  return { entryId, workspaceId: copy.scope.workspaceId, workspaceName: workspace.name, end };
}
/** Caller holds the account timer gate and has verified the original current
 * body. Save the complete plan before touching either running representation. */
export async function stagePrivateStandardHandoff(options: {
  userId: string; workspaceId: string; body: Record<string, unknown>; action: PrivateTimerAction;
  timer: Awaited<ReturnType<typeof privateAccountTimerStore>>; local: PrivateTimerCheckpoint; copy: Copy; check: () => void;
}): Promise<SavedPrivateStandardHandoff> {
  const { userId, workspaceId, action, timer, local, copy, check } = options, binding = privateClientScope(userId);
  check(); const { supported } = privateScopedRpc(userId, "privacy.standardTimerResult", 20_000); supported();
  if (!local.current || local.current.workspaceId !== copy.scope.workspaceId) throw new PrivateContentUnavailableError("The original private timer changed before its handoff");
  const intent = await preparePrivateTimerIntent({ scope: { ...copy.scope, workspaceId }, path: "entries.start", input: options.body, operationId: action.operationId, current: binding.current }); check();
  const end = typeof intent.input.start === "string" ? intent.input.start : new Date(action.now).toISOString();
  const view = await copy.readKinds(PRIVATE_ENTRY_EDIT_KINDS), replaced = await privateTimerReplacement(copy, local.current.entryId, end); check();
  const handoff = await privateStandardHandoffRecord({ scope: copy.scope, directory: copy.directory, records: view.records, current: binding.current, intent, accountRevision: local.revision + 1, replaced, now: action.now }); check();
  const stopped = privateTimerEntryEdit({ scope: copy.scope, directory: copy.directory, records: view.records, current: binding.current, command: { kind: "stop", id: local.current.entryId, end: handoff.payload.input.start }, expectedRunningId: local.current.entryId, now: action.now });
  const tail = await copy.prepareTail(); check(); const records = [];
  for (const row of [...stopped.records, handoff.record]) { records.push(await encryptPrivateRecord(copy.scope.workspaceId, row, copy.directory.signed.directory.members, tail.revision + 1)); check(); }
  const secrets = privateSession(userId)!, edit = await signPrivateChainedWorkspaceEdit({ edit: { v: 1, workspaceId: copy.scope.workspaceId, userId, operationId: crypto.randomUUID(), expectedRevision: tail.revision, records, remove: [] }, directory: copy.directory, previousRoot: tail.head, secrets, current: binding.current }); check();
  const signed = await signPrivateTimer({ v: 1, protocol: "trackyourtime-private-account-timer-v1", server: binding.server, userId, operationId: action.operationId, revision: local.revision + 1, previousRoot: local.root, previous: local.current, current: null, standardStop: null, standardStart: { workspaceId, entryId: handoff.payload.entryId }, edits: await privateTimerEditBindings([edit]) }, secrets.signingPrivateKey, binding.current); check(); supported();
  const permit = await timer.prepare({ signed, edits: [edit], standardStartInput: handoff.payload.input }); check();
  await copy.stageCoordinated(permit); check(); await timer.publish(permit); check();
  notePrivateView(binding); notifyPrivateWorkspaceEdit(copy.scope); check();
  return { operationId: action.operationId, payload: handoff.payload };
}
/** No original-result read is allowed to clear pending work. Verify both
 * histories first; the server endpoint is replay-only and cannot recreate time. */
export async function finishPrivateStandardHandoff(userId: string, saved: SavedPrivateStandardHandoff, original: PrivateRequestScope) {
  const binding = privateClientScope(userId), deadline = performance.now() + 20_000;
  const check = () => { binding.check(); checkPrivateRequestScope(original); };
  const current = () => { try { check(); return performance.now() < deadline; } catch { return false; } };
  try {
    check(); const synced = await syncPrivateAccountTimer(userId, current); check();
    if (!synced.caughtUp || synced.pending || synced.committed || synced.conflict || synced.revision < saved.payload.accountRevision) throw new PrivateContentUnavailableError("The timer handoff is saved and is waiting for verified sync");
    const route = await workspaceContentRoute(userId, saved.payload.workspaceId, binding.server); check(); route.check();
    if (route.mode !== "standard") throw new PrivateContentUnavailableError("The original standard timer workspace is now private. The handoff was kept.");
    const guarded = { ...binding, check: () => { check(); route.check(); }, current: () => { try { check(); route.check(); return true; } catch { return false; } } };
    const { rpc, supported } = privateBoundRpc(guarded, "privacy.standardTimerResult", 20_000); supported();
    const entry = standardCurrentTimerSchema.parse(await rpc.privacy.standardTimerResult.mutate({ workspaceId: saved.payload.workspaceId, entryId: saved.payload.entryId, operationId: saved.operationId, input: saved.payload.input })); check(); route.check(); supported();
    if (entry.id !== saved.payload.entryId || entry.workspaceId !== saved.payload.workspaceId || entry.authorId !== userId || Date.parse(entry.start) !== Date.parse(saved.payload.input.start)) throw new PrivateContentUnavailableError("The original standard timer result could not be verified");
    notePrivateView(binding); check();
    return { handled: true as const, value: markPrivateLocalResult({ ...entry, replaced: saved.payload.replaced }) };
  } catch (error) {
    check();
    if (error instanceof PrivateContentUnavailableError) throw error;
    if (error instanceof PrivateTimerConflictError) throw new PrivateContentUnavailableError("The account timer changed. The saved handoff needs review.");
    throw new PrivateContentUnavailableError("The timer handoff is saved. Reconnect to confirm its result.");
  }
}
