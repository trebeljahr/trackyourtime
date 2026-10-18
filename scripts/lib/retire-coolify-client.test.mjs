/**
 * Retiring the Coolify client app (scripts/lib/retire-coolify-client.mjs)
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
  COOLIFY_APP,
  COOLIFY_LAST_COMMIT,
  retire,
  SITE_ROUTE,
  WORKER,
} from "./retire-coolify-client.mjs";

const LIVE = "c".repeat(40);
const AFTER_SOAK = new Date("2026-10-26T09:00:00Z");

const fakeWorld = ({
  now = AFTER_SOAK,
  routes = [
    { id: "r-site", pattern: SITE_ROUTE, script: WORKER },
    { id: "r-acme", pattern: ACME_ROUTE, script: null },
  ],
  served = LIVE,
  onMain = true,
  apps = [
    { uuid: "app-client", name: COOLIFY_APP, fqdn: "https://trackyourtime.dev" },
    { uuid: "app-server", name: "trackyourtime-server", fqdn: "https://api.trackyourtime.dev" },
  ],
  secrets = [...CLIENT_SECRETS, "COOLIFY_SERVER_DEPLOY_SECRET", "CLOUDFLARE_API_TOKEN"],
  failRouteDelete = false,
} = {}) => {
  const calls = [];
  const state = { apps: [...apps], routes: [...routes], secrets: [...secrets] };
  const deps = {
    coolify: {
      listApplications: async () => state.apps.map(({ uuid, name }) => ({ uuid, name })),
      getApplication: async (uuid) => state.apps.find((app) => app.uuid === uuid),
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
        if (failRouteDelete) throw new Error("403 forbidden");
        calls.push(`cloudflare:delete:${id}`);
        state.routes = state.routes.filter((route) => route.id !== id);
        return "deleted";
      },
    },
    github: {
      listSecrets: async () => state.secrets.map((name) => ({ name })),
      deleteSecret: async (repo, name) => {
        calls.push(`github:delete:${name}`);
        state.secrets = state.secrets.filter((secret) => secret !== name);
        return "done";
      },
    },
    fetch: async () => ({ status: 200, json: async () => ({ commit: served, apiUrl: "https://api.trackyourtime.dev" }) }),
    onMain: () => onMain,
    reconcileBackups: async (uuids) => {
      calls.push(`backups:${uuids.join(",")}`);
      return [];
    },
    now: () => now,
    log: () => {},
  };
  return { deps, calls, state };
};

describe("retire", () => {
  it("audits without changing anything", async () => {
    const world = fakeWorld();
    const result = await retire(world.deps, { execute: false });
    assert.deepEqual(result, { ok: true, done: [], refusals: [] });
    assert.deepEqual(world.calls, []);
  });

  it("deletes the app, then the ACME route, then the client secrets, in that order", async () => {
    const world = fakeWorld();
    const result = await retire(world.deps, { execute: true });
    assert.equal(result.ok, true);
    assert.deepEqual(world.calls, [
      "coolify:delete:app-client",
      "backups:app-client",
      "cloudflare:delete:r-acme",
      ...CLIENT_SECRETS.map((name) => `github:delete:${name}`),
    ]);
    assert.deepEqual(world.state.secrets, ["COOLIFY_SERVER_DEPLOY_SECRET", "CLOUDFLARE_API_TOKEN"]);
    assert.ok(world.state.apps.some((app) => app.name === "trackyourtime-server"));
    assert.ok(world.state.routes.some((route) => route.pattern === SITE_ROUTE));
  });

  it("refuses during the soak unless --early", async () => {
    const world = fakeWorld({ now: new Date("2026-10-20T09:00:00Z") });
    const refused = await retire(world.deps, { execute: true });
    assert.equal(refused.ok, false);
    assert.match(refused.refusals[0], /soak runs until 2026-10-25/);
    assert.deepEqual(world.calls, []);
    const early = await retire(world.deps, { execute: true, early: true });
    assert.equal(early.ok, true);
  });

  it("refuses while Coolify still serves the site", async () => {
    for (const world of [
      fakeWorld({ routes: [{ id: "r-acme", pattern: ACME_ROUTE, script: null }] }),
      fakeWorld({ served: COOLIFY_LAST_COMMIT }),
      fakeWorld({ onMain: false }),
    ]) {
      const result = await retire(world.deps, { execute: true });
      assert.equal(result.ok, false);
      assert.deepEqual(world.calls, []);
    }
  });

  it("refuses an app that routes more than the apex", async () => {
    const world = fakeWorld({
      apps: [{ uuid: "app-client", name: COOLIFY_APP, fqdn: "https://trackyourtime.dev,https://api.trackyourtime.dev" }],
    });
    const result = await retire(world.deps, { execute: true });
    assert.equal(result.ok, false);
    assert.match(result.refusals[0], /also routes api\.trackyourtime\.dev/);
    assert.deepEqual(world.calls, []);
  });

  it("runs again after a partial run and finishes what is left", async () => {
    const world = fakeWorld({ failRouteDelete: true });
    await assert.rejects(retire(world.deps, { execute: true }), /route .* failed \(403 forbidden\); already done: Coolify app trackyourtime-client deleted/);
    const again = fakeWorld({ apps: world.state.apps, routes: world.state.routes, secrets: world.state.secrets });
    const result = await retire(again.deps, { execute: true });
    assert.equal(result.ok, true);
    assert.deepEqual(again.calls, ["cloudflare:delete:r-acme", ...CLIENT_SECRETS.map((name) => `github:delete:${name}`)]);
  });

  it("is a no-op once everything is gone", async () => {
    const world = fakeWorld({ apps: [], routes: [{ id: "r-site", pattern: SITE_ROUTE, script: WORKER }], secrets: [] });
    const result = await retire(world.deps, { execute: true });
    assert.deepEqual(result, { ok: true, done: [], refusals: [] });
    assert.deepEqual(world.calls, []);
  });
});

describe("appHosts", () => {
  it("reads fqdn lists and compose domains", () => {
    assert.deepEqual(appHosts({ fqdn: "https://trackyourtime.dev, http://trackyourtime.dev:443" }), ["trackyourtime.dev"]);
    assert.deepEqual(appHosts({ fqdn: null, dockerComposeDomains: [{ domain: "https://trackyourtime.dev" }] }), ["trackyourtime.dev"]);
    assert.deepEqual(appHosts({ fqdn: "" }), []);
  });
});
