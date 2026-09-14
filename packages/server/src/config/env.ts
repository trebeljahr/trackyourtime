import { config as dotenvxConfig } from "@dotenvx/dotenvx";
import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { STORE_APP_ORIGINS } from "@starter/shared";

// dotenvx handles encrypted .env files transparently. It looks for
// `DOTENV_PRIVATE_KEY_*` either in the process env (Coolify / CI set
// it there) or in a local .env.keys file (dev workstation).
//
// Load order mirrors conventional dotenv behavior:
//   - production: only .env.production (untracked here — a local convenience
//                 for `NODE_ENV=production ... start`. The deployed server
//                 has no such file; Coolify supplies env directly.)
//   - otherwise:  .env.development (plaintext, local-dev defaults)
// Any plaintext values in a production file stay plaintext — dotenvx
// only decrypts values whose cipher prefix starts with "encrypted:".
const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(__dirname, "../..");
const envFile =
  process.env.NODE_ENV === "production" ? ".env.production" : ".env.development";
const envPath = resolve(serverRoot, envFile);
if (existsSync(envPath)) {
  dotenvxConfig({ path: envPath });
}

/** `version` from this package's package.json, or "" when it cannot be read. */
function readRelease(): string {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(resolve(serverRoot, "package.json"), "utf8"),
    );
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" ? version : "";
  } catch {
    return "";
  }
}

function getRequired(key: string): string {
  const value = process.env[key];
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value ?? "";
}

function getOptional(key: string, defaultValue = ""): string {
  return process.env[key] ?? defaultValue;
}

export interface AppUrlSource {
  appUrl: string;
  frontendUrl: string;
  betterAuthUrl: string;
}

export interface ResolvedAppUrls {
  frontendUrl: string;
  betterAuthUrl: string;
}

/**
 * One URL instead of two, for the single-domain deployment.
 *
 * The hosted deploy is a split — the web app on one host, the API on another —
 * so there FRONTEND_URL and BETTER_AUTH_URL are genuinely two different values.
 * Both stay authoritative whenever they are set, which is what keeps that
 * deploy working untouched. A self-host instead runs everything behind one
 * reverse proxy on ONE domain (/api and /ws proxied to this server), where the
 * two are necessarily the same string and asking for it twice is only a way to
 * get it wrong once. APP_URL supplies both.
 *
 * BETTER_AUTH_URL is the API's own base ORIGIN, not the auth mount point:
 * auth/auth.ts passes it straight to betterAuth({ baseURL }), and better-auth
 * appends its own basePath (/api/auth) to it. Under a single domain the API
 * answers at APP_URL/api/*, so APP_URL is exactly right — and must NOT carry
 * an /api/auth suffix, which would produce /api/auth/api/auth/... routes.
 *
 * The trailing slash is stripped from the derived values because both are
 * concatenated with a leading-slash path downstream, and FRONTEND_URL is
 * additionally compared against a browser Origin header, which never carries
 * one. Explicitly-set values are passed through verbatim — normalising them
 * would change behaviour for a deploy that is already working.
 *
 * Throws in production when a value has neither source, the same contract
 * getRequired() gives the other required variables. The message names both
 * ways of supplying it, or a self-hoster who set neither goes looking for the
 * wrong knob.
 */
export function resolveAppUrls(
  source: AppUrlSource,
  nodeEnv: string,
): ResolvedAppUrls {
  const appUrl = source.appUrl.trim().replace(/\/+$/, "");
  const resolved = {
    betterAuthUrl: source.betterAuthUrl || appUrl,
    frontendUrl: source.frontendUrl || appUrl,
  };
  const missing = !resolved.betterAuthUrl
    ? "BETTER_AUTH_URL"
    : !resolved.frontendUrl
      ? "FRONTEND_URL"
      : "";
  if (missing && nodeEnv === "production") {
    throw new Error(
      `Missing required environment variable: ${missing} (or set APP_URL)`,
    );
  }
  return resolved;
}

