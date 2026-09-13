/**
 * Build targets, and the manifest each one produces.
 *
 * The API URL is baked in at build time, so a build IS a target — there is no
 * one bundle that works against both a laptop and the deployed server. Keeping
 * both targets described here, in TypeScript that ships in the repo, rather
 * than in `.env.development` / `.env.production`: those two filenames are
 * commonly gitignored (they are on this machine), which would make a fresh
 * clone build an extension with no URL in it and no error to say so.
 *
 * The popup can still repoint the URL at runtime, but only within the host
 * permissions the build declared — a production build cannot be aimed at
 * localhost, by design.
 */

export type BuildMode = "development" | "production";

export type BuildTarget = {
  /** Baked in as the default API origin. */
  apiUrl: string;
  /** Distinct so a dev build and a real one can sit in the toolbar together. */
  name: string;
  /**
   * Hosts the extension may talk to. Narrow on purpose: this is the line
   * Chrome shows the user at install time, and `https://*\/*` reads as "every
   * site you visit" for something that talks to exactly one server.
   */
  hostPermissions: string[];
  outDir: string;
};

export const BUILD_TARGETS: Record<BuildMode, BuildTarget> = {
  development: {
    // The API port `pnpm run dev` pins. A git worktree runs on random ports
    // instead, which is what the popup's runtime override is for.
    apiUrl: "http://localhost:5159",
    name: "Track Your Time (dev)",
    hostPermissions: ["http://localhost/*", "http://127.0.0.1/*"],
    // Deliberately still `dist`: an unpacked extension's id is derived from
    // its path, so moving this would change the id, and with it the
    // `chrome-extension://…` origin already listed in the dev server's
    // TRUSTED_ORIGINS.
    outDir: "dist",
  },
  production: {
    // The API has its own host on its own apex zone. `api.trackyourtime.dev`
    // is one label under `trackyourtime.dev`, which a wildcard certificate
    // covers — the reason the old `api.tracktime.trebeljahr.com` could not
    // exist was that it was two labels under `trebeljahr.com`.
    //
    // This is an ORIGIN — the extension appends `/api/...` itself, the same
    // as the web client does — so it is the bare host with no path. The
    // server still mounts at `/api`, so calls land on
    // `https://api.trackyourtime.dev/api/trpc`.
    apiUrl: "https://api.trackyourtime.dev",
    name: "Track Your Time",
    hostPermissions: ["https://api.trackyourtime.dev/*"],
    outDir: "dist-prod",
  },
};

export const VERSION = "0.1.0";

/**
 * A pinned public key, which fixes the extension's id.
 *
 * Without one, an unpacked extension's id follows its path and a Web Store
 * extension's id is assigned by Google — neither of which can be known before
 * the server needs it in TRUSTED_ORIGINS. Supplying `EXTENSION_KEY` at build
 * time makes the production id deterministic, so the origin can be configured
 * ahead of the first upload. Generate one with:
 *
 *   openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out tracktime.pem
 *   openssl rsa -in tracktime.pem -pubout -outform DER | base64 | tr -d '\n'
 *
 * Keep the .pem out of the repo; only the public half belongs in a manifest.
 */
const pinnedKey = (): string | undefined => {
  const key = process.env.EXTENSION_KEY?.trim();
  return key !== undefined && key !== "" ? key : undefined;
};

export function buildManifest(mode: BuildMode): Record<string, unknown> {
  const target = BUILD_TARGETS[mode];
  const key = pinnedKey();

  return {
    manifest_version: 3,
    name: target.name,
    version: VERSION,
    description: "Start, stop and see your Track Your Time timer from the toolbar.",
    // WebSocket traffic only keeps an MV3 service worker alive from 116 on,
    // and the sync socket depends on that.
    minimum_chrome_version: "116",
    ...(key ? { key } : {}),
    action: {
      default_popup: "src/popup/index.html",
      default_title: target.name,
    },
    background: {
      service_worker: "background.js",
      type: "module",
    },
    // `cookies` is what lets the extension read the web app's better-auth
    // session and sign in without a second form. `idle` is the only way to
    // learn that the person has walked away — a service worker sees no input
    // events of its own.
    permissions: ["storage", "alarms", "cookies", "idle"],
    host_permissions: target.hostPermissions,
    icons: {
      "16": "icons/16.png",
      "32": "icons/32.png",
      "48": "icons/48.png",
      "128": "icons/128.png",
    },
  };
}
