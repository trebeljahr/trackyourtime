/**
 * The version handshake, server side (docs/versioning.md).
 *
 * Four claims, each of which fails without an error anywhere:
 *  - `/api/health` and `health.check` report `apiLevel`, `minClientApiLevel`
 *    and `commit`, and keep the old `version` (the commit) for clients that
 *    already read it.
 *  - A request DECLARING an API level below the floor is refused with a
 *    stable code — `data.versionRefusal` on tRPC, `problems/client-too-old` on
 *    REST — as a 412, which the offline queue never treats as permanent.
 *  - A request declaring NO level is a pre-handshake client and is served.
 *  - The client version lands on the session row and only moves forward.
 */
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import express from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer } from "better-auth/plugins/bearer";
import {
  API_LEVEL,
  API_LEVEL_CHANGES,
  API_LEVEL_HEADER,
  CLIENT_TOO_OLD,
  CLIENT_VERSION_HEADER,
  MIN_CLIENT_API_LEVEL,
  compareVersions,
  parseApiLevel,
  parseClientVersion,
} from "@starter/shared/api-level";

import {
  declaredClient,
  recordSessionClientVersion,
  versionFieldsForNewSession,
  versionRefusalFor,
  versionUpdateForSession,
} from "../auth/client-version.js";
import { toDeviceSession } from "../trpc/routers/devices.js";
import cors from "cors";
import { env } from "../config/env.js";

const listen = async (app: express.Express): Promise<{ server: Server; base: string }> => {
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
};

describe("the API level table", () => {
  it("ends at API_LEVEL and never skips a level", () => {
    assert.equal(API_LEVEL_CHANGES.at(-1)?.level, API_LEVEL);
    API_LEVEL_CHANGES.forEach((change, index) => {
      assert.equal(change.level, index + 1);
      assert.ok(change.added.length > 0, `level ${change.level} names what it added`);
    });
    assert.ok(MIN_CLIENT_API_LEVEL <= API_LEVEL);
  });
});

describe("parsing what a request declares", () => {
  it("reads versions and levels, and treats garbage as undeclared", () => {
    assert.equal(parseClientVersion("0.3.1"), "0.3.1");
    assert.equal(parseClientVersion("1.0.0-rc.2"), "1.0.0-rc.2");
    assert.equal(parseClientVersion("latest"), null);
    assert.equal(parseClientVersion("1.2.3".padEnd(80, "0")), null);
    assert.equal(parseApiLevel("3"), 3);
    assert.equal(parseApiLevel("0"), 0);
    assert.equal(parseApiLevel("-1"), null);
    assert.equal(parseApiLevel("two"), null);
    assert.equal(parseApiLevel(undefined), null);
  });

  it("compares releases numerically, prereleases first", () => {
    assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
    assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
    assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
    assert.equal(compareVersions("junk", "1.0.0"), 0);
  });

  it("reads Node's header object and a Fetch Headers alike", () => {
    assert.deepEqual(declaredClient({ [CLIENT_VERSION_HEADER]: "0.2.0", [API_LEVEL_HEADER]: "1" }), {
      clientVersion: "0.2.0",
      apiLevel: 1,
    });
    assert.deepEqual(declaredClient(new Headers({ [API_LEVEL_HEADER]: "2" })), {
      clientVersion: null,
      apiLevel: 2,
    });
  });
});

describe("the client floor", () => {
  it("refuses a declared level below the floor", () => {
    assert.equal(versionRefusalFor({ [API_LEVEL_HEADER]: "0" }), CLIENT_TOO_OLD);
    assert.equal(versionRefusalFor({ [API_LEVEL_HEADER]: "2" }, 3), CLIENT_TOO_OLD);
  });

  it("serves a request that declares no level, or an unreadable one", () => {
    assert.equal(versionRefusalFor({}), null);
    assert.equal(versionRefusalFor({ [API_LEVEL_HEADER]: "not-a-number" }, 5), null);
    assert.equal(versionRefusalFor(undefined), null);
  });

  it("serves the level this build declares", () => {
    assert.equal(versionRefusalFor({ [API_LEVEL_HEADER]: String(API_LEVEL) }), null);
  });
});

