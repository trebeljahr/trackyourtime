// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

// ── a controllable stand-in for the Keychain-backed store ────────────

type Snapshot = { token: string | null; ready: boolean };

let persistToken = async () => {};
let shell: "web" | "capacitor" = "capacitor";
let token: string | null = null;
let ready = false;
let snapshot: Snapshot = { token: null, ready: false };
const listeners = new Set<() => void>();

const publish = (): void => {
  snapshot = { token, ready };
  for (const listener of [...listeners]) listener();
};

/** What the Keychain read does when it finally answers. */
const hydrateWith = (next: string | null): void => {
  token = next;
  ready = true;
  publish();
};

vi.mock("@/lib/shell", async () =>
  (await import("@/lib/shell-mock")).mockShellModule(() => shell),
);

vi.mock("@/lib/native-session", () => ({
  getNativeToken: () => token,
  getNativeSession: () => snapshot,
  getServerNativeSession: (): Snapshot => ({ token: null, ready: false }),
  subscribeNativeSession: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  // Hydration is driven by the test, not by mounting.
  hydrateNativeSession: () => Promise.resolve(),
  setNativeToken: async (next: string) => { if (shell !== "web") { await persistToken(); hydrateWith(next); } },
  clearNativeToken: async () => { hydrateWith(null); },
}));

// ── the stubbed API ──────────────────────────────────────────────────

type Call = { url: string; authorization: string | null };

const calls: Call[] = [];

const SESSION_BODY = {
  session: { id: "sess-1", userId: "u1", token: "tok-new", expiresAt: new Date(Date.now() + 86400000).toISOString() },
  user: {
    id: "u1",
    name: "Rico",
    email: "rico@example.com",
    image: null,
    emailVerified: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  },
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/**
 * Answers `/get-session` the way the server does for a client with no cookie
 * jar: a session when the bearer token is present, a clean `null` when it is
 * not. That `null` is the whole bug — cached once, it never gets revisited.
 * Swappable, so one test can make every answer `null`.
 */
let respond: (authorization: string | null) => Response = (authorization) =>
  json(authorization ? SESSION_BODY : null);

/*
 * Installed at module scope rather than in `beforeEach`: better-auth's client
 * is created while `auth-client.ts` is evaluated and its first
 * `/get-session` goes out on the mount that follows, so a stub installed by a
 * hook is already too late for the very request this file is about.
 */
globalThis.fetch = (async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const headers =
    input instanceof Request && !init?.headers
      ? input.headers
      : new Headers((init?.headers ?? {}) as HeadersInit);
  const authorization = headers.get("authorization");

  calls.push({ url, authorization });
  if (url.includes("/sign-in/email")) return loginResponse();
  return respond(authorization);
}) as typeof fetch;

const sessionCalls = (): Call[] =>
  calls.filter((call) => call.url.includes("/get-session"));

// ── the subject ──────────────────────────────────────────────────────

/**
 * better-auth's session atom is module state that fetches exactly once per
 * module instance, so every scenario gets a freshly imported provider — a
 * second `render()` against the same module would issue no mount request at
 * all and the test would prove nothing.
 */
const loadProvider = async (): Promise<() => void> => {
  vi.resetModules();
  const { AuthProvider, useAuth } = await import("../providers/auth-provider");

  function Consumer() {
    const { user, isAuthenticated } = useAuth();
    return (
      <p data-testid="who">
        {isAuthenticated && user ? user.email : "anonymous"}
      </p>
    );
  }

  return () => {
    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );
  };
};

let loginResponse = () => new Response(JSON.stringify({ ...SESSION_BODY, token: "tok-new", redirect: false }), { headers: { "content-type": "application/json", "set-auth-token": "tok-new" } });

beforeEach(() => {
  persistToken = async () => {};
  shell = "capacitor";
  calls.length = 0;
  token = null;
  ready = false;
  snapshot = { token: null, ready: false };
  respond = (authorization) => json(authorization ? SESSION_BODY : null);
});

afterEach(() => {
  cleanup();
  listeners.clear();
  vi.clearAllMocks();
});


vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/components/app-shell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
describe("password login", () => {
  for (const platform of ["web", "capacitor"] as const) {
    it(`uses one auth request including protected navigation on ${platform}`, async () => {
      shell = platform;
      hydrateWith(null);
      const mount = await loadProvider(); mount();
      await waitFor(() => expect(sessionCalls()).toHaveLength(1));
      await new Promise(resolve => setTimeout(resolve, 20));
      calls.length = 0;
      const client = await import("./auth-client");
      await act(async () => { await client.signInWithPassword("rico@example.com", "password"); });
      expect(screen.getByTestId("who").textContent).toBe("rico@example.com");
      const { AuthProvider } = await import("../providers/auth-provider");
      const { default: Layout } = await import("../app/app/layout");
      render(<AuthProvider><Layout><p>protected content</p></Layout></AuthProvider>);
      await waitFor(() => expect(screen.getByText("protected content")).toBeTruthy());
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(calls.map(call => new URL(call.url).pathname)).toEqual(["/api/auth/sign-in/email"]);
      expect(client.hasFreshLoginSession()).toBe(true);
    });
  }
  it("does not let a late anonymous read overwrite login", async () => {
    let release!: (response: Response) => void;
    respond = () => new Promise<Response>(resolve => { release = resolve; }) as unknown as Response;
    hydrateWith(null);
    const mount = await loadProvider(); mount();
    await waitFor(() => expect(release).toBeTypeOf("function"));
    const client = await import("./auth-client");
    await act(async () => { await client.signInWithPassword("rico@example.com", "password"); });
    await act(async () => { release(json(null)); });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(screen.getByTestId("who").textContent).toBe("rico@example.com");
    expect(sessionCalls()).toHaveLength(1);
  });
  it("persists the native token before completing login", async () => {
    hydrateWith(null);
    const mount = await loadProvider(); mount();
    await waitFor(() => expect(sessionCalls()).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 20));
    let release!: () => void;
    persistToken = () => new Promise(resolve => { release = resolve; });
    const client = await import("./auth-client");
    let done = false;
    const login = client.signInWithPassword("rico@example.com", "password").then(() => { done = true; });
    await waitFor(() => expect(release).toBeTypeOf("function"));
    expect(done).toBe(false);
    await act(async () => { release(); await login; });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(sessionCalls()).toHaveLength(1);
    expect(token).toBe("tok-new");
  });
  it("fetches the session once for older servers", async () => {
    const previous = loginResponse;
    loginResponse = () => new Response(JSON.stringify({ user: SESSION_BODY.user, token: "tok-new" }), {
      headers: { "content-type": "application/json", "set-auth-token": "tok-new" },
    });
    try {
      hydrateWith(null);
      const mount = await loadProvider(); mount();
      await waitFor(() => expect(sessionCalls()).toHaveLength(1));
      await new Promise(resolve => setTimeout(resolve, 20));
      calls.length = 0;
      const client = await import("./auth-client");
      await act(async () => { await client.signInWithPassword("rico@example.com", "password"); });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(sessionCalls()).toHaveLength(1);
      expect(screen.getByTestId("who").textContent).toBe("rico@example.com");
    } finally { loginResponse = previous; }
  });
  it("still validates fresh protected loads with cookie cache disabled", async () => {
    hydrateWith("existing");
    const mount = await loadProvider(); mount();
    await waitFor(() => expect(screen.getByTestId("who").textContent).toBe("rico@example.com"));
    const { AuthProvider } = await import("../providers/auth-provider");
    const { default: Layout } = await import("../app/app/layout");
    render(<AuthProvider><Layout><p>fresh protected content</p></Layout></AuthProvider>);
    await waitFor(() => expect(sessionCalls().some(call => call.url.includes("disableCookieCache=true"))).toBe(true));
  });
  it("drops the login shortcut and identity on sign-out", async () => {
    hydrateWith(null);
    const mount = await loadProvider(); mount();
    await waitFor(() => expect(sessionCalls()).toHaveLength(1));
    const client = await import("./auth-client");
    await act(async () => { await client.signInWithPassword("rico@example.com", "password"); });
    expect(client.hasFreshLoginSession()).toBe(true);
    await act(async () => { await client.signOut(); });
    expect(client.hasFreshLoginSession()).toBe(false);
    expect(screen.getByTestId("who").textContent).toBe("anonymous");
    expect(token).toBeNull();
  });
  it("keeps invalid credentials unauthenticated", async () => {
    vi.resetModules();
    const previous = loginResponse;
    loginResponse = () => new Response(JSON.stringify({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid credentials" }), {
      status: 401, headers: { "content-type": "application/json" },
    });
    try {
      const client = await import("./auth-client");
      const result = await client.signInWithPassword("rico@example.com", "wrong");
      expect(result.error?.status).toBe(401);
      expect(client.hasFreshLoginSession()).toBe(false);
      expect(sessionCalls()).toHaveLength(0);
    } finally { loginResponse = previous; }
  });
  it("does not hydrate a two-factor challenge", async () => {
    vi.resetModules();
    const previous = loginResponse;
    loginResponse = () => json({ twoFactorRedirect: true });
    try {
      const client = await import("./auth-client");
      const result = await client.signInWithPassword("rico@example.com", "password");
      expect(client.isTwoFactorChallenge(result.data)).toBe(true);
      expect(client.hasFreshLoginSession()).toBe(false);
      expect(sessionCalls()).toHaveLength(0);
    } finally { loginResponse = previous; }
  });
});
