// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import { PrivateAccountInventoryMissingError, LOGIN_SECRET_PREFIX } from "@starter/core";

const state = vi.hoisted(() => ({
  supports: true, level: 42 as number | null,
  kdf: vi.fn(), upgrade: vi.fn(), identity: vi.fn(),
  prepare: vi.fn(), finish: vi.fn(), unlock: vi.fn(),
  status: vi.fn(), bootstrap: vi.fn(), close: vi.fn(), notify: vi.fn(),
  rewrapped: vi.fn(), keysStatus: vi.fn(), verify: vi.fn(), updateIdentity: vi.fn(),
  session: {} as object | null,
}));
vi.mock("@starter/core", async (original) => ({ ...(await original<typeof import("@starter/core")>()), signPrivateChange: async () => "signature" }));
vi.mock("./private-identity-cache", () => ({ rememberPrivateIdentity: async () => ({}) }));
vi.mock("./auth-client", () => ({ authClient: { $store: { atoms: { session: { get: () => ({ data: { user: { email: "a@example.test" } } }) } } } } }));
vi.mock("./server-level", () => ({ serverSupportsNow: () => state.supports, currentServerApiLevel: () => state.level, refreshServerLevel: async () => null }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => "https://api.example.test", getAbsoluteApiOrigin: () => "https://api.example.test", whenApiOriginReady: async () => {} }));
vi.mock("./app-version", () => ({ APP_VERSION: "test" }));
vi.stubGlobal("fetch", async (url: string) => {
  expect(url).toContain("https://api.example.test/api/trpc/accountPassword.kdf?input=");
  return new Response(JSON.stringify({ result: { data: await state.kdf() } }), { status: 200 });
});
vi.mock("./trpc", () => ({ getTRPCClient: () => ({
  accountPassword: { kdf: { query: state.kdf }, upgrade: { mutate: state.upgrade }, keysRewrapped: { mutate: state.rewrapped }, keysStatus: { query: state.keysStatus }, verify: { mutate: state.verify } },
  privacy: { identity: { query: state.identity }, updateIdentity: { mutate: state.updateIdentity } },
  workspaces: { list: { query: async () => [] } },
}) }));
vi.mock("./private-account-setup", () => ({ preparePrivateAccountSetup: state.prepare, finishPrivateAccountSetup: state.finish }));
vi.mock("./private-session", () => ({ unlockPrivatePassword: state.unlock, privateSession: () => state.session, sealIdentityForPassword: async () => ({ sealed: true }) }));
vi.mock("./private-inventory-sync", () => ({
  openPrivateAccountInventorySync: async () => ({ status: state.status, bootstrapFromServer: state.bootstrap, close: state.close, flushOne: async () => ({ pending: 0 }) }),
  privateAccountInventoryTransport: () => ({ transport: true }),
}));
vi.mock("./private-device-access", () => ({ notifyPrivateDeviceAccessChanged: state.notify }));
vi.mock("./active-workspace", () => ({ applyWorkspaceList: async () => ({}) }));

const unlock = await import("./password-unlock");
const kdf = { v: 1, kdf: "PBKDF2-SHA256", iterations: 600000, salt: "AAECAwQFBgcICQoLDA0ODw" } as const;

beforeEach(() => {
  state.supports = true; state.level = 42;
  for (const fn of [state.kdf, state.upgrade, state.identity, state.prepare, state.finish, state.unlock, state.status, state.bootstrap, state.close, state.notify, state.rewrapped, state.keysStatus, state.verify, state.updateIdentity]) fn.mockReset();
  state.session = {};
  state.identity.mockResolvedValue(null);
  state.prepare.mockResolvedValue({ recoveryKey: "recovery-key" });
  unlock.forgetPasswordUnlock();
});

it("sends only the derived login secret to a ready account and creates keys after sign-in", async () => {
  state.kdf.mockResolvedValue({ state: "ready", kdf });
  const sent: string[] = [];
  const result = await unlock.signInWithPasswordUnlock("a@example.test", "typed password", async (secret) => { sent.push(secret); return { ok: true }; });
  expect(result.ok).toBe(true);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.startsWith(LOGIN_SECRET_PREFIX)).toBe(true);
  expect(sent).not.toContain("typed password");
  await unlock.finishPasswordUnlock("user-1");
  expect(state.upgrade).not.toHaveBeenCalled();
  expect(state.prepare).toHaveBeenCalledWith("user-1", { password: { kdf, wrappingKey: expect.any(Uint8Array) } });
  expect(state.finish).toHaveBeenCalledOnce();
  expect(unlock.recoveryKeyToSave("user-1")).toBe("recovery-key");
  expect(unlock.recoveryKeyToSave("someone-else")).toBeNull();
});

it("signs a legacy account in with its typed password once, then upgrades it", async () => {
  state.kdf.mockResolvedValue({ state: "legacy", kdf });
  const sent: string[] = [];
  await unlock.signInWithPasswordUnlock("a@example.test", "typed password", async (secret) => { sent.push(secret); return { ok: true }; });
  expect(sent).toEqual(["typed password"]);
  await unlock.finishPasswordUnlock("user-1");
  const call = state.upgrade.mock.calls[0]![0];
  expect(call.current).toBe("typed password");
  expect(call.loginSecret.startsWith(LOGIN_SECRET_PREFIX)).toBe(true);
  expect(call.kdf.salt).not.toBe(kdf.salt); // fresh parameters, not the decoy
  expect(state.prepare.mock.calls[0]![1].password.kdf).toEqual(call.kdf);
});

