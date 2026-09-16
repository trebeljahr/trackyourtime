/**
 * `admin doctor`: the checks an operator runs when an instance misbehaves.
 *
 * Every check is a function of what it is handed — the resolved URLs, the
 * trusted-origin list, a ping function — and never reads `process.env` or
 * opens a connection itself. `cli/runtime.ts` is the only place that binds
 * them to this process, which is what lets `tests/admin-cli.test.ts` drive
 * each verdict with a made-up environment.
 *
 * Nothing here phones home: no telemetry, no update check. Every connection
 * the doctor opens is one the server itself opens.
 */

export type CheckStatus = "pass" | "warn" | "fail";

export type CheckResult = {
  name: string;
  status: CheckStatus;
  detail: string;
  /** What to do about a warn or a fail. Absent on a pass. */
  fix?: string;
};

const COMPOSE = "docker compose -f docker-compose.selfhost.yml";

// ── Database ──────────────────────────────────────────────────────────────

/** Ping the database and report its clock, when it gives one. */
export type MongoProbe = () => Promise<{ serverTime: Date | null }>;

export type MongoOutcome =
  | { ok: true; serverTime: Date | null; startedAt: number; finishedAt: number }
  | { ok: false; error: string };

/** Run the probe once and time it; both the ping and the clock check read this. */
export async function probeMongo(
  probe: MongoProbe,
  now: () => number = Date.now,
): Promise<MongoOutcome> {
  const startedAt = now();
  try {
    const { serverTime } = await probe();
    return { ok: true, serverTime, startedAt, finishedAt: now() };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

export function checkMongo(outcome: MongoOutcome): CheckResult {
  if (!outcome.ok) {
    return {
      name: "database",
      status: "fail",
      detail: `MongoDB did not answer a ping: ${outcome.error}`,
      fix: `check MONGODB_URI, and that the mongo service is healthy: ${COMPOSE} ps mongo`,
    };
  }
  return {
    name: "database",
    status: "pass",
    detail: `MongoDB answered a ping in ${outcome.finishedAt - outcome.startedAt} ms`,
  };
}

/** Skew at or above this is reported as a warning. */
export const CLOCK_SKEW_WARN_MS = 30_000;
/**
 * Skew at or above this fails. Five minutes is the usual tolerance of a
 * webhook receiver checking a signed timestamp, and of most token and
 * certificate validation; past it, things break for reasons nobody looks for
 * in a clock.
 */
export const CLOCK_SKEW_FAIL_MS = 5 * 60_000;

/**
 * The difference between this process's clock and the database server's.
 *
 * The database's time (`hello.localTime`) is compared with the midpoint of
 * the round trip, so latency does not count as skew. Containers share the
 * host's clock, so skew here means the host clock or a managed database's is
 * wrong — and the process clock is what stamps every entry, session expiry
 * and webhook signature.
 */
export function checkClockSkew(outcome: MongoOutcome): CheckResult {
  const name = "clock";
  if (!outcome.ok) {
    return {
      name,
      status: "warn",
      detail: "not checked: the database did not answer",
      fix: "fix the database check first",
    };
  }
  if (!outcome.serverTime) {
    return {
      name,
      status: "warn",
      detail: "not checked: the database did not report its time",
      fix: "compare `date -u` on this host with a trusted clock",
    };
  }
  const midpoint = (outcome.startedAt + outcome.finishedAt) / 2;
  const skew = Math.round(midpoint - outcome.serverTime.getTime());
  const detail = `this process is ${formatSkew(skew)} the database server`;
  if (Math.abs(skew) >= CLOCK_SKEW_FAIL_MS) {
    return {
      name,
      status: "fail",
      detail,
      fix: "turn on time synchronisation on this host (timedatectl set-ntp true) and on the database host",
    };
  }
  if (Math.abs(skew) >= CLOCK_SKEW_WARN_MS) {
    return {
      name,
      status: "warn",
      detail,
      fix: "turn on time synchronisation on this host (timedatectl set-ntp true)",
    };
  }
  return { name, status: "pass", detail };
}

function formatSkew(skewMs: number): string {
  const abs = Math.abs(skewMs);
  if (abs === 0) return "in step with";
  const amount = abs < 1000 ? `${abs} ms` : `${(abs / 1000).toFixed(1)} s`;
  return `${amount} ${skewMs > 0 ? "ahead of" : "behind"}`;
}

// ── Redis ─────────────────────────────────────────────────────────────────

/**
 * The server refuses to start when a configured Redis is unreachable, and
 * the self-host compose file configures one, so a configured-but-dead Redis
 * fails. An unset REDIS_URL only warns: that is a supported smaller stack,
 * which counts rate limits per process instead of sharing them.
 */
export async function checkRedis(
  redisUrl: string,
  ping: (url: string) => Promise<void>,
): Promise<CheckResult> {
  const name = "redis";
  if (!redisUrl.trim()) {
    return {
      name,
      status: "warn",
      detail: "REDIS_URL is not set, so rate limits are counted per process",
      fix: "set REDIS_URL; the self-host compose file uses redis://redis:6379",
    };
  }
  try {
    await ping(redisUrl);
    return { name, status: "pass", detail: "Redis answered PING" };
  } catch (error) {
    return {
      name,
      status: "fail",
      detail: `Redis did not answer PING: ${errorText(error)}`,
      fix: `check REDIS_URL, and that the redis service is healthy: ${COMPOSE} ps redis`,
    };
  }
}

// ── Mail ──────────────────────────────────────────────────────────────────

export type MailState = {
  /** `isEmailDeliveryConfigured()` from `services/email.ts`. */
  configured: boolean;
  /** `selectEmailTransport(env)`. */
  transport: string;
  /** `resolveFromAddress(env)`; empty when no sender is set. */
  fromAddress: string;
};

/**
 * Whether a transport is selected, and whether SMTP has a sender. The doctor
 * sends no mail: a test message to a real address is not a check an operator
 * asked for. `docs/self-hosting.md` → Email → "Verifying a send" covers that.
 */
export function checkMail(state: MailState): CheckResult {
  const name = "mail";
  if (!state.configured) {
    return {
      name,
      status: "warn",
      detail: "no mail transport; password-reset links are written to the server log",
      fix: "set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and EMAIL_FROM to send mail",
    };
  }
  if (state.transport === "smtp" && !state.fromAddress) {
    return {
      name,
      status: "fail",
      detail: "SMTP_HOST is set but EMAIL_FROM is empty, so every send is refused",
      fix: 'set EMAIL_FROM, e.g. EMAIL_FROM="Track Your Time <time@example.com>"',
    };
  }
  return { name, status: "pass", detail: `mail is sent through ${state.transport}` };
}

// ── URLs and origins ──────────────────────────────────────────────────────

export type UrlState = {
  /** `env.APP_URL`: trailing slashes removed, empty when unset. */
  appUrl: string;
  /** `env.FRONTEND_URL`, already defaulted from APP_URL. */
  frontendUrl: string;
  /** `env.BETTER_AUTH_URL`, already defaulted from APP_URL. */
  betterAuthUrl: string;
  /** `getTrustedOrigins()` from `config/env.ts`. */
  trustedOrigins: readonly string[];
  isProduction: boolean;
};

/**
 * The address people open the web app at: APP_URL when set (the
 * single-domain self-host shape), else FRONTEND_URL, which a deploy with the
 * API on its own host sets separately.
 */
export function appOrigin(state: UrlState): { url: string; origin: string | null } {
  const url = state.appUrl || state.frontendUrl;
  return { url, origin: originOf(url) };
}

/**
 * The web app's origin must be in the trusted list VERBATIM. better-auth and
 * the CORS layer compare the browser's `Origin` header as a string, so
 * `https://time.example.com/` in the list trusts nothing, and sign-in answers
 * `403 INVALID_ORIGIN`.
 */
export function checkTrustedOrigins(state: UrlState): CheckResult {
  const name = "trusted-origins";
  const app = appOrigin(state);
  if (!app.url) {
    return {
      name,
      status: "fail",
      detail: "neither APP_URL nor FRONTEND_URL is set, so no browser origin is trusted",
      fix: "set APP_URL to the address people open, e.g. APP_URL=https://time.example.com",
    };
  }
  if (!app.origin) {
    return {
      name,
      status: "fail",
      detail: `the app URL ${JSON.stringify(app.url)} is not a valid URL`,
      fix: "set APP_URL to a full URL with its scheme, e.g. https://time.example.com",
    };
  }

  if (!state.trustedOrigins.includes(app.origin)) {
    const lookalike = state.trustedOrigins.find((entry) => originOf(entry) === app.origin);
    return lookalike
      ? {
          name,
          status: "fail",
          detail: `the app origin ${app.origin} is listed only as ${JSON.stringify(lookalike)}, which never matches an Origin header`,
          fix: `spell it as a bare origin, with no path and no trailing slash: ${app.origin}`,
        }
      : {
          name,
          status: "fail",
          detail: `the app origin ${app.origin} is not trusted (trusted: ${formatList(state.trustedOrigins)})`,
          fix: `set APP_URL=${app.origin}, or add ${app.origin} to TRUSTED_ORIGINS`,
        };
  }

  const unmatchable = state.trustedOrigins.filter((entry) => originOf(entry) !== entry);
  if (unmatchable.length > 0) {
    return {
      name,
      status: "warn",
      detail: `${app.origin} is trusted, but ${formatList(unmatchable)} never matches an Origin header`,
      fix: "list origins only in TRUSTED_ORIGINS: scheme, host and port, lower case, no path, no trailing slash",
    };
  }
  return { name, status: "pass", detail: `${app.origin} is trusted` };
}

/**
 * BETTER_AUTH_URL is the base every auth link, redirect and cookie is issued
 * against. With APP_URL set the stack is single-origin, so a different auth
 * origin is a misconfiguration and fails; without APP_URL the API can
 * legitimately be on a host of its own, which only warns.
 */
export function checkAuthUrl(state: UrlState): CheckResult {
  const name = "auth-url";
  const raw = state.betterAuthUrl;
  if (!raw) {
    return {
      name,
      status: "fail",
      detail: "BETTER_AUTH_URL is not set, and neither is APP_URL",
      fix: "set APP_URL to the address people open, e.g. APP_URL=https://time.example.com",
    };
  }
  const url = parseUrl(raw);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return {
      name,
      status: "fail",
      detail: `BETTER_AUTH_URL ${JSON.stringify(raw)} is not a valid http(s) URL`,
      fix: "set it to a full URL with its scheme, or unset it and set APP_URL",
    };
  }

  const app = appOrigin(state);
  if (app.origin && url.origin !== app.origin) {
    const detail = `BETTER_AUTH_URL is on ${url.origin}, the web app on ${app.origin}`;
    return state.appUrl
      ? {
          name,
          status: "fail",
          detail,
          fix: "APP_URL means one origin for both: unset BETTER_AUTH_URL so it follows APP_URL",
        }
      : {
          name,
          status: "warn",
          detail: `${detail}; correct only when the API is served from a host of its own`,
          fix: "for a single-domain install, set APP_URL and unset BETTER_AUTH_URL and FRONTEND_URL",
        };
  }

  if (url.pathname !== "/" || url.search || url.hash) {
    return {
      name,
      status: "warn",
      detail: `BETTER_AUTH_URL ${JSON.stringify(raw)} is more than an origin; the server mounts auth at /api/auth itself`,
      fix: `set it to the origin alone: ${url.origin}`,
    };
  }
  if (state.isProduction && url.protocol === "http:" && !isLoopback(url.hostname)) {
    return {
      name,
      status: "warn",
      detail: `${url.origin} is plain http; browsers do not keep a secure session cookie on it`,
      fix: "serve the instance over https; the Caddy service does this for a real domain",
    };
  }
  return { name, status: "pass", detail: `${url.origin} is well-formed and is the app origin` };
}

// ── Schema and indexes ────────────────────────────────────────────────────

/** The fields of `MigrationStatus` the check reads. */
export type SchemaState = {
  schemaVersion: number;
  requiredReaderSchema: number;
  readable: boolean;
  raisedBy: { release: string } | null;
  pending: readonly { id: number }[];
};

export function checkSchema(outcome: { ok: true; state: SchemaState } | { ok: false; error: string }): CheckResult {
  const name = "schema";
  if (!outcome.ok) {
    return {
      name,
      status: "warn",
      detail: `not checked: ${outcome.error}`,
      fix: "fix the database check first",
    };
  }
  const { state } = outcome;
  if (!state.readable) {
    return {
      name,
      status: "fail",
      detail:
        `the database requires schema ${state.requiredReaderSchema}, written by ` +
        `${state.raisedBy?.release ? `v${state.raisedBy.release}` : "a newer release"}; this build reads up to ${state.schemaVersion}, and the server refuses to start`,
      fix: "upgrade to that release, or restore the mongodump taken before upgrading",
    };
  }
  if (state.pending.length > 0) {
    return {
      name,
      status: "warn",
      detail: `${state.pending.length} migration(s) pending (${state.pending.map((m) => m.id).join(", ")}); the server applies them at its next start`,
      fix: "take a mongodump, then restart the server or run: node dist/cli/admin.js migrate",
    };
  }
  return { name, status: "pass", detail: `schema ${state.schemaVersion}, no migrations pending` };
}

/** The fields of an index inspection the check reads (`db/indexes.ts`). */
export type IndexState = {
  model: string;
  keys: Record<string, unknown>;
  unique: boolean;
  critical: boolean;
  error: string | null;
};

export function checkIndexes(
  outcome: { ok: true; indexes: readonly IndexState[] } | { ok: false; error: string },
): CheckResult {
  const name = "indexes";
  if (!outcome.ok) {
    return { name, status: "warn", detail: `not checked: ${outcome.error}`, fix: "fix the database check first" };
  }
  const describe = (index: IndexState) =>
    `${index.model} ${JSON.stringify(index.keys)}${index.unique ? " (unique)" : ""}`;
  const missing = outcome.indexes.filter((index) => index.error !== null);
  const critical = missing.filter((index) => index.critical);
  if (critical.length > 0) {
    return {
      name,
      status: "fail",
      detail: `missing: ${critical.map(describe).join("; ")}; the invariant it enforces is not guaranteed`,
      fix: `restart the server and read its log: it builds each index and names the one that fails, usually over duplicate documents (${COMPOSE} logs server)`,
    };
  }
  if (missing.length > 0) {
    return {
      name,
      status: "warn",
      detail: `missing: ${missing.map(describe).join("; ")}`,
      fix: "restart the server, which builds missing indexes; its log says why one fails",
    };
  }
  return { name, status: "pass", detail: `all ${outcome.indexes.length} declared indexes exist` };
}

// ── Running and printing ──────────────────────────────────────────────────

export type DoctorInputs = {
  urls: UrlState;
  mail: MailState;
  redisUrl: string;
  mongo: MongoProbe;
  redisPing: (url: string) => Promise<void>;
  /** Stored migration state. Checked only when given and the database answers. */
  schema?: () => Promise<SchemaState>;
  /** Declared indexes and whether each exists. Same condition. */
  indexes?: () => Promise<readonly IndexState[]>;
  now?: () => number;
};

/** Every check, in the order they are printed. */
export async function runDoctor(inputs: DoctorInputs): Promise<CheckResult[]> {
  const mongo = await probeMongo(inputs.mongo, inputs.now);
  return [
    checkMongo(mongo),
    await checkRedis(inputs.redisUrl, inputs.redisPing),
    checkMail(inputs.mail),
    checkTrustedOrigins(inputs.urls),
    checkAuthUrl(inputs.urls),
    checkClockSkew(mongo),
    ...(inputs.schema ? [checkSchema(await settle(mongo, inputs.schema, (state) => ({ ok: true as const, state })))] : []),
    ...(inputs.indexes
      ? [checkIndexes(await settle(mongo, inputs.indexes, (indexes) => ({ ok: true as const, indexes })))]
      : []),
  ];
}

async function settle<T, R>(
  mongo: MongoOutcome,
  read: () => Promise<T>,
  wrap: (value: T) => R,
): Promise<R | { ok: false; error: string }> {
  if (!mongo.ok) return { ok: false, error: "the database did not answer" };
  try {
    return wrap(await read());
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

/** Non-zero when any check failed. A warning alone never fails the run. */
export function doctorExitCode(results: readonly CheckResult[]): number {
  return results.some((result) => result.status === "fail") ? 1 : 0;
}

export function formatDoctorReport(results: readonly CheckResult[]): string {
  const width = Math.max(0, ...results.map((result) => result.name.length));
  const lines: string[] = [];
  for (const result of results) {
    lines.push(`${result.status.toUpperCase().padEnd(4)}  ${result.name.padEnd(width)}  ${result.detail}`);
    if (result.fix) lines.push(`${" ".repeat(width + 6)}  fix: ${result.fix}`);
  }
  const fails = results.filter((result) => result.status === "fail").length;
  const warns = results.filter((result) => result.status === "warn").length;
  lines.push("");
  lines.push(
    fails === 0 && warns === 0
      ? "All checks passed."
      : `${fails} failed, ${warns} warned, ${results.length - fails - warns} passed.`,
  );
  return lines.join("\n") + "\n";
}

// ── helpers ───────────────────────────────────────────────────────────────

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Scheme, host and port of a URL, or null when it does not parse. Native
 * shells trust non-web schemes (`capacitor://localhost`), which `URL` gives an
 * opaque "null" origin, so those are rebuilt from scheme and host. A value is
 * a matchable trusted-origin entry exactly when this returns it unchanged.
 */
function originOf(value: string): string | null {
  const url = parseUrl(value);
  if (!url) return null;
  if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
  return url.host ? `${url.protocol}//${url.host}` : null;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function formatList(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.map((value) => JSON.stringify(value)).join(", ");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
