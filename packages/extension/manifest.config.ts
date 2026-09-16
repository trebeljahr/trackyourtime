/**
 * Build targets, and the manifest each one produces.
 *
 * The DEFAULT API URL is baked in at build time, so a build is still a target
 * — a development bundle starts out pointed at a laptop, a production one at
 * the hosted API. Keeping both targets described here, in TypeScript that
 * ships in the repo, rather than in `.env.development` / `.env.production`:
 * those two filenames are commonly gitignored (they are on this machine),
 * which would make a fresh clone build an extension with no URL in it and no
 * error to say so.
 *
 * The default is only where a build starts. Track Your Time can be self-hosted,
 * and the Chrome Web Store build is one bundle for everybody, so the popup lets
 * a person pick any server and asks Chrome for access to that one host at the
 * moment they pick it (`optional_host_permissions`, `src/lib/server-access.ts`).
 * The required `host_permissions` stay narrow — only the build's own default —
 * because that is the line Chrome shows at install time.
 */
import { STORE_EXTENSION_KEY } from "@starter/shared/store-clients";
import rootPackage from "../../package.json" with { type: "json" };

export type BuildMode = "development" | "production";

export type BuildTarget = {
  /** Baked in as the default API origin. */
  apiUrl: string;
  /** Distinct so a dev build and a real one can sit in the toolbar together. */
  name: string;
  /**
   * The `_locales/<lang>/messages.json` key the manifest names the extension by.
   * Chrome resolves `__MSG_<key>__` in the BROWSER's UI language — which is
   * right for the store listing and the toolbar tooltip, and exactly why the
   * popup itself does not use `chrome.i18n` (see src/i18n/index.ts).
   */
  nameMessage: "extName" | "extNameDev";
  /**
   * Hosts the extension may talk to from the moment it is installed. Narrow on
   * purpose: this is the line Chrome shows the user at install time, and
   * `https://*\/*` there reads as "every site you visit" for something that
   * talks to exactly one server.
   */
  hostPermissions: string[];
  /**
   * Hosts the extension may ASK for later, one at a time, from a click.
   *
   * Broad because a self-hosted server can live on any name, and a manifest
   * cannot list names nobody has chosen yet. Declaring a pattern here grants
   * nothing: Chrome shows no warning for it at install, and the extension only
   * ever requests the single `https://<host>/*` a person typed into the server
   * picker. Chrome only accepts `permissions.request` for patterns covered by
   * this list, so it is also the ceiling on what the popup can ask for.
   */
  optionalHostPermissions: string[];
  /**
   * The public key pinned when `EXTENSION_KEY` is not set, or undefined to let
   * the id follow the load path.
   */
  defaultKey: string | undefined;
  outDir: string;
};

export const BUILD_TARGETS: Record<BuildMode, BuildTarget> = {
  development: {
    // The API port `pnpm run dev` pins. A git worktree runs on random ports
    // instead, which is what the popup's server picker is for.
    apiUrl: "http://localhost:5159",
    name: "Track Your Time (dev)",
    nameMessage: "extNameDev",
    hostPermissions: ["http://localhost/*", "http://127.0.0.1/*"],
    // Only https: a development build already holds both loopback hosts, and
    // this is what lets it exercise the self-hosted path — the request, the
    // prompt, the revocation — against a real https server.
    optionalHostPermissions: ["https://*/*"],
    // No key. The dev id is derived from the load path, and `scripts/dev.mjs`
    // derives the same id to put in the dev server's TRUSTED_ORIGINS. Pinning
    // the store key here would give the dev build the store build's id — the
    // two could no longer be installed side by side, and the dev server would
    // be trusting an id no dev build has.
    defaultKey: undefined,
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
    nameMessage: "extName",
    hostPermissions: ["https://api.trackyourtime.dev/*"],
    // Any https host, for a self-hosted server, plus the two loopback names
    // over plain http for someone running one on the same machine. Plain http
    // anywhere else is refused before Chrome is ever asked
    // (`normalizeServerInput`), because it would send the password in the
    // clear — so no `http://*/*` here either.
    optionalHostPermissions: [
      "https://*/*",
      "http://localhost/*",
      "http://127.0.0.1/*",
    ],
    // The Web Store key, so the id every self-hosted server trusts by default
    // (`STORE_EXTENSION_ID`) is the id this build actually gets — unpacked,
    // uploaded, or installed from the store.
    defaultKey: STORE_EXTENSION_KEY,
    outDir: "dist-prod",
  },
};

