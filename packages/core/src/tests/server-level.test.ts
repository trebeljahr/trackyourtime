import assert from "node:assert/strict";
import { test } from "node:test";
import {
  API_LEVEL,
  API_LEVEL_CHANGES,
  CAPABILITIES,
  CLIENT_TOO_OLD,
  highestCapabilityLevel,
  REQUIRES_API_LEVEL,
  SERVER_TOO_OLD,
  serverSupports,
} from "@starter/shared";
import { createServerLevelCache } from "../server-level.js";
import { createOfflineQueue, type QueuedMutation } from "../offline-queue.js";
import { decodeOfflineMutation, holdBlocksReplay, holdReasonOf } from "../offline-ops.js";
import { classifyReplayOutcome, serverLevelHold } from "../offline-replay.js";
import { ApiError } from "../api-client.js";
import type { ServerCheck } from "../server-origin.js";
import { memoryStorage } from "../storage.js";

// ── the capability map ───────────────────────────────────────────────

test("every API level has a capability, and none is above API_LEVEL", () => {
  // A bump of API_LEVEL without a capability at the new level fails here:
  // add what the level lets a client gate on to REQUIRES_API_LEVEL.
  assert.equal(highestCapabilityLevel(), API_LEVEL);
  for (let level = 1; level <= API_LEVEL; level += 1) {
    assert.ok(
      Object.values(REQUIRES_API_LEVEL).some((it) => it === level),
      `no capability requires API level ${level}`,
    );
    assert.ok(API_LEVEL_CHANGES.some((change) => change.level === level));
  }
  for (const capability of CAPABILITIES) {
    assert.ok(Number.isInteger(REQUIRES_API_LEVEL[capability]));
    assert.ok(REQUIRES_API_LEVEL[capability] >= 1);
  }
});

test("serverSupports: unknown is optimistic, level 0 has nothing", () => {
  assert.equal(serverSupports("entries.discard", null), true);
  assert.equal(serverSupports("entries.discard", 0), false);
  assert.equal(serverSupports("entries.discard", API_LEVEL), true);
});

// ── the cache ────────────────────────────────────────────────────────

const ok = (apiLevel: number, minClientApiLevel: number | null = 1): ServerCheck => ({
  ok: true,
  server: {
    origin: "https://track.example.com",
    release: "0.1.0",
    commit: null,
    webUrl: "https://track.example.com",
    originTrusted: null,
    apiLevel,
    minClientApiLevel,
  },
});

test("refresh records the level per origin, and a failed read keeps it", async () => {
  const answers: ServerCheck[] = [
    ok(1),
    { ok: false, problem: "unreachable", message: "down" },
    ok(0, null),
  ];
  let calls = 0;
  const cache = createServerLevelCache({ check: async () => answers[calls++]! });
  const origin = "https://track.example.com";

  assert.equal(cache.apiLevel(origin), null);
  assert.equal(cache.compatibility(origin), null);

  await cache.refresh(origin);
  assert.equal(cache.apiLevel(origin), 1);
  assert.equal(cache.apiLevel("https://other.example.com"), null);
  assert.equal(cache.compatibility(origin), null);

  await cache.refresh(origin);
  assert.equal(cache.apiLevel(origin), 1, "an unreachable server keeps its known level");

  await cache.refresh(origin);
  assert.equal(cache.apiLevel(origin), 0);
  assert.equal(cache.compatibility(origin), SERVER_TOO_OLD);
  assert.equal(cache.supports(origin, "entries.discard"), false);
});

test("concurrent refreshes share one request and notify subscribers", async () => {
  let calls = 0;
  const cache = createServerLevelCache({
    check: async () => {
      calls += 1;
      return ok(1);
    },
  });
  let notified = 0;
  cache.subscribe(() => {
    notified += 1;
  });
  await Promise.all([cache.refresh("https://a.example"), cache.refresh("https://a.example")]);
  assert.equal(calls, 1);
  assert.equal(notified, 1);
  await cache.refresh("https://a.example");
  assert.equal(calls, 2);
});

test("a CLIENT_TOO_OLD refusal is remembered until a health read clears it", async () => {
  const cache = createServerLevelCache({ check: async () => ok(1) });
  const origin = "https://a.example";
  cache.noteClientTooOld(origin);
  assert.equal(cache.compatibility(origin), CLIENT_TOO_OLD);
  await cache.refresh(origin);
  assert.equal(cache.compatibility(origin), null);
});

