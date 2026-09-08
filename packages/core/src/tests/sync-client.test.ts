/**
 * The socket contract, exercised against a real `ws` server on a real Node
 * WebSocket.
 *
 * Raycast, the CLI and the desktop shell all reach the sync socket through
 * the host's global `WebSocket` rather than a bundled library, and they carry
 * their session token in the subprotocol because a WebSocket constructor
 * cannot set a header. Both halves of that are easy to break in a way no
 * type-check catches and only a live client notices, so they are asserted
 * here rather than assumed.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";
import { WebSocketServer } from "ws";
import { createSyncClient } from "../sync-client.js";
import { SESSION_REVOKED_CLOSE_CODE, type SyncEvent } from "@starter/shared";

const BEARER = "bearer.";

type Harness = {
  url: string;
  /** Subprotocols the last connection offered. */
  offered: string[];
  /** How many times a client has completed the upgrade. */
  connections: () => number;
  send: (event: SyncEvent, originId?: string) => void;
  sendRaw: (payload: string) => void;
  /** Close every live socket with a specific code, as the sweep does. */
  closeAll: (code: number, reason: string) => void;
  close: () => Promise<void>;
};

const harness = async (): Promise<Harness> => {
  const http: Server = createServer();
  const state: {
    offered: string[];
    connections: number;
    sockets: Set<import("ws").WebSocket>;
  } = {
    offered: [],
    connections: 0,
    sockets: new Set(),
  };

  const wss = new WebSocketServer({
    server: http,
    path: "/api/ws",
    handleProtocols: (protocols) => {
      state.offered = [...protocols];
      for (const protocol of protocols) {
        if (protocol.startsWith(BEARER)) return protocol;
      }
      return false;
    },
  });

  wss.on("connection", (socket) => {
    state.connections += 1;
    state.sockets.add(socket);
    socket.on("close", () => state.sockets.delete(socket));
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");

  return {
    url: `ws://127.0.0.1:${address.port}/api/ws`,
    get offered() {
      return state.offered;
    },
    connections: () => state.connections,
    send: (event, originId) => {
      const payload = JSON.stringify({
        type: "tt:sync",
        event,
        ...(originId ? { originId } : {}),
      });
      for (const socket of state.sockets) socket.send(payload);
    },
    sendRaw: (payload) => {
      for (const socket of state.sockets) socket.send(payload);
    },
    closeAll: (code, reason) => {
      for (const socket of state.sockets) socket.close(code, reason);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of state.sockets) socket.terminate();
        wss.close(() => http.close(() => resolve()));
      }),
  };
};

test("a Node host connects with its token in the subprotocol and receives events", async () => {
  assert.equal(
    typeof globalThis.WebSocket,
    "function",
    "this Node has no global WebSocket — the token clients rely on it",
  );

  const server = await harness();
  after(() => server.close());

  const received: Array<{ event: SyncEvent; originId?: string }> = [];
  let opened: () => void = () => {};
  const isOpen = new Promise<void>((resolve) => {
    opened = resolve;
  });

  const client = createSyncClient({
    url: server.url,
    token: "tok en/+",
    onEvent: (event, originId) => {
      received.push({ event, originId });
    },
    onStatus: (status) => {
      if (status === "open") opened();
    },
  });
  after(() => client.close());
  client.connect();
  await isOpen;

  // Percent-encoded, because a raw token can hold characters a header value
  // may not — and decoded back to the original on the server side.
  assert.deepEqual(server.offered, [`${BEARER}${encodeURIComponent("tok en/+")}`]);
  assert.equal(
    decodeURIComponent(server.offered[0].slice(BEARER.length)),
    "tok en/+",
  );

  const delivered = new Promise<void>((resolve) => {
    const id = setInterval(() => {
      if (received.length > 0) {
        clearInterval(id);
        resolve();
      }
    }, 5);
  });
  server.send({ kind: "timer.stopped", entry: { id: "e1" } as never }, "web-1");
  await delivered;

  assert.equal(received[0].event.kind, "timer.stopped");
  assert.equal(received[0].originId, "web-1");

  client.close();
  assert.equal(client.status(), "closed");
});

