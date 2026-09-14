import assert from "node:assert/strict";
import test from "node:test";
import type { WebSocket } from "ws";
import type { ServerToClientMessage } from "@starter/shared";
// Subpath import: a bare named import from "@starter/shared" throws under tsx
// (see the note in duration.test.ts). `publishSync` and its per-recipient
// projection are exercised in visibility-sync-projection.test.ts.
import { userRoomId } from "@starter/shared/protocol";
import { RoomManager } from "../ws/rooms.js";

/** A socket stand-in that records what the server sent it. */
type FakeSocket = WebSocket & { sent: ServerToClientMessage[] };

const fakeSocket = (readyState = 1): FakeSocket => {
  const sent: ServerToClientMessage[] = [];
  const socket = {
    readyState,
    sent,
    send: (data: string) => {
      sent.push(JSON.parse(data) as ServerToClientMessage);
    },
  };
  return socket as unknown as FakeSocket;
};

const settingsChanged = (): ServerToClientMessage => ({
  type: "tt:sync",
  event: { kind: "settings.changed" },
});

// ── room names ───────────────────────────────────────────────────────

test("userRoomId namespaces a user's own room", () => {
  assert.equal(userRoomId("u1"), "user:u1");
  assert.notEqual(userRoomId("u1"), userRoomId("u2"));
});

// ── RoomManager ──────────────────────────────────────────────────────

const U1 = userRoomId("u1");
const U2 = userRoomId("u2");

test("joining puts the socket in its user's room and sends it nothing", () => {
  const rooms = new RoomManager();
  const laptop = fakeSocket();
  const phone = fakeSocket();

  rooms.join("u1", laptop);
  rooms.join("u1", phone);

  // The starter announced presence on every join. A sync feed has no use
  // for it, and a frame per join is a frame a client must ignore.
  assert.deepEqual(laptop.sent, []);
  assert.deepEqual(phone.sent, []);
  assert.deepEqual(rooms.socketsIn(U1), [laptop, phone]);
  assert.equal(rooms.roomOf(phone), U1);
  assert.equal(rooms.getRoomCount(), 1);
  assert.equal(rooms.getConnectionCount(), 2);
});

test("broadcast reaches every device of that user and no other user", () => {
  const rooms = new RoomManager();
  const laptop = fakeSocket();
  const phone = fakeSocket();
  const colleague = fakeSocket();

  rooms.join("u1", laptop);
  rooms.join("u1", phone);
  rooms.join("u2", colleague);

  rooms.broadcast(U1, settingsChanged());

  assert.deepEqual(laptop.sent, [settingsChanged()]);
  assert.deepEqual(phone.sent, [settingsChanged()]);
  assert.deepEqual(
    colleague.sent,
    [],
    "another user's room never sees the broadcast",
  );
});

test("a user id that looks like a room name is still only that user's room", () => {
  // `join` derives the room; it never takes one. A user id spelled like
  // somebody else's room lands in its own, differently named, room.
  const rooms = new RoomManager();
  const victim = fakeSocket();
  const attacker = fakeSocket();

  rooms.join("u1", victim);
  rooms.join(U1, attacker);

  rooms.broadcast(U1, settingsChanged());
  assert.deepEqual(victim.sent, [settingsChanged()]);
  assert.deepEqual(attacker.sent, []);
  assert.equal(rooms.roomOf(attacker), userRoomId(U1));
});

test("broadcast skips sockets that are not open", () => {
  const rooms = new RoomManager();
  const closing = fakeSocket(2);
  rooms.join("u1", closing);

  rooms.broadcast(U1, settingsChanged());
  assert.deepEqual(closing.sent, []);
});

test("leaving removes the socket and drops the room once it is empty", () => {
  const rooms = new RoomManager();
  const laptop = fakeSocket();
  const phone = fakeSocket();

  rooms.join("u1", laptop);
  rooms.join("u1", phone);

  rooms.leave(phone);
  assert.deepEqual(rooms.socketsIn(U1), [laptop]);
  rooms.broadcast(U1, settingsChanged());
  assert.deepEqual(phone.sent, [], "a socket that left receives nothing");

  rooms.leave(laptop);
  assert.equal(rooms.getRoomCount(), 0);
  assert.equal(rooms.getConnectionCount(), 0);
  assert.deepEqual(rooms.socketsIn(U1), []);
  assert.equal(rooms.roomOf(laptop), undefined);
});

test("leaving twice is harmless", () => {
  const rooms = new RoomManager();
  const socket = fakeSocket();
  rooms.join("u1", socket);
  rooms.leave(socket);
  rooms.leave(socket);
  assert.equal(rooms.getRoomCount(), 0);
});

test("a socket is only ever in one room", () => {
  const rooms = new RoomManager();
  const socket = fakeSocket();

  rooms.join("u1", socket);
  rooms.join("u2", socket);

  assert.deepEqual(rooms.socketsIn(U1), []);
  assert.deepEqual(rooms.socketsIn(U2), [socket]);
  assert.equal(rooms.getConnectionCount(), 1);
});

test("broadcasting to a room with no sockets is a no-op", () => {
  const rooms = new RoomManager();
  rooms.broadcast(userRoomId("nobody"), settingsChanged());
  assert.equal(rooms.getRoomCount(), 0);
});
