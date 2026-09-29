/**
 * The hosted deploy's gate and rollback (scripts/lib/coolify-deploy.mjs)
 * against a fake GHCR, a fake Coolify webhook and a fake pair of deployed
 * apps. No network.
 *
 * Run by the server package's `test` script (`pnpm test:unit`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

import {
  commitProblems,
  deployWithRollback,
  gateProblems,
  healthProblems,
  imageRef,
  parseWhich,
  planRollback,
  serverDowngradeBlock,
  shaFromImage,
  verifyOnly,
  WATCH_PATH,
  webhookBody,
  webhookQueued,
} from "./coolify-deploy.mjs";

const OWNER = "trebeljahr/trackyourtime";
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const OLDER = "c".repeat(40);
const WEB = "https://trackyourtime.dev";
const API = "https://api.trackyourtime.dev";
const COOLIFY = "https://coolify.test";
const GH_TOKEN = "ghs_registry-password";
const INDEX = "application/vnd.oci.image.index.v1+json";

const HOOKS = Object.freeze({
  server: { uuid: "srv-uuid", secret: "server-hook-secret", repository: OWNER, branch: "main" },
  client: { uuid: "cli-uuid", secret: "client-hook-secret", repository: OWNER, branch: "main" },
});

const contract = (schemaVersion, migrations = []) => ({ schemaVersion, migrations });
const migration = (id, minReaderSchema) => ({ id, file: `${String(id).padStart(3, "0")}-m.ts`, minReaderSchema });

/** Registries per sha. OLD and NEW are both at schema 1 unless a test says otherwise. */
const contractsFrom = (table) => (sha) => {
  if (!(sha in table)) throw new Error(`commit ${sha} is not in this checkout`);
  return table[sha];
};
const sameSchema = contractsFrom({
  [OLD]: contract(1, [migration(1, 0)]),
  [NEW]: contract(1, [migration(1, 0)]),
  [OLDER]: contract(1, [migration(1, 0)]),
});

