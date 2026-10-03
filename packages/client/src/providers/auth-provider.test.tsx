// @vitest-environment jsdom
// Real auth client over a delayed fake native store.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

// ── a controllable stand-in for the Keychain-backed store ────────────

type Snapshot = { token: string | null; ready: boolean };

let shell: "web" | "capacitor" = "capacitor";
let hydrated: (() => void)[] = [];
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
  for (const resolve of hydrated.splice(0)) resolve();
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
  hydrateNativeSession: () => ready ? Promise.resolve() : new Promise<void>((resolve) => hydrated.push(resolve)),
  setNativeToken: async () => {},
  clearNativeToken: async () => {},
}));

// ── the stubbed API ──────────────────────────────────────────────────

type Call = { url: string; authorization: string | null };

const calls: Call[] = [];

const SESSION_BODY = {
  session: { id: "sess-1", userId: "u1" },
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
  const { AuthProvider, useAuth } = await import("./auth-provider");

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

beforeEach(() => {
  calls.length = 0;
  shell = "capacitor";
  hydrated = [];
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

describe("AuthProvider on native", () => {
  it("waits for the token before its only validation", async () => {
    (await loadProvider())();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sessionCalls()).toHaveLength(0);
    hydrateWith("tok-abc");
    await waitFor(() => expect(screen.getByTestId("who").textContent).toBe("rico@example.com"));
    expect(sessionCalls()).toHaveLength(1);
    expect(sessionCalls()[0]?.authorization).toBe("Bearer tok-abc");
  });

  it("does not retry a revoked stored token", async () => {
    respond = () => json(null);
    (await loadProvider())();
    hydrateWith("tok-revoked");
    await waitFor(() => expect(sessionCalls()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sessionCalls()).toHaveLength(1);
    expect(screen.getByTestId("who").textContent).toBe("anonymous");
  });

  it("validates a token that was ready before mount once", async () => {
    hydrateWith("tok-early");
    (await loadProvider())();
    await waitFor(() => expect(screen.getByTestId("who").textContent).toBe("rico@example.com"));
    expect(sessionCalls()).toHaveLength(1);
  });

  it("validates a token arriving after the storage deadline once", async () => {
    hydrateWith(null);
    (await loadProvider())();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sessionCalls()).toHaveLength(0);
    hydrateWith("tok-late");
    await waitFor(() => expect(screen.getByTestId("who").textContent).toBe("rico@example.com"));
    expect(sessionCalls()).toHaveLength(1);
    expect(sessionCalls()[0]?.authorization).toBe("Bearer tok-late");
  });
});

describe("AuthProvider on web", () => {
  it("issues one cookie session request without a bearer header", async () => {
    shell = "web";
    hydrateWith(null);
    (await loadProvider())();
    await waitFor(() => expect(sessionCalls()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sessionCalls()).toHaveLength(1);
    expect(sessionCalls()[0]?.authorization).toBeNull();
    expect(new URL(sessionCalls()[0]!.url).search).toBe("");
  });
});
