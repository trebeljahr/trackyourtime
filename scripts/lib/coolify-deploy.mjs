/**
 * The hosted deploy, its health gate and its rollback — the logic
 * `scripts/coolify-deploy.mjs` runs from `.github/workflows/build-and-deploy.yml`
 * (every push to main) and `.github/workflows/hosted-rollback.yml` (by hand).
 *
 * Everything that touches the network, git or the clock is injected, so the
 * whole sequence — pin, deploy, poll, gate, restore — is driven by
 * `coolify-deploy.test.mjs` against a fake Coolify without a network.
 *
 * docs/deploy.md → "Rollback" is the same thing in words.
 */
import { breakingMigrations } from "./release-policy.mjs";

/** The two Coolify apps, in the order they are deployed. */
export const APPS = Object.freeze(["server", "client"]);

/** The Coolify env var that holds each app's image reference. */
export const IMAGE_ENV = Object.freeze({ server: "SERVER_IMAGE", client: "CLIENT_IMAGE" });

const FULL_SHA = /^[0-9a-f]{40}$/;

export const isFullSha = (value) => typeof value === "string" && FULL_SHA.test(value);

/** `ghcr.io/<owner/repo>-<app>:<sha>` — the immutable tag build-and-deploy pushes. */
export const imageRef = (ownerRepo, app, sha) => `ghcr.io/${ownerRepo}-${app}:${sha}`;

/**
 * The commit an image reference is pinned to, or null.
 *
 * Only a full sha counts. `:main` is what the compose files default to, and
 * after a push it already points at the NEW build — "restoring" it would
 * redeploy the very image that just failed.
 */
export const shaFromImage = (value) => {
  if (typeof value !== "string") return null;
  const tag = value.slice(value.lastIndexOf(":") + 1);
  return isFullSha(tag) ? tag : null;
};

/**
 * The production value of `key` in a Coolify `GET /applications/<uuid>/envs`
 * answer, or null when it is absent or unreadable.
 *
 * Coolify keeps a preview copy of a variable beside the production one, and
 * leaves `value` out of the answer when the token may not read sensitive data.
 * Both read as "unknown", never as an empty string, so a token without that
 * permission means "no rollback target" rather than "roll back to nothing".
 */
export const findEnvValue = (envs, key) => {
  if (!Array.isArray(envs)) return null;
  const rows = envs.filter((row) => row && typeof row === "object" && row.key === key);
  const row = rows.find((candidate) => candidate.is_preview !== true) ?? null;
  return row && typeof row.value === "string" && row.value !== "" ? row.value : null;
};

/** `both` → both apps, `client` / `server` → that one. Anything else throws. */
export const parseWhich = (which) => {
  if (which === undefined || which === "" || which === "both") return [...APPS];
  if (which === "client" || which === "server") return [which];
  throw new Error(`--which must be client, server or both, not "${which}"`);
};

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
 * Problems with an `/api/health` answer, as named checks. `expectedSha` null
 * skips the commit comparison (the server was not part of this deploy).
 */
export const healthProblems = (body, expectedSha) => {
  if (!body || typeof body !== "object") return noAnswerProblems("api", "/api/health", expectedSha);
  const problems = [];
  // `commit` is the field's name; `version` is the same commit under the name
  // older images report it as (app.ts), which a rollback target may be.
  const commit = body.commit ?? body.version;
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
    const reason = caught instanceof Error ? caught.message : String(caught);
    return `the migration registries of ${olderSha} and ${newerSha} could not be compared (${reason})`;
  }
  const breaking = breakingMigrations(older, newer);
  if (breaking.length === 0) return null;
  const list = breaking.map((m) => `${m.id} (${m.file}, minReaderSchema ${m.minReaderSchema})`).join(", ");
  return `${newerSha} carries migration ${list}, above the SCHEMA_VERSION ${older.schemaVersion} of ${olderSha}, which would refuse to start on that database`;
};

