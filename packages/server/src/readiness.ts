let draining = false;
export const setDraining = (): void => { draining = true; };
export const isDraining = (): boolean => draining;

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
