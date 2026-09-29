/**
 * The hosted deploy, its health gate and its rollback — the logic
 * `scripts/coolify-deploy.mjs` runs from `.github/workflows/build-and-deploy.yml`
 * (every push to main) and `.github/workflows/hosted-rollback.yml` (by hand).
 *
 * Everything that touches the network, git or the clock is injected, so the
 * whole sequence — promote, deploy, poll, gate, restore — is driven by
 * `coolify-deploy.test.mjs` against a fake registry and a fake Coolify
 * without a network.
 *
 * There is no Coolify API token anywhere in it. Coolify cannot scope a token
 * below "every app in the team", and on this one-server install `write` is
 * root on the host. So:
 *
 * - The image is chosen in the REGISTRY. Both apps pull `<image>:live`
 *   (SERVER_IMAGE / CLIENT_IMAGE in Coolify), and a deploy of commit X points
 *   `:live` at the manifest `:X` names, with the job's own GITHUB_TOKEN —
 *   which can write this repository's packages and nothing else.
 * - The deploy is queued through each app's own signed webhook: a GitHub
 *   `push` payload, HMAC-signed with that app's secret, sent to Coolify's
 *   manual webhook endpoint. It queues a deploy of that one app and can read
 *   or change nothing. The payload names `.hatchkit/deploy-webhook`, the
 *   apps' only watch path, so no ordinary push deploys through Coolify's
 *   GitHub App before its image exists.
 *
 * `hatchkit secrets isolate` sets up both halves: the webhook secrets, watch
 * paths and GitHub secrets, and `:live` with the image variables pointing
 * at it.
 *
 * docs/deploy.md → "Rollback" is the same thing in words.
 */
import { createHash, createHmac } from "node:crypto";

import { breakingMigrations } from "./release-policy.mjs";

/** The two Coolify apps, in the order they are deployed. */
export const APPS = Object.freeze(["server", "client"]);

/** The moving tag both apps pull. Only a deploy moves it. */
export const LIVE_TAG = "live";

/** Coolify's manual GitHub webhook, relative to its base URL. */
export const WEBHOOK_PATH = "/webhooks/source/github/events/manual";

/**
 * The one path a deploy payload names as modified. Each app's `watch_paths`
 * is exactly this and no commit ever creates it, so a push that reaches
 * Coolify through its GitHub App matches no watch path and deploys nothing.
 */
export const WATCH_PATH = ".hatchkit/deploy-webhook";

const FULL_SHA = /^[0-9a-f]{40}$/;

export const isFullSha = (value) => typeof value === "string" && FULL_SHA.test(value);

/** `ghcr.io/<owner/repo>-<app>` — the image, without a tag. */
export const imageBase = (ownerRepo, app) => `ghcr.io/${ownerRepo}-${app}`;

/** `ghcr.io/<owner/repo>-<app>:<sha>` — the immutable tag build-and-deploy pushes. */
export const imageRef = (ownerRepo, app, sha) => `${imageBase(ownerRepo, app)}:${sha}`;

/**
 * The commit an image reference is pinned to, or null.
 *
 * Only a full sha counts: `:main` and `:live` are moving tags, and a moving
 * tag names no particular build to go back to.
 */
export const shaFromImage = (value) => {
  if (typeof value !== "string") return null;
  const tag = value.slice(value.lastIndexOf(":") + 1);
  return isFullSha(tag) ? tag : null;
};

/** `both` → both apps, `client` / `server` → that one. Anything else throws. */
export const parseWhich = (which) => {
  if (which === undefined || which === "" || which === "both") return [...APPS];
  if (which === "client" || which === "server") return [which];
  throw new Error(`--which must be client, server or both, not "${which}"`);
};

const messageOf = (caught) => (caught instanceof Error ? caught.message : String(caught));

// ── Checks ───────────────────────────────────────────────────────────────

/**
 * The problems of an app that gave no JSON body — a 502 from the proxy while
 * the container swaps, a connection refused, a timeout.
 *
 * No body is no commit either. While a commit is expected, that is reported
 * as the commit check failing (`api-commit` / `web-commit`), which is what
 * `commitProblems` and so the ten-minute poll wait on. Reported as the
 * `api-health` / `web-version` check alone, the poll would take the first
 * silent look as "landed" and hand a server it never heard from to the gate,
 * which gives up after a few short retries.
 */
