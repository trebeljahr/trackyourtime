import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ user: "private-a" as string | null, server: "https://api.example.test", version: 0, routing: 0, sessionListeners: new Set<() => void>(), accountListeners: new Set<() => void>(), routingListeners: new Set<() => void>() }));
const add = (set: Set<() => void>, f: () => void) => { set.add(f); return () => { set.delete(f); }; };
vi.mock("./private-session", () => ({ privateSessionVersion: () => state.version, privateAccountId: () => state.user, privateDataOrigin: () => state.server, subscribePrivateSession: (f: () => void) => add(state.sessionListeners, f), subscribePrivateAccount: (f: () => void) => add(state.accountListeners, f) }));
vi.mock("./private-routing-requirement", () => ({ privateRoutingRevision: () => state.routing, subscribePrivateRoutingRequirement: (f: () => void) => add(state.routingListeners, f) }));
beforeEach(() => { vi.resetModules(); state.user = "private-a"; state.server = "https://api.example.test"; state.version = 0; state.routing = 0; state.sessionListeners.clear(); state.accountListeners.clear(); state.routingListeners.clear(); });
it("clears private views on lock/account change while preserving standard forms during optional key setup", async () => {
 const lifecycle = await import("./private-view-lifecycle"), changed = vi.fn(); lifecycle.subscribePrivateViewEpoch(changed);
 lifecycle.notePrivateView({ userId: state.user!, server: state.server }); const initial = lifecycle.privateViewEpoch(); expect(initial).not.toBe("0");
 state.version++; for (const f of state.sessionListeners) f(); expect(lifecycle.privateViewEpoch()).not.toBe(initial); expect(changed).toHaveBeenCalledTimes(2);
 state.user = "standard-b"; for (const f of state.accountListeners) f(); expect(lifecycle.privateViewEpoch()).toBe("0"); const count = changed.mock.calls.length;
 state.version++; for (const f of state.sessionListeners) f(); expect(lifecycle.privateViewEpoch()).toBe("0"); expect(changed).toHaveBeenCalledTimes(count);
 state.user = "private-a"; for (const f of state.accountListeners) f(); expect(lifecycle.privateViewEpoch()).not.toBe("0"); expect(changed).toHaveBeenCalledTimes(count + 1);
});
it("keeps private account/server scopes separate and refuses a stale response before persistence handlers see it", async () => {
 const lifecycle = await import("./private-view-lifecycle"), observed = vi.fn(); lifecycle.subscribePrivateView(observed);
 expect(() => lifecycle.notePrivateView({ server: state.server, userId: "other" })).toThrow("account changed"); expect(observed).not.toHaveBeenCalled();
 lifecycle.notePrivateView({ server: state.server, userId: state.user! }); state.server = "https://other.example.test"; for (const f of state.accountListeners) f(); expect(lifecycle.privateViewEpoch()).toBe("0");
 expect(() => lifecycle.notePrivateView({ server: "https://api.example.test", userId: state.user! })).toThrow("account changed"); expect(observed).toHaveBeenCalledOnce();
});
it("invalidates current private views on policy changes without retaining or publishing content", async () => {
 const lifecycle = await import("./private-view-lifecycle"), changed = vi.fn(); lifecycle.subscribePrivateViewEpoch(changed); lifecycle.notePrivateView({ server: state.server, userId: state.user! });
 const before = lifecycle.privateViewEpoch(); state.routing++; for (const f of state.routingListeners) f(); expect(lifecycle.privateViewEpoch()).not.toBe(before); expect(changed).toHaveBeenCalledTimes(2);
 for (const f of state.routingListeners) f(); expect(changed).toHaveBeenCalledTimes(2);
});