const appUrls = resolveAppUrls(
  {
    appUrl: getOptional("APP_URL"),
    frontendUrl: getOptional("FRONTEND_URL"),
    betterAuthUrl: getOptional("BETTER_AUTH_URL"),
  },
  getOptional("NODE_ENV", "development"),
);

/**
 * A positive integer, or the default — never NaN.
 *
 * `parseInt` answers NaN for an empty string and happily answers 600 for
 * "600/min", and every comparison against NaN is false. A NaN rate limit
 * therefore refuses the FIRST request of every window (`count <= NaN` is
 * false) and advertises `RateLimit-Limit: NaN`, so one stray character typed
 * into a hosting panel's env editor takes the entire public API down while
 * looking like a limiter working as designed. `Number` rather than `parseInt`
 * so a trailing-garbage value is rejected outright instead of silently read as
 * its numeric prefix, which is the other half of the same surprise.
 *
 * A value that was PRESENT but unusable is warned about rather than swallowed:
 * falling back silently would express the typo as "the limit is mysteriously
 * 600 again", which nobody traces back to the env var.
 */
function getPositiveInt(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return defaultValue;

  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `[env] ${key}=${JSON.stringify(raw)} is not a positive integer — using ${defaultValue}.`,
    );
    return defaultValue;
  }
  return parsed;
}

/**
 * A non-negative integer, or the default — never NaN.
 *
 * The same parse as {@link getPositiveInt} and for the same reason, except
 * that ZERO is a meaningful value here rather than a typo: `TRUST_PROXY_HOPS=0`
 * is how a directly-exposed container says "believe the socket, never an
 * `X-Forwarded-For` header". Rejecting it would pin that deployment to a hop
 * count it does not have, which is the misconfiguration the variable exists to
 * let an operator fix.
 */
function getNonNegativeInt(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return defaultValue;

  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.warn(
      `[env] ${key}=${JSON.stringify(raw)} is not a non-negative integer — using ${defaultValue}.`,
    );
    return defaultValue;
  }
  return parsed;
}

/** On unless the value explicitly says off. */
export function parseBooleanDefaultOn(raw: string): boolean {
  return !["false", "0", "no", "off"].includes(raw.trim().toLowerCase());
}

