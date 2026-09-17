import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXTENSION_BRIDGE_CHANNEL,
  EXTENSION_BRIDGE_SYNC_MIN_INTERVAL_MS,
  extensionBridgeDeviceReply,
  extensionBridgeSyncReply,
  extensionBridgeUnsupportedReply,
  type ExtensionBridgeSyncAction,
} from "@starter/shared";

import {
  createExtensionBridgeController,
  syncWithExtensions,
  type BridgeWebSession,
  type ExtensionBridgeHost,
  type ExtensionSyncDeps,
} from "./extension-bridge";

const API = "https://api.trackyourtime.dev";
const EXT_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EXT_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REQUEST_ID = "req_0123456789abcdef";
const NOW = 1_800_000_000_000;

const U: BridgeWebSession = { userId: "user-u", createdAt: NOW - 60_000 };
const V: BridgeWebSession = { userId: "user-v", createdAt: NOW - 1_000 };

type Sent = { id: string; message: Record<string, unknown> };

/** A fake extension: `reply(id, message)` decides each answer. */
const harness = (
  reply: (id: string, message: Record<string, unknown>) => unknown,
  overrides: Partial<ExtensionSyncDeps> = {},
): { deps: ExtensionSyncDeps; sent: Sent[]; approve: ReturnType<typeof vi.fn>; signOutWeb: ReturnType<typeof vi.fn> } => {
  const sent: Sent[] = [];
  const approve = vi.fn(async (_code: string) => true);
  const signOutWeb = vi.fn(async () => undefined);
  const deps: ExtensionSyncDeps = {
    ids: [EXT_A],
    apiOrigin: API,
    session: U,
    currentSession: () => U,
    send: async (id, message) => {
      const record = message as Record<string, unknown>;
      sent.push({ id, message: record });
      return reply(id, record);
    },
    approve,
    signOutWeb,
    now: () => NOW,
    ...overrides,
  };
  return { deps, sent, approve, signOutWeb };
};

const syncReply = (action: ExtensionBridgeSyncAction): unknown => extensionBridgeSyncReply(action);

const approveAction = (overrides: Partial<Extract<ExtensionBridgeSyncAction, { type: "approve-device" }>> = {}): ExtensionBridgeSyncAction => ({
  type: "approve-device",
  requestId: REQUEST_ID,
  userCode: "ABCD-1234",
  expiresAt: NOW + 600_000,
  ...overrides,
});

