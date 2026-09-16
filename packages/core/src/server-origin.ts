/**
 * Choosing a Track Your Time server.
 *
 * The store-distributed clients — the phone apps, the Chrome Web Store
 * extension — are one build each, and the person using one decides which
 * server it talks to: the hosted one, or one they run themselves. That makes
 * an address somebody typed into a text field the root of every request the
 * client will ever make, so it is checked twice before anything is saved:
 *
 *  - {@link normalizeServerInput}, synchronously, for what can be known from
 *    the string alone — that it is a URL, and that plain http is only used
 *    for this machine. Synchronous on purpose: the browser extension has to
 *    ask Chrome for the host permission inside the click that chose the
 *    server, and a user gesture does not survive an `await`.
 *  - {@link checkServer}, over the network, for what only the server can
 *    say — that it answers, and that what answers is Track Your Time.
 *
 * Framework-free like the rest of core: the web app, the extension's service
 * worker and Raycast share one definition of "a usable server".
 */

import {
  API_LEVEL,
  CLIENT_TOO_OLD,
  parseApiLevel,
  SERVER_TOO_OLD,
  type VersionRefusal,
} from "@starter/shared";

/**
 * The lowest server API level the first-party clients (web, phone, extension,
 * Raycast) work with. A server reporting less is refused with
 * `SERVER_TOO_OLD` rather than half-working. Level 0 is a server from before
 * the handshake, which reports no level at all.
 *
 * Raise it only together with a client change that cannot work without the
 * newer server, and never past what the oldest supported self-hosted release
 * reports — see docs/versioning.md.
 */
export const MIN_SERVER_API_LEVEL = 1;

/** The hosted service's API origin. */
export const CLOUD_API_ORIGIN = "https://api.trackyourtime.dev";

/** What the hosted service is called wherever a person picks a server. */
export const CLOUD_SERVER_LABEL = "Track Your Time cloud";

export type ServerInputProblem = "empty" | "invalid-url" | "insecure";

export type ParsedServerInput =
  | { ok: true; origin: string }
  | { ok: false; problem: ServerInputProblem; message: string };

/**
 * Hosts that may be reached over plain http: this machine only.
 *
 * Plain http anywhere else sends the password and then the session token
 * across a network in the clear. A self-hoster testing on a laptop is served
 * by `localhost`; anything reachable from a phone has a name, and a name can
 * have a certificate.
 */
export const isLoopbackHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
};

/** "track.example.com" or "localhost:5159" — how an origin reads in a sentence. */
export const serverHost = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/** Same server, whatever the letter case or a trailing slash says. */
export const sameServerOrigin = (a: string, b: string): boolean => {
  const canonical = (value: string): string => {
    try {
      return new URL(value).origin;
    } catch {
      return value.trim().replace(/\/+$/, "").toLowerCase();
    }
  };
  return canonical(a) === canonical(b);
};

/** The label a person sees for a server: the cloud by name, anything else by host. */
export const serverLabel = (origin: string): string =>
  sameServerOrigin(origin, CLOUD_API_ORIGIN) ? CLOUD_SERVER_LABEL : serverHost(origin);

/**
 * Turn what somebody typed into the origin a client stores, or say why not.
 *
 * Forgiving where the intent is plain — no scheme means https (http for
 * `localhost`), a pasted page URL keeps only its origin because the server
 * lives at the root of its domain — and strict where it is not.
 */
export const normalizeServerInput = (input: string): ParsedServerInput => {
  const trimmed = input.trim();
  if (trimmed === "") {
    return { ok: false, problem: "empty", message: "Enter your server's address." };
  }

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  let candidate = trimmed;
  if (!hasScheme) {
    const host = trimmed.split(/[/?#]/)[0]?.replace(/:\d+$/, "") ?? "";
    candidate = `${isLoopbackHost(host) ? "http" : "https"}://${trimmed}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return {
      ok: false,
      problem: "invalid-url",
      message: `"${trimmed}" is not a web address. It looks like https://track.example.com.`,
    };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      ok: false,
      problem: "invalid-url",
      message: "The address has to start with https://.",
    };
  }
  if (url.hostname === "" || url.username !== "" || url.password !== "") {
    return {
      ok: false,
      problem: "invalid-url",
      message: `"${trimmed}" is not a web address. It looks like https://track.example.com.`,
    };
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    return {
      ok: false,
      problem: "insecure",
      message: `Use https:// for ${url.host}. Plain http:// sends your password unencrypted, so it is only accepted for localhost.`,
    };
  }

  return { ok: true, origin: url.origin };
};

// ── asking the server ────────────────────────────────────────────────

/** What a server said about itself. */
export type ServerInfo = {
  origin: string;
  /** Release number, e.g. "0.1.0". Null from a server too old to report one. */
  release: string | null;
  /** The commit its image was built from, when it was built by CI. */
  commit: string | null;
  /** Where its web app lives. */
  webUrl: string | null;
  /**
   * Whether the server trusts the origin that asked, or null when it did not
   * say — an older server, or a caller with no Origin (Raycast, Node).
   */
  originTrusted: boolean | null;
  /**
   * The API level the server speaks. 0 for a server released before the
   * version handshake, which reports none.
   */
  apiLevel: number;
  /**
   * The lowest client API level it serves, or null when it did not say (a
   * pre-handshake server serves every client that sends no level).
   */
  minClientApiLevel: number | null;
};