describe("over HTTP", () => {
  let server: Server;
  let base: string;
  const trusted = "https://web.version-handshake.test";

  before(async () => {
    const { createApp } = await import("../app.js");
    const { appRouter } = await import("../trpc/router.js");
    const { corsOptions } = await import("../app.js");

    // The real app for /api/health, CORS and REST. tRPC is mounted again on a
    // second path with a context that needs no better-auth instance: the floor
    // runs before any session is read, which is what this proves.
    const app = createApp();
    const trpcApp = express();
    trpcApp.use(
      "/trpc",
      createExpressMiddleware({
        router: appRouter,
        createContext: ({ req, res }) => ({
          req,
          res,
          session: null,
          user: null,
          authMethod: null,
          activeWorkspaceId: null,
          sessionId: null,
        }),
      }) as unknown as express.RequestHandler,
    );
    const outer = express();
    // The app's own CORS options, with an origin this test trusts.
    outer.use("/cors", cors(corsOptions([trusted])), (_req, res) => {
      res.sendStatus(204);
    });
    outer.use("/isolated", trpcApp);
    outer.use(app);
    ({ server, base } = await listen(outer));
  });

  after(() => {
    server?.close();
  });

  it("/api/health reports the handshake and keeps `version` as the commit", async () => {
    const response = await fetch(`${base}/api/health`);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.apiLevel, API_LEVEL);
    assert.equal(body.minClientApiLevel, MIN_CLIENT_API_LEVEL);
    assert.equal(body.commit, env.COMMIT_SHA);
    assert.equal(body.version, body.commit);
    assert.equal(typeof body.release, "string");
    assert.equal(body.service, "trackyourtime");
  });

  it("lets a trusted origin preflight the new headers", async () => {
    const response = await fetch(`${base}/cors/api/trpc/entries.current`, {
      method: "OPTIONS",
      headers: {
        origin: trusted,
        "access-control-request-method": "GET",
        "access-control-request-headers": `${CLIENT_VERSION_HEADER},${API_LEVEL_HEADER},x-trackyourtime-client`,
      },
    });
    const allowed = (response.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    assert.equal(response.headers.get("access-control-allow-origin"), trusted);
    assert.ok(allowed.includes(CLIENT_VERSION_HEADER), allowed);
    assert.ok(allowed.includes(API_LEVEL_HEADER), allowed);
  });

  it("health.check answers every client, however old, with the handshake", async () => {
    const response = await fetch(`${base}/isolated/trpc/health.check`, {
      headers: { [API_LEVEL_HEADER]: "0" },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { result: { data: Record<string, unknown> } };
    assert.equal(body.result.data.apiLevel, API_LEVEL);
    assert.equal(body.result.data.minClientApiLevel, MIN_CLIENT_API_LEVEL);
    assert.equal(body.result.data.commit, env.COMMIT_SHA);
  });

  it("refuses a tRPC call below the floor with data.versionRefusal and a 412", async () => {
    const response = await fetch(`${base}/isolated/trpc/entries.current`, {
      headers: { [API_LEVEL_HEADER]: "0", [CLIENT_VERSION_HEADER]: "0.0.1" },
    });
    assert.equal(response.status, 412);
    const body = (await response.json()) as {
      error: { data: { code: string; versionRefusal: unknown } };
    };
    assert.equal(body.error.data.code, "PRECONDITION_FAILED");
    assert.equal(body.error.data.versionRefusal, CLIENT_TOO_OLD);
  });

  it("serves a legacy tRPC call with no header as before", async () => {
    const response = await fetch(`${base}/isolated/trpc/entries.current`);
    // Past the floor, into the ordinary auth refusal.
    assert.equal(response.status, 401);
    const body = (await response.json()) as { error: { data: { versionRefusal: unknown } } };
    assert.equal(body.error.data.versionRefusal, null);
  });

  it("refuses a REST call below the floor as problems/client-too-old", async () => {
    const response = await fetch(`${base}/api/v1/me`, {
      headers: { [API_LEVEL_HEADER]: "0" },
    });
    assert.equal(response.status, 412);
    assert.match(response.headers.get("content-type") ?? "", /application\/problem\+json/);
    const body = (await response.json()) as { type: string };
    assert.equal(body.type, "https://trackyourtime.dev/problems/client-too-old");
  });

  it("serves a legacy REST call with no header as before", async () => {
    const response = await fetch(`${base}/api/v1/me`);
    assert.equal(response.status, 401);
    const body = (await response.json()) as { type: string };
    assert.equal(body.type, "https://trackyourtime.dev/problems/invalid-token");
  });
});

describe("the version on a session", () => {
  it("moves forward only", () => {
    const declared = { clientVersion: "0.3.0", apiLevel: 2 };
    assert.deepEqual(versionUpdateForSession({}, declared), { clientVersion: "0.3.0", clientApiLevel: 2 });
    assert.equal(versionUpdateForSession({ clientVersion: "0.3.0", clientApiLevel: 2 }, declared), null);
    assert.equal(versionUpdateForSession({ clientVersion: "0.4.0", clientApiLevel: 3 }, declared), null);
    assert.deepEqual(versionUpdateForSession({ clientVersion: "0.3.0", clientApiLevel: 1 }, declared), {
      clientVersion: "0.3.0",
      clientApiLevel: 2,
    });
    assert.equal(versionUpdateForSession({ clientVersion: "0.3.0" }, { clientVersion: null, apiLevel: 9 }), null);
  });

  it("stamps only what was declared on a new session", () => {
    assert.deepEqual(versionFieldsForNewSession(new Headers()), {});
    assert.deepEqual(
      versionFieldsForNewSession(new Headers({ [CLIENT_VERSION_HEADER]: "0.2.0", [API_LEVEL_HEADER]: "1" })),
      { clientVersion: "0.2.0", clientApiLevel: 1 },
    );
  });

  it("projects onto the devices list, null for a pre-handshake row", () => {
    const row = {
      id: "s1",
      token: "tok",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      expiresAt: new Date(0),
      client: "raycast",
    };
    const legacy = toDeviceSession(row, null);
    assert.equal(legacy.clientVersion, null);
    assert.equal(legacy.apiLevel, null);
    assert.equal("token" in legacy, false);
    const stamped = toDeviceSession({ ...row, clientVersion: "0.3.1", clientApiLevel: 1 }, null);
    assert.equal(stamped.clientVersion, "0.3.1");
    assert.equal(stamped.apiLevel, 1);
  });

  describe("against the real better-auth", () => {
    type Row = { id: string; token: string; clientVersion?: string; clientApiLevel?: number };
    const db = { user: [], session: [] as Row[], account: [], verification: [] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let auth: any;

    before(() => {
      auth = betterAuth({
        database: memoryAdapter(db as never),
        secret: "version-handshake-integration-secret-0123456789",
        baseURL: "http://localhost:3000",
        emailAndPassword: { enabled: true },
        session: {
          additionalFields: {
            client: { type: "string", required: false, defaultValue: "unknown", input: false },
            clientVersion: { type: "string", required: false, input: false },
            clientApiLevel: { type: "number", required: false, input: false },
          },
        },
        plugins: [bearer()],
        databaseHooks: {
          session: {
            create: {
              before: async (session, context) => ({
                data: {
                  ...session,
                  ...versionFieldsForNewSession(context?.headers ?? context?.request?.headers ?? null),
                },
              }),
            },
          },
        },
      });
    });

    const signUp = async (headers: Record<string, string>): Promise<{ token: string; row: Row }> => {
      const email = `version-${db.session.length}-${Date.now()}@example.com`;
      const response = await auth.api.signUpEmail({
        body: { email, password: "password1234", name: "Version Tester" },
        headers: new Headers(headers),
        returnHeaders: true,
      });
      const token = response.headers.get("set-auth-token");
      assert.ok(token);
      return { token, row: db.session.at(-1) as Row };
    };

    const writer = async (sessionToken: string, update: { clientVersion: string; clientApiLevel?: number }) => {
      const context = await auth.$context;
      await context.internalAdapter.updateSession(sessionToken, update);
    };

    it("records the version a session was created with", async () => {
      const { row } = await signUp({ [CLIENT_VERSION_HEADER]: "0.2.0", [API_LEVEL_HEADER]: "1" });
      assert.equal(row.clientVersion, "0.2.0");
      assert.equal(row.clientApiLevel, 1);
    });

    it("leaves both fields absent for a client that declares nothing", async () => {
      const { row } = await signUp({});
      assert.equal(row.clientVersion, undefined);
      assert.equal(row.clientApiLevel, undefined);
    });

    it("moves the row forward when a newer build uses the session, never back", async () => {
      const { token, row } = await signUp({ [CLIENT_VERSION_HEADER]: "0.2.0", [API_LEVEL_HEADER]: "1" });
      const session = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });
      assert.equal(session.session.clientVersion, "0.2.0");

      const wrote = await recordSessionClientVersion(
        session.session,
        { [CLIENT_VERSION_HEADER]: "0.3.1", [API_LEVEL_HEADER]: "1" },
        writer,
      );
      assert.equal(wrote, true);
      assert.equal(db.session.find((r) => r.id === row.id)?.clientVersion, "0.3.1");

      // The same stale session object again (a cookie-cache hit) writes nothing.
      assert.equal(
        await recordSessionClientVersion(
          session.session,
          { [CLIENT_VERSION_HEADER]: "0.3.1", [API_LEVEL_HEADER]: "1" },
          writer,
        ),
        false,
      );

      const fresh = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });
      const older = await recordSessionClientVersion(
        fresh.session,
        { [CLIENT_VERSION_HEADER]: "0.2.5", [API_LEVEL_HEADER]: "1" },
        writer,
      );
      assert.equal(older, false);
      assert.equal(db.session.find((r) => r.id === row.id)?.clientVersion, "0.3.1");
    });
  });
});
