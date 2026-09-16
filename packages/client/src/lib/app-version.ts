/**
 * This build's release, from the root `package.json`.
 *
 * `next.config.ts` reads it at build time and inlines it as
 * `NEXT_PUBLIC_APP_VERSION`, so the web image, the phone bundles and the
 * Electron/Tauri shells each carry the version they were built as — with no
 * second copy of the number to keep in step. Empty only where Next never ran
 * (unit tests), and an empty version is simply not sent.
 */
export const APP_VERSION: string = process.env.NEXT_PUBLIC_APP_VERSION ?? "";
