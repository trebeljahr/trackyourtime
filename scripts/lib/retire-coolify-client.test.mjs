/**
 * Retiring the Coolify side of the web app (scripts/lib/retire-coolify-client.mjs)
 * against a fake Coolify, Cloudflare zone, GitHub and live site. No network.
 *
 * Run by the server package's `test` script (`pnpm test:unit`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ACME_ROUTE,
  appHosts,
  CLIENT_SECRETS,
  clientAppProblem,
  COOLIFY_LAST_COMMIT,
  IMAGE,
  REPO,
  retire,
  SITE_ROUTE,
  WORKER,
} from "./retire-coolify-client.mjs";

const MAIN = "c".repeat(40);
const AFTER_SOAK = new Date("2026-10-26T09:00:00Z");

const imageApp = { uuid: "app-client", name: "trackyourtime-client", fqdn: "https://trackyourtime.dev", dockerRegistryImageName: `${IMAGE}:live`, status: "running:healthy" };
const legacyApp = { uuid: "app-legacy", name: "trackyourtime-client-legacy-compose", fqdn: null, dockerComposeDomains: [{ name: "client", domain: "https://trackyourtime.dev" }], gitRepository: REPO, status: "exited" };
const serverApp = { uuid: "app-server", name: "trackyourtime-server", fqdn: "https://api.trackyourtime.dev", dockerRegistryImageName: "ghcr.io/trebeljahr/trackyourtime-server:live" };

const fakeWorld = ({
  now = AFTER_SOAK,
  routes = [
    { id: "r-site", pattern: SITE_ROUTE, script: WORKER },
    { id: "r-acme", pattern: ACME_ROUTE, script: null },
  ],
  served = MAIN,
  releaseAssets = true,
  apps = [imageApp, legacyApp, serverApp],
  secrets = [...CLIENT_SECRETS, "COOLIFY_SERVER_DEPLOY_SECRET", "CLOUDFLARE_API_TOKEN"],
  packageExists = true,
  confirm = true,
  failPackageDelete = false,
} = {}) => {
  const calls = [];
  const state = { apps: [...apps], routes: [...routes], secrets: [...secrets], packageExists };
  const deps = {
    coolify: {
      listApplications: async () => state.apps.map(({ uuid, name }) => ({ uuid, name })),
      getApplication: async (uuid) => state.apps.find((app) => app.uuid === uuid),
      listApplicationStorages: async () => ({ persistent: [], fileCount: 0 }),
      deleteApplicationKeepingVolumes: async (uuid) => {
        calls.push(`coolify:delete:${uuid}`);
        state.apps = state.apps.filter((app) => app.uuid !== uuid);
        return "deleted";
      },
    },
    cloudflare: {
      getZoneByName: async () => ({ id: "zone" }),
      listWorkerRoutes: async () => state.routes,
      deleteWorkerRoute: async (zone, id) => {
        calls.push(`cloudflare:delete:${id}`);
        state.routes = state.routes.filter((route) => route.id !== id);
        return "deleted";
      },
    },
    github: {
      listSecrets: async () => [...state.secrets],
      deleteSecret: async (name) => {
        calls.push(`github:secret:${name}`);
        state.secrets = state.secrets.filter((secret) => secret !== name);
        return "done";
      },
      packageExists: async () => state.packageExists,
      deletePackage: async () => {
        if (failPackageDelete) throw new Error("HTTP 403: needs delete:packages");
        calls.push("github:package");
        state.packageExists = false;
      },
    },
    fetch: async (url) => {
      if (url.includes("/release-assets.json")) return { status: releaseAssets ? 200 : 404, json: async () => ({ schema: 1, releases: [] }) };
      return { status: 200, json: async () => ({ commit: served }) };
    },
    mainSha: () => MAIN,
    reconcileBackups: async (uuids) => {
      calls.push(`backups:${uuids.join(",")}`);
      return [];
    },
    confirm: async () => {
      calls.push("confirm");
      return confirm;
    },
    now: () => now,
    sleep: async () => {},
    log: () => {},
  };
  return { deps, calls, state };
};

const DELETE_ALL = [
  "confirm",
  "cloudflare:delete:r-acme",
  "coolify:delete:app-client",
  "coolify:delete:app-legacy",
  "backups:app-client,app-legacy",
  "github:package",
  ...CLIENT_SECRETS.map((name) => `github:secret:${name}`),
];

describe("retire", () => {
  it("dry run checks and plans without asking or changing anything, even during the soak", async () => {
    const world = fakeWorld({ now: new Date("2026-10-19T09:00:00Z") });
    const result = await retire(world.deps, { dryRun: true });
    assert.deepEqual(result, { ok: true, done: [], refusals: [] });
    assert.deepEqual(world.calls, []);
  });

  it("asks once, then deletes the ACME route, both client apps, the package and the client secrets", async () => {
    const world = fakeWorld();
    const result = await retire(world.deps, { dryRun: false });
    assert.equal(result.ok, true, result.refusals.join("\n"));
    assert.deepEqual(world.calls, DELETE_ALL);
    assert.deepEqual(world.state.apps.map((app) => app.name), ["trackyourtime-server"]);
    assert.deepEqual(world.state.secrets, ["COOLIFY_SERVER_DEPLOY_SECRET", "CLOUDFLARE_API_TOKEN"]);
    assert.deepEqual(world.state.routes.map((route) => route.pattern), [SITE_ROUTE]);
  });

  it("deletes nothing without the typed confirmation", async () => {
    const world = fakeWorld({ confirm: false });
    const result = await retire(world.deps, { dryRun: false });
    assert.deepEqual(result.refusals, ["not confirmed"]);
    assert.deepEqual(world.calls, ["confirm"]);
  });

  it("refuses during the soak unless --skip-soak", async () => {
    const world = fakeWorld({ now: new Date("2026-10-20T09:00:00Z") });
    const refused = await retire(world.deps, { dryRun: false });
    assert.match(refused.refusals[0], /soak runs until 2026-10-25/);
    assert.deepEqual(world.calls, []);
    assert.equal((await retire(world.deps, { dryRun: false, skipSoak: true })).ok, true);
  });

  it("refuses while the site is not the Worker's, or not yet at origin/main", async () => {
    for (const options of [
      { routes: [{ id: "r-acme", pattern: ACME_ROUTE, script: null }] },
      { served: COOLIFY_LAST_COMMIT },
      { releaseAssets: false },
      { served: "d".repeat(40) },
    ]) {
      const world = fakeWorld(options);
      const result = await retire(world.deps, { dryRun: false });
      assert.equal(result.ok, false, JSON.stringify(options));
      assert.deepEqual(world.calls, []);
    }
  });

  it("refuses an app named like the client that routes the API or is not this project's", async () => {
    for (const app of [
      { ...imageApp, fqdn: "https://trackyourtime.dev,https://api.trackyourtime.dev" },
      { ...imageApp, dockerRegistryImageName: "ghcr.io/someone/else:live" },
    ]) {
      const world = fakeWorld({ apps: [app, serverApp] });
      const result = await retire(world.deps, { dryRun: false });
      assert.equal(result.ok, false);
      assert.match(result.refusals[0], /resolve by hand/);
      assert.deepEqual(world.calls, []);
    }
  });

  it("stops at a failed step, and a second run finishes what is left", async () => {
    const world = fakeWorld({ failPackageDelete: true });
    await assert.rejects(retire(world.deps, { dryRun: false }), /GHCR package .* failed \(HTTP 403: needs delete:packages\); already done: route .* deleted; Coolify app trackyourtime-client deleted; Coolify app trackyourtime-client-legacy-compose deleted/);
    const again = fakeWorld({ apps: world.state.apps, routes: world.state.routes, secrets: world.state.secrets, packageExists: world.state.packageExists });
    const result = await retire(again.deps, { dryRun: false });
    assert.equal(result.ok, true);
    assert.deepEqual(again.calls, ["confirm", "github:package", ...CLIENT_SECRETS.map((name) => `github:secret:${name}`)]);
  });

  it("has nothing to do once everything is gone, and does not ask", async () => {
    const world = fakeWorld({ apps: [serverApp], routes: [{ id: "r-site", pattern: SITE_ROUTE, script: WORKER }], secrets: [], packageExists: false });
    const result = await retire(world.deps, { dryRun: false });
    assert.deepEqual(result, { ok: true, done: [], refusals: [] });
    assert.deepEqual(world.calls, []);
  });
});

describe("guards", () => {
  it("reads hosts from fqdn lists and compose domains", () => {
    assert.deepEqual(appHosts({ fqdn: "https://trackyourtime.dev, http://trackyourtime.dev:443" }), ["trackyourtime.dev"]);
    assert.deepEqual(appHosts(legacyApp), ["trackyourtime.dev"]);
    assert.deepEqual(appHosts({ fqdn: "" }), []);
  });

  it("accepts the client image app and the legacy Compose app, never the self-host image", () => {
    assert.equal(clientAppProblem(imageApp), null);
    assert.equal(clientAppProblem(legacyApp), null);
    assert.match(clientAppProblem({ ...imageApp, dockerRegistryImageName: `${IMAGE}-selfhost:latest` }), /neither pulls/);
  });
});