export const env = {
  NODE_ENV: getOptional("NODE_ENV", "development"),
  PORT: getPositiveInt("PORT", 5000),

  // How many reverse proxies sit in front of this process, for Express's
  // `trust proxy`. Express then reads `req.ip` as the (n+1)-th address from
  // the RIGHT of `X-Forwarded-For`, so the number has to match the deployment:
  //   too high — a directly-exposed container believes a header the caller
  //     wrote, so anyone picks their own `req.ip` per request and the public
  //     API's failed-authentication meter, which is keyed on it, never
  //     accumulates at all;
  //   too low — with a CDN in front of a reverse proxy, every caller collapses
  //     onto the edge's address and shares one key.
  // 1 is the safe generic default, NOT the right value for the deployed
  // topology: that has two hops — Cloudflare in front of Coolify's reverse
  // proxy (caddy-docker-proxy) — so it needs TRUST_PROXY_HOPS=2, set on the
  // deployment. See docs/deploy.md. 0 means "no proxy, believe the socket".
  TRUST_PROXY_HOPS: getNonNegativeInt("TRUST_PROXY_HOPS", 1),
  MONGODB_URI: getRequired("MONGODB_URI"),
  REDIS_URL: getOptional("REDIS_URL"),

  // Auth
  BETTER_AUTH_SECRET: getRequired("BETTER_AUTH_SECRET"),
  // The single-domain shortcut: set APP_URL alone and both of the next two
  // derive from it. See resolveAppUrls() above for why that is safe and for
  // what APP_URL must (and must not) contain.
  APP_URL: getOptional("APP_URL").trim().replace(/\/+$/, ""),
  BETTER_AUTH_URL: appUrls.betterAuthUrl,
  FRONTEND_URL: appUrls.frontendUrl,
  // Additional CORS / auth origins, comma-separated. Use this for
  // native clients:
  //   capacitor://localhost,https://localhost   (Capacitor iOS+Android)
  //   app://-                                    (custom Electron protocol)
  // Electron file:// sends Origin: null, which can't be allowed with
  // credentials:true — register a custom protocol in the main process
  // and list it here instead.
  TRUSTED_ORIGINS: getOptional("TRUSTED_ORIGINS"),
  // Trust the store-distributed clients — the iOS and Android apps
  // (capacitor://localhost, https://localhost) and the Chrome Web Store
  // extension, whose id is pinned in @starter/shared's store-clients.ts. Those
  // builds let a person choose any server, so a self-hosted server has to
  // accept them without anyone editing TRUSTED_ORIGINS; the self-host compose
  // file defaults this to true. Off unless set, so the hosted deploy's trust
  // list stays exactly what its Coolify env fields say.
  TRUST_STORE_APPS: getOptional("TRUST_STORE_APPS").trim().toLowerCase() === "true",

  // The git commit this image was built from, baked in as a Docker build arg
  // (see packages/server/Dockerfile). Reported by /api/health so "is the
  // deployed thing the thing I built?" is one HTTP request rather than an
  // archaeology session. Empty outside a CI image build, which is correct —
  // a local `pnpm dev` has no commit it was built from.
  COMMIT_SHA: getOptional("COMMIT_SHA"),
  // The release this server is, from packages/server/package.json — which the
  // image carries (see the Dockerfile's runtime stage). Reported by
  // /api/health so a client choosing a server can say what it found there.
  RELEASE: readRelease(),
  GOOGLE_CLIENT_ID: getOptional("GOOGLE_CLIENT_ID"),
  GOOGLE_CLIENT_SECRET: getOptional("GOOGLE_CLIENT_SECRET"),

  // Stripe
  // Hatchkit provisions one set per environment:
  //   .env.development → sandbox keys (STRIPE_MODE=test)
  //   .env.production  → live keys    (STRIPE_MODE=live, dotenvx-encrypted)
  // Each project gets its own pair (paste once at `hatchkit create` /
  // `hatchkit adopt`); STRIPE_WEBHOOK_SECRET is auto-minted by hatchkit.
  STRIPE_MODE: getOptional("STRIPE_MODE"),
  STRIPE_SECRET_KEY: getOptional("STRIPE_SECRET_KEY"),
  STRIPE_PUBLISHABLE_KEY: getOptional("STRIPE_PUBLISHABLE_KEY"),
  STRIPE_WEBHOOK_SECRET: getOptional("STRIPE_WEBHOOK_SECRET"),

  // Email — plain SMTP. The default transport, and the only one a self-host
  // needs: any mailbox provider or relay works. SMTP_HOST alone selects it
  // (see selectEmailTransport in services/email.ts); the rest are refinements.
  // SMTP_USER/SMTP_PASSWORD are optional because an unauthenticated relay on
  // a private network is a legitimate setup — omit both and no AUTH is
  // attempted, rather than offering empty credentials and being rejected.
  SMTP_HOST: getOptional("SMTP_HOST"),
  SMTP_PORT: getOptional("SMTP_PORT", "587"),
  SMTP_USER: getOptional("SMTP_USER"),
  SMTP_PASSWORD: getOptional("SMTP_PASSWORD"),
  // Implicit TLS from the first byte (port 465) rather than STARTTLS on a
  // plaintext connection (ports 587/25). Left unset it follows the port, which
  // is right for every provider I know of; set it explicitly for the odd relay
  // that puts implicit TLS somewhere else.
  SMTP_SECURE: getOptional("SMTP_SECURE"),
  // Envelope + header From for SMTP sends. Required with SMTP because relays
  // reject a message with no sender, and most only accept a domain they have
  // been configured to send for — there is no default worth guessing.
  EMAIL_FROM: getOptional("EMAIL_FROM"),

  // Email — Listmonk + SES. Listmonk owns the API surface (tx + campaigns
  // + subscriber management); SES is the SMTP relay it sends through.
  // `hatchkit add <project> listmonk-ses` provisions the SES identity +
  // Listmonk lists/templates and writes these values.
  LISTMONK_URL: getOptional("LISTMONK_URL"),
  LISTMONK_API_USER: getOptional("LISTMONK_API_USER"),
  LISTMONK_API_TOKEN: getOptional("LISTMONK_API_TOKEN"),
  LISTMONK_FROM_EMAIL: getOptional("LISTMONK_FROM_EMAIL"),
  LISTMONK_FROM: getOptional("LISTMONK_FROM"),
  LISTMONK_LIVE_LIST_ID: getOptional("LISTMONK_LIVE_LIST_ID"),
  LISTMONK_TEST_LIST_ID: getOptional("LISTMONK_TEST_LIST_ID"),
  LISTMONK_TX_TEMPLATE_ID: getOptional("LISTMONK_TX_TEMPLATE_ID"),
  LISTMONK_CAMPAIGN_TEMPLATE_ID: getOptional("LISTMONK_CAMPAIGN_TEMPLATE_ID"),
  // Pre-filled into .env.development by `hatchkit add <project>
  // listmonk-ses` when a global default forwarding email is configured.
  // The bundled `pnpm newsletter:test-tx` / `newsletter:welcome` /
  // `newsletter:verify` scripts default to this address so a fresh
  // provision is one command away from a real send in your own inbox.
  LISTMONK_TEST_RECIPIENT: getOptional("LISTMONK_TEST_RECIPIENT"),

  // S3
  S3_ENDPOINT: getOptional("S3_ENDPOINT"),
  S3_BUCKET_NAME: getOptional("S3_BUCKET_NAME", "tracktime-assets"),
  S3_PUBLIC_URL: getOptional("S3_PUBLIC_URL"),
  S3_FORCE_PATH_STYLE: getOptional("S3_FORCE_PATH_STYLE") === "true",
  AWS_REGION: getOptional("AWS_REGION", "us-east-1"),
  AWS_ACCESS_KEY_ID: getOptional("AWS_ACCESS_KEY_ID"),
  AWS_SECRET_ACCESS_KEY: getOptional("AWS_SECRET_ACCESS_KEY"),

  // ML services (Modal/RunPod endpoints)
  ML_BACKGROUND_REMOVAL_ENDPOINT: getOptional("ML_BACKGROUND_REMOVAL_ENDPOINT"),
  ML_SUBTITLES_ENDPOINT: getOptional("ML_SUBTITLES_ENDPOINT"),
  ML_IMAGE_RECOGNITION_ENDPOINT: getOptional("ML_IMAGE_RECOGNITION_ENDPOINT"),
  ML_3D_EXTRACTION_ENDPOINT: getOptional("ML_3D_EXTRACTION_ENDPOINT"),
  ML_3D_SAM_OBJECTS_ENDPOINT: getOptional("ML_3D_SAM_OBJECTS_ENDPOINT"),
  ML_3D_SAM_BODY_ENDPOINT: getOptional("ML_3D_SAM_BODY_ENDPOINT"),
  ML_3D_HUNYUAN_ENDPOINT: getOptional("ML_3D_HUNYUAN_ENDPOINT"),
  ML_3D_TRELLIS_ENDPOINT: getOptional("ML_3D_TRELLIS_ENDPOINT"),

  // Public REST API
  // Fixed-window rate limit per API token, per minute. Fixed window rather
  // than a token bucket because it is INCR + EXPIRE — two commands, no Lua,
  // no stored clock. Without Redis it degrades to per-process, which is the
  // documented caveat for a single-container self-host.
  // Validated, not parsed: an unusable value here would 429 every caller.
  API_RATE_LIMIT_PER_MINUTE: getPositiveInt("API_RATE_LIMIT_PER_MINUTE", 600),

  // Webhooks
  // Opt-in for delivering to private/loopback addresses and over plain http.
  // OFF by default because a webhook URL is attacker-controlled input: with
  // this on, anyone who can create a subscription can make this server issue
  // requests into its own network (SSRF). Turn it on only to point a local
  // listener at a dev server.
  WEBHOOK_ALLOW_PRIVATE_TARGETS:
    getOptional("WEBHOOK_ALLOW_PRIVATE_TARGETS") === "true",

  // Background jobs
  // The in-process scheduler (services/scheduler/). On unless set to
  // false/0/no/off. Safe with several server processes on one database: a job
  // row is leased, so each interval runs once across all of them. Turning it
  // off leaves the runaway guard to its lazy on-read evaluation and sends no
  // reminder emails.
  SCHEDULER_ENABLED: parseBooleanDefaultOn(getOptional("SCHEDULER_ENABLED")),

  // Monitoring
  SENTRY_DSN: getOptional("SENTRY_DSN"),

  isProduction: getOptional("NODE_ENV") === "production",
  isTest: getOptional("NODE_ENV") === "test",
} as const;

