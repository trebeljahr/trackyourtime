/**
 * Retire the Coolify client app after the web app moved to its Cloudflare
 * Worker (2026-10-18, docs/deploy.md → Web app on Cloudflare). The logic of
 * scripts/ops/retire-coolify-client.mjs; every provider call is injected, so
 * retire-coolify-client.test.mjs drives it against fakes.
 *
 * What goes, in this order, each step idempotent:
 *
 *   1. The Coolify app `trackyourtime-client`, its volumes kept, then the
 *      backup sources that read it. This ends the quick way back (delete
 *      the `trackyourtime.dev/*` route and Coolify answers again).
 *   2. The no-Worker route `trackyourtime.dev/.well-known/acme-challenge/*`.
 *      It let Traefik renew the apex certificate, which only that app held.
 *   3. The repo secrets COOLIFY_CLIENT_*, which nothing reads since the
 *      cutover.
 *
 * Nothing runs unless every check passes first: the soak is over, the site
 * is the Worker's (the route exists and `/version.json` names a commit on
 * main that is not the Coolify app's last one), and the app found by name
 * routes only the apex host. Anything unexpected is a refusal with nothing
 * changed. The GHCR package and the repo files are left alone; the plan says
 * what is left to do by hand.
 */

export const SITE_HOST = "trackyourtime.dev";
export const WORKER = "trackyourtime-client";
export const COOLIFY_APP = "trackyourtime-client";
export const SITE_ROUTE = `${SITE_HOST}/*`;
export const ACME_ROUTE = `${SITE_HOST}/.well-known/acme-challenge/*`;
export const REPO = "trebeljahr/trackyourtime";
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

/**
 * @typedef {object} RetireDeps
 * @property {{ listApplications(): Promise<{ uuid: string, name: string }[]>, getApplication(uuid: string): Promise<{ uuid: string, name: string, fqdn: string | null, dockerComposeDomains?: { domain: string }[] }>, deleteApplicationKeepingVolumes(uuid: string): Promise<"deleted" | "not-found"> }} coolify
 * @property {{ getZoneByName(name: string): Promise<{ id: string } | null>, listWorkerRoutes(zoneId: string): Promise<{ id: string, pattern: string, script?: string | null }[]>, deleteWorkerRoute(zoneId: string, id: string): Promise<"deleted" | "not-found"> }} cloudflare
 * @property {{ listSecrets(repo: string): Promise<{ name: string }[] | null>, deleteSecret(repo: string, name: string): Promise<"done" | "not-found"> }} github
 * @property {(url: string) => Promise<{ status: number, json(): Promise<unknown> }>} fetch
 * @property {(sha: string) => boolean} onMain   is `sha` reachable from origin/main
 * @property {(uuids: string[]) => Promise<string[]>} reconcileBackups  lines to print
 * @property {() => Date} now
 * @property {(line: string) => void} log
 */

/**
 * Everything the retirement would do and every reason it must not, read
 * without changing anything.
 *
 * @param {RetireDeps} deps
 * @param {{ early?: boolean }} [options]
 */
