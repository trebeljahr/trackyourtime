import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLOUD_API_ORIGIN,
  CLOUD_SERVER_LABEL,
  checkServer,
  describeServerVersion,
  isLoopbackHost,
  normalizeServerInput,
  sameServerOrigin,
  serverLabel,
} from "../server-origin.js";

// ── normalizeServerInput ─────────────────────────────────────────────

const origin = (input: string): string => {
  const parsed = normalizeServerInput(input);
  assert.ok(parsed.ok, `expected ${input} to be accepted`);
  return parsed.origin;
};

const problem = (input: string): string => {
  const parsed = normalizeServerInput(input);
  assert.ok(!parsed.ok, `expected ${input} to be refused`);
  return parsed.problem;
};

test("an https address is kept as its origin", () => {
  assert.equal(origin("https://track.example.com"), "https://track.example.com");
  assert.equal(origin("  https://Track.Example.com/  "), "https://track.example.com");
});

test("a pasted page URL keeps only the origin the server lives at", () => {
  assert.equal(
    origin("https://track.example.com/settings/?tab=data#x"),
    "https://track.example.com",
  );
});

test("no scheme means https, except for this machine", () => {
  assert.equal(origin("track.example.com"), "https://track.example.com");
  assert.equal(origin("track.example.com:8443"), "https://track.example.com:8443");
  assert.equal(origin("localhost:5159"), "http://localhost:5159");
  assert.equal(origin("127.0.0.1:5159/api"), "http://127.0.0.1:5159");
});

test("plain http is refused on anything that is not loopback", () => {
  assert.equal(problem("http://track.example.com"), "insecure");
  assert.equal(problem("http://192.168.1.20:5159"), "insecure");
  assert.equal(problem("http://10.0.2.2:5159"), "insecure");
  const refused = normalizeServerInput("http://track.example.com");
  assert.ok(!refused.ok);
  assert.match(refused.message, /https:\/\/ for track\.example\.com/);
});

test("plain http is accepted for loopback in every spelling", () => {
  assert.equal(origin("http://localhost:3000"), "http://localhost:3000");
  assert.equal(origin("http://127.0.0.1"), "http://127.0.0.1");
  assert.equal(origin("http://[::1]:5159"), "http://[::1]:5159");
  assert.equal(origin("http://app.localhost"), "http://app.localhost");
});

test("empty, garbage, other schemes and credentials are refused", () => {
  assert.equal(problem("   "), "empty");
  assert.equal(problem("https://"), "invalid-url");
  assert.equal(problem("ftp://track.example.com"), "invalid-url");
  assert.equal(problem("javascript://alert(1)"), "invalid-url");
  assert.equal(problem("https://user:pass@track.example.com"), "invalid-url");
  assert.equal(problem("not a url at all"), "invalid-url");
});

test("loopback detection does not accept look-alikes", () => {
  assert.equal(isLoopbackHost("localhost.example.com"), false);
  assert.equal(isLoopbackHost("127.0.0.1.nip.io"), false);
  assert.equal(isLoopbackHost("128.0.0.1"), false);
  assert.equal(isLoopbackHost("127.10.0.3"), true);
});

test("the cloud is named, anything else is its host", () => {
  assert.equal(serverLabel(CLOUD_API_ORIGIN), CLOUD_SERVER_LABEL);
  assert.equal(serverLabel(`${CLOUD_API_ORIGIN}/`), CLOUD_SERVER_LABEL);
  assert.equal(serverLabel("https://track.example.com"), "track.example.com");
  assert.ok(sameServerOrigin("HTTPS://api.trackyourtime.dev/", CLOUD_API_ORIGIN));
  assert.ok(!sameServerOrigin("https://track.example.com", CLOUD_API_ORIGIN));
});

// ── checkServer ──────────────────────────────────────────────────────

const answering =
  (status: number, body: unknown, calls: string[] = []): typeof fetch =>
  async (input) => {
    calls.push(String(input));
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };

const HEALTH = {
  status: "ok",
  service: "tracktime",
  release: "0.1.0",
  db: true,
  webUrl: "https://track.example.com",
  version: "1a2b3c4d5e6f",
  originTrusted: true,
  timestamp: "2026-09-13T10:00:00.000Z",
};

test("a Track Your Time server is recognised and describes itself", async () => {
  const calls: string[] = [];
  const result = await checkServer("https://track.example.com", {
    fetchImpl: answering(200, HEALTH, calls),
  });
  assert.deepEqual(calls, ["https://track.example.com/api/health"]);
  assert.ok(result.ok);
  assert.deepEqual(result.server, {
    origin: "https://track.example.com",
    release: "0.1.0",
    commit: "1a2b3c4d5e6f",
    webUrl: "https://track.example.com",
    originTrusted: true,
  });
  assert.equal(describeServerVersion(result.server), "Track Your Time 0.1.0 (1a2b3c4)");
});

test("a server from before the service marker is still recognised by shape", async () => {
  const result = await checkServer("https://api.trackyourtime.dev", {
    fetchImpl: answering(200, {
      status: "ok",
      db: true,
      webUrl: "https://trackyourtime.dev",
      version: "",
      timestamp: "2026-09-13T10:00:00.000Z",
    }),
  });
  assert.ok(result.ok);
  assert.equal(result.server.release, null);
  assert.equal(result.server.commit, null);
  assert.equal(result.server.originTrusted, null);
  assert.equal(describeServerVersion(result.server), "Track Your Time");
});

test("a transport failure is unreachable, with the host in the message", async () => {
  const result = await checkServer("https://track.example.com", {
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  assert.ok(!result.ok);
  assert.equal(result.problem, "unreachable");
  assert.match(result.message, /track\.example\.com/);
});

test("a server that never answers is unreachable once the timeout passes", async () => {
  const result = await checkServer("https://slow.example.com", {
    timeoutMs: 20,
    fetchImpl: (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
  });
  assert.ok(!result.ok);
  assert.equal(result.problem, "unreachable");
});

test("anything else that answers is not a Track Your Time server", async () => {
  const cases: Array<[number, unknown]> = [
    [404, "<html>Not found</html>"],
    [200, "<!doctype html><html></html>"],
    [200, { status: "ok" }],
    [200, { status: "healthy", webUrl: "https://x" }],
    [200, { ...HEALTH, service: "someone-else" }],
    [500, HEALTH],
    [200, [1, 2, 3]],
  ];
  for (const [status, body] of cases) {
    const result = await checkServer("https://other.example.com", {
      fetchImpl: answering(status, body),
    });
    assert.ok(!result.ok, JSON.stringify(body));
    assert.equal(result.problem, "not-tracktime");
  }
});

test("a server without its database says so plainly", async () => {
  const result = await checkServer("https://track.example.com", {
    fetchImpl: answering(200, { ...HEALTH, db: false }),
  });
  assert.ok(!result.ok);
  assert.equal(result.problem, "unhealthy");
});
