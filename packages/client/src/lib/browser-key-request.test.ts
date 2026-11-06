// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { browserKeysUrl, newBrowserKeyRequest } from "@starter/core";

const state = vi.hoisted(() => ({ session: null as object | null, created: vi.fn() }));
vi.mock("./private-session", () => ({ privateDataOrigin: () => "https://api.example.test", privateSession: () => state.session }));
vi.mock("./trpc", () => ({ getTRPCClient: () => ({ privacy: { createDeviceUnlock: { mutate: state.created } } }) }));

const { captureBrowserKeyRequest, pendingBrowserKeyRequest, prepareBrowserKeys } = await import("./browser-key-request");

beforeEach(() => {
  sessionStorage.clear();
  state.session = null;
  state.created.mockReset();
  window.history.replaceState(null, "", "/app/device/?user_code=ABCD-EFGH");
});

it("moves a key request from the address bar into this tab, keeping the code", async () => {
  const { request } = await newBrowserKeyRequest("https://api.example.test");
  const url = new URL(browserKeysUrl("http://localhost/app/device/?user_code=ABCD-EFGH", request));
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  captureBrowserKeyRequest();
  expect(window.location.hash).toBe("");
  expect(window.location.search).toBe("?user_code=ABCD-EFGH");
  expect(pendingBrowserKeyRequest()?.requestId).toBe(request.requestId);
});

it("drops an invalid request and opens no slot while the keys are locked", async () => {
  window.history.replaceState(null, "", "/app/device/#keys=not-a-request");
  captureBrowserKeyRequest();
  expect(window.location.hash).toBe("");
  expect(pendingBrowserKeyRequest()).toBeNull();

  const { request } = await newBrowserKeyRequest("https://api.example.test");
  const url = new URL(browserKeysUrl("http://localhost/app/device/", request));
  window.history.replaceState(null, "", url.pathname + url.hash);
  captureBrowserKeyRequest();
  expect(await prepareBrowserKeys("user-1")).toBeNull();
  expect(state.created).not.toHaveBeenCalled();
  state.session = {};
  expect(await prepareBrowserKeys("user-1")).toMatchObject({ userId: "user-1", request: { requestId: request.requestId } });
  expect(state.created).toHaveBeenCalledWith({ requestId: request.requestId, publicKey: request.publicKey });
});

it("opens no slot for a request made against another server", async () => {
  state.session = {};
  const { request } = await newBrowserKeyRequest("https://other.example.test");
  const url = new URL(browserKeysUrl("http://localhost/app/device/", request));
  window.history.replaceState(null, "", url.pathname + url.hash);
  captureBrowserKeyRequest();
  expect(await prepareBrowserKeys("user-1")).toBeNull();
});
