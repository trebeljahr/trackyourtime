import { WebSocketServer, type WebSocket } from "ws";
import type { Server } from "http";
import { enforceMaxEntryDuration } from "../services/runaway.js";
import { authenticateUpgrade, probeUpgradeSession } from "./auth.js";
import { RoomManager } from "./rooms.js";
import {
  SESSION_REVOKED_CLOSE_CODE,
  SessionWatch,
  type SessionProbe,
} from "./session-watch.js";
import { env, getTrustedOrigins } from "../config/env.js";

const PING_INTERVAL_MS = 10_000;
const PONG_TIMEOUT_MS = 5_000;

/**
 * How often a live socket's session is re-checked.
 *
 * The handshake authenticates once, and a phone holds its socket open for
 * days — so without this, "sign this device out" signs out only the HTTP half
 * and the socket keeps streaming that user's sync events. A minute is the
 * trade: one indexed session lookup per connected device per minute, against
 * a revocation that is never more than a minute from taking effect on the
 * socket too. Revocation is still instant on every HTTP request.
 */
const SESSION_RECHECK_INTERVAL_MS = 60_000;

/** A socket that has been through `authenticateUpgrade`. */
type AuthedSocket = WebSocket & {
  userId?: string;
  probeSession?: SessionProbe;
};

export const roomManager = new RoomManager();

/** Live sockets, and the session lookup that keeps each one honest. */
export const sessionWatch = new SessionWatch();

/**
 * Drop a socket whose session no longer exists.
 *
 * The room is left explicitly rather than waiting for the `close` handler:
 * `close()` is asynchronous, and a broadcast that lands in the meantime would
 * be one more event delivered to a device that has been signed out — which is
 * the entire bug.
 */
const dropRevokedSocket = (socket: WebSocket): void => {
  roomManager.leave(socket);
  socket.close(SESSION_REVOKED_CLOSE_CODE, "session revoked");
};

/**
 * One pass of the re-check: drop every watched socket whose session is gone,
 * and answer how many that was.
 *
 * Exported so the test suite runs exactly what the interval runs, rather than
 * a re-implementation of it that could drift from the wiring it is meant to
 * be pinning.
 */
export const revokeStaleSockets = (): Promise<number> =>
  sessionWatch.sweep(dropRevokedSocket);

/**
 * The two auth lookups the upgrade path needs, injectable for tests.
 *
 * Not a generality for its own sake: `probeSession` is attached to the socket
 * inside `wss.handleUpgrade`'s callback, and every other test in this suite
 * drives `wss.emit("connection", ...)` directly with a socket it built itself
 * — so nothing exercised the attachment, and deleting it left the whole
 * revocation feature inert with a green suite. Real lookups need better-auth
 * and a database; injecting them lets the upgrade run for real without both.
 */
export type UpgradeDeps = {
  authenticate: typeof authenticateUpgrade;
  probe: typeof probeUpgradeSession;
  /**
   * The runaway guard a connecting device triggers. Optional, defaulting to
   * the real one, so the socket tests can connect without a database behind
   * the guard's lookups.
   */
  enforceRunaway?: (userId: string) => Promise<unknown>;
};

const defaultEnforceRunaway = (userId: string): Promise<unknown> =>
  // `null`, i.e. unconfined: a socket is authenticated as the PERSON, so the
  // guard should reach their timer wherever it is running. A token principal
  // passes its workspace id instead — see services/runaway.ts.
  enforceMaxEntryDuration(userId, null);

