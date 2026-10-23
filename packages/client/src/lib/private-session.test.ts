// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomSecret } from "@starter/core";
const state = vi.hoisted(() => ({ origin: "https://api.example.test", changed: null as (() => void) | null, bridge: null as unknown }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => state.origin, subscribeApiOrigin: (fn: () => void) => { state.changed = fn; return () => {}; } }));
vi.mock("./desktop-activity", () => ({ desktopActivity: () => state.bridge }));
const { installPrivateSession, lockPrivateData, newPrivateIdentity, privateSession, unlockPrivateRecovery, unlockPrivatePrf, wrapIdentityWithPrf, protectPrivateActivity, privateAccountChanged } = await import("./private-session");
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); state.origin = "https://api.example.test"; state.bridge = null; lockPrivateData(); privateAccountChanged(null); });
afterEach(() => { state.bridge = null; lockPrivateData(); vi.unstubAllGlobals(); });
describe("private session keys", () => {
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
  it("binds decryption to this installation and locks on account or server change", async () => {
    const draft = await newPrivateIdentity("owner"); installPrivateSession("owner", draft.secrets);
    privateAccountChanged("other"); expect(privateSession("owner")).toBeNull();
    installPrivateSession("owner", draft.secrets);
    state.origin = "https://other.example.test"; expect(privateSession("owner")).toBeNull(); state.changed?.();
    await expect(unlockPrivateRecovery("owner", draft.identity, draft.recoveryKey)).rejects.toThrow();
  });
  it("uses local passkey PRF results to unwrap the identity and rejects a different credential", async () => {
    const draft = await newPrivateIdentity("owner"), prf = randomSecret(); installPrivateSession("owner", draft.secrets);
    const envelope = await wrapIdentityWithPrf("owner", prf);
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
    const secret = randomSecret(), envelope = await wrapIdentityWithPrf("owner", secret);
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
});