/** The manifest the build pushed as `<app>:<sha>` — distinct bytes per build. */
const manifestFor = (app, sha) => JSON.stringify({ schemaVersion: 2, mediaType: INDEX, manifests: [{ digest: `sha256:${app}-${sha}` }] });
const shaOfManifest = (body) => (body ? /-([0-9a-f]{40})"/.exec(body)?.[1] ?? null : null);

/**
 * GHCR, Coolify's manual webhook and the two apps it runs. An app serves
 * whatever its `:live` tag named when its deploy was queued, as a compose app
 * with `pull_policy: always` does; `broken` makes a commit answer badly.
 *
 * - `built`: the commits whose `:<sha>` images exist.
 * - `stuck`: apps whose deploy is queued and never lands.
 * - `failPromoteFor`: the app whose `:live` PUT the registry refuses.
 */
const fakeWorld = ({ served = { server: OLD, client: OLD }, built = [OLD, NEW, OLDER], broken = {}, stuck = [], failPromoteFor = null } = {}) => {
  const tags = {};
  for (const app of ["server", "client"]) {
    tags[app] = new Map(built.map((sha) => [sha, manifestFor(app, sha)]));
    if (served[app] !== null) tags[app].set("live", manifestFor(app, served[app]));
  }
  const live = { ...served };
  const calls = [];
  const webhooks = [];

  const reply = (status, body, headers = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => (body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)),
  });

  const registry = (u, init, method) => {
    if (u.pathname === "/v2/") {
      return reply(401, "", { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:user/image:pull"' });
    }
    if (u.pathname === "/token") {
      const basic = Buffer.from(`octocat:${GH_TOKEN}`).toString("base64");
      if (init.headers?.Authorization !== `Basic ${basic}`) return reply(401, { errors: [{ code: "UNAUTHORIZED" }] });
      return reply(200, { token: "registry-bearer" });
    }
    const match = /^\/v2\/trebeljahr\/trackyourtime-(server|client)\/manifests\/([\w.-]+)$/.exec(u.pathname);
    if (!match) return reply(404, "");
    if (init.headers?.Authorization !== "Bearer registry-bearer") return reply(401, "");
    const [, app, reference] = match;
    if (method === "GET") {
      const body = tags[app].get(reference);
      if (body === undefined) return reply(404, { errors: [{ code: "MANIFEST_UNKNOWN" }] });
      return reply(200, body, { "content-type": INDEX, "docker-content-digest": `sha256:${createHash("sha256").update(body).digest("hex")}` });
    }
    if (method === "PUT") {
      if (failPromoteFor === app) return reply(500, "");
      assert.equal(init.headers["Content-Type"], INDEX, "the manifest is written back with its own media type");
      tags[app].set(reference, init.body);
      return reply(201, "");
    }
    return reply(405, "");
  };

  const coolify = (u, init, method) => {
    if (u.pathname !== "/webhooks/source/github/events/manual" || method !== "POST") return reply(401, { message: "Unauthenticated." });
    const payload = JSON.parse(init.body);
    const entries = [];
    for (const [app, hook] of Object.entries(HOOKS)) {
      if (payload.repository.full_name !== hook.repository || payload.ref !== `refs/heads/${hook.branch}`) continue;
      const expected = `sha256=${createHmac("sha256", hook.secret).update(init.body).digest("hex")}`;
      if (init.headers["X-Hub-Signature-256"] !== expected) {
        entries.push({ application_uuid: hook.uuid, status: "failed", message: "Invalid signature." });
        continue;
      }
      if (!payload.commits.some((commit) => commit.modified.includes(WATCH_PATH))) {
        entries.push({ application_uuid: hook.uuid, status: "failed", message: "Changed files do not match watch paths." });
        continue;
      }
      webhooks.push(`${app} ${payload.after}`);
      if (!stuck.includes(app)) live[app] = shaOfManifest(tags[app].get("live"));
      entries.push({ application_uuid: hook.uuid, status: "success", message: "Deployment queued." });
    }
    return reply(200, entries);
  };

  const fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const u = new URL(url);
    if (u.origin === "https://ghcr.io") {
      calls.push(`${method} ghcr${u.pathname}`);
      return registry(u, init, method);
    }
    if (u.origin === COOLIFY) {
      calls.push(`${method} coolify${u.pathname}`);
      return coolify(u, init, method);
    }
    const serverBroken = broken[live.server] ?? {};
    const clientBroken = broken[live.client] ?? {};
    if (url.startsWith(`${API}/api/health`)) {
      if (serverBroken.down || live.server === null) return reply(503, "no available server");
      return reply(200, { status: "ok", db: !serverBroken.noDb, commit: live.server, version: live.server });
    }
    if (url.startsWith(`${WEB}/version.json`)) {
      if (live.client === null) return reply(503, "no available server");
      return reply(200, { commit: live.client, apiUrl: clientBroken.wrongApi ? "" : API });
    }
    if (url.startsWith(`${API}/api/auth/get-session`)) {
      if (method === "OPTIONS") return reply(204, undefined, { "access-control-allow-origin": WEB });
      return reply(serverBroken.authDown ? 500 : 200, "null");
    }
    return reply(404, "not found");
  };
  /** The commit each app's `:live` names now. */
  const liveTags = () => ({ server: shaOfManifest(tags.server.get("live")), client: shaOfManifest(tags.client.get("live")) });
  return { fetch, calls, webhooks, live, liveTags };
};

const config = {
  coolifyBaseUrl: COOLIFY,
  hooks: HOOKS,
  registryAuth: { username: "octocat", password: GH_TOKEN },
  ownerRepo: OWNER,
  webUrl: WEB,
  apiUrl: API,
  pollAttempts: 3,
  pollIntervalMs: 0,
  gateAttempts: 2,
  gateIntervalMs: 0,
};

/** A fresh config per run: registry tokens are cached per config object. */
const configWith = (overrides = {}) => ({ ...config, ...overrides });

const depsFor = (world, contractAt = sameSchema) => {
  const lines = [];
  return { deps: { fetch: world.fetch, sleep: async () => {}, log: (line) => lines.push(line), contractAt }, lines };
};

const writes = (world) => world.calls.filter((call) => call.startsWith("PUT") || call.startsWith("POST"));

describe("image references", () => {
  it("reads a sha only from an immutable tag", () => {
    assert.equal(shaFromImage(imageRef(OWNER, "server", OLD)), OLD);
    assert.equal(shaFromImage(`ghcr.io/${OWNER}-server:main`), null);
    assert.equal(shaFromImage(`ghcr.io/${OWNER}-server:live`), null);
    assert.equal(shaFromImage(`ghcr.io/${OWNER}-server:${OLD.slice(0, 12)}`), null);
    assert.equal(shaFromImage(null), null);
  });

  it("parses which", () => {
    assert.deepEqual(parseWhich("both"), ["server", "client"]);
    assert.deepEqual(parseWhich(undefined), ["server", "client"]);
    assert.deepEqual(parseWhich("client"), ["client"]);
    assert.throws(() => parseWhich("everything"));
  });
});

