import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import test from "node:test";
import type { WebSocket } from "ws";
import type { ServerToClientMessage } from "@starter/shared";
import { userRoomId } from "@starter/shared/protocol";
import {
  roomManager,
  revokeStaleSockets,
  sessionWatch,
  setupWebSocket,
} from "../ws/handler.js";
import { SESSION_REVOKED_CLOSE_CODE } from "../ws/session-watch.js";

/**
 * The wiring, not just the mechanism.
 *
 * `ws-session-watch.test.ts` pins what `SessionWatch` does; this pins that
 * `handler.ts` actually uses it — that a connection is put under watch, that
 * the sweep the interval runs closes a revoked socket and takes it out of its
 * room, and that a closed socket stops being probed. Deleting the two lines
 * that connect the two files would leave the other suite entirely green,
 * which is precisely how this hole would come back.
 *
 * Driven by emitting `connection` on the real `WebSocketServer` rather than
 * by a real handshake: the upgrade half needs a live better-auth instance and
 * a database, and neither exists in this suite.
 */

type FakeSocket = WebSocket & {
  sent: ServerToClientMessage[];
  closes: { code: number; reason: string }[];
  probeSession?: () => Promise<"live" | "revoked" | "unknown">;
  userId?: string;
};

/**
 * A socket the connection handler can actually drive: it registers `pong`,
 * `message` and `close` listeners on it, so this needs to be a real emitter.
 */
const fakeSocket = (): FakeSocket => {
  const socket = new EventEmitter() as unknown as FakeSocket & {
    readyState: number;
  };
  socket.readyState = 1;
  socket.sent = [];
  socket.closes = [];
  Object.assign(socket, {
    send: (data: string) => {
      socket.sent.push(JSON.parse(data) as ServerToClientMessage);
    },
    close: (code: number, reason: string) => {
      socket.closes.push({ code, reason });
      socket.readyState = 2;
      // A real `ws` emits close asynchronously; the point of the explicit
      // room-leave in the handler is that it does not wait for this.
      queueMicrotask(() => socket.emit("close"));
    },
    ping: () => {},
    terminate: () => {},
  });
  return socket as unknown as FakeSocket;
};

const upgradeRequest = (): IncomingMessage =>
  ({ url: "/api/ws", headers: { host: "localhost" } }) as unknown as IncomingMessage;

const syncEvents = (socket: FakeSocket): ServerToClientMessage[] =>
  socket.sent.filter((message) => message.type === "tt:sync");

/** Any sync frame will do: these tests are about who receives it. */
const syncFrame = (): ServerToClientMessage => ({
  type: "tt:sync",
  event: { kind: "settings.changed" },
});

// The auth lookups are never reached (connections are emitted directly), and
// the runaway guard is stubbed because the real one needs a database.
const wss = setupWebSocket(createServer(), {
  authenticate: async () => null,
  probe: async () => "unknown",
  enforceRunaway: async () => undefined,
});

/**
 * `roomManager` and `sessionWatch` are module singletons shared by every test
 * in this file, so each test connects as its own user — the handler places a
 * socket in that user's room and nowhere else — and cleans up after.
 */
const connect = (
  userId: string,
  probe: () => Promise<"live" | "revoked" | "unknown">,
): FakeSocket => {
  const socket = fakeSocket();
  socket.userId = userId;
  socket.probeSession = probe;
  wss.emit("connection", socket, upgradeRequest());
  return socket;
};

test("a connection is put under session watch", () => {
  const user = "watch-registers";
  const room = userRoomId(user);
  const before = sessionWatch.size;
  const socket = connect(user, async () => "live");

  assert.equal(sessionWatch.size, before + 1);
  assert.equal(roomManager.socketsIn(room).length, 1);

  socket.close(1000, "done");
});

test("the sweep the interval runs drops a revoked socket out of its room", async () => {
  const user = "revocation";
  const room = userRoomId(user);

  let phoneSessionExists = true;
  const laptop = connect(user, async () => "live");
  const phone = connect(user, async () =>
    phoneSessionExists ? "live" : "revoked",
  );

  roomManager.broadcast(room, syncFrame());
  assert.equal(syncEvents(phone).length, 1, "a live device receives events");

  // "Sign this device out" — the session document is gone. HTTP already
  // 401s at this point; the socket used to carry on regardless.
  phoneSessionExists = false;
  assert.equal(await revokeStaleSockets(), 1);

  assert.deepEqual(phone.closes, [
    { code: SESSION_REVOKED_CLOSE_CODE, reason: "session revoked" },
  ]);

  roomManager.broadcast(room, syncFrame());
  assert.equal(
    syncEvents(phone).length,
    1,
    "a revoked device must receive nothing further",
  );
  assert.equal(syncEvents(laptop).length, 2, "the live device is unaffected");
  assert.deepEqual(laptop.closes, []);

  laptop.close(1000, "done");
});

test("a closed socket stops being probed", async () => {
  const user = "close-unwatches";
  const room = userRoomId(user);
  let probes = 0;
  const socket = connect(user, async () => {
    probes += 1;
    return "live";
  });

  const before = sessionWatch.size;
  socket.close(1000, "done");
  // The handler unwatches from the `close` listener, which `close()` above
  // schedules on a microtask.
  await Promise.resolve();

  assert.equal(sessionWatch.size, before - 1);
  await revokeStaleSockets();
  assert.equal(probes, 0);
  assert.equal(roomManager.socketsIn(room).length, 0);
});

test("an unreadable session does not close anybody's socket", async () => {
  const user = "unknown-verdict";
  const room = userRoomId(user);
  const socket = connect(user, async () => {
    throw new Error("mongo went away");
  });

  assert.equal(await revokeStaleSockets(), 0);
  assert.deepEqual(socket.closes, []);
  assert.equal(roomManager.socketsIn(room).length, 1);

  socket.close(1000, "done");
});