test("a malformed frame is ignored rather than killing the socket", async () => {
  const server = await harness();
  after(() => server.close());

  const received: SyncEvent[] = [];
  let opened: () => void = () => {};
  const isOpen = new Promise<void>((resolve) => {
    opened = resolve;
  });

  const client = createSyncClient({
    url: server.url,
    token: "t",
    onEvent: (event) => {
      received.push(event);
    },
    onStatus: (status) => {
      if (status === "open") opened();
    },
  });
  after(() => client.close());
  client.connect();
  await isOpen;

  const delivered = new Promise<void>((resolve) => {
    const id = setInterval(() => {
      if (received.length > 0) {
        clearInterval(id);
        resolve();
      }
    }, 5);
  });

  // Unparseable, then valid JSON that is not a sync envelope, then the real
  // event. Only the last reaches the consumer, and the socket survives all of
  // them — a client that dropped its connection on a frame it did not
  // recognise would stop syncing the moment the protocol grew.
  server.sendRaw("{not json");
  server.sendRaw(JSON.stringify({ type: "chat", text: "hi" }));
  server.sendRaw(JSON.stringify({ type: "tt:sync" }));
  server.send({ kind: "favorites.changed" });
  await delivered;

  assert.equal(client.status(), "open");
  assert.deepEqual(received, [{ kind: "favorites.changed" }]);
});


/** Resolves once `predicate` holds, or rejects at the deadline. */
const until = (predicate: () => boolean, label: string): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const id = setInterval(() => {
      if (predicate()) {
        clearInterval(id);
        resolve();
        return;
      }
      if (Date.now() - started > 3000) {
        clearInterval(id);
        reject(new Error(`timed out waiting for ${label}`));
      }
    }, 5);
  });

const idle = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Revocation, over a real socket closed with the real code.
 *
 * The server sweeps live sockets and closes a revoked session's with 4401
 * (`ws/session-watch.ts`). Before this, the client read that as any other
 * disconnect and went into backoff — so a device signed out in Settings →
 * Devices reconnected forever against a credential the server had
 * permanently rejected, showing a sync dot that never settled and saying
 * nothing. The number is shared through `@starter/shared` precisely so the
 * two ends cannot disagree; this asserts the client end of it end to end.
 */
test("a 4401 close stops the reconnect loop and reports the revocation", async () => {
  const server = await harness();
  after(() => server.close());

  let revoked = 0;
  const client = createSyncClient({
    url: server.url,
    token: "revoked-token",
    onEvent: () => undefined,
    onSessionRevoked: () => {
      revoked += 1;
    },
    // Tight, so a retry this test is asserting the absence of would have had
    // several chances to happen before the assertion runs.
    minBackoffMs: 10,
    maxBackoffMs: 10,
  });
  after(() => client.close());

  client.connect();
  await until(() => client.status() === "open", "the socket to open");
  assert.equal(server.connections(), 1);

  server.closeAll(SESSION_REVOKED_CLOSE_CODE, "session revoked");
  await until(() => revoked === 1, "the revocation callback");

  assert.equal(client.status(), "closed");

  // The host is told once, and the socket stays down. A nudge — which is
  // exactly what the browser extension's 30-second alarm does — must not
  // resurrect a session the server has thrown away.
  await idle(150);
  client.connect();
  client.reconnect();
  await idle(150);

  assert.equal(server.connections(), 1, "no socket was reopened");
  assert.equal(revoked, 1, "the host was told exactly once");
  assert.equal(client.status(), "closed");
});

/**
 * The negative control, and the more dangerous half.
 *
 * "Any disconnect signs you out" would be far worse than the bug being fixed:
 * a phone that loses signal for a moment would land on the login screen with
 * its token wiped. An ordinary close must still go through the backoff.
 */
test("an ordinary close still reconnects and never reports a revocation", async () => {
  const server = await harness();
  after(() => server.close());

  let revoked = 0;
  const client = createSyncClient({
    url: server.url,
    token: "good-token",
    onEvent: () => undefined,
    onSessionRevoked: () => {
      revoked += 1;
    },
    minBackoffMs: 10,
    maxBackoffMs: 10,
  });
  after(() => client.close());

  client.connect();
  await until(() => client.status() === "open", "the first socket to open");
  assert.equal(server.connections(), 1);

  // 1001 "going away" — a server restart, a proxy recycling a connection.
  server.closeAll(1001, "going away");

  await until(() => server.connections() === 2, "the automatic reconnect");
  await until(() => client.status() === "open", "the socket to come back");
  assert.equal(revoked, 0, "an ordinary close is not a revocation");
});
