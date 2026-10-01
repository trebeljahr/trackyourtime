import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { approveBrowserDevice, browserAccountImage, canReadBrowserAccount, readBrowserAccount } from "./browser-account";
import { confirmWebAccount } from "./bridge";
import { loadSession } from "../lib/session";
import { loadPendingDeviceAuth } from "../lib/device-auth-store";
import { API, createFakeAuthServer, installFakeAuthServer } from "../test/fake-auth-server";
import { reload } from "./runtime";

const user = { id: "u1", email: "rico@example.com", image: "/api/avatars/u1/photo" };
const createdAt = "2026-10-01T00:00:00.000Z";
const cookie = { name: "__Secure-better-auth.session_token", value: "web-token.signature" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
let cookies: ReturnType<typeof vi.fn>;

beforeEach(() => {
  cookies = vi.fn(async () => [cookie]);
  Object.assign(chrome, { cookies: { getAll: cookies } });
});
afterEach(() => vi.unstubAllGlobals());

describe("background web account", () => {
  test("reads only this build's API cookies and normalizes relative profile photos", async () => {
    const fetcher = vi.fn(async () => json({ user, session: { createdAt } }));
    vi.stubGlobal("fetch", fetcher);
    const result = await readBrowserAccount(API);
    expect(cookies).toHaveBeenCalledExactlyOnceWith({ url: `${API}/api/auth/get-session` });
    expect(result?.account).toEqual({ userId: "u1", email: user.email, image: `${API}${user.image}`, sessionCreatedAt: Date.parse(createdAt) });
    expect(fetcher.mock.calls[0]).toMatchObject([`${API}/api/auth/get-session?disableCookieCache=true`, {
      headers: { authorization: `Bearer ${cookie.value}` }, credentials: "omit", redirect: "error",
    }]);
    expect(canReadBrowserAccount("https://unrelated.example")).toBe(false);
    expect(await readBrowserAccount("https://unrelated.example")).toBeUndefined();
    expect(cookies).toHaveBeenCalledTimes(1);
  });

  test("development build can offer the hosted web account", () => {
    expect(canReadBrowserAccount("https://api.trackyourtime.dev")).toBe(true);
  });

  test("does not use unrelated or partitioned cookies", async () => {
    cookies.mockResolvedValue([{ name: "analytics", value: "x" }, { ...cookie, partitionKey: { topLevelSite: "https://example.com" } }]);
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect(await readBrowserAccount(API)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("claims then approves without navigation or sending cookies", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => json({ success: true })); vi.stubGlobal("fetch", fetcher);
    await approveBrowserDevice(API, cookie.value, "ABCDEF");
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([`${API}/api/auth/device?user_code=ABCDEF`, `${API}/api/auth/device/approve`]);
    expect(fetcher.mock.calls[1]).toMatchObject([expect.any(String), { method: "POST", body: '{"userCode":"ABCDEF"}', credentials: "omit" }]);
    expect(fakeChrome.created).toEqual([]);
  });

  test("inlines the actual profile image bytes without forwarding auth", async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([137,80,78,71]), { headers: { "content-type": "image/png" } })); vi.stubGlobal("fetch", fetcher);
    expect(await browserAccountImage(API, "/api/avatars/u1/image-test")).toBe("data:image/png;base64,iVBORw==");
    expect(fetcher.mock.calls[0]).toMatchObject([`${API}/api/avatars/u1/image-test`, { credentials: "omit", redirect: "error" }]);
    expect(await browserAccountImage(API, "javascript:alert(1)")).toBeNull();
  });

  test("one confirmation signs in without an open web tab and keeps the web session separate", async () => {
    const server = createFakeAuthServer(); installFakeAuthServer(server);
    const baseFetch = globalThis.fetch;
    server.sessions.set(cookie.value, user);
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/api/auth/get-session" && new Headers(init?.headers).get("authorization") === `Bearer ${cookie.value}`) {
        return json({ user, session: { createdAt } });
      }
      if (parsed.pathname === "/api/auth/device") return json({ status: "pending" });
      if (parsed.pathname === "/api/auth/device/approve") {
        server.approvedUser = user; server.token = "approved";
        return json({ success: true });
      }
      return baseFetch(url, init);
    });
    await reload();
    await confirmWebAccount(user.id, Date.parse(createdAt));
    const session = await loadSession();
    expect(session).toMatchObject({ userId: user.id, email: user.email, source: "web" });
    expect(session?.token).not.toBe(cookie.value);
    expect(server.sessions.has(cookie.value)).toBe(true);
    expect(await loadPendingDeviceAuth()).toBeNull();
    expect(fakeChrome.created).toEqual([]);
    expect(JSON.stringify(await chrome.storage.session.get(null))).not.toContain(cookie.value);
  });

  test("a web account switch after the offer refuses the stale confirmation", async () => {
    const server = createFakeAuthServer(); installFakeAuthServer(server);
    const baseFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => new URL(url).pathname === "/api/auth/get-session"
      ? Promise.resolve(json({ user: { ...user, id: "different" }, session: { createdAt } })) : baseFetch(url, init));
    await reload();
    await expect(confirmWebAccount(user.id, Date.parse(createdAt))).rejects.toMatchObject({ code: "WEB_ACCOUNT_CHANGED" });
    expect(server.issued).toBe(0);
  });
});
