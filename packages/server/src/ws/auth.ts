import type { IncomingMessage } from "http";
import { getAuth } from "../auth/auth.js";
import type { SessionVerdict } from "./session-watch.js";
import { fromNodeHeaders } from "better-auth/node";

/** Subprotocol prefix a browser client uses to carry its session token. */
const BEARER_SUBPROTOCOL_PREFIX = "bearer.";

/**
 * Find a session token on an upgrade request, for clients that have no cookie.
 *
 * Three sources, in descending order of how safe they are:
 *  1. `Authorization: Bearer <token>` — native clients (Raycast, CLI, the
 *     desktop shell) that can set headers on an upgrade.
 *  2. `Sec-WebSocket-Protocol: bearer.<token>` — the browser `WebSocket`
 *     constructor cannot set headers but *can* set a subprotocol, so this is
 *     the extension's path.
 *  3. `?token=` — last resort. A query string is the one place a session
 *     token can leak into a log or a referrer, so it is deliberately last.
 */
function extractUpgradeToken(req: IncomingMessage): string | null {
  const authorization = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  const fromHeader = /^Bearer\s+(\S+)$/i.exec((authorization ?? "").trim());
  if (fromHeader) return fromHeader[1];

  const protocols = req.headers["sec-websocket-protocol"];
  const offered = (Array.isArray(protocols) ? protocols.join(",") : protocols)
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const fromProtocol = offered?.find((value) =>
    value.startsWith(BEARER_SUBPROTOCOL_PREFIX),
  );
  if (fromProtocol) {
    const token = fromProtocol.slice(BEARER_SUBPROTOCOL_PREFIX.length);
    if (token) return decodeURIComponent(token);
  }

  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const candidate = url.searchParams.get("token");
    if (candidate) return candidate.trim();
  } catch {
    return null;
  }
  return null;
}

/**
 * A successful upgrade: better-auth's `{ session, user }` envelope, plus the
 * exact headers that produced it.
 *
 * The headers are kept because authenticating once at the handshake is not
 * enough — a socket outlives the session that opened it, so the same lookup
 * has to be repeatable for as long as the socket is open. See
 * `ws/session-watch.ts`.
 */
export type UpgradeAuth = {
  session: NonNullable<
    Awaited<ReturnType<ReturnType<typeof getAuth>["api"]["getSession"]>>
  >;
  headers: Headers;
};

/**
 * Authenticate a WebSocket upgrade request.
 *
 * Same single credential as every other entry point: a better-auth session,
 * arriving either as a cookie (web app) or as a session token (everything
 * else). Returns the session and the headers that authenticated it, or null
 * when unauthenticated. Never throws — a failed upgrade must not take the
 * server down.
 */
export async function authenticateUpgrade(
  req: IncomingMessage,
): Promise<UpgradeAuth | null> {
  const headers = fromNodeHeaders(req.headers);

  try {
    const auth = getAuth();
    const session = await auth.api.getSession({ headers });
    if (session?.user) return { session, headers };
  } catch {
    // Fall through and retry with an explicit token, below.
  }

  const raw = extractUpgradeToken(req);
  if (!raw) return null;

  try {
    // The `bearer` plugin turns this header into the session lookup, exactly
    // as it does for HTTP requests — no separate verification path.
    headers.set("authorization", `Bearer ${raw}`);
    const session = await getAuth().api.getSession({ headers });
    return session?.user ? { session, headers } : null;
  } catch {
    return null;
  }
}

/**
 * Ask again whether the session behind a live socket still exists.
 *
 * Replays the headers that authenticated the upgrade, so it is the same
 * lookup with the same credential — no second verification path to keep in
 * sync with the first.
 *
 * Two details are load-bearing:
 *
 *  - `disableCookieCache` — the auth config enables a five-minute signed
 *    cookie cache, and without this flag a revoked web session would keep
 *    answering from that cache instead of from the session table. A socket
 *    re-check that reads a cache is not a re-check.
 *  - `disableRefresh` — this is a question, not a use. Without it the probe
 *    also *extends* the session it is asking about, once a minute, for as long
 *    as the socket is open: an open browser tab would renew its own session
 *    forever, and every renewal is a write. It costs nothing to give up,
 *    because the same lookup still reads the session row and still reports a
 *    deleted or expired one as `revoked` — better-auth checks that before it
 *    looks at this flag (`api/routes/session.mjs`).
 *  - a throw is `"unknown"`, never `"revoked"` — a database hiccup must not
 *    sign every connected device out. Only a clean "no session" closes a
 *    socket.
 */
export async function probeUpgradeSession(
  headers: Headers,
): Promise<SessionVerdict> {
  try {
    const session = await getAuth().api.getSession({
      headers,
      query: { disableCookieCache: true, disableRefresh: true },
    });
    return session?.user ? "live" : "revoked";
  } catch {
    return "unknown";
  }
}
