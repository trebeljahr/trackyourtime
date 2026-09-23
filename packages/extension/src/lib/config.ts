/**
 * Where this extension talks to the server.
 *
 * A baked-in URL alone is not enough, for two reasons. Track Your Time can be
 * self-hosted, and the Web Store build is one bundle for everybody, so the
 * server is somebody's choice rather than the build's. And `pnpm run dev`
 * picks a random API port per run in a worktree, so a build from yesterday
 * would point at a port nothing is listening on. The build-time value is
 * therefore only a default, and the popup's server picker overrides it into
 * `chrome.storage.local`.
 */
import type { ExtensionBridgeTarget } from "@starter/shared/extension-bridge";
import {
  decodeVersioned,
  encodeVersioned,
  normalizeServerInput,
  resolveSyncUrl,
  type ClientId,
  type ServerInfo,
  type VersionedSpec,
} from "@starter/core";
import { chromeStorage, localStorageArea } from "./chrome-storage";

/**
 * The origin this build targets, injected by vite.config.ts from the build
 * mode — localhost for a development build, the deployed host for production.
 *
 * There is deliberately no localhost fallback. A fallback cannot tell which
 * build it is standing in for, so a production build whose define went missing
 * would quietly ship pointing at a laptop, and present as "the extension is
 * broken" rather than as the build error it is. `import.meta.env` is loosely
 * typed by vite/client, so the value is still narrowed before it is trusted.
 */
const buildTimeApiUrl = ((): string => {
  const configured: unknown = import.meta.env.VITE_API_URL;
  if (typeof configured !== "string" || configured.trim() === "") {
    throw new Error(
      "No API URL was baked into this build — see `define` in vite.config.ts.",
    );
  }
  return configured.trim();
})();

export const DEFAULT_API_URL: string = buildTimeApiUrl;

/**
 * Which web origins this build's bridge accepts messages from, injected by
 * vite.config.ts from the same build target the manifest's
 * `externally_connectable` was generated from.
 *
 * No fallback, for the reason the API URL has none: a production bundle that
 * silently accepted `http://localhost` would be a widened trust list nobody
 * chose.
 */
export const BRIDGE_TARGET: ExtensionBridgeTarget = ((): ExtensionBridgeTarget => {
  const configured: unknown = import.meta.env.VITE_BRIDGE_TARGET;
  // "none" is the Firefox build, which has no bridge at all: Gecko implements
  // `externally_connectable` for extensions only, never for web pages. It is
  // still a value that must be recognised here — the module scope of the
  // background page reads this, so an unrecognised target throws before a
  // single listener is registered and the extension does nothing at all, with
  // the error only visible in the browser console.
  if (
    configured === "development" ||
    configured === "production" ||
    configured === "none"
  ) {
    return configured;
  }
  throw new Error(
    "No bridge target was baked into this build — see `define` in vite.config.ts.",
  );
})();

export const API_URL_STORAGE_KEY = "trackyourtime.api-url";

/** Names this client in Settings → Devices, and to the device-flow allowlist. */
export const EXTENSION_CLIENT_ID: ClientId = "trackyourtime-extension";

const storage = (): ReturnType<typeof chromeStorage> =>
  chromeStorage(localStorageArea());

export async function loadApiUrl(): Promise<string> {
  const stored = await storage().getItem(API_URL_STORAGE_KEY);
  return stored !== null && stored.trim() !== "" ? stored : DEFAULT_API_URL;
}

/**
 * Persist an override, as the normalized origin.
 *
 * Validated here even though every caller has already validated it: a value
 * that does not parse bricks every later request with no obvious way back —
 * the popup would keep failing against a URL the user can no longer see was
 * wrong. Stored as the ORIGIN, so a pasted page URL or a trailing slash can
 * never become part of `<apiUrl>/api/trpc`.
 */
export async function saveApiUrl(url: string): Promise<void> {
  const parsed = normalizeServerInput(url);
  if (!parsed.ok) throw new Error(parsed.message);
  await storage().setItem(API_URL_STORAGE_KEY, parsed.origin);
}

/**
 * What the chosen server said about itself when it was checked — its release
 * and commit — so Settings → Account can say which Track Your Time it is
 * talking to. Kept beside the URL, and keyed by the origin inside it, so a
 * record left from an earlier server is recognisably not about this one.
 */
export const SERVER_INFO_STORAGE_KEY = "trackyourtime.server-info";

const textOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const readServerInfo = (value: unknown): ServerInfo | null => {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const origin = textOrNull(record.origin);
  if (origin === null) return null;
  return {
    origin,
    release: textOrNull(record.release),
    commit: textOrNull(record.commit),
    // Absent from records written before the handshake: level 0 and no floor,
    // which is exactly what such a server reported.
    apiLevel:
      typeof record.apiLevel === "number" && Number.isInteger(record.apiLevel) && record.apiLevel >= 0
        ? record.apiLevel
        : 0,
    minClientApiLevel:
      typeof record.minClientApiLevel === "number" && Number.isInteger(record.minClientApiLevel)
        ? record.minClientApiLevel
        : null,
    webUrl: textOrNull(record.webUrl),
    originTrusted:
      typeof record.originTrusted === "boolean" ? record.originTrusted : null,
  };
};

/**
 * Version 1 is the `ServerInfo` itself, which builds before it wrote bare.
 * Written by another build, or hand-edited: a missing version line is the
 * whole cost of a miss, which is not worth failing a snapshot over.
 */
const SERVER_INFO_SPEC: VersionedSpec<ServerInfo> = {
  version: 1,
  decode: readServerInfo,
  legacy: readServerInfo,
};

export async function saveServerInfo(info: ServerInfo): Promise<void> {
  await storage().setItem(
    SERVER_INFO_STORAGE_KEY,
    encodeVersioned(SERVER_INFO_SPEC.version, info),
  );
}

/** The stored record, or null when there is none or it is not readable. */
export async function loadServerInfo(): Promise<ServerInfo | null> {
  return decodeVersioned(
    await storage().getItem(SERVER_INFO_STORAGE_KEY),
    SERVER_INFO_SPEC,
  );
}

/**
 * The WebSocket URL for an API origin.
 *
 * Delegates to core's `resolveSyncUrl` rather than re-deriving the rule: a
 * private copy here would keep working right up until the socket path changes,
 * at which point the extension would connect to a URL the server no longer
 * serves — with no typecheck or test failure to say so, because
 * `connectSync` skips an unusable URL quietly.
 *
 * The empty origin is what makes this the one-argument form: an extension has
 * no page origin to fall back to, and `resolveSyncUrl` already returns "" when
 * neither input parses, so callers can skip connecting rather than throw.
 */
export function syncUrlFrom(apiUrl: string): string {
  return resolveSyncUrl(apiUrl, "");
}