const noAnswerProblems = (prefix, path, expectedSha) => [
  ...(expectedSha === null ? [] : [`${prefix}-commit: ${path} gave no answer, expected ${expectedSha}`]),
  `${prefix}-${prefix === "api" ? "health" : "version"}: no JSON answer from ${path}`,
];

/**
 * `commit` is the field's name; `version` is the same commit under the name
 * older images report it as (app.ts), which a rollback target may be.
 */
const healthCommit = (body) => body.commit ?? body.version;

/**
 * Problems with an `/api/health` answer, as named checks. `expectedSha` null
 * skips the commit comparison (the server was not part of this deploy).
 */
export const healthProblems = (body, expectedSha) => {
  if (!body || typeof body !== "object") return noAnswerProblems("api", "/api/health", expectedSha);
  const problems = [];
  const commit = healthCommit(body);
  if (expectedSha !== null && commit !== expectedSha) {
    problems.push(`api-commit: /api/health reports ${String(commit || "<none>")}, expected ${expectedSha}`);
  }
  if (body.status !== "ok") problems.push(`api-status: /api/health status is ${String(body.status)}, expected ok`);
  if (body.db !== true) problems.push(`api-db: /api/health db is ${String(body.db)}, expected true`);
  return problems;
};

/**
 * Problems with the client's `/version.json`. The client bakes its API origin
 * in at build time, so the right commit can still carry the wrong URL.
 */
export const versionJsonProblems = (body, expectedSha, apiUrl) => {
  if (!body || typeof body !== "object") return noAnswerProblems("web", "/version.json", expectedSha);
  const problems = [];
  if (expectedSha !== null && body.commit !== expectedSha) {
    problems.push(`web-commit: /version.json reports ${String(body.commit || "<none>")}, expected ${expectedSha}`);
  }
  if (body.apiUrl !== apiUrl) {
    problems.push(`web-api-url: the client was built against ${String(body.apiUrl || "<none>")}, expected ${apiUrl}`);
  }
  return problems;
};

/**
 * Everything the gate looked at, turned into named problems. Empty means the
 * pair that is now live works.
 *
 * - `/api/health`: the expected commit, `status: ok`, `db: true`.
 * - `/version.json`: the expected commit, and the API it was built against.
 * - `GET /api/auth/get-session` answers 200 (`null` without a cookie): the
 *   auth handler is mounted and its database reads work, which `db: true`
 *   alone does not prove.
 * - The CORS preflight from the web origin: the two apps are separate origins,
 *   and nothing else in CI exercises that pairing.
 */
export const gateProblems = (observed, expected) => [
  ...healthProblems(observed.health, expected.serverSha),
  ...versionJsonProblems(observed.version, expected.clientSha, expected.apiUrl),
  ...(observed.sessionStatus === 200
    ? []
    : [`auth-session: GET /api/auth/get-session answered ${observed.sessionStatus ?? "nothing"}, expected 200`]),
  ...(observed.corsAllowOrigin === expected.webUrl
    ? []
    : [
        `cors: the preflight from ${expected.webUrl} was answered with Access-Control-Allow-Origin ${observed.corsAllowOrigin ?? "<none>"}`,
      ]),
];

/**
 * Only the commit checks: what "the deploy landed" means, before the gate.
 * An app that answered nothing fails its commit check too (`noAnswerProblems`),
 * so "landed" always means a body that named the sha.
 */
export const commitProblems = (problems) =>
  problems.filter((problem) => problem.startsWith("api-commit:") || problem.startsWith("web-commit:"));

/** The check name of a problem line: `api-db: …` → `api-db`. */
export const checkName = (problem) => problem.slice(0, problem.indexOf(":"));

// ── Migrations ───────────────────────────────────────────────────────────

