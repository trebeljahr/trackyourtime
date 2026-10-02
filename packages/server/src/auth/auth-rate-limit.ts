/** Desktop E2E alone may skip Better Auth's shared-IP sign-in limit. */
export function authRateLimitEnabled(baseUrl: string, desktopE2eOverride: string | undefined): boolean {
  return !(
    desktopE2eOverride === "1" &&
    new URL(baseUrl).hostname === "127.0.0.1"
  );
}
