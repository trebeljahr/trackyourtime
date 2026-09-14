import assert from "node:assert/strict";
import test from "node:test";
import type { WebSocket } from "ws";
import type { ServerToClientMessage } from "@starter/shared";
// Subpath import: a bare named import from "@starter/shared" throws under tsx
// (see the note in duration.test.ts).
import { userRoomId } from "@starter/shared/protocol";
import { RoomManager } from "../ws/rooms.js";
import {
  SESSION_REVOKED_CLOSE_CODE,
  SessionWatch,
  type SessionVerdict,
} from "../ws/session-watch.js";

/**
 * "Sign this device out" used to sign out only half of it.
 *
 * `ws/handler.ts` authenticates once at the upgrade and then trusts the
 * socket for as long as it stays open — days, for a phone. Deleting the
 * session document made every HTTP request 401 while the socket carried on
 * receiving that user's sync events. These tests pin the periodic re-check
 * that closes that hole, and in particular pin the two ways it could quietly
 * go wrong: a socket that stops receiving events, and an error that must not
 * be mistaken for a revocation.
 */

/** A socket stand-in that records what the server sent and how it closed. */
type FakeSocket = WebSocket & {
  sent: ServerToClientMessage[];
  closes: { code: number; reason: string }[];
};

const fakeSocket = (): FakeSocket => {
  const sent: ServerToClientMessage[] = [];
  const closes: { code: number; reason: string }[] = [];
  const socket = {
    readyState: 1,
    sent,
    closes,
    send: (data: string) => {
      sent.push(JSON.parse(data) as ServerToClientMessage);
    },
    close: (code: number, reason: string) => {
      closes.push({ code, reason });
      // A real socket goes to CLOSING synchronously, which is what stops
      // `RoomManager.broadcast` from writing to it.
      (socket as { readyState: number }).readyState = 2;
    },
  };
  return socket as unknown as FakeSocket;
};

const syncEvents = (socket: FakeSocket): ServerToClientMessage[] =>
  socket.sent.filter((message) => message.type === "tt:sync");

/** Any sync frame will do: these tests are about who receives it. */
const syncFrame = (): ServerToClientMessage => ({
  type: "tt:sync",
  event: { kind: "settings.changed" },
});

/** The revoke action `ws/handler.ts` hands to the sweep. */
const dropFrom =
  (rooms: RoomManager) =>
  (socket: WebSocket): void => {
    rooms.leave(socket);
    socket.close(SESSION_REVOKED_CLOSE_CODE, "session revoked");
  };

// ── the hole itself ──────────────────────────────────────────────────

test("a socket whose session was deleted stops receiving that user's events", async () => {
  const rooms = new RoomManager();
  const watch = new SessionWatch();

  const laptop = fakeSocket();
  const phone = fakeSocket();
  const room = userRoomId("u1");

  rooms.join("u1", laptop);
  rooms.join("u1", phone);

  // Both devices are live, so both see the user's sync events.
  let phoneSessionExists = true;
  watch.watch(laptop, async () => "live" as SessionVerdict);
  watch.watch(phone, async () =>
    phoneSessionExists ? "live" : ("revoked" as SessionVerdict),
  );

  rooms.broadcast(room, syncFrame());
  assert.equal(syncEvents(phone).length, 1);

  // The phone's session row is deleted — the exact thing "sign this device
  // out" does, and what the reviewer did by hand.
  phoneSessionExists = false;

  const dropped = await watch.sweep(dropFrom(rooms));
  assert.equal(dropped, 1);
  assert.deepEqual(phone.closes, [
    { code: SESSION_REVOKED_CLOSE_CODE, reason: "session revoked" },
  ]);

  // The whole point: the next event for this user does not reach the revoked
  // device, and does still reach the one that is still signed in.
  rooms.broadcast(room, syncFrame());
  assert.equal(
    syncEvents(phone).length,
    1,
    "a revoked device must receive nothing further",
  );
  assert.equal(syncEvents(laptop).length, 2);
  assert.deepEqual(laptop.closes, [], "the live device is left alone");
});