/**
 * Why a server built from `olderSha` cannot start on the database a server
 * built from `newerSha` has run, or null when it can.
 *
 * Migrations are forward-only (docs/versioning.md → Migrations): a migration
 * whose `minReaderSchema` is above an older build's `SCHEMA_VERSION` makes that
 * build refuse to start. Nobody can tell from outside whether the new server
 * got far enough to run it, so a registry that CONTAINS such a migration is
 * treated as having run it. An unreadable registry (a sha missing from the
 * checkout, a file the parser does not recognise) is a reason too: the
 * question is whether it is safe, and "unknown" is not "yes".
 *
 * @param {(sha: string) => { migrations: object[], schemaVersion: number }} contractAt  release-policy's readMigrationContract at a sha; throws when it cannot
 */
export const serverDowngradeBlock = (contractAt, olderSha, newerSha) => {
  let older;
  let newer;
  try {
    older = contractAt(olderSha);
    newer = contractAt(newerSha);
  } catch (caught) {
    return `the migration registries of ${olderSha} and ${newerSha} could not be compared (${messageOf(caught)})`;
  }
  const breaking = breakingMigrations(older, newer);
  if (breaking.length === 0) return null;
  const list = breaking.map((m) => `${m.id} (${m.file}, minReaderSchema ${m.minReaderSchema})`).join(", ");
  return `${newerSha} carries migration ${list}, above the SCHEMA_VERSION ${older.schemaVersion} of ${olderSha}, which would refuse to start on that database`;
};

// ── The gate, over the network ───────────────────────────────────────────

/**
 * @typedef {object} DeployDeps
 * @property {(url: string, init?: object) => Promise<{ status: number, ok: boolean, headers: { get(name: string): string | null }, text(): Promise<string> }>} fetch
 * @property {(ms: number) => Promise<void>} sleep
 * @property {(line: string) => void} log
 * @property {(sha: string) => { migrations: object[], schemaVersion: number }} contractAt  readMigrationContract at a sha
 */

/**
 * One app's signed deploy webhook. `secret` is the only secret in here and is
 * never logged; `repository` and `branch` must match what Coolify stored for
 * the app, since the endpoint picks candidate apps by them.
 *
 * @typedef {object} DeployHook
 * @property {string} uuid
 * @property {string} secret
 * @property {string} repository  `owner/repo`
 * @property {string} branch
 */

/**
 * @typedef {object} DeployConfig
 * @property {string} coolifyBaseUrl
 * @property {Partial<Record<"server" | "client", DeployHook>>} hooks  one per app this run moves
 * @property {{ username: string, password: string }} registryAuth  GITHUB_ACTOR + GITHUB_TOKEN
 * @property {string} ownerRepo
 * @property {string} webUrl
 * @property {string} apiUrl
 * @property {number} [pollAttempts]     commit polls per app before giving up
 * @property {number} [pollIntervalMs]
 * @property {number} [gateAttempts]     gate retries once the commits match
 * @property {number} [gateIntervalMs]
 */

const bust = (url, attempt) => `${url}${url.includes("?") ? "&" : "?"}cb=${Date.now()}${attempt}`;

