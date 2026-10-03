/** Explicitly marked E2E APIs on loopback alone may skip Better Auth's shared-IP sign-in limit. */
export function authRateLimitEnabled(baseUrl: string, e2eOverride: string | undefined): boolean {
  return !(
    e2eOverride === "1" &&
    new URL(baseUrl).hostname === "127.0.0.1"
  );
}
