import { isTokenShell } from "@/lib/shell";

/** Native mail callbacks are resolved by the selected server's FRONTEND_URL. */
export const webCallbackUrl = (path: string): string =>
  typeof window === "undefined" || isTokenShell()
    ? path
    : `${window.location.origin}${path}`;