describe("gate", () => {
  const healthy = {
    health: { status: "ok", db: true, commit: NEW, version: NEW },
    version: { commit: NEW, apiUrl: API },
    sessionStatus: 200,
    corsAllowOrigin: WEB,
  };
  const expected = { serverSha: NEW, clientSha: NEW, apiUrl: API, webUrl: WEB };

  it("passes a healthy pair", () => {
    assert.deepEqual(gateProblems(healthy, expected), []);
  });

  it("reads the commit from an older image's `version` field", () => {
    const older = { ...healthy, health: { status: "ok", db: true, version: NEW } };
    assert.deepEqual(gateProblems(older, expected), []);
  });

  it("names every failed check", () => {
    const names = gateProblems(
      { health: { status: "degraded", db: false, version: OLD }, version: { commit: NEW, apiUrl: "" }, sessionStatus: 500, corsAllowOrigin: null },
      expected,
    ).map((line) => line.slice(0, line.indexOf(":")));
    assert.deepEqual(names, ["api-commit", "api-status", "api-db", "web-api-url", "auth-session", "cors"]);
  });

  it("does not ask for a commit from an app that was not deployed", () => {
    assert.deepEqual(gateProblems({ ...healthy, health: { ...healthy.health, version: OLD } }, { ...expected, serverSha: null }), []);
  });

  it("counts an app that answered nothing as not landed while its commit is expected", () => {
    // A 502 from the proxy or a refused connection reads as no body. That is
    // no commit either, so the poll must keep waiting rather than hand the
    // silent app to the gate.
    const silent = gateProblems({ ...healthy, health: null, version: null }, expected);
    assert.deepEqual(silent.map((line) => line.slice(0, line.indexOf(":"))), ["api-commit", "api-health", "web-commit", "web-version"]);
    assert.deepEqual(commitProblems(silent).map((line) => line.slice(0, line.indexOf(":"))), ["api-commit", "web-commit"]);
    // With no commit expected from it, a silent app is a gate failure only.
    assert.deepEqual(healthProblems(null, null), ["api-health: no JSON answer from /api/health"]);
    assert.deepEqual(commitProblems(gateProblems({ ...healthy, health: null }, { ...expected, serverSha: null })), []);
  });
});

describe("migrations and server rollback", () => {
  it("allows a downgrade over additive migrations", () => {
    const contractAt = contractsFrom({
      [OLD]: contract(1, [migration(1, 0)]),
      [NEW]: contract(2, [migration(1, 0), migration(2, 0)]),
    });
    assert.equal(serverDowngradeBlock(contractAt, OLD, NEW), null);
  });

  it("blocks a downgrade past a migration that raised minReaderSchema", () => {
    const contractAt = contractsFrom({
      [OLD]: contract(1, [migration(1, 0)]),
      [NEW]: contract(2, [migration(1, 0), migration(2, 2)]),
    });
    assert.match(serverDowngradeBlock(contractAt, OLD, NEW), /migration 2 .*minReaderSchema 2.*SCHEMA_VERSION 1/);
  });

  it("blocks when a registry cannot be read", () => {
    const contractAt = contractsFrom({ [NEW]: contract(1, [migration(1, 0)]) });
    assert.match(serverDowngradeBlock(contractAt, OLD, NEW), /could not be compared.*not in this checkout/);
  });

  it("plans a client-only rollback when the server cannot go back", () => {
    const contractAt = contractsFrom({
      [OLD]: contract(1, [migration(1, 0)]),
      [NEW]: contract(2, [migration(1, 0), migration(2, 2)]),
    });
    const plan = planRollback({
      apps: ["server", "client"],
      served: { server: OLD, client: OLD },
      inRegistry: { server: true, client: true },
      targetSha: NEW,
      contractAt,
    });
    assert.deepEqual(plan.restore, { client: OLD });
    assert.match(plan.skipped.server, /refuse to start/);
  });

  it("has no target for a first deploy, a pruned image or the same sha", () => {
    const plan = planRollback({
      apps: ["server", "client"],
      served: { server: null, client: OLD },
      inRegistry: { server: false, client: false },
      targetSha: NEW,
      contractAt: sameSchema,
    });
    assert.deepEqual(plan.restore, {});
    assert.match(plan.skipped.server, /reported no commit/);
    assert.match(plan.skipped.client, /no longer in the registry/);
    const same = planRollback({ apps: ["client"], served: { client: NEW }, inRegistry: { client: true }, targetSha: NEW, contractAt: sameSchema });
    assert.match(same.skipped.client, /already serving/);
  });
});

