// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://trackyourtime.dev/app"}
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { EXTENSION_RELAY_CHANNEL } from "@starter/shared/extension-relay";
import { extensionBridgeSyncReply, extensionBridgeDeviceReply } from "@starter/shared/extension-bridge";

let session: { data: { user: { id: string }; session: { createdAt: Date } } | null; isPending: boolean; error: null } = { data: null, isPending: true, error: null };
vi.mock("@/lib/shell", () => ({ isAppShell: () => false }));
vi.mock("@/lib/api-origin", () => ({ getAbsoluteApiOrigin: () => "https://api.trackyourtime.dev" }));
vi.mock("@/lib/auth-client", () => ({ useSession: () => session, signOut: vi.fn(async () => {}) }));
vi.mock("@/lib/device-approve", () => ({ approveDeviceCode: vi.fn(async () => ({ ok: true })) }));
const { ExtensionBridge } = await import("./extension-bridge");
const { approveDeviceCode } = await import("@/lib/device-approve");
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test("Firefox without chrome.runtime connects after the web session resolves and publishes sign-out", async () => {
  delete (globalThis as { chrome?: unknown }).chrome;
  const requests: Array<{ kind: string; web?: { userId: string | null } }> = [];
  vi.spyOn(window, "postMessage").mockImplementation((value) => {
    if (value.channel !== EXTENSION_RELAY_CHANNEL || value.direction !== "request") return;
    requests.push(value.payload);
    const payload = value.payload.kind === "device-approved" ? extensionBridgeDeviceReply("signed-in") :
      value.payload.web.userId === null ? extensionBridgeSyncReply({ type: "none", reason: "signed-out" }) :
      extensionBridgeSyncReply({ type: "approve-device", requestId: "request-1234567890", userCode: "ABCDEFGH", expiresAt: Date.now() + 60000 });
    queueMicrotask(() => window.dispatchEvent(new MessageEvent("message", { source: window, origin: window.location.origin, data: { ...value, direction: "reply", payload } })));
  });
  const view = render(<ExtensionBridge />);
  expect(requests).toEqual([]);
  await act(async () => {
    session = { data: { user: { id: "new-account" }, session: { createdAt: new Date() } }, isPending: false, error: null };
    view.rerender(<ExtensionBridge />);
  });
  await waitFor(() => expect(requests.map((request) => request.kind)).toEqual(["sync", "device-approved"]));
  expect(approveDeviceCode).toHaveBeenCalledWith("ABCDEFGH", { alreadyApprovedIsOk: true });
  await act(async () => { session = { data: null, isPending: false, error: null }; view.rerender(<ExtensionBridge />); });
  await waitFor(() => expect(requests[2]).toMatchObject({ kind: "sync", web: { userId: null } }));
});
