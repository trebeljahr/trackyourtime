import {
  isSyncMessage,
  SESSION_REVOKED_CLOSE_CODE,
  type ServerToClientMessage,
  type SyncEvent,
} from "@starter/shared";

export type SyncStatus = "connecting" | "open" | "closed";

export type SyncClientOptions = {
  /** Full ws:// or wss:// URL, e.g. `wss://example.com/api/ws`. */
  url: string;
  onEvent: (event: SyncEvent, originId?: string) => void;
  onStatus?: (status: SyncStatus) => void;
  /**
   * better-auth session token, for clients with no cookie (Raycast, the
   * extensions, the native shells). Obtain it from `signInWithPassword()` or
   * the device flow — there is no separate credential to mint.
   *
   * A getter is read again on every `open()`, which is what a reconnect
   * needs: a client that captured the token once keeps offering a dead one
   * after a sign-out/sign-in within the same launch, and never picks up a
   * token that arrived from secure storage after the socket was created.
   */
  token?: string | (() => string | undefined);
  /**
   * The server closed this socket with `SESSION_REVOKED_CLOSE_CODE` — the
   * session behind it no longer exists (signed out from Settings → Devices,
   * expired, or deleted). Called at most once per client.
   *
   * Reconnection stops before this fires, and stays stopped: the credential
   * this client was built with will never be accepted again, so a backoff is
   * pure noise and a sync indicator that never settles is a lie. That halt
   * applies whether or not a host passes this callback, which is why the
   * hosts that do not — Raycast, the browser extension — inherit the fix
   * safely. What they cannot inherit is the clearing: the token lives in
   * Keychain, `chrome.storage` or Raycast's own store depending on who is
   * asking, so forgetting it is the host's job and this is the notification
   * that it needs doing.
   *
   * Recovery is by construction: every host builds a NEW client when its
   * session changes (`useSync` is keyed on the token, the extension's
   * `reload()` rebuilds the runtime, a Raycast command is a fresh process),
   * so nothing has to un-latch this one.
   */
  onSessionRevoked?: () => void;
  /** Injectable for Node tests and non-DOM hosts. */
  WebSocketImpl?: typeof WebSocket;
  minBackoffMs?: number;
  maxBackoffMs?: number;
};

export type SyncClient = {
  connect(): void;
  close(): void;
  /**
   * Drop the current socket and open a new one immediately, without waiting
   * for a close event or a backoff. The native shells call this on resume: the
   * server pings every 10s and terminates on the first missed pong, so the
   * connection a backgrounded phone comes back to is usually already gone
   * server-side while the client still believes it is open.
   */
  reconnect(): void;
  status(): SyncStatus;
};

/** Subprotocol prefix the server reads the session token from. */
const BEARER_SUBPROTOCOL_PREFIX = "bearer.";

/**
 * The WebSocket constructor cannot set an Authorization header, so the token
 * rides in the subprotocol instead of the query string — a URL is the one
 * place it could end up in an access log or a referrer.
 */
const subprotocols = (
  token?: string | (() => string | undefined),
): string[] | undefined => {
  const value = typeof token === "function" ? token() : token;
  return value
    ? [`${BEARER_SUBPROTOCOL_PREFIX}${encodeURIComponent(value)}`]
    : undefined;
};

/**
 * WebSocket subscription to the signed-in user's sync room.
 *
 * Reconnects with jittered exponential backoff and never throws on a
 * malformed frame — a bad message must not take down the socket that
 * keeps every device's timer in agreement.
 */
