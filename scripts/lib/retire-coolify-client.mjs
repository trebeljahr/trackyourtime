/**
 * Retire the Coolify side of the web app after its move to the Cloudflare
 * Worker (2026-10-18, docs/deploy.md → Web app on Cloudflare). The logic of
 * scripts/ops/retire-coolify-client.mjs; every provider call is injected, so
 * retire-coolify-client.test.mjs drives it against fakes. Shaped like the
 * other projects' retirement scripts (vault:
 * projects/hatchkit/coolify-retirement-index.md).
 *
 * What goes, each step idempotent, nothing else ever:
 *
 *   1. The no-Worker route `trackyourtime.dev/.well-known/acme-challenge/*`.
 *      It only let Traefik renew the apex certificate, which only the client
 *      app held.
 *   2. The Coolify client apps: `trackyourtime-client` (Docker Image app) and
 *      a stopped legacy Compose client app, each only while it is named as a
 *      client, routes nothing but the apex, and pulls the client image or
 *      builds this repo. Volumes are kept and reported. Then the backup
 *      sources that read them.
 *   3. The GHCR package `trackyourtime-client` (the Coolify image; GitHub can
 *      restore a deleted package for 30 days). Never `-client-selfhost`, which
 *      self-hosters pull, and never `-server`.
 *   4. The repo secrets COOLIFY_CLIENT_*. The COOLIFY_SERVER_* ones stay.
 *
 * The Coolify project stays: it holds the API server and its database. DNS
 * stays: the route needs the proxied records.
 *
 * Nothing is deleted unless every check passes first: the soak is over, the
 * `trackyourtime.dev/*` route points at the Worker, and the site answers from
 * the Worker (it serves `/release-assets.json`, which the Coolify image never
 * did) at the commit on origin/main.
 */

export const SITE_HOST = "trackyourtime.dev";
export const SITE = `https://${SITE_HOST}`;
export const WORKER = "trackyourtime-client";
export const SITE_ROUTE = `${SITE_HOST}/*`;
export const ACME_ROUTE = `${SITE_HOST}/.well-known/acme-challenge/*`;
export const REPO = "trebeljahr/trackyourtime";
export const IMAGE = "ghcr.io/trebeljahr/trackyourtime-client";
export const PACKAGE = "trackyourtime-client";
export const CLIENT_SECRETS = Object.freeze([
  "COOLIFY_CLIENT_RESOURCE_UUID",
  "COOLIFY_CLIENT_DEPLOY_SECRET",
  "COOLIFY_CLIENT_DEPLOY_REPOSITORY",
  "COOLIFY_CLIENT_DEPLOY_BRANCH",
]);
/** The commit the Coolify app served when nothing deployed it any more. */
export const COOLIFY_LAST_COMMIT = "42e1294634dbb3ac3de2406bb0b53d30f7d54222";
/** Seven days after the cutover on 2026-10-18. */
export const SOAK_ENDS = "2026-10-25";

/** Client app names: the image app and the stopped legacy Compose app. */
const CLIENT_APP_NAME = /^(trackyourtime|tracktime)-client(-legacy-compose)?$/;

/** Hosts an app routes, from its `fqdn` (comma-separated URLs) and compose domains. */
export const appHosts = (app) => {
  const urls = [
    ...String(app.fqdn ?? "").split(","),
    ...(app.dockerComposeDomains ?? []).flatMap((entry) => String(entry.domain ?? "").split(",")),
  ];
  const hosts = new Set();
  for (const raw of urls.map((url) => url.trim()).filter(Boolean)) {
    try {
      hosts.add(new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase());
    } catch {
      hosts.add(raw.toLowerCase());
    }
  }
  return [...hosts];
};

/** Why an app named like a client app must not be deleted, or null. */
export const clientAppProblem = (app) => {
  const foreign = appHosts(app).filter((host) => host !== SITE_HOST);
  if (foreign.length > 0) return `it also routes ${foreign.join(", ")}`;
  const image = String(app.dockerRegistryImageName ?? "");
  const pullsClientImage = image === IMAGE || image.startsWith(`${IMAGE}:`);
  const buildsRepo = String(app.gitRepository ?? "").replace(/\.git$/, "").endsWith(REPO);
  if (!pullsClientImage && !buildsRepo) return `it neither pulls ${IMAGE} nor builds ${REPO}`;
  return null;
};

