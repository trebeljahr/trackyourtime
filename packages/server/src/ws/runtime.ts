import { userRoomId } from "@starter/shared";
import { env } from "../config/env.js";
import { RoomManager } from "./rooms.js";
import { SyncTransport, syncNamespace } from "./sync-transport.js";

export const roomManager = new RoomManager();
export const syncTransport = new SyncTransport(
  (userId, message) => roomManager.broadcast(userRoomId(userId), message),
  syncNamespace(env.MONGODB_URI),
  () => roomManager.reconnectAll(),
);
