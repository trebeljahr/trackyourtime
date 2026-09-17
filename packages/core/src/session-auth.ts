/**
 * Signing in from a client that has no cookie jar — Raycast, a CLI, the
 * browser extensions, the native shells.
 *
 * There is no separate credential type to mint or paste. A client signs in
 * the ordinary way and keeps the resulting better-auth session token, which
 * it then sends as `Authorization: Bearer <token>` on every request (and as
 * the `bearer.<token>` WebSocket subprotocol). The server's `bearer` plugin
 * resolves it to the same session a browser cookie would, so the account
 * appears under Settings → Devices and can be signed out from there.
 *
 * Two ways in:
 *  - `signInWithPassword()` — the client shows its own email/password form.
 *    Right for a browser extension popup.
 *  - `startDeviceAuthorization()` + `pollForDeviceSession()` — the client
 *    shows a short code the user approves at `/app/device` in a real browser.
 *    Right for Raycast and CLIs, where typing a password is wrong.
 *
 * Persisting the returned token is the caller's job, and it deserves the
 * platform's real secret storage (Keychain, `chrome.storage.session`, the
 * Raycast password store) — never a plain config file.
 */
import { versionHeaders } from "@starter/shared";

/** Which client is signing in. Labels the row in Settings → Devices. */
export type ClientId =
  | "trackyourtime-raycast"
  | "trackyourtime-cli"
  | "trackyourtime-extension"
  | "trackyourtime-desktop"
  | "trackyourtime-mobile"
  /**
   * The web app, holding a bearer session of its own on a server it is not
   * served by — the "Move to another server" flow signs in to the target that
   * way. Its ordinary session is a cookie and never goes through here.
   */
  | "web";

/** Header a client sets so the devices list can name it. */
export const CLIENT_HEADER = "x-trackyourtime-client";

/** Response header better-auth's bearer plugin returns the session token on. */
const SESSION_TOKEN_HEADER = "set-auth-token";

/** `AuthError.code` for a two-factor account signing in through `signInWithPassword`. */
export const TWO_FACTOR_UNSUPPORTED = "TWO_FACTOR_UNSUPPORTED";

export class AuthError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

export type SessionAuthOptions = {
  /** Server origin, e.g. `https://api.trackyourtime.example`. */
  baseUrl: string;
  /** Identifies this client to the server. */
  clientId: ClientId;
  /**
   * This build's release, stamped on the session it creates so Settings →
   * Devices can name it ("Raycast · 0.3.1"). Sent with the API level.
   */
  clientVersion?: string;
  fetchImpl?: typeof fetch;
};

/** A signed-in session. `token` is the credential — store it securely. */
export type IssuedSession = {
  token: string;
  userId: string | null;
  email: string | null;
};

const resolveFetch = (fetchImpl?: typeof fetch): typeof fetch => {
  const impl =
    fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch?.bind(globalThis);
  if (!impl) {
    throw new AuthError(
      "No fetch implementation available — pass `fetchImpl`.",
      "NO_FETCH",
    );
  }
  return impl;
};

const authUrl = (baseUrl: string, path: string): string =>
  `${baseUrl.replace(/\/$/, "")}/api/auth${path}`;