export const createSyncClient = ({
  url,
  onEvent,
  onStatus,
  token,
  onSessionRevoked,
  WebSocketImpl,
  minBackoffMs = 1000,
  maxBackoffMs = 30_000,
}: SyncClientOptions): SyncClient => {
  const SocketCtor =
    WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;

  let socket: WebSocket | null = null;
  let status: SyncStatus = "closed";
  let attempt = 0;
  let retryHandle: ReturnType<typeof setTimeout> | null = null;
  let closedByCaller = false;
  /**
   * Latched by a 4401 close. Nothing clears it — see `onSessionRevoked`.
   * `connect()` and `reconnect()` become no-ops rather than throwing, so the
   * extension's 30-second "is the socket up?" nudge stays harmless.
   */
  let revoked = false;

  const setStatus = (next: SyncStatus): void => {
    if (status === next) return;
    status = next;
    onStatus?.(next);
  };

  const backoffMs = (): number => {
    const exponential = Math.min(maxBackoffMs, minBackoffMs * 2 ** attempt);
    // Jitter so many devices waking at once don't reconnect in lockstep.
    return Math.round(exponential * (0.5 + Math.random() * 0.5));
  };

  const scheduleReconnect = (): void => {
    if (closedByCaller || revoked || retryHandle) return;
    const delay = backoffMs();
    attempt += 1;
    retryHandle = setTimeout(() => {
      retryHandle = null;
      open();
    }, delay);
  };

  const handleMessage = (raw: unknown): void => {
    if (typeof raw !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const message = parsed as ServerToClientMessage;
    if (!("type" in message) || !isSyncMessage(message)) return;
    try {
      onEvent(message.event, message.originId);
    } catch {
      // A throwing consumer must not kill the socket.
    }
  };

  const open = (): void => {
    if (revoked) return;
    if (!SocketCtor) {
      setStatus("closed");
      return;
    }
    if (socket) return;

    setStatus("connecting");
    let created: WebSocket;
    try {
      const protocols = subprotocols(token);
      created = protocols
        ? new SocketCtor(url, protocols)
        : new SocketCtor(url);
      socket = created;
    } catch {
      socket = null;
      scheduleReconnect();
      return;
    }

    /*
     * Every handler checks that it still speaks for the live socket.
     *
     * `close()` followed immediately by `connect()` — what a native shell does
     * on resume, because a socket the OS froze is dead server-side within ~20s
     * and may never deliver an `onclose` — leaves the OLD socket's close event
     * still in flight. Without this guard that event fires after the new
     * socket exists, nulls the reference to it, reports "closed" and schedules
     * a reconnect, which then opens a THIRD socket. Two live connections, and
     * a status that no longer describes either.
     */
    const isCurrent = (): boolean => socket === created;

    created.onopen = () => {
      if (!isCurrent()) return;
      attempt = 0;
      setStatus("open");
    };
    created.onmessage = (event: MessageEvent) => {
      if (!isCurrent()) return;
      handleMessage(event.data);
    };
    created.onerror = () => {
      /* the close handler drives reconnection */
    };
    created.onclose = (event?: { code?: number }) => {
      if (!isCurrent()) return;
      socket = null;

      /*
       * "You were signed out" is not "the network died".
       *
       * Everything else here — a dropped Wi-Fi, a server restart, a phone
       * that went into a tunnel — is worth retrying, and the backoff above
       * exists for exactly those. A revoked session is the one close this
       * client can never recover from on its own, so retrying it is a
       * reconnect loop that no amount of waiting resolves, hidden behind a
       * sync dot that never settles.
       *
       * `event` is read defensively: a close event always carries a code in a
       * browser and in `ws`, but this handler is also driven directly by test
       * doubles and by hosts with their own socket shims, and an absent code
       * must mean "ordinary close" rather than "signed out".
       */
      if (event?.code === SESSION_REVOKED_CLOSE_CODE) {
        revoked = true;
        if (retryHandle) {
          clearTimeout(retryHandle);
          retryHandle = null;
        }
        setStatus("closed");
        try {
          onSessionRevoked?.();
        } catch {
          // A throwing host must not leave the latch half-applied.
        }
        return;
      }

      setStatus("closed");
      scheduleReconnect();
    };
  };

  return {
    connect: () => {
      if (revoked) return;
      closedByCaller = false;
      open();
    },
    reconnect: () => {
      if (revoked) return;
      closedByCaller = true;
      if (retryHandle) {
        clearTimeout(retryHandle);
        retryHandle = null;
      }
      const current = socket;
      socket = null;
      current?.close();
      // Straight back up: `attempt` is reset so the new connection is not
      // charged for the backoff the old one had accumulated.
      attempt = 0;
      closedByCaller = false;
      open();
    },
    close: () => {
      closedByCaller = true;
      if (retryHandle) {
        clearTimeout(retryHandle);
        retryHandle = null;
      }
      const current = socket;
      socket = null;
      current?.close();
      setStatus("closed");
    },
    status: () => status,
  };
};
