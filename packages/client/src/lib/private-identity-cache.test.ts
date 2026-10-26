// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomSecret, seal, encodeSecret } from "@starter/core";
const state = vi.hoisted(() => ({ origin: "https://api.example.test" }));
vi.mock("./api-origin", () => ({ getApiOrigin: () => state.origin, subscribeApiOrigin: () => () => {} }));
vi.mock("./desktop-activity", () => ({ desktopActivity: () => null }));
vi.mock("./shell", () => ({ isCapacitor: () => false }));
const session = await import("./private-session");
const cache = await import("./private-identity-cache");
const stored = () => localStorage.getItem(localStorage.key(0)!)!;
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); localStorage.clear(); state.origin = "https://api.example.test"; session.lockPrivateData(); session.privateAccountChanged("owner"); });
afterEach(() => { session.lockPrivateData(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("reopens the enrolled root offline after locking and persists no raw secrets or recovery key", async () => {
 const draft = await session.newPrivateIdentity("owner"); session.installPrivateSession("owner", draft.secrets);
 await cache.rememberPrivateIdentity("owner", draft.identity, draft.recoveryKey); const raw = stored();
 for (const secret of [draft.secrets.master, draft.secrets.privateKey.d!, draft.secrets.signingPrivateKey.d!, draft.recoveryKey]) expect(raw).not.toContain(secret);
 expect(raw).not.toContain('"d":'); session.lockPrivateData();
 const fetcher = vi.fn(() => { throw new Error("Offline"); }); vi.stubGlobal("fetch", fetcher);
 const cached = await cache.cachedPrivateIdentity("owner"); expect(cached).toEqual(draft.identity);
 await session.unlockPrivateRecovery("owner", cached!, draft.recoveryKey); expect(session.privateSession("owner")).toEqual(draft.secrets); expect(fetcher).not.toHaveBeenCalled();
});
it("cannot remember arbitrary API envelopes while locked or overwrite a known root with different keys", async () => {
 const first = await session.newPrivateIdentity("owner"); await expect(cache.rememberPrivateIdentity("owner", first.identity)).rejects.toThrow("Unlock");
 session.installPrivateSession("owner", first.secrets); await cache.rememberPrivateIdentity("owner", first.identity, first.recoveryKey); const raw = stored();
 const other = await session.newPrivateIdentity("owner"); session.installPrivateSession("owner", other.secrets);
 await expect(cache.rememberPrivateIdentity("owner", other.identity, other.recoveryKey)).rejects.toThrow("differ"); expect(stored()).toBe(raw);
});
it("detects corruption before exposing passkey IDs and preserves invalid storage instead of replacing it", async () => {
 const draft = await session.newPrivateIdentity("owner"); session.installPrivateSession("owner", draft.secrets); await cache.rememberPrivateIdentity("owner", draft.identity);
 const row = JSON.parse(stored()); row.statement.identity.passkeys = [{ credentialId: "substituted-credential", envelope: draft.identity.recovery }];
 const raw = JSON.stringify(row); localStorage.setItem(localStorage.key(0)!, raw);
 await expect(cache.cachedPrivateIdentity("owner")).rejects.toThrow("could not be verified");
 await expect(cache.rememberPrivateIdentity("owner", draft.identity)).rejects.toThrow("could not be verified"); expect(stored()).toBe(raw);
});
it("preserves known recovery ciphertext across passkey-only updates and permits verified recovery changes", async () => {
 const draft = await session.newPrivateIdentity("owner"); session.installPrivateSession("owner", draft.secrets); await cache.rememberPrivateIdentity("owner", draft.identity, draft.recoveryKey);
 const recoveryRaw = randomSecret(), recoveryKey = encodeSecret(recoveryRaw), recovery = await seal(recoveryRaw, draft.secrets, `trackyourtime:identity:v1:${state.origin}:owner`);
 const next = { ...draft.identity, recovery, passkeys: [{ credentialId: "new-credential", envelope: draft.identity.recovery }] };
 await cache.rememberPrivateIdentity("owner", next); expect((await cache.cachedPrivateIdentity("owner"))!.recovery).toEqual(draft.identity.recovery);
 expect((await cache.cachedPrivateIdentity("owner"))!.passkeys).toEqual(next.passkeys);
 await expect(cache.rememberPrivateIdentity("owner", next, draft.recoveryKey)).rejects.toThrow();
 await cache.rememberPrivateIdentity("owner", next, recoveryKey); expect((await cache.cachedPrivateIdentity("owner"))!.recovery).toEqual(recovery);
});
it("scopes wrappers to their exact account/server and erases only the deleted account", async () => {
 const draft = await session.newPrivateIdentity("owner"); session.installPrivateSession("owner", draft.secrets); await cache.rememberPrivateIdentity("owner", draft.identity, draft.recoveryKey);
 session.privateAccountChanged("other"); expect(await cache.cachedPrivateIdentity("other")).toBeNull(); session.privateAccountChanged("owner");
 state.origin = "https://other.example.test"; expect(await cache.cachedPrivateIdentity("owner")).toBeNull(); state.origin = "https://api.example.test";
 localStorage.setItem("unrelated-account-data", "keep"); await cache.eraseCachedPrivateIdentity({ server: state.origin, userId: "owner" }); expect(await cache.cachedPrivateIdentity("owner")).toBeNull(); expect(localStorage.getItem("unrelated-account-data")).toBe("keep");
});
it("refuses storage/readback failures instead of acknowledging a memory-only save", async () => {
 const draft = await session.newPrivateIdentity("owner"); session.installPrivateSession("owner", draft.secrets);
 const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Quota"); });
 await expect(cache.rememberPrivateIdentity("owner", draft.identity)).rejects.toThrow("Quota"); expect(localStorage.length).toBe(0); write.mockRestore();
 vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {}); await expect(cache.rememberPrivateIdentity("owner", draft.identity)).rejects.toThrow("reopened");
});
it("does not overwrite saved keys when locking interrupts an update", async () => {
 const draft = await session.newPrivateIdentity("owner"); session.installPrivateSession("owner", draft.secrets); await cache.rememberPrivateIdentity("owner", draft.identity, draft.recoveryKey); const raw = stored();
 const pending = cache.rememberPrivateIdentity("owner", draft.identity); session.lockPrivateData(); await expect(pending).rejects.toThrow("changed"); expect(stored()).toBe(raw);
});
