// @vitest-environment jsdom
/**
 * The native session store, asserted end to end.
 *
 * `AuthProvider` mounts better-auth's `useSession()` at the root, and
 * better-auth fires its one `/get-session` on mount — before the Keychain
 * read that publishes the bearer token has settled. Without a refetch the
 * store caches the tokenless `null` forever, and `useAuth().user` is empty
 * for the life of the launch. That went unnoticed because a localhost API is
 * same-site with the dev WebView origin and sends the cookie anyway; against
 * `https://…` from `capacitor://localhost` nothing is sent at all.
 *
 * So this drives the real `@/lib/auth-client` (real better-auth client, real
 * `fetchOptions.auth` token getter) over a stubbed `fetch`, with a token that
 * arrives *after* mount, and asserts that a second `/get-session` goes out
 * carrying `Authorization: Bearer …` and that the provider then exposes the
 * user. Only the Keychain itself is faked — `native-session.test.ts` owns
 * that.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

// ── a controllable stand-in for the Keychain-backed store ────────────

type Snapshot = { token: string | null; ready: boolean };

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
  (await import("@/lib/shell-mock")).mockShellModule(() => "capacitor"),
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
  it("re-resolves the session store once the token arrives after mount", async () => {
    const renderProvider = await loadProvider();
    renderProvider();

    // The mount request is the tokenless one — that ordering is the whole
    // defect, so it is asserted rather than assumed away.
    await waitFor(() => {
      expect(sessionCalls().length).toBe(1);
    });
    expect(sessionCalls()[0]?.authorization).toBeNull();
    expect(screen.getByTestId("who").textContent).toBe("anonymous");

    // The Keychain finally answers.
    hydrateWith("tok-abc");

    await waitFor(() => {
      expect(sessionCalls().length).toBe(2);
    });
    expect(sessionCalls()[1]?.authorization).toBe("Bearer tok-abc");

    await waitFor(() => {
      expect(screen.getByTestId("who").textContent).toBe("rico@example.com");
    });
  });

  it("does not refetch in a loop when the stored token is not accepted", async () => {
    // A token the server has revoked answers null every time. One retry is a
    // fix; a retry per render is a request storm on a phone.
    respond = () => json(null);

    const renderProvider = await loadProvider();
    renderProvider();

    await waitFor(() => {
      expect(sessionCalls().length).toBe(1);
    });

    hydrateWith("tok-revoked");

    await waitFor(() => {
      expect(sessionCalls().length).toBe(2);
    });
    expect(sessionCalls()[1]?.authorization).toBe("Bearer tok-revoked");

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sessionCalls().length).toBe(2);
    expect(screen.getByTestId("who").textContent).toBe("anonymous");
  });

  it("does not fire a second request when the token was already there", async () => {
    // The Keychain can win the race against better-auth's on-mount fetch, in
    // which case the first request already carries the header and a refetch
    // would be a wasted round trip on every cold launch.
    hydrateWith("tok-early");

    const renderProvider = await loadProvider();
    renderProvider();

    await waitFor(() => {
      expect(screen.getByTestId("who").textContent).toBe("rico@example.com");
    });
    expect(sessionCalls().length).toBe(1);
    expect(sessionCalls()[0]?.authorization).toBe("Bearer tok-early");
  });
});

describe("AuthProvider on web", () => {
  it("issues exactly one session request and never a bearer header", async () => {
    // The web path has no token by construction (`getNativeToken()` only
    // returns a value under Capacitor), so the effect must be inert: the same
    // single cookie-authenticated request as before this existed.
    hydrateWith(null);

    const renderProvider = await loadProvider();
    renderProvider();

    await waitFor(() => {
      expect(sessionCalls().length).toBe(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sessionCalls().length).toBe(1);
    expect(sessionCalls()[0]?.authorization).toBeNull();
  });
});
