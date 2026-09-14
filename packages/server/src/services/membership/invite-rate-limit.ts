// How many invitations one person may send per hour.
//
// A fresh account is free to create, and every invitation is an email this
// server sends to an address the account chose. Without a per-inviter budget
// the invite form is a mail relay. The per-workspace pending cap alone does not
// stop it: cancel, invite again, repeat.
//
// Fixed window, counted in Redis when there is one and in this process when
// there is not — the same shape and the same fall-open rule as the REST API's
// limiter (api/v1/rate-limit.ts): a Redis blip must not turn into "nobody can
// invite anybody".
import type { Redis } from "ioredis";

export type InviteBudget = (inviterId: string, now?: number) => Promise<boolean>;

type Window = { windowId: number; count: number };

/**
 * A budget of `limit` invitations per `windowMs` per inviter.
 *
 * The in-memory map is swept on window rollover and capped at `maxEntries`
 * keys, past which a new key falls OPEN rather than growing the heap — only
 * authenticated owners and admins reach this, but an unbounded map is still
 * the wrong failure.
 */
export function createInviteBudget(options: {
  limit: number;
  windowMs: number;
  redis: () => Redis | null;
  maxEntries?: number;
}): InviteBudget {
  const entries = new Map<string, Window>();
  const maxEntries = options.maxEntries ?? 10_000;
  let sweptWindowId = -1;

  const countInMemory = (key: string, windowId: number): number | null => {
    if (sweptWindowId !== windowId) {
      sweptWindowId = windowId;
      for (const [k, entry] of entries) if (entry.windowId !== windowId) entries.delete(k);
    }
    const existing = entries.get(key);
    if (existing && existing.windowId === windowId) {
      existing.count += 1;
      return existing.count;
    }
    if (!existing && entries.size >= maxEntries) return null;
    entries.set(key, { windowId, count: 1 });
    return 1;
  };

  return async (inviterId, now = Date.now()) => {
    const windowId = Math.floor(now / options.windowMs);
    const key = `invite:${inviterId}`;
    const redis = options.redis();
    let count: number | null;
    if (!redis) {
      count = countInMemory(key, windowId);
    } else {
      try {
        const full = `ratelimit:${key}:${windowId}`;
        count = await redis.incr(full);
        if (count === 1) await redis.expire(full, Math.ceil(options.windowMs / 1000));
      } catch {
        count = null;
      }
    }
    return count === null || count <= options.limit;
  };
}