const readJson = async (deps, url, attempt) => {
  try {
    const response = await deps.fetch(bust(url, attempt), { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    return JSON.parse(await response.text());
  } catch {
    return null;
  }
};

/** One look at everything the gate checks. Never throws: a failure is a value. */
export const observe = async (deps, config, attempt = 0) => {
  const [health, version, sessionStatus, corsAllowOrigin] = await Promise.all([
    readJson(deps, `${config.apiUrl}/api/health`, attempt),
    readJson(deps, `${config.webUrl}/version.json`, attempt),
    deps
      .fetch(bust(`${config.apiUrl}/api/auth/get-session`, attempt), { signal: AbortSignal.timeout(10_000) })
      .then((response) => response.status)
      .catch(() => null),
    deps
      .fetch(`${config.apiUrl}/api/auth/get-session`, {
        method: "OPTIONS",
        headers: {
          Origin: config.webUrl,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
        signal: AbortSignal.timeout(10_000),
      })
      .then((response) => response.headers.get("access-control-allow-origin"))
      .catch(() => null),
  ]);
  return { health, version, sessionStatus, corsAllowOrigin };
};

/**
 * Wait for the expected commits, then for the gate to pass.
 *
 * Two phases because they fail differently. A deploy is asynchronous — the
 * webhook answers when it is QUEUED — so the commits are polled for minutes.
 * Once they match, the gate gets a few short retries for a database that is
 * still connecting, and no more: a server that is up on the right commit and
 * still cannot reach its database is the failure being gated on.
 *
 * @returns {Promise<string[]>} the problems of the last look; empty is a pass
 */
export const waitForHealthy = async (deps, config, expected) => {
  const pollAttempts = config.pollAttempts ?? 40;
  const pollIntervalMs = config.pollIntervalMs ?? 15_000;
  const gateAttempts = config.gateAttempts ?? 6;
  const gateIntervalMs = config.gateIntervalMs ?? 10_000;
  const full = { ...expected, apiUrl: config.apiUrl, webUrl: config.webUrl };

  let problems = [];
  for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
    problems = gateProblems(await observe(deps, config, attempt), full);
    const waiting = commitProblems(problems);
    if (waiting.length === 0) break;
    deps.log(`  waiting (${attempt}/${pollAttempts}): ${waiting.join("; ")}`);
    if (attempt === pollAttempts) return problems;
    await deps.sleep(pollIntervalMs);
  }
  // Reached only with no commit problem left, and an app that answered
  // nothing has one while its sha is expected: each line below is a body
  // that named the sha, never a look that got no answer.
  for (const [app, sha] of [
    ["server", expected.serverSha],
    ["client", expected.clientSha],
  ]) {
    if (sha !== null) deps.log(`✓ ${app} reports ${sha}`);
  }

  for (let attempt = 1; ; attempt += 1) {
    if (problems.length === 0) {
      deps.log("✓ gate: api status ok, db up, client API URL, get-session 200, CORS");
      return [];
    }
    if (attempt >= gateAttempts) return problems;
    deps.log(`  gate (${attempt}/${gateAttempts}): ${problems.join("; ")}`);
    await deps.sleep(gateIntervalMs);
    problems = gateProblems(await observe(deps, config, pollAttempts + attempt), full);
  }
};

// ── The registry ─────────────────────────────────────────────────────────
//
// Moving `:live` is two calls of the OCI distribution API: read the manifest
// `:<sha>` names, write the same bytes under `:live`. The bytes are copied
// verbatim — a manifest's digest is the sha256 of its exact bytes, and a
// re-serialised body would name an image that does not exist.

const REGISTRY_TIMEOUT_MS = 30_000;

/** Every manifest shape a multi-arch build or a plain build can push. */
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const splitImage = (base) => {
  const slash = base.indexOf("/");
  return { host: base.slice(0, slash), repository: base.slice(slash + 1).toLowerCase() };
};

const bearerChallenge = (header) => {
  if (!header || !/^Bearer\s/i.test(header)) return null;
  const params = {};
  for (const match of header.matchAll(/(\w+)="([^"]*)"/g)) params[match[1].toLowerCase()] = match[2];
  return params.realm ? params : null;
};

const registryTokens = new WeakMap();

/** A pull+push token for one repository, fetched once per config. */
const registryToken = async (deps, config, name) => {
  let cache = registryTokens.get(config);
  if (!cache) {
    cache = new Map();
    registryTokens.set(config, cache);
  }
  const key = `${name.host}/${name.repository}`;
  if (cache.has(key)) return cache.get(key);
  const probe = await deps.fetch(`https://${name.host}/v2/`, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
  const challenge = bearerChallenge(probe.headers.get("www-authenticate"));
  if (challenge === null) throw new Error(`${name.host} did not offer bearer authentication (${probe.status})`);
  const url = new URL(challenge.realm);
  if (challenge.service) url.searchParams.set("service", challenge.service);
  url.searchParams.set("scope", `repository:${name.repository}:pull,push`);
  const { username, password } = config.registryAuth;
  const response = await deps.fetch(url.toString(), {
    headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${name.host} refused a registry token (${response.status})`);
  const body = JSON.parse(await response.text());
  const token = body.token || body.access_token;
  if (!token) throw new Error(`${name.host} answered without a registry token`);
  cache.set(key, token);
  return token;
};

/** The manifest `<base>:<reference>` names, or null when there is none. */
export const readManifest = async (deps, config, base, reference) => {
  const name = splitImage(base);
  const token = await registryToken(deps, config, name);
  const response = await deps.fetch(`https://${name.host}/v2/${name.repository}/manifests/${reference}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_ACCEPT },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`reading ${base}:${reference} failed (${response.status})`);
  const body = await response.text();
  const mediaType = (response.headers.get("content-type") || "").split(";")[0].trim() || JSON.parse(body).mediaType || "";
  const digest = response.headers.get("docker-content-digest") || `sha256:${createHash("sha256").update(body).digest("hex")}`;
  return { mediaType, body, digest };
};

/**
 * Point each app's `:live` at the image built for its commit, then read the
 * tag back — a registry that answered and kept the old manifest is an error,
 * not a deploy of the previous build.
 *
 * @param {Partial<Record<"server" | "client", string>>} shas
 */
export const promote = async (deps, config, shas) => {
  for (const app of APPS.filter((name) => name in shas)) {
    const base = imageBase(config.ownerRepo, app);
    const source = await readManifest(deps, config, base, shas[app]);
    if (source === null) throw new Error(`${base}:${shas[app]} is not in the registry`);
    const name = splitImage(base);
    const token = await registryToken(deps, config, name);
    const response = await deps.fetch(`https://${name.host}/v2/${name.repository}/manifests/${LIVE_TAG}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": source.mediaType },
      body: source.body,
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`writing ${base}:${LIVE_TAG} failed (${response.status})`);
    const after = await readManifest(deps, config, base, LIVE_TAG);
    if (after === null || after.digest !== source.digest) {
      throw new Error(`${base}:${LIVE_TAG} does not point at ${shas[app]} after the update`);
    }
    deps.log(`promoted ${base}:${shas[app]} to :${LIVE_TAG}`);
  }
};

// ── Coolify ──────────────────────────────────────────────────────────────

/** The exact body signed and sent for one app. */
export const webhookBody = (hook, sha) =>
  JSON.stringify({
    ref: `refs/heads/${hook.branch}`,
    after: sha,
    repository: { full_name: hook.repository },
    commits: [{ id: sha, added: [], removed: [], modified: [WATCH_PATH] }],
  });

/** `X-Hub-Signature-256`, without its `sha256=` prefix. */
export const signWebhook = (secret, body) => createHmac("sha256", secret).update(body).digest("hex");

/**
 * Whether Coolify's answer says THIS app's deploy was queued.
 *
 * The endpoint answers 200 with one entry per app whose repository and branch
 * matched — the other app of this pair included, marked "Invalid signature.".
 * Only an entry for this uuid with status `success`, or a `skipped` one (the
 * same commit is already queued; only an app whose signature matched gets
 * that far), counts. Anything else — "Deployments disabled.", a watch path
 * mismatch, every entry invalid, a plain-text "Nothing to do." — is a
 * failure, and the detail says which without naming any other app.
 */
export const webhookQueued = (text, uuid) => {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, detail: String(text).slice(0, 200).trim() || "(empty answer)" };
  }
  if (!Array.isArray(parsed)) return { ok: false, detail: JSON.stringify(parsed).slice(0, 200) };
  const entries = parsed.filter((entry) => entry && typeof entry === "object");
  if (entries.some((entry) => entry.application_uuid === uuid && entry.status === "success")) {
    return { ok: true, detail: "deployment queued" };
  }
  if (entries.some((entry) => entry.status === "skipped")) return { ok: true, detail: "this commit is already queued" };
  const own = entries.filter((entry) => entry.message !== "Invalid signature.");
  if (own.length === 0) {
    return {
      ok: false,
      detail:
        entries.length === 0
          ? "no app matched the repository and branch"
          : "the signature matched no app — the deploy secret is stale or belongs to another app (hatchkit secrets isolate)",
    };
  }
  return { ok: false, detail: own.map((entry) => `${entry.status}: ${entry.message}`).join("; ") };
};

/**
 * Queue a deploy of each app, server first, as the workflow always has. The
 * payload names the commit, so Coolify reads that commit's compose file and
 * its deployment list shows which build it was.
 *
 * @param {Partial<Record<"server" | "client", string>>} shas
 */
export const trigger = async (deps, config, shas) => {
  for (const app of APPS.filter((name) => name in shas)) {
    const hook = config.hooks[app];
    const body = webhookBody(hook, shas[app]);
    const response = await deps.fetch(`${config.coolifyBaseUrl}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "push",
        "X-Hub-Signature-256": `sha256=${signWebhook(hook.secret, body)}`,
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Coolify answered ${response.status} to the ${app} app's deploy webhook`);
    const verdict = webhookQueued(text, hook.uuid);
    if (!verdict.ok) throw new Error(`the ${app} app's deploy was not queued: ${verdict.detail}`);
    deps.log(`deploy queued for the ${app} app (${verdict.detail})`);
  }
};

// ── The sequence ─────────────────────────────────────────────────────────

/**
 * The commit each app is serving now, from its own endpoint, before anything
 * moves. Once `:live` moves nothing names the previous build, and what was
 * SERVING is what a rollback should return to — not whatever a tag last said.
 */
export const readServed = async (deps, config) => {
  const observed = await observe(deps, config, 0);
  const commitOf = (value) => (isFullSha(value) ? value : null);
  return {
    server: observed.health && typeof observed.health === "object" ? commitOf(healthCommit(observed.health)) : null,
    client: observed.version && typeof observed.version === "object" ? commitOf(observed.version.commit) : null,
  };
};

/**
 * Which apps a failed deploy can be put back, and why the others cannot.
 *
 * @param {object} input
 * @param {string[]} input.apps          the apps this deploy changed
 * @param {Record<string, string | null>} input.served   the commit each served before it
 * @param {Record<string, boolean>} input.inRegistry     whether `:<served>` still exists
 * @param {string} input.targetSha
 * @param {(sha: string) => { migrations: object[], schemaVersion: number }} input.contractAt
 */
export const planRollback = ({ apps, served, inRegistry, targetSha, contractAt }) => {
  const restore = {};
  const skipped = {};
  for (const app of apps) {
    const sha = served[app] ?? null;
    if (sha === null) {
      skipped[app] = `the ${app} app reported no commit before the deploy (a first deploy, or it was not answering)`;
    } else if (sha === targetSha) {
      skipped[app] = `the ${app} app was already serving ${targetSha}`;
    } else if (inRegistry[app] !== true) {
      skipped[app] = `it served ${sha}, and that image is no longer in the registry`;
    } else if (app === "server") {
      const block = serverDowngradeBlock(contractAt, sha, targetSha);
      if (block === null) restore[app] = sha;
      else skipped[app] = `not rolled back: ${block}`;
    } else {
      restore[app] = sha;
    }
  }
  return { restore, skipped };
};

/**
 * Deploy `targetSha` to `apps`, gate it, and put the previous builds back when
 * the gate fails.
 *
 * Never loops: a failed rollback is reported and the run fails, because a
 * second automatic attempt against an unknown state is how an outage grows.
 *
 * @param {DeployDeps} deps
 * @param {DeployConfig} config
 * @param {{ targetSha: string, apps: string[], rollback: boolean, guardServerDowngrade?: boolean, forceServer?: boolean }} request
 * @returns {Promise<{ ok: boolean, errors: string[] }>}
 */
export const deployWithRollback = async (deps, config, request) => {
  const { targetSha, apps, rollback } = request;
  if (!isFullSha(targetSha)) return { ok: false, errors: [`${targetSha} is not a full 40-character commit sha`] };

  // What a rollback returns to, read before anything moves, and whether the
  // registry still holds it — `:live` can only be pointed at an image that
  // exists. The new images are checked here too, so a missing build fails
  // with nothing changed instead of half way through promoting.
  const served = await readServed(deps, config);
  const inRegistry = {};
  try {
    for (const app of apps) {
      const base = imageBase(config.ownerRepo, app);
      if ((await readManifest(deps, config, base, targetSha)) === null) {
        return { ok: false, errors: [`${base}:${targetSha} is not in the registry, so there is nothing to deploy; nothing was changed`] };
      }
      inRegistry[app] = served[app] !== null && (await readManifest(deps, config, base, served[app])) !== null;
      deps.log(`${app} before: ${served[app] ?? "<no commit reported>"}${served[app] !== null && !inRegistry[app] ? " (no longer in the registry)" : ""}`);
    }
  } catch (caught) {
    return { ok: false, errors: [`the registry could not be read (${messageOf(caught)}); nothing was changed`] };
  }

  // Deploying an OLDER server by hand is the same question as rolling one
  // back: can that build read the database the current one has migrated?
  // Refuse before anything changes, unless the operator says the database was
  // restored from a dump that predates the migration. Only the manual
  // workflow asks: a push deploys a newer build, and an unreadable registry
  // of the build it replaces must not stop that.
  if (
    request.guardServerDowngrade &&
    !request.forceServer &&
    apps.includes("server") &&
    served.server !== null &&
    served.server !== targetSha
  ) {
    const block = serverDowngradeBlock(deps.contractAt, targetSha, served.server);
    if (block !== null) {
      return {
        ok: false,
        errors: [
          `refusing to deploy the server at ${targetSha}: ${block}. Deploy only the client (which=client), or restore a database dump from before that migration and run again with force_server.`,
        ],
      };
    }
  }

  const expectedFor = (shas) => ({
    serverSha: apps.includes("server") ? (shas.server ?? null) : null,
    clientSha: apps.includes("client") ? (shas.client ?? null) : null,
  });
  const each = (sha, names) => Object.fromEntries(names.map((app) => [app, sha]));

  // A call that fails half way (the server's `:live` moved, the client's
  // refused, or a webhook not queued) leaves a tag the next unrelated
  // redeploy would pick up. It goes through the same restore as a failed gate.
  let problems;
  try {
    await promote(deps, config, each(targetSha, apps));
    await trigger(deps, config, each(targetSha, apps));
    problems = await waitForHealthy(deps, config, expectedFor({ server: targetSha, client: targetSha }));
  } catch (caught) {
    problems = [`promote-or-deploy: ${messageOf(caught)}`];
  }
  if (problems.length === 0) return { ok: true, errors: [] };

  const failed = [...new Set(problems.map(checkName))].join(", ");
  const details = problems.map((problem) => `  ${problem}`);
  const headline = (outcome) => `${targetSha} failed the deploy gate (${failed}); ${outcome}`;
  if (!rollback) return { ok: false, errors: [headline(`it stays on :${LIVE_TAG}, since no rollback was requested`), ...details] };

  const plan = planRollback({ apps, served, inRegistry, targetSha, contractAt: deps.contractAt });
  const skipped = Object.entries(plan.skipped).map(([app, reason]) => `  ${app}: ${reason}`);
  const restoreApps = Object.keys(plan.restore);
  if (restoreApps.length === 0) {
    return {
      ok: false,
      errors: [
        headline(`nothing was rolled back and ${targetSha} is still on :${LIVE_TAG}. Fix forward, or run hosted-rollback.yml with a known-good sha`),
        ...details,
        ...skipped,
      ],
    };
  }

  const restored = restoreApps.map((app) => `${app} ${plan.restore[app]}`).join(", ");
  deps.log(`rolling back to ${restored}`);
  try {
    await promote(deps, config, plan.restore);
    await trigger(deps, config, plan.restore);
  } catch (caught) {
    return {
      ok: false,
      errors: [headline(`ROLLBACK to ${restored} FAILED while promoting or deploying (${messageOf(caught)}); the hosted apps need a person now`), ...details, ...skipped],
    };
  }
  // The gate after a rollback expects each restored app's old commit, and no
  // particular commit from an app that stayed on the new build.
  const after = await waitForHealthy(deps, config, {
    serverSha: plan.restore.server ?? null,
    clientSha: plan.restore.client ?? null,
  });
  if (after.length > 0) {
    return {
      ok: false,
      errors: [
        headline(`ROLLBACK to ${restored} FAILED its own gate; the hosted apps need a person now`),
        ...details,
        ...skipped,
        ...after.map((problem) => `  after rollback: ${problem}`),
      ],
    };
  }
  return {
    ok: false,
    errors: [headline(`rolled back to ${restored}, which passed the gate`), ...details, ...skipped],
  };
};

/**
 * The gate alone: nothing to promote and nothing to restore, but the same
 * checks against whatever is serving.
 */
export const verifyOnly = async (deps, config, targetSha) => {
  const problems = await waitForHealthy(deps, config, { serverSha: targetSha, clientSha: targetSha });
  return problems.length === 0
    ? { ok: true, errors: [] }
    : { ok: false, errors: [`${targetSha} failed the deploy gate:`, ...problems.map((p) => `  ${p}`)] };
};