describe("the signed webhook", () => {
  it("names the sentinel watch path and the commit", () => {
    assert.deepEqual(JSON.parse(webhookBody(HOOKS.server, NEW)), {
      ref: "refs/heads/main",
      after: NEW,
      repository: { full_name: OWNER },
      commits: [{ id: NEW, added: [], removed: [], modified: [".hatchkit/deploy-webhook"] }],
    });
  });

  it("counts only this app's queued deploy", () => {
    const other = { application_uuid: "cli-uuid", status: "failed", message: "Invalid signature." };
    assert.equal(webhookQueued(JSON.stringify([{ application_uuid: "srv-uuid", status: "success" }, other]), "srv-uuid").ok, true);
    assert.equal(webhookQueued(JSON.stringify([{ application_uuid: "srv-uuid", status: "skipped" }]), "srv-uuid").ok, true);
    assert.equal(webhookQueued(JSON.stringify([{ application_uuid: "cli-uuid", status: "success" }]), "srv-uuid").ok, false);
    assert.match(webhookQueued(JSON.stringify([other]), "srv-uuid").detail, /signature matched no app/);
    assert.match(webhookQueued(JSON.stringify([]), "srv-uuid").detail, /no app matched/);
    assert.match(
      webhookQueued(JSON.stringify([{ application_uuid: "srv-uuid", status: "failed", message: "Deployments disabled." }, other]), "srv-uuid").detail,
      /^failed: Deployments disabled\.$/,
    );
    assert.equal(webhookQueued("Nothing to do.", "srv-uuid").ok, false);
  });
});