export type ServerCheckProblem = "unreachable" | "not-trackyourtime" | "unhealthy";

export type ServerCheck =
  | { ok: true; server: ServerInfo }
  | { ok: false; problem: ServerCheckProblem; message: string };

export type CheckServerOptions = {
  fetchImpl?: typeof fetch;
  /** Give up after this long. A server that takes longer is not usable anyway. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/**
 * Call `GET <origin>/api/health` and decide what answered.
 *
 * Recognised by shape as well as by the `service` marker, because a server
 * released before the marker existed is still a Track Your Time server a
 * person may want to use: `status: "ok"` together with a string `webUrl` is
 * this server's health response and nobody else's.
 */
export async function checkServer(
  origin: string,
  options: CheckServerOptions = {},
): Promise<ServerCheck> {
  const host = serverHost(origin);
  const doFetch =
    options.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch?.bind(globalThis);
  if (!doFetch) {
    return { ok: false, problem: "unreachable", message: `Could not reach ${host}.` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await doFetch(`${origin.replace(/\/+$/, "")}/api/health`, {
      method: "GET",
      headers: { accept: "application/json" },
      // Nothing to authenticate, and a cookie would make the answer depend on
      // who is asking.
      credentials: "omit",
      signal: controller.signal,
    });
  } catch {
    return {
      ok: false,
      problem: "unreachable",
      message: `Could not reach ${host}. Check the address, and that the server is running.`,
    };
  } finally {
    clearTimeout(timer);
  }

  const notOurs: ServerCheck = {
    ok: false,
    problem: "not-trackyourtime",
    message: `${host} answered, but it is not a Track Your Time server. Enter the address you open Track Your Time at.`,
  };

  if (!response.ok) return notOurs;

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed !== "object" || parsed === null) return notOurs;
    body = parsed as Record<string, unknown>;
  } catch {
    return notOurs;
  }

  const marked = body.service === "trackyourtime";
  const shaped = body.status === "ok" && typeof body.webUrl === "string";
  if (!shaped || (body.service !== undefined && !marked)) return notOurs;

  if (body.db === false) {
    return {
      ok: false,
      problem: "unhealthy",
      message: `${host} is a Track Your Time server, but it cannot reach its database right now. Try again in a minute.`,
    };
  }

  return {
    ok: true,
    server: {
      origin,
      ...readHealthVersion(body),
      webUrl: text(body.webUrl),
      originTrusted: typeof body.originTrusted === "boolean" ? body.originTrusted : null,
    },
  };
}

/**
 * The version fields of a `/api/health` body.
 *
 * `commit` is read from `commit`, then from `version`: servers before the
 * handshake reported the commit as `version`, and newer ones send both.
 * Shared with the extension's own health read, so the two cannot disagree.
 */
export const readHealthVersion = (
  body: Readonly<Record<string, unknown>>,
): Pick<ServerInfo, "release" | "commit" | "apiLevel" | "minClientApiLevel"> => ({
  release: text(body.release),
  commit: text(body.commit) ?? text(body.version),
  apiLevel: parseApiLevel(body.apiLevel) ?? 0,
  minClientApiLevel: parseApiLevel(body.minClientApiLevel),
});

/**
 * Whether this build and a server can work together, or which side is too old.
 *
 * `SERVER_TOO_OLD` when the server's level is below {@link MIN_SERVER_API_LEVEL};
 * `CLIENT_TOO_OLD` when the server's floor is above this build's `API_LEVEL`.
 * Both are loud answers with a way out — update the server, update the app —
 * never a reason to delete anything stored on the device.
 */
export const serverCompatibility = (
  server: Pick<ServerInfo, "apiLevel" | "minClientApiLevel">,
  levels: { clientApiLevel?: number; minServerApiLevel?: number } = {},
): VersionRefusal | null => {
  const minServer = levels.minServerApiLevel ?? MIN_SERVER_API_LEVEL;
  const clientLevel = levels.clientApiLevel ?? API_LEVEL;
  if (server.apiLevel < minServer) return SERVER_TOO_OLD;
  if (server.minClientApiLevel !== null && clientLevel < server.minClientApiLevel) {
    return CLIENT_TOO_OLD;
  }
  return null;
};

/** "Track Your Time 0.1.0 (1a2b3c4)", or as much of that as the server said. */
export const describeServerVersion = (server: ServerInfo): string => {
  const commit = server.commit ? server.commit.slice(0, 7) : null;
  if (server.release && commit) return `Track Your Time ${server.release} (${commit})`;
  if (server.release) return `Track Your Time ${server.release}`;
  if (commit) return `Track Your Time (${commit})`;
  return "Track Your Time";
};
