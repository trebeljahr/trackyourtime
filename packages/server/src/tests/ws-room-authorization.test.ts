import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WebSocket } from "ws";
import type { ServerToClientMessage, SyncEvent } from "@starter/shared";
// Subpath import: a bare named import from "@starter/shared" throws under tsx
// (see the note in duration.test.ts).
import { userRoomId } from "@starter/shared/protocol";
import type { UpgradeAuth } from "../ws/auth.js";
import { roomManager, setupWebSocket } from "../ws/handler.js";
import { publishToUser } from "../ws/sync.js";

/**
 * A socket receives its own user's sync events and nobody else's.
 *
 * The starter this repo grew from let the CLIENT name its room, twice over: a
 * `?roomId=` on the upgrade URL and a `join-room` message after it. Either one
 * let any signed-in user subscribe to `user:<someone else>` and read every
 * entry, description and rate that person tracked. These tests go through a
 * real handshake against a real HTTP server, so what they pin is the shipped
 * connection handler, and they check both halves of the fix: the spoof
 * receives nothing, and it does not cost the spoofing client its socket (a
 * close would only put an older build into a reconnect loop).
 *
 * The two auth lookups are injected — the real ones need better-auth and a
 * database — and so is the runaway guard, for the same reason. Which user a
 * socket authenticates as is chosen by a test-only header the injected lookup
 * reads, standing in for a session cookie or bearer token.
 */

const USER_HEADER = "x-test-user";

const startServer = async (): Promise<{ server: Server; port: number }> => {
  const server = createServer();
  setupWebSocket(server, {
    authenticate: async (req) => {
      const userId = req.headers[USER_HEADER];
      if (typeof userId !== "string") return null;
      return {
        session: { user: { id: userId, name: userId } },
        headers: new Headers(),
      } as unknown as UpgradeAuth;
    },
    probe: async () => "live",
    enforceRunaway: async () => undefined,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port };
};

/** A connected client and everything the server has sent it. */
type Client = {
  ws: WebSocket;
  received: ServerToClientMessage[];
  closed: boolean;
  /** Resolves once a message matching `match` has arrived. */
  next: (match: (message: ServerToClientMessage) => boolean) => Promise<void>;
};

const connect = (port: number, userId: string, path = "/api/ws"): Promise<Client> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: { [USER_HEADER]: userId },
    });
    const waiters: {
      match: (message: ServerToClientMessage) => boolean;
      done: () => void;
    }[] = [];
    const client: Client = {
      ws,
      received: [],
      closed: false,
      next: (match) =>
        client.received.some(match)
          ? Promise.resolve()
          : new Promise((done) => waiters.push({ match, done })),
    };
    ws.on("message", (data) => {
      const message = JSON.parse(String(data)) as ServerToClientMessage;
      client.received.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.match(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.done();
        }
      }
    });
    ws.on("close", () => {
      client.closed = true;
    });
    ws.once("open", () => resolve(client));
    ws.once("error", reject);
  });

/** A frame the server has read before this resolves: pings are answered in order. */
const roundTrip = (ws: WebSocket): Promise<void> =>
  new Promise((resolve) => {
    ws.once("pong", () => resolve());
    ws.ping();
  });

const invoiceEvent = (id: string): SyncEvent => ({ kind: "invoice.changed", id });

const isInvoice =
  (id: string) =>
  (message: ServerToClientMessage): boolean =>
    message.type === "tt:sync" &&
    message.event.kind === "invoice.changed" &&
    message.event.id === id;

/**
 * Publish one event to the victim and then one to the attacker, and wait for
 * each to land where it belongs. Frames on one socket arrive in the order the
 * server sent them, so once the attacker holds its own event, anything of the
 * victim's that was ever going to reach it already has.
 */
const publishToBoth = async (
  victim: Client,
  attacker: Client,
  tag: string,
): Promise<void> => {
  publishToUser("victim", invoiceEvent(`victim-${tag}`));
  publishToUser("attacker", invoiceEvent(`attacker-${tag}`));
  await Promise.all([
    victim.next(isInvoice(`victim-${tag}`)),
    attacker.next(isInvoice(`attacker-${tag}`)),
  ]);
};

const assertHasNothingOfVictims = (attacker: Client): void => {
  const leaked = attacker.received.filter(
    (message) =>
      message.type === "tt:sync" &&
      message.event.kind === "invoice.changed" &&
      message.event.id.startsWith("victim-"),
  );
  assert.deepEqual(leaked, [], "the attacker received the victim's events");
};

test("a ?roomId= naming another user's room is ignored", async (t) => {
  const { server, port } = await startServer();
  const victim = await connect(port, "victim");
  const attacker = await connect(
    port,
    "attacker",
    `/api/ws?roomId=${encodeURIComponent(userRoomId("victim"))}`,
  );
  t.after(() => {
    victim.ws.close();
    attacker.ws.close();
    server.close();
  });

  assert.equal(
    roomManager.socketsIn(userRoomId("victim")).length,
    1,
    "only the victim's own socket is in the victim's room",
  );
  assert.equal(roomManager.socketsIn(userRoomId("attacker")).length, 1);

  await publishToBoth(victim, attacker, "query");

  assertHasNothingOfVictims(attacker);
  assert.equal(attacker.closed, false);
  assert.equal(attacker.ws.readyState, WebSocket.OPEN);
});

test("a join-room message naming another user's room moves nothing and closes nothing", async (t) => {
  const { server, port } = await startServer();
  const victim = await connect(port, "victim");
  const attacker = await connect(port, "attacker");
  t.after(() => {
    victim.ws.close();
    attacker.ws.close();
    server.close();
  });

  // Everything an older build — or a hostile one — might send: the starter's
  // join, its other room messages, an unknown type, malformed JSON and a
  // binary frame. None of them has a meaning any more.
  const victimRoom = userRoomId("victim");
  attacker.ws.send(JSON.stringify({ type: "join-room", roomId: victimRoom }));
  attacker.ws.send(JSON.stringify({ type: "leave-room" }));
  attacker.ws.send(JSON.stringify({ type: "chat", text: "hello" }));
  attacker.ws.send(JSON.stringify({ type: "action", payload: { roomId: victimRoom } }));
  attacker.ws.send(JSON.stringify({ type: "subscribe", roomId: victimRoom }));
  attacker.ws.send("{not json");
  attacker.ws.send(Buffer.from([0, 1, 2, 3]));
  await roundTrip(attacker.ws);

  assert.equal(roomManager.socketsIn(victimRoom).length, 1);
  assert.equal(roomManager.socketsIn(userRoomId("attacker")).length, 1);

  await publishToBoth(victim, attacker, "message");

  assertHasNothingOfVictims(attacker);
  assert.deepEqual(
    attacker.received.filter((message) => message.type !== "tt:sync"),
    [],
    "an ignored frame is not answered with an error either",
  );
  assert.equal(attacker.closed, false);
  assert.equal(attacker.ws.readyState, WebSocket.OPEN);
});

test("every device of one user shares that user's room", async (t) => {
  const { server, port } = await startServer();
  const laptop = await connect(port, "victim");
  const phone = await connect(port, "victim");
  const colleague = await connect(port, "attacker");
  t.after(() => {
    laptop.ws.close();
    phone.ws.close();
    colleague.ws.close();
    server.close();
  });

  await publishToBoth(laptop, colleague, "devices");
  await phone.next(isInvoice("victim-devices"));
  assertHasNothingOfVictims(colleague);
});
