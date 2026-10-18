import type { IncomingHttpHeaders } from "node:http";

let draining = false;
let proxyDrainsAt = 0;
// The drain in index.ts is 20 s, so the grace below is the full 4 s.
export const setDraining = (drainMs = 20_000): void => {
  draining = true;
  proxyDrainsAt = Date.now() + Math.min(4000, drainMs / 4);
};
export const isDraining = (): boolean => draining;

/**
 * Traefik's own health check fails only after a grace — a quarter of the
 * drain, at most 4 s. Traefik drops a container on ONE failed check, and
 * Coolify stops this one as soon as Docker calls the new one healthy, which
 * Traefik can take 2 s more to add. Failing at once could empty the pool.
 */
export const isProxyDraining = (): boolean => draining && Date.now() >= proxyDrainsAt;

/** Whether a request is Traefik's load-balancer health check: the
 *  X-Hatchkit-Drain header, and no X-Forwarded-For (Traefik adds that to
 *  every request it forwards). */
export function isTraefikProbe(headers: IncomingHttpHeaders): boolean {
  return headers["x-hatchkit-drain"] !== undefined && headers["x-forwarded-for"] === undefined;
}

export function readiness(database: boolean, redisConfigured: boolean, distributed: boolean): {
  ready: boolean;
  rollingReady: boolean;
} {
  return {
    ready: !draining && database && (!redisConfigured || distributed),
    // Redis-less self-hosting remains supported, but cannot advertise safe overlap.
    rollingReady: !draining && database && redisConfigured && distributed,
  };
}
