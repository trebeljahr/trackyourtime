import { environment, getPreferenceValues } from "@raycast/api";
import { DEV_BUILD_USES_LOCALHOST } from "./local-defaults.js";

/**
 * Where an unset preference points, per build mode.
 *
 * Same convention as the browser extension's build targets
 * (`packages/extension/manifest.config.ts`): a development build of a client
 * talks to the development server. `ray develop` is that build — the copy
 * running out of this checkout is the one being changed, so aiming it at the
 * deployed API only ever produces an ENOTFOUND against a server the change is
 * not in.
 *
 * The ports are the ones `pnpm run dev` pins. A worktree runs on random ports
 * instead (agents, several at once), which is what the preferences below are
 * for.
 *
 * The store copy has no local server to reach, so its `ray develop` build
 * (what a Store reviewer runs) uses the production origins too — see
 * `local-defaults.ts`.
 */
export const DEFAULT_ORIGINS = {
  development: {
    apiUrl: "http://localhost:5159",
    webUrl: "http://localhost:3392",
  },
  production: {
    // Two hosts, not one: `apiUrl` is an origin the callers append `/api/...`
    // to, and the API has its own single-label host under the apex zone.
    // (`api.tracktime.trebeljahr.com` was two labels under `trebeljahr.com`,
    // which the wildcard cert did not cover — hence the move.) `webUrl` is
    // where the device-flow approval page and the dashboard live.
    apiUrl: "https://api.trackyourtime.dev",
    webUrl: "https://trackyourtime.dev",
  },
} as const;

/** True under `ray develop`, false in a `ray build` bundle. */
export const isDevBuild = (): boolean => environment.isDevelopment;

/** True when empty preferences point at the local dev stack. */
export const usesLocalDefaults = (): boolean => isDevBuild() && DEV_BUILD_USES_LOCALHOST;

const defaults = (): { apiUrl: string; webUrl: string } =>
  usesLocalDefaults() ? DEFAULT_ORIGINS.development : DEFAULT_ORIGINS.production;

const trimSlash = (value: string): string => value.trim().replace(/\/+$/, "");

/**
 * A preference wins when it holds anything, otherwise the mode's default.
 *
 * Neither field carries a `default` in package.json on purpose: a default there
 * is baked into the stored value, so "never touched it" and "typed the
 * production URL" become indistinguishable and the dev fallback could never
 * fire. Unset therefore arrives here as an empty string.
 */
const resolve = (value: string | undefined, fallback: string): string => {
  const explicit = value === undefined ? "" : trimSlash(value);
  return explicit === "" ? fallback : explicit;
};

/** Server origin every API and auth call is made against. */
export const apiUrl = (): string => {
  const { apiUrl } = getPreferenceValues<ExtensionPreferences>();
  return resolve(apiUrl, defaults().apiUrl);
};

/** Web app origin — the device-pairing page and "Open in Browser" live here. */
export const webUrl = (): string => {
  const { webUrl } = getPreferenceValues<ExtensionPreferences>();
  return resolve(webUrl, defaults().webUrl);
};

/** Deep link into a page of the web app, e.g. `webLink("/app/track")`. */
export const webLink = (path: string): string => `${webUrl()}${path.startsWith("/") ? path : `/${path}`}`;

/**
 * Host without the scheme, for Raycast's metadata column.
 *
 * That column is narrow and renders plain text — a full URL truncates to
 * "https://api.example…" and hides the part that matters.
 */
export const hostLabel = (url: string): string => url.replace(/^https?:\/\//, "") || url;