describe("syncWithExtensions", () => {
  it("describes the session and nothing more", async () => {
    const { deps, sent } = harness(() => syncReply({ type: "none", reason: "linked" }));
    await expect(syncWithExtensions(deps)).resolves.toEqual(["nothing-to-do"]);
    expect(sent).toEqual([
      {
        id: EXT_A,
        message: {
          channel: EXTENSION_BRIDGE_CHANNEL,
          v: 1,
          kind: "sync",
          apiOrigin: API,
          web: { userId: "user-u", sessionCreatedAt: U!.createdAt },
        },
      },
    ]);
  });

  it("describes a signed-out page as nulls", async () => {
    const { deps, sent } = harness(() => syncReply({ type: "none", reason: "signed-out" }), {
      session: null,
      currentSession: () => null,
    });
    await syncWithExtensions(deps);
    expect(sent[0]!.message.web).toEqual({ userId: null, sessionCreatedAt: null });
  });

  it("treats no reply, a foreign reply and a malformed reply as no extension", async () => {
    for (const answer of [undefined, { hello: "world" }, { channel: EXTENSION_BRIDGE_CHANNEL, v: 1, kind: "sync-result", action: { type: "launch" } }]) {
      const { deps, sent, approve, signOutWeb } = harness(() => answer);
      await expect(syncWithExtensions(deps)).resolves.toEqual(["no-reply"]);
      expect(sent).toHaveLength(1);
      expect(approve).not.toHaveBeenCalled();
      expect(signOutWeb).not.toHaveBeenCalled();
    }
  });

  it("does nothing with an unsupported reply, nor a device reply to a sync", async () => {
    let { deps } = harness(() => extensionBridgeUnsupportedReply());
    await expect(syncWithExtensions(deps)).resolves.toEqual(["unsupported"]);
    ({ deps } = harness(() => extensionBridgeDeviceReply("signed-in")));
    await expect(syncWithExtensions(deps)).resolves.toEqual(["no-reply"]);
  });

  describe("approve-device", () => {
    it("approves the normalised code and reports it", async () => {
      const { deps, sent, approve } = harness((_id, message) =>
        message.kind === "sync" ? syncReply(approveAction()) : extensionBridgeDeviceReply("signed-in"),
      );
      await expect(syncWithExtensions(deps)).resolves.toEqual(["approved"]);
      expect(approve).toHaveBeenCalledWith("ABCD1234");
      expect(sent[1]).toEqual({
        id: EXT_A,
        message: {
          channel: EXTENSION_BRIDGE_CHANNEL,
          v: 1,
          kind: "device-approved",
          apiOrigin: API,
          requestId: REQUEST_ID,
          outcome: "approved",
        },
      });
    });

    it("reports a failed approval", async () => {
      const { deps, sent, approve } = harness((_id, message) =>
        message.kind === "sync" ? syncReply(approveAction()) : extensionBridgeDeviceReply("failed"),
      );
      approve.mockResolvedValue(false);
      await expect(syncWithExtensions(deps)).resolves.toEqual(["approve-failed"]);
      expect(sent[1]!.message.outcome).toBe("failed");
    });

    it("counts a throwing approval as failed", async () => {
      const { deps, sent, approve } = harness((_id, message) =>
        message.kind === "sync" ? syncReply(approveAction()) : undefined,
      );
      approve.mockRejectedValue(new Error("boom"));
      await expect(syncWithExtensions(deps)).resolves.toEqual(["approve-failed"]);
      expect(sent[1]!.message.outcome).toBe("failed");
    });

    it("never approves when the signed-in user changed before the reply", async () => {
      const { deps, sent, approve } = harness(
        (_id, message) => (message.kind === "sync" ? syncReply(approveAction()) : undefined),
        { currentSession: (() => { let calls = 0; return () => (calls++ === 0 ? U : V); })() },
      );
      await expect(syncWithExtensions(deps)).resolves.toEqual(["approve-failed"]);
      expect(approve).not.toHaveBeenCalled();
      expect(sent[1]!.message.outcome).toBe("failed");
    });

    it("never approves after the page signed out", async () => {
      let current: BridgeWebSession = U;
      const { deps, approve, sent } = harness((_id, message) => {
        if (message.kind === "sync") {
          current = null;
          return syncReply(approveAction());
        }
        return undefined;
      }, { currentSession: () => current });
      await expect(syncWithExtensions(deps)).resolves.toEqual(["approve-failed"]);
      expect(approve).not.toHaveBeenCalled();
      expect(sent[1]!.message.outcome).toBe("failed");
    });

    it("drops an expired code without answering", async () => {
      const { deps, sent, approve } = harness(() => syncReply(approveAction({ expiresAt: NOW - 1 })));
      await expect(syncWithExtensions(deps)).resolves.toEqual(["approve-dropped"]);
      expect(approve).not.toHaveBeenCalled();
      expect(sent).toHaveLength(1);
    });
  });

  describe("sign-out-web", () => {
    it("signs out a session that began before the extension signed out", async () => {
      const { deps, signOutWeb } = harness(() => syncReply({ type: "sign-out-web", at: NOW - 1 }));
      await expect(syncWithExtensions(deps)).resolves.toEqual(["signed-out-web"]);
      expect(signOutWeb).toHaveBeenCalledTimes(1);
    });

    it("keeps a session that began after, or at, the extension's sign-out", async () => {
      for (const at of [U!.createdAt, U!.createdAt - 1]) {
        const { deps, signOutWeb } = harness(() => syncReply({ type: "sign-out-web", at }));
        await expect(syncWithExtensions(deps)).resolves.toEqual(["sign-out-refused"]);
        expect(signOutWeb).not.toHaveBeenCalled();
      }
    });

    it("keeps the session when the user changed or nobody is signed in", async () => {
      let { deps, signOutWeb } = harness(() => syncReply({ type: "sign-out-web", at: NOW }), {
        currentSession: () => V,
      });
      // The first id check passes on the described user; the action re-reads.
      let calls = 0;
      deps.currentSession = () => (calls++ === 0 ? U : V);
      await expect(syncWithExtensions(deps)).resolves.toEqual(["sign-out-refused"]);
      expect(signOutWeb).not.toHaveBeenCalled();

      ({ deps, signOutWeb } = harness(() => syncReply({ type: "sign-out-web", at: NOW }), {
        session: null,
        currentSession: () => null,
      }));
      await expect(syncWithExtensions(deps)).resolves.toEqual(["sign-out-refused"]);
      expect(signOutWeb).not.toHaveBeenCalled();
    });
  });

  describe("several extension ids", () => {
    it("messages each id in turn", async () => {
      const { deps, sent } = harness(
        (id) => (id === EXT_A ? undefined : syncReply({ type: "none", reason: "linked" })),
        { ids: [EXT_A, EXT_B] },
      );
      await expect(syncWithExtensions(deps)).resolves.toEqual(["no-reply", "nothing-to-do"]);
      expect(sent.map((s) => s.id)).toEqual([EXT_A, EXT_B]);
    });

    it("stops after signing out", async () => {
      const { deps, sent } = harness(() => syncReply({ type: "sign-out-web", at: NOW }), {
        ids: [EXT_A, EXT_B],
      });
      await expect(syncWithExtensions(deps)).resolves.toEqual(["signed-out-web"]);
      expect(sent).toHaveLength(1);
    });

    it("stops when the user changed between ids", async () => {
      let current: BridgeWebSession = U;
      const { deps, sent } = harness(
        () => {
          current = V;
          return syncReply({ type: "none", reason: "linked" });
        },
        { ids: [EXT_A, EXT_B], currentSession: () => current },
      );
      await syncWithExtensions(deps);
      expect(sent.map((s) => s.id)).toEqual([EXT_A]);
    });
  });
});