export const audit = async (deps, options = {}) => {
  const refusals = [];
  const notes = [];

  const today = deps.now().toISOString().slice(0, 10);
  if (today < SOAK_ENDS && !options.early) {
    refusals.push(`the soak runs until ${SOAK_ENDS} (today is ${today}); --early overrides this one check`);
  }

  // The site must already be the Worker's, or deleting the app is an outage.
  const zone = await deps.cloudflare.getZoneByName(SITE_HOST);
  let acmeRoute = null;
  if (!zone) {
    refusals.push(
      `hatchkit's Cloudflare provisioner token cannot see the zone ${SITE_HOST}; add it to the token's Zone Resources (Zone Read, Workers Routes Edit) in the dashboard (token hatchkit-workers-provisioner)`,
    );
  }
  if (zone) {
    const routes = await deps.cloudflare.listWorkerRoutes(zone.id);
    const site = routes.find((route) => route.pattern === SITE_ROUTE);
    if (!site) refusals.push(`there is no route ${SITE_ROUTE}: Coolify still serves the site`);
    else if (site.script !== WORKER) refusals.push(`${SITE_ROUTE} sends to ${site.script || "no Worker"}, not ${WORKER}`);
    acmeRoute = routes.find((route) => route.pattern === ACME_ROUTE) ?? null;
    if (acmeRoute && acmeRoute.script) refusals.push(`${ACME_ROUTE} sends to ${acmeRoute.script}; it was made with no Worker`);
    if (!acmeRoute) notes.push(`${ACME_ROUTE} is already gone`);
  }

  let served = null;
  try {
    const response = await deps.fetch(`https://${SITE_HOST}/version.json?cb=${Date.now()}`);
    if (response.status === 200) served = await response.json();
  } catch {
    // reported below
  }
  const commit = served && typeof served === "object" ? served.commit : null;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
    refusals.push(`https://${SITE_HOST}/version.json gave no commit`);
  } else if (commit === COOLIFY_LAST_COMMIT) {
    refusals.push(`the site serves ${commit}, the Coolify app's last build: the Worker is not what answers`);
  } else if (!deps.onMain(commit)) {
    refusals.push(`the site serves ${commit}, which is not on origin/main`);
  }

  // The app, by its exact name, and only if it routes nothing but the apex.
  const apps = await deps.coolify.listApplications();
  const named = apps.filter((app) => app.name === COOLIFY_APP);
  let app = null;
  if (named.length > 1) refusals.push(`${named.length} Coolify apps are named ${COOLIFY_APP}; resolve by hand`);
  else if (named.length === 1) {
    app = await deps.coolify.getApplication(named[0].uuid);
    const hosts = appHosts(app);
    const foreign = hosts.filter((host) => host !== SITE_HOST);
    if (foreign.length > 0) refusals.push(`${COOLIFY_APP} (${app.uuid}) also routes ${foreign.join(", ")}; it is not only the web client`);
  } else notes.push(`no Coolify app is named ${COOLIFY_APP}; it is already gone`);
  const others = apps.filter((other) => other.name !== COOLIFY_APP && /trackyourtime.*client|tracktime.*client/i.test(other.name));
  for (const other of others) notes.push(`not touched, review by hand: Coolify app ${other.name} (${other.uuid})`);

  const listed = await deps.github.listSecrets(REPO);
  if (listed === null) refusals.push(`the secrets of ${REPO} could not be listed (gh auth?)`);
  const secrets = (listed ?? []).map((secret) => secret.name).filter((name) => CLIENT_SECRETS.includes(name));

  return { refusals, notes, zoneId: zone?.id ?? null, acmeRoute, app, secrets, servedCommit: commit };
};

/** The plan as lines, for the audit and for the record of a run. */
export const describe = (state) => [
  state.app ? `delete Coolify app ${state.app.name} (${state.app.uuid}), volumes kept, then its backup sources` : "Coolify app: nothing to delete",
  state.acmeRoute ? `delete route ${state.acmeRoute.pattern} (${state.acmeRoute.id})` : "ACME route: nothing to delete",
  state.secrets.length > 0 ? `delete secrets ${state.secrets.join(", ")} on ${REPO}` : "COOLIFY_CLIENT_* secrets: nothing to delete",
];

/**
 * Audit, and when nothing refuses, retire. With `execute` false it only
 * audits. Never retries a failed step: the error says which step and what
 * is already done.
 *
 * @param {RetireDeps} deps
 * @param {{ execute: boolean, early?: boolean }} options
 * @returns {Promise<{ ok: boolean, done: string[], refusals: string[] }>}
 */
export const retire = async (deps, options) => {
  const state = await audit(deps, options);
  deps.log(`site serves ${state.servedCommit ?? "<unknown>"}`);
  for (const note of state.notes) deps.log(`note: ${note}`);
  for (const line of describe(state)) deps.log(`plan: ${line}`);
  if (state.refusals.length > 0) return { ok: false, done: [], refusals: state.refusals };
  if (!options.execute) return { ok: true, done: [], refusals: [] };

  const done = [];
  const step = async (label, action) => {
    try {
      await action();
      done.push(label);
      deps.log(`done: ${label}`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      throw new Error(`${label} failed (${message}); already done: ${done.join("; ") || "nothing"}`);
    }
  };

  if (state.app) {
    const app = state.app;
    await step(`Coolify app ${app.name} deleted`, async () => {
      const result = await deps.coolify.deleteApplicationKeepingVolumes(app.uuid);
      deps.log(`  ${app.name}: ${result}`);
      for (const line of await deps.reconcileBackups([app.uuid])) deps.log(`  ${line}`);
    });
  }
  if (state.acmeRoute && state.zoneId) {
    const { zoneId, acmeRoute } = state;
    await step(`route ${acmeRoute.pattern} deleted`, async () => {
      deps.log(`  ${await deps.cloudflare.deleteWorkerRoute(zoneId, acmeRoute.id)}`);
    });
  }
  for (const name of state.secrets) {
    await step(`secret ${name} deleted`, async () => {
      deps.log(`  ${await deps.github.deleteSecret(REPO, name)}`);
    });
  }

  // The site has to look exactly as before: the Worker never depended on any
  // of it.
  const response = await deps.fetch(`https://${SITE_HOST}/version.json?cb=${Date.now()}`);
  const after = response.status === 200 ? await response.json() : null;
  if (!after || after.commit !== state.servedCommit) {
    return { ok: false, done, refusals: [`after the retirement /version.json answered ${response.status} ${JSON.stringify(after)}; check the site now`] };
  }
  deps.log(`site still serves ${after.commit}`);
  return { ok: true, done, refusals: [] };
};
