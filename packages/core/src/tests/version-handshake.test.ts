import assert from "node:assert/strict";
import { test } from "node:test";
import {
  API_LEVEL,
  API_LEVEL_HEADER,
  CLIENT_TOO_OLD,
  CLIENT_VERSION_HEADER,
  SERVER_TOO_OLD,
} from "@starter/shared";
import { ApiError, createApiClient } from "../api-client.js";
import {
  MIN_SERVER_API_LEVEL,
  checkServer,
  readHealthVersion,
  serverCompatibility,
} from "../server-origin.js";
import { withVersionQuery } from "../sync-client.js";

const healthAnswer =
  (body: unknown): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

const BASE_HEALTH = {
  status: "ok",
  service: "trackyourtime",
  release: "0.4.0",
  db: true,
  webUrl: "https://track.example.com",
  originTrusted: null,
};

test("checkServer reads apiLevel, the client floor and the commit", async () => {
  const result = await checkServer("https://track.example.com", {
    fetchImpl: healthAnswer({
      ...BASE_HEALTH,
      apiLevel: 3,
      minClientApiLevel: 2,
      commit: "abcdef0123",
      version: "abcdef0123",
    }),
  });
  assert.ok(result.ok);
  assert.equal(result.server.apiLevel, 3);
  assert.equal(result.server.minClientApiLevel, 2);
  assert.equal(result.server.commit, "abcdef0123");
});

test("a server that reports no apiLevel is level 0, pre-handshake", async () => {
  const result = await checkServer("https://track.example.com", {
    fetchImpl: healthAnswer({ ...BASE_HEALTH, version: "1a2b3c4" }),
  });
  assert.ok(result.ok);
  assert.equal(result.server.apiLevel, 0);
  assert.equal(result.server.minClientApiLevel, null);
  // Before `commit` existed the commit was reported as `version`.
  assert.equal(result.server.commit, "1a2b3c4");
});

test("a malformed apiLevel reads as 0, never as a number it is not", () => {
  assert.equal(readHealthVersion({ apiLevel: "three" }).apiLevel, 0);
  assert.equal(readHealthVersion({ apiLevel: -1 }).apiLevel, 0);
  assert.equal(readHealthVersion({ apiLevel: 2.5 }).apiLevel, 0);
  assert.equal(readHealthVersion({ apiLevel: "2" }).apiLevel, 2);
});

test("serverCompatibility names the side that is too old", () => {
  assert.equal(MIN_SERVER_API_LEVEL, 1);
  assert.equal(serverCompatibility({ apiLevel: 0, minClientApiLevel: null }), SERVER_TOO_OLD);
  assert.equal(serverCompatibility({ apiLevel: API_LEVEL, minClientApiLevel: 1 }), null);
  assert.equal(
    serverCompatibility({ apiLevel: API_LEVEL + 5, minClientApiLevel: API_LEVEL + 1 }),
    CLIENT_TOO_OLD,
  );
  assert.equal(
    serverCompatibility({ apiLevel: 4, minClientApiLevel: null }, { minServerApiLevel: 5 }),
    SERVER_TOO_OLD,
  );
});

test("createApiClient sends the client version and API level on every call", async () => {
  const seen: Headers[] = [];
  const api = createApiClient({
    baseUrl: "https://api.example.com",
    token: "t",
    clientId: "trackyourtime-raycast",
    clientVersion: "0.3.1",
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response(JSON.stringify({ result: { data: null } }), { status: 200 });
    }) as typeof fetch,
  });
  await api.query("entries.current");
  await api.mutate("entries.stop", {});
  assert.equal(seen.length, 2);
  for (const headers of seen) {
    assert.equal(headers.get(CLIENT_VERSION_HEADER), "0.3.1");
    assert.equal(headers.get(API_LEVEL_HEADER), String(API_LEVEL));
    // The kind header is untouched: it decides device labels and session windows.
    assert.equal(headers.get("x-trackyourtime-client"), "trackyourtime-raycast");
  }
});

test("createApiClient without a version still declares its API level", async () => {
  let headers: Headers | null = null;
  const api = createApiClient({
    baseUrl: "https://api.example.com",
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return new Response(JSON.stringify({ result: { data: 1 } }), { status: 200 });
    }) as typeof fetch,
  });
  await api.query("health.check");
  assert.ok(headers);
  assert.equal((headers as Headers).get(API_LEVEL_HEADER), String(API_LEVEL));
  assert.equal((headers as Headers).get(CLIENT_VERSION_HEADER), null);
});

test("a CLIENT_TOO_OLD refusal surfaces on ApiError and is not permanent", async () => {
  const api = createApiClient({
    baseUrl: "https://api.example.com",
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "This app is too old for this server.",
            data: { code: "PRECONDITION_FAILED", httpStatus: 412, versionRefusal: CLIENT_TOO_OLD },
          },
        }),
        { status: 412 },
      )) as typeof fetch,
  });
  await assert.rejects(api.query("entries.current"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.versionRefusal, CLIENT_TOO_OLD);
    assert.equal(error.httpStatus, 412);
    return true;
  });
});

test("the sync URL carries the handshake as query parameters, not in the subprotocol", () => {
  const url = new URL(withVersionQuery("wss://api.example.com/api/ws", "0.3.1"));
  assert.equal(url.pathname, "/api/ws");
  assert.equal(url.searchParams.get("apiLevel"), String(API_LEVEL));
  assert.equal(url.searchParams.get("clientVersion"), "0.3.1");
  assert.equal(withVersionQuery("not a url", "0.3.1"), "not a url");
});