// ── The sequence ─────────────────────────────────────────────────────────

/**
 * @typedef {object} DeployDeps
 * @property {(url: string, init?: object) => Promise<{ status: number, ok: boolean, headers: { get(name: string): string | null }, text(): Promise<string> }>} fetch
 * @property {(ms: number) => Promise<void>} sleep
 * @property {(line: string) => void} log
 * @property {(sha: string) => { migrations: object[], schemaVersion: number }} contractAt  readMigrationContract at a sha
 */

/**
 * @typedef {object} DeployConfig
 * @property {string} coolifyBaseUrl
 * @property {string} coolifyToken
 * @property {{ server: string, client: string }} uuids
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
 * API call returns when it is QUEUED — so the commits are polled for minutes.
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

const coolify = async (deps, config, method, path, body) => {
  const response = await deps.fetch(`${config.coolifyBaseUrl}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.coolifyToken}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Coolify ${method} ${path} answered ${response.status}: ${text.slice(0, 300)}`);
  }
  return text === "" ? null : JSON.parse(text);
};

/** The current image value of each app, or null where it cannot be read. */
export const readPinned = async (deps, config, apps) => {
  const pinned = {};
  for (const app of apps) {
    const envs = await coolify(deps, config, "GET", `/applications/${config.uuids[app]}/envs`);
    pinned[app] = findEnvValue(envs, IMAGE_ENV[app]);
  }
  return pinned;
};

/**
 * PATCH each app's image variable, then read it back where the token can.
 *
 * Coolify's PATCH accepts a key that does not exist and does nothing, so the
 * read-back is what turns "the variable was never created" into an error
 * instead of a deploy of whatever was there before.
 */
export const pin = async (deps, config, values) => {
  for (const [app, value] of Object.entries(values)) {
    await coolify(deps, config, "PATCH", `/applications/${config.uuids[app]}/envs`, {
      key: IMAGE_ENV[app],
      value,
      is_preview: false,
    });
    const after = (await readPinned(deps, config, [app]))[app];
    if (after !== null && after !== value) {
      throw new Error(
        `${IMAGE_ENV[app]} on the ${app} app still reads ${after} after the PATCH; create it once in the Coolify UI (docs/deploy.md → One-time setup)`,
      );
    }
    deps.log(`pinned ${IMAGE_ENV[app]}=${value}`);
  }
};

/** Queue a deploy of each app, server first, as the workflow always has. */
export const trigger = async (deps, config, apps) => {
  for (const app of APPS.filter((name) => apps.includes(name))) {
    await coolify(deps, config, "POST", `/deploy?uuid=${encodeURIComponent(config.uuids[app])}&force=true`);
    deps.log(`deploy queued for the ${app} app`);
  }
};

/**
 * Which apps a failed deploy can be put back, and why the others cannot.
 *
 * @param {object} input
 * @param {string[]} input.apps          the apps this deploy changed
 * @param {Record<string, string | null>} input.previous  their image values before it
 * @param {string} input.targetSha
 * @param {(sha: string) => { migrations: object[], schemaVersion: number }} input.contractAt
 */
export const planRollback = ({ apps, previous, targetSha, contractAt }) => {
  const restore = {};
  const skipped = {};
  for (const app of apps) {
    const value = previous[app] ?? null;
    const sha = shaFromImage(value);
    if (value === null) {
      skipped[app] = `no previous ${IMAGE_ENV[app]} value could be read (a first deploy, or a token without read access to env values)`;
    } else if (sha === null) {
      skipped[app] = `the previous ${IMAGE_ENV[app]} was ${value}, not pinned to a commit, so it cannot name the build to go back to`;
    } else if (sha === targetSha) {
      skipped[app] = `the previous ${IMAGE_ENV[app]} is already ${targetSha}`;
    } else if (app === "server") {
      const block = serverDowngradeBlock(contractAt, sha, targetSha);
      if (block === null) restore[app] = { value, sha };
      else skipped[app] = `not rolled back: ${block}`;
    } else {
      restore[app] = { value, sha };
    }
  }
  return { restore, skipped };
};

