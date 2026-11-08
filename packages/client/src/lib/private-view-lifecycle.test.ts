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

it("discards private form state across workspace switches while leaving standard-only accounts unchanged", async () => {
 const lifecycle = await import("./private-view-lifecycle");
 lifecycle.setPrivateViewWorkspaceContext("standard-one"); expect(lifecycle.privateViewEpoch()).toBe("0");
 lifecycle.setPrivateViewWorkspaceContext("private-one"); lifecycle.notePrivateView({ server: state.server, userId: state.user! });
 const privateEpoch = lifecycle.privateViewEpoch(); lifecycle.setPrivateViewWorkspaceContext("standard-two"); expect(lifecycle.privateViewEpoch()).not.toBe(privateEpoch);
});

it("re-reads in place on a page's first private view, and remounts on every later change", async () => {
 const lifecycle = await import("./private-view-lifecycle"), changed = vi.fn(); lifecycle.subscribePrivateViewEpoch(changed);
 const mount = lifecycle.privateViewMountKey();
 // The first private read of this page load: an open dialog must survive it.
 lifecycle.notePrivateView({ server: state.server, userId: state.user! });
 expect(changed).toHaveBeenLastCalledWith("first-view"); expect(lifecycle.privateViewMountKey()).toBe(mount);
 lifecycle.notePrivateView({ server: state.server, userId: state.user! }); expect(changed).toHaveBeenCalledTimes(1);
 // A lock or new keys discards everything.
 state.version++; for (const f of state.sessionListeners) f();
 expect(changed).toHaveBeenLastCalledWith("change"); const afterLock = lifecycle.privateViewMountKey(); expect(afterLock).not.toBe(mount);
 // Leaving for a standard account and coming back to a seen private one is
 // an account change, not a first view, even though the epoch was "0" between.
 state.user = "standard-b"; for (const f of state.accountListeners) f(); expect(changed).toHaveBeenLastCalledWith("change");
 const standard = lifecycle.privateViewMountKey(); expect(standard).not.toBe(afterLock);
 state.user = "private-a"; for (const f of state.accountListeners) f();
 expect(changed).toHaveBeenLastCalledWith("change"); expect(lifecycle.privateViewMountKey()).not.toBe(standard);
});