test("a revoked socket is removed from the room, not merely closed", async () => {
  const rooms = new RoomManager();
  const watch = new SessionWatch();
  const phone = fakeSocket();
  const room = userRoomId("u1");

  rooms.join("u1", phone);
  watch.watch(phone, async () => "revoked");

  await watch.sweep(dropFrom(rooms));

  // `close()` is asynchronous on a real socket; leaving the room is what
  // makes the very next broadcast miss it rather than racing it.
  assert.deepEqual(rooms.socketsIn(room), []);
  assert.equal(rooms.getConnectionCount(), 0);
});

// ── what must NOT close a socket ─────────────────────────────────────

test("a session that is still live keeps its socket and stays watched", async () => {
  const watch = new SessionWatch();
  const socket = fakeSocket();
  watch.watch(socket, async () => "live");

  assert.equal(await watch.sweep(() => assert.fail("must not revoke")), 0);
  assert.equal(watch.size, 1, "still watched, so it is re-checked next sweep");
});

test("an unreadable session is not a revoked one", async () => {
  // A database blip answering for a revocation would sign every connected
  // device out at once, which is a far worse failure than a late close.
  const watch = new SessionWatch();
  const unknown = fakeSocket();
  const thrown = fakeSocket();

  watch.watch(unknown, async () => "unknown");
  watch.watch(thrown, async () => {
    throw new Error("mongo went away");
  });

  const dropped = await watch.sweep(() => assert.fail("must not revoke"));

  assert.equal(dropped, 0);
  assert.deepEqual(unknown.closes, []);
  assert.deepEqual(thrown.closes, []);
  assert.equal(watch.size, 2, "both survive to be asked again");
});

// ── registry bookkeeping ─────────────────────────────────────────────

test("a revoked socket is unwatched, so it is not closed twice", async () => {
  const rooms = new RoomManager();
  const watch = new SessionWatch();
  const phone = fakeSocket();

  rooms.join("u1", phone);
  watch.watch(phone, async () => "revoked");

  assert.equal(await watch.sweep(dropFrom(rooms)), 1);
  assert.equal(watch.size, 0);
  assert.equal(await watch.sweep(dropFrom(rooms)), 0);
  assert.equal(phone.closes.length, 1);
});

test("unwatching a closed socket stops it being probed", async () => {
  const watch = new SessionWatch();
  const socket = fakeSocket();
  let probes = 0;

  watch.watch(socket, async () => {
    probes += 1;
    return "revoked";
  });
  watch.unwatch(socket);

  assert.equal(await watch.sweep(() => assert.fail("must not revoke")), 0);
  assert.equal(probes, 0);
  assert.equal(watch.size, 0);
});

test("watching the same socket twice replaces its probe rather than duplicating it", async () => {
  const watch = new SessionWatch();
  const socket = fakeSocket();

  watch.watch(socket, async () => "live");
  watch.watch(socket, async () => "revoked");
  assert.equal(watch.size, 1);

  const revoked: WebSocket[] = [];
  assert.equal(
    await watch.sweep((s) => {
      revoked.push(s);
    }),
    1,
  );
  assert.deepEqual(revoked, [socket]);
});

test("one revoked socket does not stop the sweep reaching the rest", async () => {
  const watch = new SessionWatch();
  const first = fakeSocket();
  const second = fakeSocket();
  const third = fakeSocket();

  watch.watch(first, async () => "revoked");
  watch.watch(second, async () => "live");
  watch.watch(third, async () => "revoked");

  const revoked: WebSocket[] = [];
  const dropped = await watch.sweep((socket) => {
    // `handler.ts`'s real revoke closes the socket, whose close handler calls
    // `unwatch` — mutating the map mid-sweep. The sweep iterates a copy for
    // exactly this reason, so mimic it here.
    watch.unwatch(socket);
    revoked.push(socket);
  });

  assert.equal(dropped, 2);
  assert.deepEqual(revoked, [first, third]);
  assert.equal(watch.size, 1);
});
