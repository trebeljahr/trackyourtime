// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStorage, randomSecret } from "@starter/core";
const state = vi.hoisted(() => ({ origin: "https://api.example.test", changed: null as (() => void) | null, bridge: null as unknown }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => state.origin, subscribeApiOrigin: (fn: () => void) => { state.changed = fn; return () => {}; } }));
vi.mock("./desktop-activity", () => ({ desktopActivity: () => state.bridge }));
const { installPrivateSession, lockPrivateData, privateAccountId, whenPrivateAccountReady, newPrivateIdentity, privateSession, privateWorkspaceStorage, unlockPrivateRecovery, unlockPrivatePrf, wrapIdentityWithPrf, protectPrivateActivity, privateAccountChanged } = await import("./private-session");
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); localStorage.clear(); state.origin = "https://api.example.test"; state.bridge = null; lockPrivateData(); privateAccountChanged(null); });
afterEach(() => { state.bridge = null; lockPrivateData(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("private session keys", () => {
  it("keeps recovered keys inactive if durable routing protection cannot be confirmed", async () => {
    const draft = await newPrivateIdentity("owner");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {});
    await expect(unlockPrivateRecovery("owner", draft.identity, draft.recoveryKey)).rejects.toThrow("confirm private routing");
    expect(privateSession("owner")).toBeNull();
  });
  it("does not let a delayed recovery replace another unlock, even for the same account", async () => {
    const first = await newPrivateIdentity("owner"), second = await newPrivateIdentity("owner"), decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    let resume!: () => void, enter!: () => void; const entered = new Promise<void>((resolve) => { enter = resolve; });
    vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce(async (...args) => { enter(); await new Promise<void>((resolve) => { resume = resolve; }); return decrypt(...args); });
    const pending = unlockPrivateRecovery("owner", first.identity, first.recoveryKey); await entered; installPrivateSession("owner", second.secrets); resume();
    await expect(pending).rejects.toThrow("Private keys changed"); expect(privateSession("owner")).toEqual(second.secrets);
  });
  it("restores the same identity using a recovery key without an account password", async () => {
    const draft = await newPrivateIdentity("owner");
    expect(JSON.stringify(draft.identity)).not.toContain(draft.secrets.master);
    await unlockPrivateRecovery("owner", draft.identity, draft.recoveryKey);
    expect(privateSession("owner")).toEqual(draft.secrets);
    expect(privateSession("other")).toBeNull();
    lockPrivateData();
    await expect(unlockPrivateRecovery("owner", draft.identity, "A".repeat(43))).rejects.toThrow();
    expect(privateSession("owner")).toBeNull();
    await expect(unlockPrivateRecovery("other", draft.identity, draft.recoveryKey)).rejects.toThrow();
  });
  it("keeps the resolved account across an api-origin publish that changes no server", async () => {
    // On web, api-origin publishes once when it becomes ready, often after
    // AuthProvider has already resolved the account (a reload with a cached
    // session). Forgetting the account then left every request waiting.
    privateAccountChanged("owner");
    state.changed?.();
    expect(privateAccountId()).toBe("owner");
    await expect(whenPrivateAccountReady()).resolves.toBe("owner");
    state.origin = "https://other.example.test"; state.changed?.();
    expect(privateAccountId()).toBeUndefined();
  });
  it("binds decryption to this installation and locks on account or server change", async () => {
    const draft = await newPrivateIdentity("owner"); installPrivateSession("owner", draft.secrets);
    privateAccountChanged("other"); expect(privateSession("owner")).toBeNull();
    installPrivateSession("owner", draft.secrets);
    state.origin = "https://other.example.test"; expect(privateSession("owner")).toBeNull(); state.changed?.();
    await expect(unlockPrivateRecovery("owner", draft.identity, draft.recoveryKey)).rejects.toThrow();
  });
  it("uses local passkey PRF results to unwrap the identity and rejects a different credential", async () => {
    const draft = await newPrivateIdentity("owner"), prf = randomSecret(); installPrivateSession("owner", draft.secrets);
    const envelope = await wrapIdentityWithPrf("owner", prf, draft.identity);
    const identity = { ...draft.identity, passkeys: [{ credentialId: "credential", envelope }] };
    lockPrivateData(); await unlockPrivatePrf("owner", identity, "credential", prf);
    expect(privateSession("owner")).toEqual(draft.secrets); lockPrivateData();
    await expect(unlockPrivatePrf("owner", identity, "other", prf)).rejects.toThrow();
    await expect(unlockPrivatePrf("owner", identity, "credential", randomSecret())).rejects.toThrow();
  });
  it("never reinstalls an identity when a lock or account change happens during decryption", async () => {
    const draft = await newPrivateIdentity("owner");
    const recoveryUnlock = unlockPrivateRecovery("owner", draft.identity, draft.recoveryKey);
    lockPrivateData();
    await expect(recoveryUnlock).rejects.toThrow("changed during");
    expect(privateSession("owner")).toBeNull();
    expect(() => draft.assertCurrent()).toThrow("changed during");
    installPrivateSession("owner", draft.secrets);
    const secret = randomSecret(), envelope = await wrapIdentityWithPrf("owner", secret, draft.identity);
    lockPrivateData(); privateAccountChanged("owner");
    const prfUnlock = unlockPrivatePrf("owner", { ...draft.identity, passkeys: [{ credentialId: "credential", envelope }] }, "credential", secret);
    privateAccountChanged("other");
    await expect(prfUnlock).rejects.toThrow("changed during");
    expect(privateSession("owner")).toBeNull();
  });
  it("sends only a purpose-specific activity key to the native bridge and clears it on lock", async () => {
    const protect = vi.fn(async (_input: { key: string; userId: string; origin: string; remember?: boolean }) => ({})), lock = vi.fn(async () => ({}));
    state.bridge = { protect, lock, snapshot: async () => ({ protection: { encrypted: false } }) };
    const draft = await newPrivateIdentity("owner"); installPrivateSession("owner", draft.secrets);
    await protectPrivateActivity("owner", false);
    expect(protect).toHaveBeenCalledTimes(1);
    expect(protect.mock.calls[0]?.[0]).toEqual({ key: expect.any(String), userId: "owner", origin: state.origin, remember: false });
    expect(JSON.stringify(protect.mock.calls)).not.toContain(draft.secrets.master);
    expect(JSON.stringify(protect.mock.calls)).not.toContain(draft.secrets.privateKey.d);
    lockPrivateData(); expect(lock).toHaveBeenCalled();
    await expect(protectPrivateActivity("owner")).rejects.toThrow();
  });
  it("rejects substituted encryption or signing public keys even when its recovery envelope decrypts", async () => {
    const draft = await newPrivateIdentity("owner"), other = await newPrivateIdentity("owner");
    await expect(unlockPrivateRecovery("owner", { ...draft.identity, publicKey: other.identity.publicKey }, draft.recoveryKey)).rejects.toThrow("do not match");
    await expect(unlockPrivateRecovery("owner", { ...draft.identity, signingPublicKey: other.identity.signingPublicKey }, draft.recoveryKey)).rejects.toThrow("do not match");
    expect(privateSession("owner")).toBeNull();
    installPrivateSession("owner", draft.secrets);
    await expect(wrapIdentityWithPrf("owner", randomSecret(), { ...draft.identity, publicKey: other.identity.publicKey })).rejects.toThrow("do not match");
    const secret = randomSecret(), envelope = await wrapIdentityWithPrf("owner", secret, draft.identity);
    lockPrivateData();
    await expect(unlockPrivatePrf("owner", { ...draft.identity, publicKey: other.identity.publicKey, passkeys: [{ credentialId: "credential", envelope }] }, "credential", secret)).rejects.toThrow("do not match");
    expect(privateSession("owner")).toBeNull();
  });
  it("does not finish passkey enrollment when private data locks while its envelope is being encrypted", async () => {
    const draft = await newPrivateIdentity("owner"); installPrivateSession("owner", draft.secrets);
    const wrapping = wrapIdentityWithPrf("owner", randomSecret(), draft.identity);
    lockPrivateData();
    await expect(wrapping).rejects.toThrow("changed during");
  });
  it("binds private workspace storage to the unlocked identity and leaves the legacy multi-account queue untouched", async () => {
    const draft = await newPrivateIdentity("owner"), backing = memoryStorage(); installPrivateSession("owner", draft.secrets);
    await backing.setItem("trackyourtime.offline-queue", "other account's unsent work");
    const encrypted = await privateWorkspaceStorage("owner", "workspace", backing);
    await encrypted.setItem("replica", "private cached work");
    expect(await encrypted.getItem("replica")).toBe("private cached work");
    expect(await backing.getItem(`${encrypted.namespace}replica`)).not.toContain("private cached work");
    expect(await backing.getItem("trackyourtime.offline-queue")).toBe("other account's unsent work");
    lockPrivateData(); await expect(encrypted.getItem("replica")).rejects.toThrow("Unlock private data");
    await unlockPrivateRecovery("owner", draft.identity, draft.recoveryKey);
    expect(await encrypted.getItem("replica")).toBe("private cached work");
    state.origin = "https://other.example.test"; state.changed?.();
    const other = await newPrivateIdentity("owner"); installPrivateSession("owner", other.secrets);
    await expect(encrypted.getItem("replica")).rejects.toThrow("Unlock private data");
    const elsewhere = await privateWorkspaceStorage("owner", "workspace", backing);
    expect(elsewhere.namespace).not.toBe(encrypted.namespace);
    expect(await elsewhere.getItem("replica")).toBeNull();
  });
});
