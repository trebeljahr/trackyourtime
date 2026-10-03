import { Redis } from "ioredis";
import { env } from "../config/env.js";

let redis: Redis | null = null;

export function getRedis(): Redis | null {
  return redis;
}

export async function connectRedis(): Promise<void> {
  if (!env.REDIS_URL) {
    console.log("[redis] No REDIS_URL configured, skipping Redis connection");
    return;
  }

  redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });

  redis.on("error", () => {});
  try {
    await redis.connect();
    console.log("[redis] Connected to Redis");
  } catch {
    console.warn("[redis] Unavailable; reconnecting with sync reconciliation fallback");
  }
}

export async function disconnectRedis(): Promise<void> {
  if (!redis) return;
  const connection = redis;
  redis = null;
  // A socket that is reconnecting cannot acknowledge QUIT. No queued writes
  // depend on this shared connection during shutdown, so close it directly.
  connection.disconnect();
  console.log("[redis] Disconnected from Redis");
}
