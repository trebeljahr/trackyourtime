/**
 * The hosted deploy's gate and rollback (scripts/lib/coolify-deploy.mjs)
 * against a fake Coolify and a fake pair of deployed apps. No network.
 *
 * Run by the server package's `test` script (`pnpm test:unit`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  deployWithRollback,
  findEnvValue,
  gateProblems,
  imageRef,
  parseWhich,
  planRollback,
  serverDowngradeBlock,
  shaFromImage,
  verifyOnly,
} from "./coolify-deploy.mjs";

const OWNER = "trebeljahr/trackyourtime";
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const OLDER = "c".repeat(40);
const WEB = "https://trackyourtime.dev";
const API = "https://api.trackyourtime.dev";

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

/**
 * A fake Coolify plus the two apps it runs. A deploy makes the app serve the
 * commit its image variable names; `broken` makes a commit answer badly.
 */
const fakeWorld = ({ pinned = { server: imageRef(OWNER, "server", OLD), client: imageRef(OWNER, "client", OLD) }, broken = {}, readableEnvs = true, failPatchFor = null } = {}) => {
  const envs = { "srv-uuid": { SERVER_IMAGE: pinned.server }, "cli-uuid": { CLIENT_IMAGE: pinned.client } };
  const live = { server: shaFromImage(pinned.server), client: shaFromImage(pinned.client) };
  const calls = [];
  const appOf = { "srv-uuid": "server", "cli-uuid": "client" };
  const envKey = { server: "SERVER_IMAGE", client: "CLIENT_IMAGE" };

  const reply = (status, body, headers = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => (body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)),
  });

  const fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const u = new URL(url);
    if (u.origin === "https://coolify.test") {
      calls.push(`${method} ${u.pathname}${u.search}`);
      const envMatch = /^\/api\/v1\/applications\/([^/]+)\/envs$/.exec(u.pathname);
      if (envMatch && method === "GET") {
        const rows = Object.entries(envs[envMatch[1]]).map(([key, value]) => ({
          key,
          ...(readableEnvs ? { value } : {}),
          is_preview: false,
        }));
        rows.push({ key: envKey[appOf[envMatch[1]]], value: "preview-value", is_preview: true });
        return reply(200, rows);
      }
      if (envMatch && method === "PATCH") {
        const body = JSON.parse(init.body);
        if (failPatchFor === appOf[envMatch[1]]) return reply(500, { message: "nope" });
        envs[envMatch[1]][body.key] = body.value;
        return reply(200, { uuid: "x" });
      }
      if (u.pathname === "/api/v1/deploy" && method === "POST") {
        const uuid = u.searchParams.get("uuid");
        const app = appOf[uuid];
        live[app] = shaFromImage(envs[uuid][envKey[app]]);
        return reply(200, { deployments: [] });
      }
      return reply(404, "not found");
    }
    const serverBroken = broken[live.server] ?? {};
    const clientBroken = broken[live.client] ?? {};
    if (url.startsWith(`${API}/api/health`)) {
      if (serverBroken.down) return reply(503, "no available server");
      return reply(200, { status: "ok", db: !serverBroken.noDb, commit: live.server, version: live.server });
    }
    if (url.startsWith(`${WEB}/version.json`)) {
      return reply(200, { commit: live.client, apiUrl: clientBroken.wrongApi ? "" : API });
    }
    if (url.startsWith(`${API}/api/auth/get-session`)) {
      if (method === "OPTIONS") return reply(204, undefined, { "access-control-allow-origin": WEB });
      return reply(serverBroken.authDown ? 500 : 200, "null");
    }
    return reply(404, "not found");
  };
  return { fetch, calls, envs, live };
};

const config = {
  coolifyBaseUrl: "https://coolify.test",
  coolifyToken: "t",
  uuids: { server: "srv-uuid", client: "cli-uuid" },
  ownerRepo: OWNER,
  webUrl: WEB,
  apiUrl: API,
  pollAttempts: 3,
  pollIntervalMs: 0,
  gateAttempts: 2,
  gateIntervalMs: 0,
};

const depsFor = (world, contractAt = sameSchema) => {
  const lines = [];
  return { deps: { fetch: world.fetch, sleep: async () => {}, log: (line) => lines.push(line), contractAt }, lines };
};