/**
 * Deploy `targetSha` to `apps`, gate it, and put the previous images back when
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

  const previous = await readPinned(deps, config, apps);
  for (const app of apps) deps.log(`${IMAGE_ENV[app]} before: ${previous[app] ?? "<unreadable>"}`);

  // Deploying an OLDER server by hand is the same question as rolling one
  // back: can that build read the database the current one has migrated?
  // Refuse before anything changes, unless the operator says the database was
  // restored from a dump that predates the migration. Only the manual
  // workflow asks: a push deploys a newer build, and an unreadable registry
  // of the build it replaces must not stop that.
  const currentServerSha = shaFromImage(previous.server);
  if (
    request.guardServerDowngrade &&
    !request.forceServer &&
    apps.includes("server") &&
    currentServerSha !== null &&
    currentServerSha !== targetSha
  ) {
    const block = serverDowngradeBlock(deps.contractAt, targetSha, currentServerSha);
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

  // A Coolify call that fails half way (the server pinned, the client PATCH
  // refused) leaves a variable that the next unrelated redeploy would pick
  // up. It goes through the same restore as a failed gate.
  let problems;
  try {
    await pin(deps, config, Object.fromEntries(apps.map((app) => [app, imageRef(config.ownerRepo, app, targetSha)])));
    await trigger(deps, config, apps);
    problems = await waitForHealthy(deps, config, expectedFor({ server: targetSha, client: targetSha }));
  } catch (caught) {
    problems = [`coolify-api: ${caught instanceof Error ? caught.message : String(caught)}`];
  }
  if (problems.length === 0) return { ok: true, errors: [] };

  const failed = [...new Set(problems.map(checkName))].join(", ");
  const details = problems.map((problem) => `  ${problem}`);
  const headline = (outcome) => `${targetSha} failed the deploy gate (${failed}); ${outcome}`;
  if (!rollback) return { ok: false, errors: [headline("it stays pinned, since no rollback was requested"), ...details] };

  const plan = planRollback({ apps, previous, targetSha, contractAt: deps.contractAt });
  const skipped = Object.entries(plan.skipped).map(([app, reason]) => `  ${app}: ${reason}`);
  const restoreApps = Object.keys(plan.restore);
  if (restoreApps.length === 0) {
    return {
      ok: false,
      errors: [
        headline(`nothing was rolled back and ${targetSha} is still pinned. Fix forward, or run hosted-rollback.yml with a known-good sha`),
        ...details,
        ...skipped,
      ],
    };
  }

  const restored = restoreApps.map((app) => `${app} ${plan.restore[app].sha}`).join(", ");
  deps.log(`rolling back to ${restored}`);
  try {
    await pin(deps, config, Object.fromEntries(restoreApps.map((app) => [app, plan.restore[app].value])));
    await trigger(deps, config, restoreApps);
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : String(caught);
    return {
      ok: false,
      errors: [headline(`ROLLBACK to ${restored} FAILED while pinning or deploying (${reason}); the hosted apps need a person now`), ...details, ...skipped],
    };
  }
  // The gate after a rollback expects each restored app's old commit, and no
  // particular commit from an app that stayed on the new build.
  const after = await waitForHealthy(deps, config, {
    serverSha: plan.restore.server?.sha ?? null,
    clientSha: plan.restore.client?.sha ?? null,
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
 * The gate alone, for the single-app layout: nothing to pin and nothing to
 * restore, but the same checks.
 */
export const verifyOnly = async (deps, config, targetSha) => {
  const problems = await waitForHealthy(deps, config, { serverSha: targetSha, clientSha: targetSha });
  return problems.length === 0
    ? { ok: true, errors: [] }
    : { ok: false, errors: [`${targetSha} failed the deploy gate:`, ...problems.map((p) => `  ${p}`)] };
};
