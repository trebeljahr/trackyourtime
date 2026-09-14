import type { WebSocket } from "ws";
import type { ServerToClientMessage } from "@starter/shared";
import { userRoomId } from "@starter/shared";

/**
 * The live sockets of each person, one room per user (`user:<userId>`).
 *
 * This used to be the starter's general room manager — any room id, chosen by
 * the client, with chat and presence on top. That is exactly the shape that
 * let a signed-in user subscribe to somebody else's sync events: a join named
 * its room in client input, and a room is nothing but "everyone here receives
 * the same bytes". So `join` takes no room id at all. It takes the user a
 * socket AUTHENTICATED as, which the upgrade handler reads off the session,
 * and derives the room from it; there is no way to ask this class to put a
 * socket anywhere else.
 *
 * Holds no visibility logic. Who receives an event is decided in `ws/sync.ts`
 * before anything reaches a room; this class only delivers.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Set<WebSocket>>();
  private readonly socketToRoom = new Map<WebSocket, string>();

  /**
   * Put an authenticated socket in its own user's room.
   *
   * Joining again leaves the previous room first, so a socket is only ever in
   * one.
   */
  join(userId: string, socket: WebSocket): void {
    this.leave(socket);
    const roomId = userRoomId(userId);
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Set();
      this.rooms.set(roomId, room);
    }
    room.add(socket);
    this.socketToRoom.set(socket, roomId);
  }

  /** Take a socket out of its room. Harmless for a socket in none. */
  leave(socket: WebSocket): void {
    const roomId = this.socketToRoom.get(socket);
    if (roomId === undefined) return;
    this.socketToRoom.delete(socket);
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.delete(socket);
    if (room.size === 0) this.rooms.delete(roomId);
  }

  /** Send one message to every open socket in a room. */
  broadcast(roomId: string, message: ServerToClientMessage): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const data = JSON.stringify(message);
    for (const socket of room) {
      if (socket.readyState === 1) socket.send(data);
    }
  }

  /** The sockets currently in a room. */
  socketsIn(roomId: string): WebSocket[] {
    return [...(this.rooms.get(roomId) ?? [])];
  }

  /** The room a socket was placed in, if any. */
  roomOf(socket: WebSocket): string | undefined {
    return this.socketToRoom.get(socket);
  }

  /** How many rooms have at least one live socket. */
  getRoomCount(): number {
    return this.rooms.size;
  }

  /** How many sockets are placed, across every room. */
  getConnectionCount(): number {
    return this.socketToRoom.size;
  }
}