const readJson = async (response: Response): Promise<Record<string, unknown>> => {
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

// ── password sign-in ─────────────────────────────────────────────────

export type PasswordCredentials = { email: string; password: string };

/**
 * Sign in with email and password and return the session token.
 *
 * The token comes back on the `set-auth-token` response header rather than in
 * the body. If it is missing, the server is not running the `bearer` plugin
 * and there is nothing usable to store — that is an error, not a silent
 * cookie-only success.
 */
export async function signInWithPassword(
  options: SessionAuthOptions,
  credentials: PasswordCredentials,
): Promise<IssuedSession> {
  return issueSession(options, "/sign-in/email", credentials, "Sign-in failed");
}

export type SignUpDetails = PasswordCredentials & { name: string };

/**
 * Create an account and return its session token, the same way
 * {@link signInWithPassword} does — the server signs a new account straight in,
 * and the bearer plugin hands the token back on the same header.
 */
export async function signUpWithPassword(
  options: SessionAuthOptions,
  details: SignUpDetails,
): Promise<IssuedSession> {
  return issueSession(options, "/sign-up/email", details, "Could not create the account");
}

async function issueSession(
  options: SessionAuthOptions,
  path: string,
  payload: Record<string, string>,
  failure: string,
): Promise<IssuedSession> {
  const doFetch = resolveFetch(options.fetchImpl);

  const response = await doFetch(authUrl(options.baseUrl, path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [CLIENT_HEADER]: options.clientId,
      ...versionHeaders(options.clientVersion),
    },
    body: JSON.stringify(payload),
  });

  const body = await readJson(response);
  if (!response.ok) {
    throw new AuthError(
      asString(body.message) ?? failure,
      asString(body.code) ?? `HTTP_${response.status}`,
    );
  }

  // A two-factor account answers a correct password with a challenge and no
  // session. The challenge is a cookie this helper cannot carry, so name the
  // reason instead of reporting a missing token.
  if (body.twoFactorRedirect === true) {
    throw new AuthError(
      "This account uses two-factor authentication, which this client does not support yet. Sign in on the web app.",
      TWO_FACTOR_UNSUPPORTED,
    );
  }

  const token = response.headers.get(SESSION_TOKEN_HEADER);
  if (!token) {
    throw new AuthError(
      "Server did not return a session token — is the bearer plugin enabled?",
      "NO_SESSION_TOKEN",
    );
  }

  const user =
    typeof body.user === "object" && body.user !== null
      ? (body.user as Record<string, unknown>)
      : {};

  return {
    token,
    userId: asString(user.id),
    email: asString(user.email),
  };
}

// ── device flow ──────────────────────────────────────────────────────

/** What to show the user while the client waits to be approved. */
export type DeviceAuthorization = {
  deviceCode: string;
  /** Short code the user types at `verificationUri`. */
  userCode: string;
  verificationUri: string;
  /** Same page with the code prefilled — worth opening directly. */
  verificationUriComplete: string;
  expiresInSeconds: number;
  /** Server-mandated minimum seconds between polls. */
  intervalSeconds: number;
};

/**
 * Ask the server for a pairing code. Show `userCode` and point the user at
 * `verificationUri`, then call {@link pollForDeviceSession} with the
 * `deviceCode`.
 */
export async function startDeviceAuthorization(
  options: SessionAuthOptions,
): Promise<DeviceAuthorization> {
  const doFetch = resolveFetch(options.fetchImpl);

  const response = await doFetch(authUrl(options.baseUrl, "/device/code"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [CLIENT_HEADER]: options.clientId,
      ...versionHeaders(options.clientVersion),
    },
    body: JSON.stringify({ client_id: options.clientId }),
  });

  const body = await readJson(response);
  if (!response.ok) {
    throw new AuthError(
      asString(body.error_description) ?? "Could not start device authorization",
      asString(body.error) ?? `HTTP_${response.status}`,
    );
  }

  const deviceCode = asString(body.device_code);
  const userCode = asString(body.user_code);
  if (!deviceCode || !userCode) {
    throw new AuthError("Malformed device authorization response", "PARSE_ERROR");
  }

  return {
    deviceCode,
    userCode,
    verificationUri: asString(body.verification_uri) ?? "",
    verificationUriComplete: asString(body.verification_uri_complete) ?? "",
    expiresInSeconds:
      typeof body.expires_in === "number" ? body.expires_in : 600,
    intervalSeconds: typeof body.interval === "number" ? body.interval : 5,
  };
}