describe("createExtensionBridgeController", () => {
  let now = NOW;
  let sent: Sent[];
  let replies: Array<(value: unknown) => void>;
  let host: ExtensionBridgeHost;

  const syncsSent = (): Array<Record<string, unknown>> =>
    sent.filter((s) => s.message.kind === "sync").map((s) => s.message.web as Record<string, unknown>);

  beforeEach(() => {
    now = NOW;
    sent = [];
    replies = [];
    host = {
      enabled: () => true,
      ids: () => [EXT_A],
      apiOrigin: () => API,
      send: (id, message) => {
        sent.push({ id, message: message as Record<string, unknown> });
        return Promise.resolve(syncReply({ type: "none", reason: "linked" }));
      },
      approve: async () => true,
      signOutWeb: async () => undefined,
      now: () => now,
    };
  });

  it("sends nothing while the session is pending or failed", async () => {
    const bridge = createExtensionBridgeController(host);
    bridge.update({ status: "pending" });
    bridge.update({ status: "error" });
    bridge.wake();
    await bridge.idle();
    expect(sent).toHaveLength(0);
  });

  it("sends once the session resolves, including a resolved null", async () => {
    const bridge = createExtensionBridgeController(host);
    bridge.update({ status: "pending" });
    bridge.update({ status: "resolved", session: null });
    await bridge.idle();
    expect(syncsSent()).toEqual([{ userId: null, sessionCreatedAt: null }]);
  });

  it("does nothing on a disabled host (app shell, no chrome) or without ids", async () => {
    let bridge = createExtensionBridgeController({ ...host, enabled: () => false });
    bridge.update({ status: "resolved", session: U });
    bridge.wake();
    await bridge.idle();
    bridge = createExtensionBridgeController({ ...host, ids: () => [] });
    bridge.update({ status: "resolved", session: U });
    await bridge.idle();
    expect(sent).toHaveLength(0);
  });

  it("sends every user transition at once, and not a repeat of the same user", async () => {
    const bridge = createExtensionBridgeController(host);
    bridge.update({ status: "resolved", session: U });
    await bridge.idle();
    bridge.update({ status: "resolved", session: { ...U!, createdAt: U!.createdAt + 5 } });
    await bridge.idle();
    bridge.update({ status: "resolved", session: null });
    await bridge.idle();
    bridge.update({ status: "resolved", session: V });
    await bridge.idle();
    expect(syncsSent().map((w) => w.userId)).toEqual(["user-u", null, "user-v"]);
  });

  it("does not treat a failed lookup after a resolved one as a transition", async () => {
    const bridge = createExtensionBridgeController(host);
    bridge.update({ status: "resolved", session: U });
    await bridge.idle();
    bridge.update({ status: "error" });
    bridge.update({ status: "resolved", session: U });
    await bridge.idle();
    expect(syncsSent()).toHaveLength(1);
  });

  it("throttles focus and visibility", async () => {
    const bridge = createExtensionBridgeController(host);
    bridge.update({ status: "resolved", session: U });
    await bridge.idle();
    now += EXTENSION_BRIDGE_SYNC_MIN_INTERVAL_MS - 1;
    bridge.wake();
    await bridge.idle();
    expect(syncsSent()).toHaveLength(1);
    now += 1;
    bridge.wake();
    await bridge.idle();
    expect(syncsSent()).toHaveLength(2);
  });

  it("sends a transition even inside the throttle window", async () => {
    const bridge = createExtensionBridgeController(host);
    bridge.update({ status: "resolved", session: U });
    await bridge.idle();
    now += 10;
    bridge.update({ status: "resolved", session: null });
    await bridge.idle();
    expect(syncsSent().map((w) => w.userId)).toEqual(["user-u", null]);
  });

  it("runs one exchange at a time and sends only the latest state afterwards", async () => {
    host.send = (id, message) => {
      sent.push({ id, message: message as Record<string, unknown> });
      return new Promise((resolve) => replies.push(resolve));
    };
    const bridge = createExtensionBridgeController(host);
    bridge.update({ status: "resolved", session: U });
    bridge.update({ status: "resolved", session: null });
    bridge.update({ status: "resolved", session: V });
    bridge.wake();
    expect(syncsSent()).toHaveLength(1);

    replies.shift()!(syncReply({ type: "none", reason: "signed-out" }));
    await vi.waitFor(() => expect(syncsSent()).toHaveLength(2));
    replies.shift()!(syncReply({ type: "none", reason: "linked" }));
    await bridge.idle();
    expect(syncsSent().map((w) => w.userId)).toEqual(["user-u", "user-v"]);
  });

  it("does not re-send after the in-flight exchange when the user ended up unchanged", async () => {
    host.send = (id, message) => {
      sent.push({ id, message: message as Record<string, unknown> });
      return new Promise((resolve) => replies.push(resolve));
    };
    const bridge = createExtensionBridgeController(host);
    bridge.update({ status: "resolved", session: U });
    bridge.update({ status: "resolved", session: null });
    bridge.update({ status: "resolved", session: U });
    replies.shift()!(syncReply({ type: "none", reason: "linked" }));
    await bridge.idle();
    expect(syncsSent()).toHaveLength(1);
  });

  it("approves against the session as it is when the reply lands", async () => {
    const approve = vi.fn(async () => true);
    let resolveSync: (value: unknown) => void = () => undefined;
    host.approve = approve;
    host.send = (id, message) => {
      sent.push({ id, message: message as Record<string, unknown> });
      const record = message as Record<string, unknown>;
      if (record.kind === "sync") return new Promise((resolve) => (resolveSync = resolve));
      return Promise.resolve(extensionBridgeDeviceReply("pending"));
    };
    const bridge = createExtensionBridgeController(host);
    bridge.update({ status: "resolved", session: U });
    bridge.update({ status: "resolved", session: V });
    resolveSync(syncReply(approveAction()));
    await vi.waitFor(() => expect(sent.some((s) => s.message.kind === "device-approved")).toBe(true));
    expect(approve).not.toHaveBeenCalled();
    expect(sent.find((s) => s.message.kind === "device-approved")!.message.outcome).toBe("failed");
    // The switch to V is sent once that exchange ends.
    await vi.waitFor(() => expect(syncsSent().map((w) => w.userId)).toEqual(["user-u", "user-v"]));
    resolveSync(syncReply({ type: "none", reason: "linked" }));
    await bridge.idle();
  });

  it("stops after dispose", async () => {
    const bridge = createExtensionBridgeController(host);
    bridge.dispose();
    bridge.update({ status: "resolved", session: U });
    await bridge.idle();
    expect(sent).toHaveLength(0);
  });
});