/**
 * @typedef {object} RetireDeps
 * @property {{ listApplications(): Promise<{ uuid: string, name: string }[]>, getApplication(uuid: string): Promise<object>, listApplicationStorages(uuid: string): Promise<{ persistent: { name: string }[], fileCount: number }>, deleteApplicationKeepingVolumes(uuid: string): Promise<string> }} coolify
 * @property {{ getZoneByName(name: string): Promise<{ id: string } | null>, listWorkerRoutes(zoneId: string): Promise<{ id: string, pattern: string, script?: string | null }[]>, deleteWorkerRoute(zoneId: string, id: string): Promise<string> }} cloudflare
 * @property {{ listSecrets(): Promise<string[] | null>, deleteSecret(name: string): Promise<string>, packageExists(): Promise<boolean>, deletePackage(): Promise<void> }} github
 * @property {(url: string) => Promise<{ status: number, json(): Promise<unknown> }>} fetch
 * @property {() => string} mainSha        origin/main's commit, freshly fetched
 * @property {(uuids: string[]) => Promise<string[]>} reconcileBackups  lines to print
 * @property {() => Promise<boolean>} confirm   the one "Type DELETE" question
 * @property {() => Date} now
 * @property {(ms: number) => Promise<void>} sleep
 * @property {(line: string) => void} log
 */

/** The site, as the Worker serves it: `/version.json`'s commit, and whether `/release-assets.json` answers. */
const siteState = async (deps) => {
  let commit = null;
  try {
    const version = await deps.fetch(`${SITE}/version.json?retire=${Date.now()}`);
    if (version.status === 200) commit = (await version.json())?.commit ?? null;
  } catch {
    // reported by the caller
  }
  let worker = false;
  try {
    const manifest = await deps.fetch(`${SITE}/release-assets.json?retire=${Date.now()}`);
    worker = manifest.status === 200 && (await manifest.json())?.schema === 1;
  } catch {
    // reported by the caller
  }
  return { commit, worker };
};

/**
 * Every check and the plan, read without changing anything.
 *
 * @param {RetireDeps} deps
 * @param {{ skipSoak?: boolean, dryRun?: boolean }} options
 */
export const audit = async (deps, options) => {
  const refusals = [];
  const notes = [];

  const today = deps.now().toISOString().slice(0, 10);
  if (today < SOAK_ENDS && !options.skipSoak && !options.dryRun) {
    refusals.push(`the soak runs until ${SOAK_ENDS} (today is ${today}); --skip-soak retires earlier`);
  } else if (today < SOAK_ENDS) notes.push(`the soak runs until ${SOAK_ENDS}`);

  // The site must already be the Worker's, or deleting the app is an outage.
  const zone = await deps.cloudflare.getZoneByName(SITE_HOST);
  let acmeRoute = null;
  if (!zone) refusals.push(`hatchkit's Cloudflare provisioner token cannot see the zone ${SITE_HOST}`);
  else {
    const routes = await deps.cloudflare.listWorkerRoutes(zone.id);
    const site = routes.find((route) => route.pattern === SITE_ROUTE);
    if (!site) refusals.push(`there is no route ${SITE_ROUTE}: Coolify still serves the site`);
    else if (site.script !== WORKER) refusals.push(`${SITE_ROUTE} sends to ${site.script || "no Worker"}, not ${WORKER}`);
    acmeRoute = routes.find((route) => route.pattern === ACME_ROUTE) ?? null;
    if (acmeRoute?.script) refusals.push(`${ACME_ROUTE} sends to ${acmeRoute.script}; it was made with no Worker`);
    if (!acmeRoute) notes.push(`${ACME_ROUTE}: already gone`);
  }

  const mainSha = deps.mainSha();
  const live = await siteState(deps);
  if (live.commit === COOLIFY_LAST_COMMIT || !live.worker) {
    refusals.push(`${SITE} is not served by the Worker (commit ${String(live.commit).slice(0, 12)}, release-assets.json ${live.worker ? "present" : "missing"})`);
  } else if (live.commit !== mainSha) {
    refusals.push(`${SITE} serves ${String(live.commit).slice(0, 12)}, origin/main is ${mainSha.slice(0, 12)}; let the deploy finish first`);
  }

  // The client apps, by name, and only those that pass every guard.
  const apps = [];
  for (const listed of (await deps.coolify.listApplications()).filter((app) => CLIENT_APP_NAME.test(app.name))) {
    const app = await deps.coolify.getApplication(listed.uuid);
    const problem = clientAppProblem(app);
    if (problem) {
      refusals.push(`Coolify app ${listed.name} (${listed.uuid}) looks like the client by name, but ${problem}; resolve by hand`);
      continue;
    }
    const storages = await deps.coolify.listApplicationStorages(listed.uuid);
    apps.push({ uuid: listed.uuid, name: listed.name, status: app.status ?? "?", volumes: storages.persistent.map((volume) => volume.name), fileCount: storages.fileCount });
  }
  if (apps.length === 0) notes.push("no Coolify client app left");

  const packageExists = await deps.github.packageExists();
  if (!packageExists) notes.push(`GHCR package ${IMAGE}: already gone`);

  const listed = await deps.github.listSecrets();
  if (listed === null) refusals.push(`the secrets of ${REPO} could not be listed (gh auth?)`);
  const secrets = (listed ?? []).filter((name) => CLIENT_SECRETS.includes(name));

  return { refusals, notes, zoneId: zone?.id ?? null, acmeRoute, apps, packageExists, secrets, live, mainSha };
};

