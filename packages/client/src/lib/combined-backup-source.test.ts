// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { emptyRecoveryCollections, emptyRecoverySupplementCollections, recoveryDigest, recoverySupplementDigest, privateMemberKeyFingerprint, privateSourceSessionBinding } from "@starter/core";
const state = vi.hoisted(() => ({ origin: "https://api.example.test", userId: "owner", sessionId: "current-session", authError: false, auth: vi.fn() }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => state.origin, subscribeApiOrigin: () => () => {} }));
vi.mock("./desktop-activity", () => ({ desktopActivity: () => null }));
vi.mock("./auth-client", () => ({ getSession: (...args: unknown[]) => { state.auth(...args); return Promise.resolve({ data: { user: { id: state.userId }, session: { id: state.sessionId } }, error: state.authError ? new Error("Expired login") : null }); } }));
const session = await import("./private-session");
const { readCombinedBackupSource } = await import("./combined-backup-source");
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); state.origin = "https://api.example.test"; state.userId = "owner"; state.sessionId = "current-session"; state.authError = false; state.auth.mockClear(); session.privateAccountChanged(null); session.lockPrivateData(); });
afterEach(() => { session.lockPrivateData(); vi.unstubAllGlobals(); });
async function fixture() {
  const root = await session.newPrivateIdentity("owner"); session.installPrivateSession("owner", root.secrets);
  const scope = { server: state.origin, userId: "owner", workspaceId: "workspace", sessionId: state.sessionId, purpose: "workspace-originals" as const, migrationId: null };
  const now = Date.now(), request = { v: 1 as const, protocol: "trackyourtime-private-source-challenge-v1" as const, requestId: crypto.randomUUID(), server: scope.server, userId: scope.userId, workspaceId: scope.workspaceId, purpose: scope.purpose, migrationId: null, sessionBinding: await privateSourceSessionBinding(scope), keyFingerprint: await privateMemberKeyFingerprint(scope.server, { userId: "owner", ...root.identity }), issuedAt: now, expiresAt: now + 120000 };
  const collections = emptyRecoveryCollections(), extra = emptyRecoverySupplementCollections(); extra.organization.push({ _id: "workspace", name: "Original workspace" });
  const archive = { format: "trackyourtime-workspace-recovery-v2" as const, server: scope.server, ownerId: "owner", snapshot: { v: 1 as const, workspaceId: "workspace", createdAt: new Date(now).toISOString(), collections, sourceRevision: await recoveryDigest(collections) }, supplement: { v: 1 as const, workspaceId: "workspace", createdAt: new Date(now).toISOString(), collections: extra, sourceRevision: await recoverySupplementDigest(extra) } };
  const transport = { challenge: vi.fn(async () => structuredClone(request)), originals: vi.fn(async (_proof: unknown) => structuredClone(archive)) };
  return { root, scope, request, archive, transport };
}
it("signs only the selected account/session operation and validates the combined source without sending keys", async () => {
  const f = await fixture(); expect(await readCombinedBackupSource("owner", "workspace", f.transport)).toEqual(f.archive);
  expect(state.auth).toHaveBeenCalledWith(expect.objectContaining({ query: { disableCookieCache: true } }));
  const proof = f.transport.originals.mock.calls[0]![0];
  expect(proof).toMatchObject({ challenge: { userId: "owner", purpose: "workspace-originals", migrationId: null } });
  const raw = JSON.stringify(proof); expect(raw).not.toContain(f.root.recoveryKey); expect(raw).not.toContain(f.root.secrets.master); expect(raw).not.toContain('"d":'); expect(raw).not.toContain(state.sessionId);
});
it("does not request originals when login, challenge scope or unlocked identity changes", async () => {
  const f = await fixture(); state.userId = "another";
  await expect(readCombinedBackupSource("owner", "workspace", f.transport)).rejects.toThrow("current account login"); expect(f.transport.challenge).not.toHaveBeenCalled();
  state.userId = "owner"; f.request.workspaceId = "different";
  await expect(readCombinedBackupSource("owner", "workspace", f.transport)).rejects.toThrow("another operation"); expect(f.transport.originals).not.toHaveBeenCalled();
  f.request.workspaceId = "workspace"; f.transport.challenge.mockImplementationOnce(async () => { session.lockPrivateData(); return f.request; });
  await expect(readCombinedBackupSource("owner", "workspace", f.transport)).rejects.toThrow(); expect(f.transport.originals).not.toHaveBeenCalled();
});
it("rejects another workspace's combined response, a partial legacy archive and an aborted operation", async () => {
  const f = await fixture(); f.archive.snapshot.workspaceId = "different";
  await expect(readCombinedBackupSource("owner", "workspace", f.transport)).rejects.toThrow();
  f.archive.snapshot.workspaceId = "workspace";
  f.transport.originals.mockResolvedValueOnce({ ...f.archive, format: "trackyourtime-workspace-recovery-v1" } as never);
  await expect(readCombinedBackupSource("owner", "workspace", f.transport)).rejects.toThrow();
  const abort = new AbortController(); abort.abort(); const calls = f.transport.originals.mock.calls.length;
  await expect(readCombinedBackupSource("owner", "workspace", f.transport, abort.signal)).rejects.toThrow(); expect(f.transport.originals).toHaveBeenCalledTimes(calls);
});