describe("image references", () => {
  it("reads a sha only from an immutable tag", () => {
    assert.equal(shaFromImage(imageRef(OWNER, "server", OLD)), OLD);
    assert.equal(shaFromImage(`ghcr.io/${OWNER}-server:main`), null);
    assert.equal(shaFromImage(`ghcr.io/${OWNER}-server:${OLD.slice(0, 12)}`), null);
    assert.equal(shaFromImage(null), null);
  });

  it("takes the production value of an env var, never the preview copy", () => {
    const rows = [
      { key: "SERVER_IMAGE", value: "preview", is_preview: true },
      { key: "SERVER_IMAGE", value: "prod", is_preview: false },
    ];
    assert.equal(findEnvValue(rows, "SERVER_IMAGE"), "prod");
    assert.equal(findEnvValue([{ key: "SERVER_IMAGE", is_preview: false }], "SERVER_IMAGE"), null);
    assert.equal(findEnvValue([], "SERVER_IMAGE"), null);
    assert.equal(findEnvValue({ message: "Unauthenticated." }, "SERVER_IMAGE"), null);
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
      previous: { server: imageRef(OWNER, "server", OLD), client: imageRef(OWNER, "client", OLD) },
      targetSha: NEW,
      contractAt,
    });
    assert.deepEqual(Object.keys(plan.restore), ["client"]);
    assert.match(plan.skipped.server, /refuse to start/);
  });

  it("has no target for a first deploy, a mutable tag or the same sha", () => {
    const plan = planRollback({
      apps: ["server", "client"],
      previous: { server: null, client: `ghcr.io/${OWNER}-client:main` },
      targetSha: NEW,
      contractAt: sameSchema,
    });
    assert.deepEqual(plan.restore, {});
    assert.match(plan.skipped.server, /no previous SERVER_IMAGE/);
    assert.match(plan.skipped.client, /not pinned to a commit/);
    const same = planRollback({ apps: ["client"], previous: { client: imageRef(OWNER, "client", NEW) }, targetSha: NEW, contractAt: sameSchema });
    assert.match(same.skipped.client, /already/);
  });
});