/**
 * In development the same dev server is reachable as both http://localhost:PORT
 * and http://127.0.0.1:PORT, and the browser treats those as different origins.
 * Whichever one FRONTEND_URL names, requests from the other are rejected by CORS
 * with "No 'Access-Control-Allow-Origin' header is present". Trust both spellings
 * so it does not matter which one the developer happens to open.
 *
 * NOTE: this only fixes CORS. localhost and 127.0.0.1 are also cross-SITE, so a
 * SameSite=Lax session cookie set on one is not sent to the other — the client
 * and the API must still agree on one host for auth to work. scripts/dev.mjs
 * points both at localhost.
 *
 * Not applied in production, where the trusted origin list must stay exact.
 */
function withLocalhostAliases(origins: string[]): string[] {
  const aliased = origins.flatMap((origin) => {
    if (origin.includes("//localhost")) {
      return [origin, origin.replace("//localhost", "//127.0.0.1")];
    }
    if (origin.includes("//127.0.0.1")) {
      return [origin, origin.replace("//127.0.0.1", "//localhost")];
    }
    return [origin];
  });
  return [...new Set(aliased)];
}

export interface TrustedOriginSource {
  frontendUrl: string;
  /** The raw TRUSTED_ORIGINS csv. */
  trustedOrigins: string;
  trustStoreApps: boolean;
  isProduction: boolean;
}