export function setupWebSocket(
  server: Server,
  deps: UpgradeDeps = {
    authenticate: authenticateUpgrade,
    probe: probeUpgradeSession,
  },
): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    /**
     * A browser that offers a subprotocol closes the socket unless the server
     * echoes one back. The extension carries its session token as
     * `bearer.<token>` (see ws/auth.ts), so accept that one and ignore the
     * rest — the token is read from the request, not from what we echo.
     */
    handleProtocols: (protocols) => {
      for (const protocol of protocols) {
        if (protocol.startsWith("bearer.")) return protocol;
      }
      return false;
    },
  });

  // Handle HTTP upgrade manually for path/origin validation
  server.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;

    // Only accept WS connections on known paths
    if (path !== "/ws" && path !== "/api/ws") {
      socket.destroy();
      return;
    }

    // Origin validation in production
    if (env.isProduction) {
      const trusted = getTrustedOrigins();
      const origin = req.headers.origin;
      if (origin && trusted.length > 0 && !trusted.includes(origin)) {
        // Answered rather than dropped, and logged with the origin: a silent
        // destroy reaches a browser as a bare close with no code, which is
        // indistinguishable from a network failure. WebSockets are not subject
        // to CORS, so this check is the only thing standing in for it here;
        // every HTTP request from a browser client — the extension included,
        // which has no host permissions — is refused by CORS for the same
        // untrusted origin. The line below names the exact value to add to
        // TRUSTED_ORIGINS.
        console.warn(`[ws] upgrade refused: untrusted origin ${origin}`);
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    // Authenticate. An unauthenticated socket has no room to be placed in,
    // so refuse the upgrade outright rather than holding a connection open
    // that can do nothing.
    const authenticated = await deps.authenticate(req);
    if (!authenticated?.session.user?.id) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const { session, headers } = authenticated;

    wss.handleUpgrade(req, socket, head, (ws) => {
      const authedWs = ws as AuthedSocket;
      authedWs.userId = session.user.id;
      // The credential that opened this socket, replayable for as long as it
      // stays open. Captured here because `req` is not kept past the upgrade.
      authedWs.probeSession = () => deps.probe(headers);
      wss.emit("connection", ws, req);
    });
  });

  const enforceRunaway = deps.enforceRunaway ?? defaultEnforceRunaway;

  // The request is deliberately not read here. It used to be, for a
  // `?roomId=` that joined whatever room it named — which, together with the
  // `join-room` message, let any signed-in user receive anybody's sync events.
  // The ONLY input to room placement is the user id the upgrade authenticated.
  wss.on("connection", (ws: AuthedSocket) => {
    const userId = ws.userId;
    if (!userId) {
      // Unreachable through the upgrade path, which refuses a session with no
      // user. A socket that got here anyway has no room it may be put in.
      ws.close(1008, "unauthenticated");
      return;
    }

    // Re-checked on a timer for the life of the socket, so revoking a device
    // in Settings → Devices closes its socket too rather than only 401ing its
    // next HTTP request.
    if (ws.probeSession) sessionWatch.watch(ws, ws.probeSession);

    // The person's own room (`user:<userId>`), so every device of this user
    // receives the sync events addressed to this user — and nothing else.
    roomManager.join(userId, ws);

    // A device reconnecting is one of the moments that resolves "what is
    // running", so it is one of the moments the runaway guard is evaluated
    // at — a laptop opened on Monday morning finds out about the Friday timer
    // here, before it renders a clock that has been counting all weekend.
    // Deliberately not awaited: the socket is live either way, and anything
    // the guard does reaches this room as a normal sync event.
    void enforceRunaway(userId);

    // Ping/pong heartbeat
    let isAlive = true;
    ws.on("pong", () => {
      isAlive = true;
    });

    const pingInterval = setInterval(() => {
      if (!isAlive) {
        clearInterval(pingInterval);
        ws.terminate();
        return;
      }
      isAlive = false;
      ws.ping();
    }, PING_INTERVAL_MS);

    // Client frames are ignored — all of them. The protocol has no client →
    // server message any more, and a frame from an older build (a `join-room`
    // naming someone else's room, most importantly) must neither move this
    // socket nor close it: closing would put that client into a reconnect
    // loop, and it is still a perfectly good receiver of its own events.
    ws.on("message", () => {});

    // Cleanup on close
    ws.on("close", () => {
      clearInterval(pingInterval);
      sessionWatch.unwatch(ws);
      roomManager.leave(ws);
    });
  });

  // Periodic session re-check, so a revoked session loses its socket.
  //
  // Unref'd: the listening HTTP server is what keeps the process alive, and a
  // bare `setInterval` here would instead keep a short-lived process (a test,
  // a script) running indefinitely.
  const recheckInterval = setInterval(() => {
    void revokeStaleSockets();
  }, SESSION_RECHECK_INTERVAL_MS);
  recheckInterval.unref?.();

  return wss;
}