/**
 * The release version, read from the root `package.json` — the one number the
 * release process bumps (docs/releasing.md), and the one `/version.json` and
 * the mobile builds already report. A second literal here drifted from it
 * silently, and the Chrome Web Store refuses an upload whose version is not
 * higher than the published one, so a forgotten bump only surfaced at upload.
 * `.github/workflows/extension-release.yml` checks it against the tag.
 */
export const RELEASE_VERSION: string = rootPackage.version;

/**
 * Chrome's `version` is one to four dot-separated integers, so a prerelease
 * such as `0.2.0-rc.1` cannot be one. It becomes `version: "0.2.0"` with the
 * full string kept as `version_name`, which is what Chrome shows people.
 */
export const manifestVersionFields = (
  release: string,
): { version: string; version_name?: string } => {
  const match = /^(\d+(?:\.\d+){0,3})(?:[-+].*)?$/.exec(release.trim());
  if (!match) {
    throw new Error(
      `package.json version "${release}" does not start with a Chrome version (1-4 dot-separated integers).`,
    );
  }
  const version = match[1];
  return version === release.trim()
    ? { version }
    : { version, version_name: release.trim() };
};

/** The environment a build reads, narrowed so no Node typings are needed. */
export type BuildEnv = Readonly<Record<string, string | undefined>>;

const processEnv = (): BuildEnv =>
  (globalThis as { process?: { env?: BuildEnv } }).process?.env ?? {};

/**
 * A pinned public key, which fixes the extension's id.
 *
 * Without one, an unpacked extension's id follows its path and a Web Store
 * extension's id is assigned by Google — neither of which can be known before
 * the server needs it in TRUSTED_ORIGINS. The production target pins the Web
 * Store key by default; `EXTENSION_KEY` overrides it for either target, for a
 * fork that publishes under its own listing. Generate one with:
 *
 *   openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out trackyourtime.pem
 *   openssl rsa -in trackyourtime.pem -pubout -outform DER | base64 | tr -d '\n'
 *
 * Keep the .pem out of the repo; only the public half belongs in a manifest.
 */
export const pinnedKey = (
  target: BuildTarget,
  env: BuildEnv = processEnv(),
): string | undefined => {
  const key = env.EXTENSION_KEY?.trim();
  return key !== undefined && key !== "" ? key : target.defaultKey;
};

export function buildManifest(
  mode: BuildMode,
  env: BuildEnv = processEnv(),
): Record<string, unknown> {
  const target = BUILD_TARGETS[mode];
  const key = pinnedKey(target, env);

  return {
    manifest_version: 3,
    // Localised through public/_locales; `default_locale` is mandatory once
    // that directory exists, and Chrome refuses to load the extension without it.
    name: `__MSG_${target.nameMessage}__`,
    default_locale: "en",
    ...manifestVersionFields(RELEASE_VERSION),
    description: "__MSG_extDescription__",
    // WebSocket traffic only keeps an MV3 service worker alive from 116 on,
    // and the sync socket depends on that.
    minimum_chrome_version: "116",
    ...(key ? { key } : {}),
    action: {
      default_popup: "src/popup/index.html",
      default_title: `__MSG_${target.nameMessage}__`,
    },
    background: {
      service_worker: "background.js",
      type: "module",
    },
    // `cookies` is what lets the extension read the web app's better-auth
    // session and sign in without a second form — for an optional host too,
    // once it has been granted. `idle` is the only way to learn that the
    // person has walked away — a service worker sees no input events of its
    // own.
    permissions: ["storage", "alarms", "cookies", "idle"],
    // Requested only when somebody turns on Settings → Activity, from that
    // click — never at install. `tabs` is what exposes a tab's URL and title
    // to activity capture, and Chrome words it as reading browsing history,
    // which nobody who has not asked for capture should be shown.
    optional_permissions: ["tabs"],
    host_permissions: target.hostPermissions,
    optional_host_permissions: target.optionalHostPermissions,
    icons: {
      "16": "icons/16.png",
      "32": "icons/32.png",
      "48": "icons/48.png",
      "128": "icons/128.png",
    },
  };
}