/**
 * The trusted-origin rule, as a pure function of its inputs so the
 * TRUST_STORE_APPS switch can be asserted without rebooting the env module.
 * FRONTEND_URL leads, the csv follows, and the store clients come last; a
 * duplicate (someone who listed capacitor://localhost by hand AND turned the
 * switch on) is kept once.
 */
export function buildTrustedOrigins(source: TrustedOriginSource): string[] {
  const extras = source.trustedOrigins
    ? source.trustedOrigins.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const listed = source.frontendUrl ? [source.frontendUrl, ...extras] : extras;
  const origins = [
    ...new Set(
      source.trustStoreApps ? [...listed, ...STORE_APP_ORIGINS] : listed,
    ),
  ];
  return source.isProduction ? origins : withLocalhostAliases(origins);
}

/** All origins trusted for CORS + better-auth. Merges FRONTEND_URL with
 *  the optional TRUSTED_ORIGINS CSV so native shells (Capacitor, custom
 *  Electron protocols) can authenticate against the same API, plus the store
 *  clients when TRUST_STORE_APPS is on. */
export function getTrustedOrigins(): string[] {
  return buildTrustedOrigins({
    frontendUrl: env.FRONTEND_URL,
    trustedOrigins: env.TRUSTED_ORIGINS,
    trustStoreApps: env.TRUST_STORE_APPS,
    isProduction: env.isProduction,
  });
}