describe("deployWithRollback", () => {
  it("pins, deploys and passes a healthy build", async () => {
    const world = fakeWorld();
    const { deps } = depsFor(world);
    const result = await deployWithRollback(deps, config, { targetSha: NEW, apps: ["server", "client"], rollback: true });
    assert.deepEqual(result, { ok: true, errors: [] });
    assert.equal(world.envs["srv-uuid"].SERVER_IMAGE, imageRef(OWNER, "server", NEW));
    assert.equal(world.envs["cli-uuid"].CLIENT_IMAGE, imageRef(OWNER, "client", NEW));
    // Server before client, as the workflow has always deployed them.
    const deploys = world.calls.filter((call) => call.startsWith("POST"));
    assert.deepEqual(deploys, ["POST /api/v1/deploy?uuid=srv-uuid&force=true", "POST /api/v1/deploy?uuid=cli-uuid&force=true"]);
  });

  it("restores the previous images when the gate fails, and still fails", async () => {
    const world = fakeWorld({ broken: { [NEW]: { noDb: true } } });
    const { deps } = depsFor(world);
    const result = await deployWithRollback(deps, config, { targetSha: NEW, apps: ["server", "client"], rollback: true });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], new RegExp(`^${NEW} failed the deploy gate \\(api-db\\); rolled back to server ${OLD}, client ${OLD}`));
    assert.equal(world.envs["srv-uuid"].SERVER_IMAGE, imageRef(OWNER, "server", OLD));
    assert.equal(world.envs["cli-uuid"].CLIENT_IMAGE, imageRef(OWNER, "client", OLD));
    assert.deepEqual(world.live, { server: OLD, client: OLD });
  });

  it("rolls back a deploy that never landed", async () => {
    // The server keeps answering with the old commit: the poll times out.
    const world = fakeWorld();
    const fetch = world.fetch;
    const stuck = { ...world, fetch: async (url, init) => (url.includes("/api/v1/deploy") && url.includes("srv-uuid") ? { status: 200, ok: true, headers: { get: () => null }, text: async () => "{}" } : fetch(url, init)) };
    const { deps } = depsFor(stuck);
    const result = await deployWithRollback(deps, config, { targetSha: NEW, apps: ["server", "client"], rollback: true });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /failed the deploy gate \(api-commit\); rolled back to server/);
  });

  it("keeps the new server and restores only the client when a migration forbids the downgrade", async () => {
    const contractAt = contractsFrom({
      [OLD]: contract(1, [migration(1, 0)]),
      [NEW]: contract(2, [migration(1, 0), migration(2, 2)]),
    });
    const world = fakeWorld({ broken: { [NEW]: { wrongApi: true } } });
    const { deps } = depsFor(world, contractAt);
    const result = await deployWithRollback(deps, config, { targetSha: NEW, apps: ["server", "client"], rollback: true });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], new RegExp(`rolled back to client ${OLD}, which passed the gate`));
    assert.ok(result.errors.some((line) => /server: not rolled back: .*refuse to start/.test(line)));
    assert.deepEqual(world.live, { server: NEW, client: OLD });
  });

  it("fails loudly without a rollback target", async () => {
    const world = fakeWorld({ broken: { [NEW]: { authDown: true } }, readableEnvs: false });
    const { deps } = depsFor(world);
    const result = await deployWithRollback(deps, config, { targetSha: NEW, apps: ["server", "client"], rollback: true });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /\(auth-session\); nothing was rolled back/);
    assert.equal(world.calls.filter((call) => call.startsWith("POST")).length, 2, "no second deploy");
  });

  it("reports a rollback that fails its own gate, once", async () => {
    const world = fakeWorld({ broken: { [NEW]: { noDb: true }, [OLD]: { noDb: true } } });
    const { deps } = depsFor(world);
    const result = await deployWithRollback(deps, config, { targetSha: NEW, apps: ["server", "client"], rollback: true });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /ROLLBACK to server .* FAILED its own gate/);
    assert.equal(world.calls.filter((call) => call.startsWith("POST")).length, 4, "one deploy and one rollback, no loop");
  });

  it("restores a half-applied pin", async () => {
    const world = fakeWorld({ failPatchFor: "client" });
    const { deps } = depsFor(world);
    const result = await deployWithRollback(deps, config, { targetSha: NEW, apps: ["server", "client"], rollback: true });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /\(coolify-api\)/);
    assert.equal(world.envs["srv-uuid"].SERVER_IMAGE, imageRef(OWNER, "server", OLD));
  });

  it("refuses a manual server downgrade past a breaking migration before touching anything", async () => {
    const contractAt = contractsFrom({
      [OLDER]: contract(1, [migration(1, 0)]),
      [OLD]: contract(2, [migration(1, 0), migration(2, 2)]),
    });
    const world = fakeWorld();
    const { deps } = depsFor(world, contractAt);
    const request = { targetSha: OLDER, apps: ["server", "client"], rollback: true, guardServerDowngrade: true };
    const refused = await deployWithRollback(deps, config, request);
    assert.equal(refused.ok, false);
    assert.match(refused.errors[0], /refusing to deploy the server/);
    assert.ok(!world.calls.some((call) => !call.startsWith("GET")), "nothing pinned or deployed");

    const forced = await deployWithRollback(deps, config, { ...request, forceServer: true });
    assert.equal(forced.ok, true);
    assert.deepEqual(world.live, { server: OLDER, client: OLDER });
  });

  it("deploys one app by hand and gates the pair", async () => {
    const world = fakeWorld();
    const { deps } = depsFor(world);
    const result = await deployWithRollback(deps, config, { targetSha: OLDER, apps: ["client"], rollback: true, guardServerDowngrade: true });
    assert.equal(result.ok, true);
    assert.deepEqual(world.live, { server: OLD, client: OLDER });
    assert.ok(!world.calls.some((call) => call.includes("srv-uuid") && !call.startsWith("GET")));
  });

  it("refuses a short sha", async () => {
    const { deps } = depsFor(fakeWorld());
    const result = await deployWithRollback(deps, config, { targetSha: NEW.slice(0, 12), apps: ["client"], rollback: true });
    assert.equal(result.ok, false);
  });
});

describe("verifyOnly", () => {
  it("gates the single-app layout without Coolify", async () => {
    const world = fakeWorld();
    const { deps } = depsFor(world);
    assert.equal((await verifyOnly(deps, config, OLD)).ok, true);
    const failed = await verifyOnly(deps, config, NEW);
    assert.equal(failed.ok, false);
    assert.match(failed.errors.join("\n"), /api-commit/);
  });
});