export type PollOptions = {
  /** Seconds between polls; the server may push this up via `slow_down`. */
  intervalSeconds?: number;
  /** Give up after this long. Defaults to the code's own lifetime. */
  timeoutSeconds?: number;
  /** Abort a wait that the user cancelled. */
  signal?: AbortSignal;
  /** Injectable for tests, so a poll loop need not actually sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The answer to one `/device/token` exchange that did not end the flow. */
export type DeviceTokenResult =
  | { status: "approved"; session: IssuedSession }
  | { status: "pending" }
  | { status: "slow-down" };

/**
 * Exchange the device code for a session ONCE.
 *
 * `pending` and `slow-down` are the RFC 8628 answers that mean "ask again
 * later"; everything else the server refuses with is terminal and thrown as
 * `AuthError` with the RFC's own code (`access_denied`, `expired_token`, …).
 * A client whose process can be stopped between two polls (a browser
 * extension's service worker) calls this from whatever wakes it, instead of
 * holding a {@link pollForDeviceSession} loop open.
 */
export async function requestDeviceToken(
  options: SessionAuthOptions,
  deviceCode: string,
): Promise<DeviceTokenResult> {
  const doFetch = resolveFetch(options.fetchImpl);

  const response = await doFetch(authUrl(options.baseUrl, "/device/token"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [CLIENT_HEADER]: options.clientId,
      ...versionHeaders(options.clientVersion),
    },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: options.clientId,
    }),
  });

  const body = await readJson(response);

  if (response.ok) {
    // The device grant returns the session token as `access_token`, in the
    // OAuth shape. The header is checked first only because a future
    // better-auth may start setting it here too.
    const token =
      response.headers.get(SESSION_TOKEN_HEADER) ?? asString(body.access_token);
    if (!token) {
      throw new AuthError(
        "Device approved but no session token was returned",
        "NO_SESSION_TOKEN",
      );
    }
    // better-auth's `/device/token` carries no user today; a caller that
    // needs the account asks `get-session` with the token.
    const user =
      typeof body.user === "object" && body.user !== null
        ? (body.user as Record<string, unknown>)
        : {};
    return {
      status: "approved",
      session: { token, userId: asString(user.id), email: asString(user.email) },
    };
  }

  const error = asString(body.error) ?? `HTTP_${response.status}`;
  if (error === "authorization_pending") return { status: "pending" };
  if (error === "slow_down") return { status: "slow-down" };

  throw new AuthError(
    asString(body.error_description) ?? "Device authorization failed",
    error,
  );
}

/**
 * Poll until the user approves the code, then return the session.
 *
 * Follows RFC 8628: `authorization_pending` means keep waiting, `slow_down`
 * means back off and keep waiting, anything else is terminal. Throws
 * `AuthError` with the RFC's own code on denial, expiry or timeout.
 */
export async function pollForDeviceSession(
  options: SessionAuthOptions,
  deviceCode: string,
  poll: PollOptions = {},
): Promise<IssuedSession> {
  const sleep = poll.sleepImpl ?? defaultSleep;
  const deadline = Date.now() + (poll.timeoutSeconds ?? 600) * 1000;

  let intervalMs = Math.max(1, poll.intervalSeconds ?? 5) * 1000;

  for (;;) {
    if (poll.signal?.aborted) {
      throw new AuthError("Cancelled", "CANCELLED");
    }
    if (Date.now() >= deadline) {
      throw new AuthError("Timed out waiting for approval", "EXPIRED_TOKEN");
    }

    const result = await requestDeviceToken(options, deviceCode);
    if (result.status === "approved") return result.session;
    if (result.status === "slow-down") intervalMs += 5000;
    await sleep(intervalMs);
  }
}

/** Sign a stored session out from the client side. Idempotent by intent. */
export async function signOutSession(
  options: SessionAuthOptions,
  token: string,
): Promise<void> {
  const doFetch = resolveFetch(options.fetchImpl);
  try {
    await doFetch(authUrl(options.baseUrl, "/sign-out"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        [CLIENT_HEADER]: options.clientId,
        ...versionHeaders(options.clientVersion),
      },
      body: "{}",
    });
  } catch {
    // Dropping the local copy of the token is what actually matters, and that
    // is the caller's to do — a failed round trip must not block it.
  }
}