it("tries the derived secret when a pending upgrade already stored it", async () => {
  state.kdf.mockResolvedValue({ state: "pending", kdf });
  const sent: string[] = [];
  await unlock.signInWithPasswordUnlock("a@example.test", "typed password", async (secret) => { sent.push(secret); return { ok: secret !== "typed password" }; });
  expect(sent[0]).toBe("typed password");
  expect(sent[1]!.startsWith(LOGIN_SECRET_PREFIX)).toBe(true);
  await unlock.finishPasswordUnlock("user-1");
  expect(state.upgrade.mock.calls[0]![0]).toMatchObject({ current: sent[1], loginSecret: sent[1], kdf });
});

it("keeps the typed password for an older server and runs no key step", async () => {
  state.supports = false;
  const sent: string[] = [];
  await unlock.signInWithPasswordUnlock("a@example.test", "typed password", async (secret) => { sent.push(secret); return { ok: true }; });
  expect(sent).toEqual(["typed password"]);
  expect(state.kdf).not.toHaveBeenCalled();
  await unlock.finishPasswordUnlock("user-1");
  expect(state.identity).not.toHaveBeenCalled();
});

it("opens existing keys with the password and rebuilds a missing inventory from the server", async () => {
  state.kdf.mockResolvedValue({ state: "ready", kdf });
  const identity = { password: { kdf, envelope: {} } };
  state.identity.mockResolvedValue({ identity, revision: 1 });
  state.status.mockRejectedValue(new PrivateAccountInventoryMissingError());
  await unlock.signInWithPasswordUnlock("a@example.test", "typed password", async () => ({ ok: true }));
  await unlock.finishPasswordUnlock("user-1");
  expect(state.unlock).toHaveBeenCalledWith("user-1", identity, expect.any(Uint8Array));
  expect(state.bootstrap).toHaveBeenCalledWith({ transport: true });
  expect(state.close).toHaveBeenCalledOnce();
  expect(state.notify).toHaveBeenCalledOnce();
  expect(state.prepare).not.toHaveBeenCalled();
});

it("does nothing after a failed sign-in, and never twice for one sign-in", async () => {
  state.kdf.mockResolvedValue({ state: "ready", kdf });
  await unlock.signInWithPasswordUnlock("a@example.test", "wrong", async () => ({ ok: false }));
  await unlock.finishPasswordUnlock("user-1");
  expect(state.identity).not.toHaveBeenCalled();
  await unlock.signInWithPasswordUnlock("a@example.test", "typed password", async () => ({ ok: true }));
  await unlock.finishPasswordUnlock("user-1");
  await unlock.finishPasswordUnlock("user-1");
  expect(state.identity).toHaveBeenCalledOnce();
});

it("clears a reset's flag once the keys open with the password", async () => {
  state.kdf.mockResolvedValue({ state: "ready", kdf });
  state.identity.mockResolvedValue({ identity: { password: { kdf, envelope: {} } }, revision: 1 });
  state.status.mockResolvedValue({});
  await unlock.signInWithPasswordUnlock("a@example.test", "typed password", async () => ({ ok: true }));
  await unlock.finishPasswordUnlock("user-1");
  expect(state.rewrapped).toHaveBeenCalledOnce();
});

it("holds the new password after a reset until the recovery key opens the keys, then seals them under it", async () => {
  state.kdf.mockResolvedValue({ state: "ready", kdf });
  state.identity.mockResolvedValue({ identity: { password: { kdf, envelope: {} } }, revision: 3 });
  state.unlock.mockRejectedValue(new Error("envelope sealed under the old password"));
  state.status.mockResolvedValue({});
  state.session = null;
  await unlock.signInWithPasswordUnlock("a@example.test", "new password", async () => ({ ok: true }));
  await unlock.finishPasswordUnlock("user-1");
  expect(unlock.passwordKeysNeedRecovery("user-1")).toBe(true);
  expect(state.updateIdentity).not.toHaveBeenCalled();
  // The recovery key opened them.
  state.session = { signingPrivateKey: {} };
  await unlock.repairKeysAfterUnlock();
  expect(state.updateIdentity).toHaveBeenCalledWith(expect.objectContaining({ revision: 3, identity: expect.objectContaining({ password: { kdf, envelope: { sealed: true } } }) }));
  expect(state.rewrapped).toHaveBeenCalledOnce();
  expect(unlock.passwordKeysNeedRecovery("user-1")).toBe(false);
  expect(state.notify).toHaveBeenCalled();
});

it("asks a device whose keys are open about a reset, and seals nothing under a wrong password", async () => {
  state.keysStatus.mockResolvedValue({ stale: true });
  await unlock.checkPasswordKeysStale("user-1");
  expect(unlock.passwordKeysStale("user-1")).toBe(true);
  state.kdf.mockResolvedValue({ state: "ready", kdf });
  state.verify.mockResolvedValue({ ok: false });
  await expect(unlock.repairKeysWithPassword("user-1", "a typo")).rejects.toBeInstanceOf(unlock.WrongPasswordError);
  expect(state.updateIdentity).not.toHaveBeenCalled();
  state.verify.mockResolvedValue({ ok: true });
  state.identity.mockResolvedValue({ identity: { password: { kdf, envelope: {} } }, revision: 5 });
  await unlock.repairKeysWithPassword("user-1", "the new password");
  expect(state.verify.mock.calls[1]![0].loginSecret.startsWith(LOGIN_SECRET_PREFIX)).toBe(true);
  expect(state.updateIdentity).toHaveBeenCalledOnce();
  expect(unlock.passwordKeysStale("user-1")).toBe(false);
});
