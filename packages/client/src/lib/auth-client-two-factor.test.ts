// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two-factor challenge on the wire, through the auth client's real fetch.
 *
 * The server hands the challenge out as `set-two-factor-token` and takes it
 * back as `x-two-factor-token` (auth/two-factor-guard.ts). What these pin:
 * the header is captured from a 2FA sign-in and sent on the verify call, and
 * on nothing once the verify succeeded; a plain sign-in leaves no challenge
 * behind; and a token shell sends these calls with no cookies at all, so the
 * header is the only credential the server sees.
 */

let shell: "web" | "capacitor" = "web";
let captured: { fetchOptions: { customFetchImpl: typeof fetch } } | null = null;

vi.mock("better-auth/react", () => ({
  createAuthClient: (options: typeof captured) => {
    captured = options;
    return {
      $store: { atoms: { session: { get: () => ({ data: null }), set: vi.fn() } } },
      signIn: vi.fn(),
      signUp: vi.fn(),
      signOut: vi.fn(async () => ({ data: null, error: null })),
      useSession: vi.fn(),
      getSession: vi.fn(),
    };
  },
}));
vi.mock("better-auth/client/plugins", () => ({
  magicLinkClient: () => ({}),
  deviceAuthorizationClient: () => ({}),
  twoFactorClient: () => ({}),
}));
vi.mock("@/lib/shell", async () => (await import("@/lib/shell-mock")).mockShellModule(() => shell));
vi.mock("@/lib/native-session", () => ({
  clearNativeToken: vi.fn(async () => undefined),
  getNativeToken: () => null,
  hydrateNativeSession: vi.fn(async () => undefined),
  setNativeToken: vi.fn(),
}));
vi.mock("@/lib/running-mirror", () => ({ writeRunningMirror: vi.fn(async () => undefined) }));

const sent: { url: string; init: RequestInit }[] = [];
let nextHeaders: Record<string, string> = {};
let nextStatus = 200;

beforeEach(() => {
  shell = "web";
  sent.length = 0;
  nextHeaders = {};
  nextStatus = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      sent.push({ url: String(input instanceof Request ? input.url : input), init });
      return new Response("{}", { status: nextStatus, headers: nextHeaders });
    }),
  );
});

await import("./auth-client");
const { forgetTwoFactorChallenge, hasTwoFactorChallenge } = await import("./two-factor-challenge");
const authFetch = (): typeof fetch => captured!.fetchOptions.customFetchImpl;
const API = "http://localhost:5000/api/auth";
const headersOf = (index: number): Headers => new Headers(sent[index]?.init.headers);

describe("the two-factor challenge transport", () => {
  beforeEach(() => forgetTwoFactorChallenge());

  it("captures the challenge from a 2FA sign-in and sends it on the verify, once", async () => {
    nextHeaders = { "set-two-factor-token": "2fa-abc.sig+/=" };
    await authFetch()(`${API}/sign-in/email`, { method: "POST" });
    expect(hasTwoFactorChallenge()).toBe(true);

    nextHeaders = {};
    nextStatus = 401;
    await authFetch()(`${API}/two-factor/verify-totp`, { method: "POST" });
    expect(headersOf(1).get("x-two-factor-token")).toBe("2fa-abc.sig+/=");
    expect(hasTwoFactorChallenge()).toBe(true);

    nextStatus = 200;
    await authFetch()(`${API}/two-factor/verify-backup-code`, { method: "POST" });
    expect(headersOf(2).get("x-two-factor-token")).toBe("2fa-abc.sig+/=");
    expect(hasTwoFactorChallenge()).toBe(false);

    await authFetch()(`${API}/two-factor/verify-totp`, { method: "POST" });
    expect(headersOf(3).get("x-two-factor-token")).toBeNull();
  });

  it("leaves no challenge after a sign-in that needed none", async () => {
    nextHeaders = { "set-two-factor-token": "2fa-old.sig" };
    await authFetch()(`${API}/sign-in/email`, { method: "POST" });
    nextHeaders = {};
    await authFetch()(`${API}/sign-in/email`, { method: "POST" });
    expect(hasTwoFactorChallenge()).toBe(false);
  });

  it("keeps the web app's request otherwise as better-fetch built it", async () => {
    await authFetch()(`${API}/two-factor/verify-totp`, { method: "POST", credentials: "include" });
    expect(sent[0]?.init.credentials).toBe("include");
  });

  it("sends every auth call from a token shell with no cookies, the session check included", async () => {
    shell = "capacitor";
    await authFetch()(`${API}/list-sessions`, { method: "GET", credentials: "include" });
    expect(sent[0]?.init.credentials).toBe("omit");
  });

  it("sends a token shell's sign-in and verify with no cookies", async () => {
    shell = "capacitor";
    nextHeaders = { "set-two-factor-token": "2fa-phone.sig" };
    await authFetch()(`${API}/sign-in/email`, { method: "POST", credentials: "include" });
    await authFetch()(`${API}/two-factor/verify-totp`, { method: "POST", credentials: "include" });
    expect(sent[0]?.init.credentials).toBe("omit");
    expect(sent[1]?.init.credentials).toBe("omit");
    expect(headersOf(1).get("x-two-factor-token")).toBe("2fa-phone.sig");
  });
});
