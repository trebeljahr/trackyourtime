/**
 * This build's release, baked in by `vite.config.ts` from the root
 * package.json. Sent as `x-trackyourtime-client-version` and shown under
 * Settings → Account. Empty only for a bundle built without the define, and an
 * empty version is simply not sent.
 */
export const APP_VERSION: string =
  typeof import.meta.env.VITE_APP_VERSION === "string" ? import.meta.env.VITE_APP_VERSION : "";
