/**
 * Activating the web app's Worker version and rolling it back
 * (scripts/lib/worker-deploy.mjs), against a fake Cloudflare API and a fake
 * pair of live hosts whose `/version.json` follows the active version. No
 * network.
 *
 * Run by the server package's `test` script (`pnpm test:unit`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { activate, CLOUDFLARE_API, versionForSha, workerNameFromConfig } from "./worker-deploy.mjs";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const WEB = "https://trackyourtime.dev";
const API = "https://api.trackyourtime.dev";
const TOKEN = "cf-worker-token";
const CONFIG = Object.freeze({
  accountId: "acc",
  apiToken: TOKEN,
  worker: "trackyourtime-client",
  webUrl: WEB,
  apiUrl: API,
  pollAttempts: 3,
  pollIntervalMs: 0,
  gateAttempts: 2,
  gateIntervalMs: 0,
});

/**
 * - `versions`: uploads, newest first, `{ id, sha }`.
 * - `active`: the version id serving now.
 * - `broken`: version ids whose `/version.json` names the wrong API.
 * - `refuseDeploy`: version ids Cloudflare refuses to deploy.
 */
const fakeWorld = ({ versions, active, broken = [], refuseDeploy = [], split = false }) => {
  const state = { active };
  const deployed = [];
  const reply = (status, body, headers = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });
  const fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const base = `${CLOUDFLARE_API}/accounts/acc/workers/scripts/trackyourtime-client`;
    if (url.startsWith(base)) {
      assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      const path = url.slice(base.length);
      if (method === "GET" && path.startsWith("/versions")) {
        return reply(200, {
          success: true,
          result: { items: versions.map((v) => ({ id: v.id, annotations: { "workers/tag": v.sha, "workers/triggered_by": "version_upload" } })) },
        });
      }
      if (method === "GET" && path === "/deployments") {
        const shares = split ? [{ version_id: state.active, percentage: 50 }, { version_id: "other", percentage: 50 }] : [{ version_id: state.active, percentage: 100 }];
        return reply(200, { success: true, result: { deployments: state.active ? [{ id: "dep", versions: shares }] : [] } });
      }
      if (method === "POST" && path === "/deployments") {
        const body = JSON.parse(init.body);
        const id = body.versions[0].version_id;
        assert.equal(body.versions[0].percentage, 100);
        if (refuseDeploy.includes(id)) return reply(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
        state.active = id;
        deployed.push(id);
        return reply(200, { success: true, result: { id: `dep-${id}` } });
      }
      throw new Error(`unexpected Cloudflare call ${method} ${path}`);
    }
    const path = url.split("?")[0];
    if (path === `${WEB}/version.json`) {
      const version = versions.find((v) => v.id === state.active);
      return reply(200, { commit: version?.sha ?? "", version: "0.3.0", apiUrl: broken.includes(state.active) ? "https://wrong.example" : API });
    }
    if (path === `${API}/api/health`) return reply(200, { status: "ok", db: true, commit: NEW });
    if (path === `${API}/api/auth/get-session` && method === "OPTIONS") return reply(204, "", { "access-control-allow-origin": WEB });
    if (path === `${API}/api/auth/get-session`) return reply(200, "null");
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  const lines = [];
  return { deps: { fetch, sleep: async () => {}, log: (line) => lines.push(line) }, state, deployed, lines };
};

describe("activate", () => {
  it("deploys the version tagged with the commit and passes the gate", async () => {
    const world = fakeWorld({ versions: [{ id: "v2", sha: NEW }, { id: "v1", sha: OLD }], active: "v1" });
    const result = await activate(world.deps, CONFIG, { sha: NEW, rollback: true });
    assert.deepEqual(result, { ok: true, errors: [] });
    assert.deepEqual(world.deployed, ["v2"]);
  });

  it("changes nothing when no version was uploaded for the commit", async () => {
    const world = fakeWorld({ versions: [{ id: "v1", sha: OLD }], active: "v1" });
    const result = await activate(world.deps, CONFIG, { sha: NEW, rollback: true });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /no version of trackyourtime-client was uploaded for b{40}/);
    assert.deepEqual(world.deployed, []);
  });

  it("rolls back to the version that served before when the gate fails", async () => {
    const world = fakeWorld({ versions: [{ id: "v2", sha: NEW }, { id: "v1", sha: OLD }], active: "v1", broken: ["v2"] });
    const result = await activate(world.deps, CONFIG, { sha: NEW, rollback: true });
    assert.equal(result.ok, false);
    assert.deepEqual(world.deployed, ["v2", "v1"]);
    assert.equal(world.state.active, "v1");
    assert.match(result.errors[0], /failed the deploy gate \(web-api-url\); rolled back to version v1 \(a{40}\), which passed the gate/);
    assert.match(result.errors[0], /The API server keeps/);
  });

  it("leaves the new version live without --rollback", async () => {
    const world = fakeWorld({ versions: [{ id: "v2", sha: NEW }, { id: "v1", sha: OLD }], active: "v1", broken: ["v2"] });
    const result = await activate(world.deps, CONFIG, { sha: NEW, rollback: false });
    assert.equal(result.ok, false);
    assert.deepEqual(world.deployed, ["v2"]);
    assert.match(result.errors[0], /version v2 stays live, since no rollback was requested/);
  });

  it("has nothing to roll back to on a split deployment", async () => {
    const world = fakeWorld({ versions: [{ id: "v2", sha: NEW }, { id: "v1", sha: OLD }], active: "v1", broken: ["v2"], split: true });
    const result = await activate(world.deps, CONFIG, { sha: NEW, rollback: true });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /nothing to roll back to \(deployment dep splits traffic between versions\)/);
  });

  it("reports a refused deploy as a failed gate and restores", async () => {
    const world = fakeWorld({ versions: [{ id: "v2", sha: NEW }, { id: "v1", sha: OLD }], active: "v1", refuseDeploy: ["v2"] });
    const result = await activate(world.deps, CONFIG, { sha: NEW, rollback: true });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /\(deploy\)/);
    assert.match(result.errors[1], /Authentication error/);
    assert.equal(world.state.active, "v1");
  });

  it("gates a version that is already live without deploying it again", async () => {
    const world = fakeWorld({ versions: [{ id: "v2", sha: NEW }], active: "v2" });
    const result = await activate(world.deps, CONFIG, { sha: NEW, rollback: true });
    assert.deepEqual(result, { ok: true, errors: [] });
    assert.deepEqual(world.deployed, []);
  });
});

describe("helpers", () => {
  it("picks the newest upload of a commit", () => {
    const versions = [
      { id: "v3", annotations: { "workers/tag": NEW } },
      { id: "v2", annotations: { "workers/tag": NEW } },
      { id: "v1", annotations: { "workers/tag": OLD } },
    ];
    assert.equal(versionForSha(versions, NEW).id, "v3");
    assert.equal(versionForSha(versions, "c".repeat(40)), null);
  });

  it("reads the Worker name from wrangler.jsonc, comments and all", () => {
    const text = `// a comment with "quotes"\n{\n  /* block */ "name": "trackyourtime-client", // trailing\n  "url": "https://x.dev/a//b",\n}\n`;
    assert.equal(workerNameFromConfig(text), "trackyourtime-client");
  });
});