/** The plan as lines. */
export const describe = (state) => [
  state.acmeRoute ? `delete route ${state.acmeRoute.pattern} (${state.acmeRoute.id}, no Worker)` : null,
  ...state.apps.map(
    (app) => `delete Coolify app ${app.name} (${app.uuid}, status ${app.status}), keeping volumes [${app.volumes.join(", ")}] and ${app.fileCount} file mount(s), then its backup sources`,
  ),
  state.packageExists ? `delete GHCR package ${IMAGE} (GitHub can restore it for 30 days)` : null,
  state.secrets.length > 0 ? `delete secrets ${state.secrets.join(", ")} on ${REPO}` : null,
].filter(Boolean);

/**
 * Check, show the plan, ask once, delete, verify. `dryRun` stops after the
 * plan. Never retries a failed step: the error says which one and what is
 * already done, and a second run picks up what is left.
 *
 * @param {RetireDeps} deps
 * @param {{ dryRun: boolean, skipSoak?: boolean }} options
 * @returns {Promise<{ ok: boolean, done: string[], refusals: string[] }>}
 */
export const retire = async (deps, options) => {
  const state = await audit(deps, options);
  deps.log(`site: ${SITE} serves ${String(state.live.commit).slice(0, 12)} (Worker: ${state.live.worker}); origin/main is ${state.mainSha.slice(0, 12)}`);
  for (const note of state.notes) deps.log(`note: ${note}`);
  const plan = describe(state);
  for (const line of plan) deps.log(`plan: ${line}`);
  if (state.refusals.length > 0) return { ok: false, done: [], refusals: state.refusals };
  if (plan.length === 0) {
    deps.log("Nothing left to retire.");
    return { ok: true, done: [], refusals: [] };
  }
  if (options.dryRun) return { ok: true, done: [], refusals: [] };
  if (!(await deps.confirm())) return { ok: false, done: [], refusals: ["not confirmed"] };

  const done = [];
  const step = async (label, action) => {
    try {
      const detail = await action();
      done.push(label);
      deps.log(`done: ${label}${detail ? ` (${detail})` : ""}`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      throw new Error(`${label} failed (${message}); already done: ${done.join("; ") || "nothing"}`);
    }
  };

  if (state.acmeRoute && state.zoneId) {
    const { zoneId, acmeRoute } = state;
    await step(`route ${acmeRoute.pattern} deleted`, () => deps.cloudflare.deleteWorkerRoute(zoneId, acmeRoute.id));
  }
  for (const app of state.apps) {
    await step(`Coolify app ${app.name} deleted`, () => deps.coolify.deleteApplicationKeepingVolumes(app.uuid));
  }
  if (state.apps.length > 0) {
    // Coolify deletes in the background; the backup sources go once it has.
    const uuids = state.apps.map((app) => app.uuid);
    for (let attempt = 0; ; attempt += 1) {
      const left = (await deps.coolify.listApplications()).filter((app) => uuids.includes(app.uuid));
      if (left.length === 0) break;
      if (attempt >= 30) throw new Error(`${left.map((app) => app.name).join(", ")} still listed in Coolify after 60 s; already done: ${done.join("; ")}`);
      await deps.sleep(2_000);
    }
    for (const line of await deps.reconcileBackups(uuids)) deps.log(`  ${line}`);
    for (const app of state.apps) for (const volume of app.volumes) deps.log(`kept volume ${volume}; remove it on the server if nothing needs it`);
  }
  if (state.packageExists) await step(`GHCR package ${IMAGE} deleted`, () => deps.github.deletePackage());
  for (const name of state.secrets) await step(`secret ${name} deleted`, () => deps.github.deleteSecret(name));

  // Verify: everything listed is gone, and the site still answers as before.
  const after = await audit(deps, { ...options, skipSoak: true });
  const leftovers = describe(after);
  if (leftovers.length > 0) return { ok: false, done, refusals: leftovers.map((line) => `still there after the run: ${line}`) };
  if (after.live.commit !== state.live.commit || !after.live.worker) {
    return { ok: false, done, refusals: [`${SITE} now serves ${after.live.commit} (Worker: ${after.live.worker}); check the site`] };
  }
  deps.log(`verified: nothing left, and ${SITE} still serves ${String(after.live.commit).slice(0, 12)} from the Worker`);
  return { ok: true, done, refusals: [] };
};