test("a cache with storage survives a new process", async () => {
  const storage = memoryStorage();
  const first = createServerLevelCache({ storage, check: async () => ok(1) });
  await first.refresh("https://a.example");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const second = createServerLevelCache({ storage });
  assert.equal(second.apiLevel("https://a.example"), null);
  await second.hydrate();
  assert.equal(second.apiLevel("https://a.example"), 1);

  await storage.setItem("trackyourtime.server-levels", "garbage");
  const third = createServerLevelCache({ storage });
  await third.hydrate();
  assert.equal(third.apiLevel("https://a.example"), null);
});

// ── rows and the server's level ──────────────────────────────────────

const row = (overrides: Partial<QueuedMutation> = {}): QueuedMutation => ({
  id: "r",
  op: "entries.start",
  payload: { input: { description: "Invoicing", start: "2026-09-14T09:00:00.000Z", originId: "o" } },
  createdAt: "2026-09-14T09:00:00.000Z",
  ...overrides,
});

test("enqueue stamps the writing build's API level; legacy rows stay unknown", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  const queued = await queue.enqueue("entries.start", row().payload);
  assert.equal(queued.apiLevel, API_LEVEL);
  const [listed] = await queue.list();
  assert.equal(listed?.apiLevel, API_LEVEL);
  assert.equal(decodeOfflineMutation(listed!)?.apiLevel, API_LEVEL);

  const legacy = row();
  assert.equal(decodeOfflineMutation(legacy)?.apiLevel, undefined);
  assert.equal("apiLevel" in decodeOfflineMutation(legacy)!, false);
});

test("a server known to be older than the row holds it before sending", () => {
  assert.equal(serverLevelHold(row({ apiLevel: 2 }), 1), "server-too-old");
  assert.equal(serverLevelHold(row({ apiLevel: 2 }), 2), null);
  assert.equal(serverLevelHold(row({ apiLevel: 2 }), null), null, "unknown server: send");
  assert.equal(serverLevelHold(row(), 0), null, "legacy row: send");
});

test("a 400 on a row of a higher level than the server holds; otherwise it drops", async () => {
  const invalid = new ApiError("Invalid input", "BAD_REQUEST", 400);
  assert.deepEqual(
    await classifyReplayOutcome(invalid, row({ apiLevel: 3 }), { serverApiLevel: 2 }),
    { kind: "hold", reason: "server-too-old" },
  );
  assert.deepEqual(
    await classifyReplayOutcome(invalid, row({ apiLevel: 2 }), { serverApiLevel: 2 }),
    { kind: "drop", reason: "refused" },
  );
  assert.deepEqual(
    await classifyReplayOutcome(invalid, row({ apiLevel: 3 })),
    { kind: "drop", reason: "refused" },
    "unknown server level: a 400 is a refusal as before",
  );
  assert.deepEqual(
    await classifyReplayOutcome(invalid, row(), { serverApiLevel: 0 }),
    { kind: "drop", reason: "refused" },
    "legacy row: a 400 is a refusal as before",
  );
  // Only a 400 says "a field it does not know": a 409 is on the merits.
  assert.deepEqual(
    await classifyReplayOutcome(new ApiError("Conflict", "CONFLICT", 409), row({ apiLevel: 3 }), {
      serverApiLevel: 2,
    }),
    { kind: "drop", reason: "refused" },
  );
});

test("a server-too-old hold is stored, and released by the server's level", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  await queue.enqueue("entries.start", row().payload);
  await queue.flush(async () => ({ hold: "server-too-old" }));
  const [held] = await queue.list();
  assert.equal(held?.hold?.reason, "server-too-old");
  assert.equal(holdReasonOf(held!), "server-too-old");

  const now = Date.parse(held!.hold!.at);
  // Unknown level: the hourly clock decides, like unknown-procedure.
  assert.equal(holdBlocksReplay(held!, { now }), true);
  assert.equal(holdBlocksReplay(held!, { now, serverApiLevel: API_LEVEL - 1 }), true);
  // Updated server: released at once, whatever the clock says.
  assert.equal(holdBlocksReplay(held!, { now, serverApiLevel: API_LEVEL }), false);
});