describe("deployWithRollback", () => {
  it("promotes :live, deploys through the signed webhooks and passes a healthy build", async () => {
    const world = fakeWorld();
    const { deps, lines } = depsFor(world);
    const result = await deployWithRollback(deps, configWith(), { targetSha: NEW, apps: ["server", "client"], rollback: true });
    assert.deepEqual(result, { ok: true, errors: [] });
    assert.deepEqual(world.liveTags(), { server: NEW, client: NEW });
    // Server before client, as the workflow has always deployed them.
    assert.deepEqual(world.webhooks, [`server ${NEW}`, `client ${NEW}`]);
    assert.deepEqual(writes(world), [
      "PUT ghcr/v2/trebeljahr/trackyourtime-server/manifests/live",
      "PUT ghcr/v2/trebeljahr/trackyourtime-client/manifests/live",
      "POST coolify/webhooks/source/github/events/manual",
      "POST coolify/webhooks/source/github/events/manual",
    ]);
    assert.ok(!world.calls.some((call) => call.includes("coolify/api/")), "the Coolify API is never called");
    const log = lines.join("\n");
    for (const secret of [HOOKS.server.secret, HOOKS.client.secret, GH_TOKEN]) assert.ok(!log.includes(secret), "no secret is logged");
  });

  it("restores the previous builds when the gate fails, and still fails", async () => {
    const world = fakeWorld({ broken: { [NEW]: { noDb: true } } });
    const { deps } = depsFor(world);
    const result = await deployWithRollback(deps, configWith(), { targetSha: NEW, apps: ["server", "client"], rollback: true });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], new RegExp(`^${NEW} failed the deploy gate \\(api-db\\); rolled back to server ${OLD}, client ${OLD}`));
    assert.deepEqual(world.liveTags(), { server: OLD, client: OLD });
    assert.deepEqual(world.live, { server: OLD, client: OLD });
    assert.deepEqual(world.webhooks, [`server ${NEW}`, `client ${NEW}`, `server ${OLD}`, `client ${OLD}`]);
  });

  it("rolls back a deploy that never landed", async () => {
    // The server keeps answering with the old commit: the poll times out.
    const world = fakeWorld({ stuck: ["server"] });
    const { deps } = depsFor(world);
    const result = await deployWithRollback(deps, configWith(), { targetSha: NEW, apps: ["server", "client"], rollback: true });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /failed the deploy gate \(api-commit\); rolled back to server/);
    assert.deepEqual(world.liveTags(), { server: OLD, client: OLD });
  });

  it("keeps polling through a proxy 502 and a refused connection until the server answers", async () => {
    // The first look (the rollback target) is healthy. Then the first poll
    // gets a 502 from the proxy (a container swap), the second no answer at
    // all (a server booting behind it), the third the new commit.
    const world = fakeWorld();
    const fetch = world.fetch;
    let looks = 0;
    const flaky = {
      ...world,
      fetch: async (url, init) => {
        if (url.startsWith(`${API}/api/health`)) {
          looks += 1;
          if (looks === 2) return { status: 502, ok: false, headers: { get: () => null }, text: async () => "Bad Gateway" };
          if (looks === 3) throw new TypeError("fetch failed");
        }
        return fetch(url, init);
      },
    };
    const { deps, lines } = depsFor(flaky);
    const result = await deployWithRollback(deps, configWith(), { targetSha: NEW, apps: ["server", "client"], rollback: true });
    assert.deepEqual(result, { ok: true, errors: [] });
    assert.equal(looks, 1 + config.pollAttempts, "every poll attempt was used before the commit matched");
    const waiting = lines.filter((line) => line.includes("waiting ("));
    assert.equal(waiting.length, 2);
    assert.ok(waiting.every((line) => /api-commit: \/api\/health gave no answer/.test(line)), waiting.join("\n"));
    // The commit is reported only after a body named it, and after the waits.
    const reported = lines.findIndex((line) => line === `✓ server reports ${NEW}`);
    assert.ok(reported > lines.lastIndexOf(waiting.at(-1)), lines.join("\n"));
  });

  it("gives a server that never answers the whole poll, then fails on the commit", async () => {
    const world = fakeWorld({ broken: { [NEW]: { down: true } } });
    const { deps, lines } = depsFor(world);
    const result = await deployWithRollback(deps, configWith(), { targetSha: NEW, apps: ["server", "client"], rollback: false });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /failed the deploy gate \(api-commit, api-health\); it stays on :live/);
    assert.deepEqual(world.liveTags(), { server: NEW, client: NEW });
    // Every poll attempt, and never the gate: the poll gave up, not the gate.
    assert.equal(lines.filter((line) => line.includes("waiting (")).length, config.pollAttempts);
    assert.ok(!lines.some((line) => line.includes("gate (")), "the gate never ran for a server that never landed");
    assert.ok(!lines.some((line) => line.startsWith("✓ server reports")), "no commit was reported for a server that never answered");
  });

  it("keeps the new server and restores only the client when a migration forbids the downgrade", async () => {
    const contractAt = contractsFrom({
      [OLD]: contract(1, [migration(1, 0)]),
      [NEW]: contract(2, [migration(1, 0), migration(2, 2)]),
    });
    const world = fakeWorld({ broken: { [NEW]: { wrongApi: true } } });
    const { deps } = depsFor(world, contractAt);
    const result = await deployWithRollback(deps, configWith(), { targetSha: NEW, apps: ["server", "client"], rollback: true });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], new RegExp(`rolled back to client ${OLD}, which passed the gate`));
    assert.ok(result.errors.some((line) => /server: not rolled back: .*refuse to start/.test(line)));
    assert.deepEqual(world.live, { server: NEW, client: OLD });
    assert.deepEqual(world.liveTags(), { server: NEW, client: OLD });
  });

  it("fails loudly when the served build is no longer in the registry", async () => {
    const world = fakeWorld({ built: [NEW], broken: { [NEW]: { authDown: true } } });
    const { deps } = depsFor(world);
    const result = await deployWithRollback(deps, configWith(), { targetSha: NEW, apps: ["server", "client"], rollback: true });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /\(auth-session\); nothing was rolled back/);
    assert.ok(result.errors.some((line) => /server: it served a{40}, and that image is no longer in the registry/.test(line)));
    assert.equal(world.webhooks.length, 2, "no second deploy");
  });

  it("reports a rollback that fails its own gate, once", async () => {
    const world = fakeWorld({ broken: { [NEW]: { noDb: true }, [OLD]: { noDb: true } } });
    const { deps } = depsFor(world);
    const result = await deployWithRollback(deps, configWith(), { targetSha: NEW, apps: ["server", "client"], rollback: true });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /ROLLBACK to server .* FAILED its own gate/);
    assert.equal(world.webhooks.length, 4, "one deploy and one rollback, no loop");
  });

  it("restores a half-applied promote", async () => {
    const world = fakeWorld({ failPromoteFor: "client" });
    const { deps } = depsFor(world);
    const result = await deployWithRollback(deps, configWith(), { targetSha: NEW, apps: ["server", "client"], rollback: true });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /\(promote-or-deploy\)/);
    assert.match(result.errors[0], /FAILED while promoting/, "the client's :live cannot be written back either");
    assert.equal(world.liveTags().server, OLD, "the server's :live was put back");
    assert.deepEqual(world.live, { server: OLD, client: OLD }, "nothing was deployed");
  });

  it("puts :live back when Coolify does not queue a deploy", async () => {
    // A stale secret on the client: Coolify answers "Invalid signature." for
    // every app, and the client never deploys.
    const world = fakeWorld();
    const { deps, lines } = depsFor(world);
    const stale = configWith({ hooks: { ...HOOKS, client: { ...HOOKS.client, secret: "stale-client-secret" } } });
    const result = await deployWithRollback(deps, stale, { targetSha: NEW, apps: ["server", "client"], rollback: true });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /\(promote-or-deploy\).*FAILED while promoting or deploying \(the client app's deploy was not queued: the signature matched no app/);
    assert.deepEqual(world.liveTags(), { server: OLD, client: OLD });
    assert.deepEqual(world.live, { server: OLD, client: OLD });
    assert.ok(!lines.join("\n").includes("stale-client-secret"), "the secret is not logged");
  });

  it("changes nothing when the new image was never pushed", async () => {
    const world = fakeWorld({ built: [OLD] });
    const { deps } = depsFor(world);
    const result = await deployWithRollback(deps, configWith(), { targetSha: NEW, apps: ["server", "client"], rollback: true });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /trackyourtime-server:b{40} is not in the registry.*nothing was changed/);
    assert.deepEqual(writes(world), []);
  });

  it("changes nothing when the registry refuses the token", async () => {
    const world = fakeWorld();
    const { deps } = depsFor(world);
    const result = await deployWithRollback(deps, configWith({ registryAuth: { username: "octocat", password: "wrong" } }), {
      targetSha: NEW,
      apps: ["server", "client"],
      rollback: true,
    });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /ghcr\.io refused a registry token \(401\)\); nothing was changed/);
    assert.deepEqual(writes(world), []);
  });

  it("refuses a manual server downgrade past a breaking migration before touching anything", async () => {
    const contractAt = contractsFrom({
      [OLDER]: contract(1, [migration(1, 0)]),
      [OLD]: contract(2, [migration(1, 0), migration(2, 2)]),
    });
    const world = fakeWorld();
    const { deps } = depsFor(world, contractAt);
    const request = { targetSha: OLDER, apps: ["server", "client"], rollback: true, guardServerDowngrade: true };
    const refused = await deployWithRollback(deps, configWith(), request);
    assert.equal(refused.ok, false);
    assert.match(refused.errors[0], /refusing to deploy the server/);
    assert.deepEqual(writes(world), [], "nothing promoted or deployed");

    const forced = await deployWithRollback(deps, configWith(), { ...request, forceServer: true });
    assert.equal(forced.ok, true);
    assert.deepEqual(world.live, { server: OLDER, client: OLDER });
  });

  it("deploys one app by hand and gates the pair", async () => {
    const world = fakeWorld();
    const { deps } = depsFor(world);
    const result = await deployWithRollback(deps, configWith(), { targetSha: OLDER, apps: ["client"], rollback: true, guardServerDowngrade: true });
    assert.equal(result.ok, true);
    assert.deepEqual(world.live, { server: OLD, client: OLDER });
    assert.deepEqual(world.liveTags(), { server: OLD, client: OLDER });
    assert.deepEqual(world.webhooks, [`client ${OLDER}`]);
    assert.ok(!writes(world).some((call) => call.includes("trackyourtime-server")));
  });

  it("refuses a short sha", async () => {
    const { deps } = depsFor(fakeWorld());
    const result = await deployWithRollback(deps, configWith(), { targetSha: NEW.slice(0, 12), apps: ["client"], rollback: true });
    assert.equal(result.ok, false);
  });
});

describe("verifyOnly", () => {
  it("gates whatever is serving, without Coolify", async () => {
    const world = fakeWorld();
    const { deps } = depsFor(world);
    assert.equal((await verifyOnly(deps, config, OLD)).ok, true);
    const failed = await verifyOnly(deps, config, NEW);
    assert.equal(failed.ok, false);
    assert.match(failed.errors.join("\n"), /api-commit/);
    assert.deepEqual(world.calls, []);
  });
});
