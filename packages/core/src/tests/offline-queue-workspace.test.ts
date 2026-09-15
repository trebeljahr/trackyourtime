import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adoptUnstampedWorkspace,
  createOfflineQueue,
  isForeignWorkspace,
  isReplayableIn,
  refusalKeepsRow,
  type QueuedMutation,
} from "../offline-queue.js";
import {
  decodeOfflineMutation,
  describeQueuedMutation,
} from "../offline-ops.js";
import {
  replayOfflineMutation,
  type OfflineReplayMutators,
} from "../offline-replay.js";
import {
  ApiError,
  createApiClient,
  isPermanentRejection,
  isPermanentRejectionStatus,
  withWorkspaceId,
} from "../api-client.js";
import { memoryStorage } from "../storage.js";

const A = "ws-a";
const B = "ws-b";

const startInput = (description: string): Record<string, unknown> => ({
  description,
  projectId: null,
  taskId: null,
  billable: false,
  start: "2026-09-14T09:00:00.000Z",
  source: "web",
  timeZone: "UTC",
  originId: "o",
});

test("enqueue stamps the workspace, and a legacy row stays unstamped", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  const stamped = await queue.enqueue("entries.start", { input: {} }, "u", undefined, A);
  const legacy = await queue.enqueue("entries.start", { input: {} }, "u");

  assert.equal(stamped.workspaceId, A);
  assert.equal("workspaceId" in legacy, false);
  const rows = await queue.list();
  assert.deepEqual(
    rows.map((row) => row.workspaceId),
    [A, undefined],
  );
});

test("a malformed workspace stamp reads as none", async () => {
  const storage = memoryStorage();
  await storage.setItem(
    "trackyourtime.offline-queue",
    JSON.stringify([
      { id: "a", op: "entries.stop", payload: {}, createdAt: "2026-09-13T00:00:00Z", workspaceId: 7 },
      { id: "b", op: "entries.stop", payload: {}, createdAt: "2026-09-13T00:00:00Z", workspaceId: "" },
    ]),
  );
  const rows = await createOfflineQueue({ storage }).list();
  assert.deepEqual(
    rows.map((row) => "workspaceId" in row),
    [false, false],
  );
});

test("adoptUnstampedWorkspace claims only unstamped rows, and only once", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  await queue.enqueue("entries.start", { input: {} }, "u");
  await queue.enqueue("entries.start", { input: {} }, "u", undefined, B);

  assert.equal(await queue.adoptUnstampedWorkspace(A), 1);
  // A later switch must not carry already-adopted rows along.
  assert.equal(await queue.adoptUnstampedWorkspace(B), 0);
  const rows = await queue.list();
  assert.deepEqual(
    rows.map((row) => row.workspaceId),
    [A, B],
  );
});

test("the pure adoption respects its filter and never moves a stamped row", () => {
  const rows: QueuedMutation[] = [
    { id: "1", op: "x", payload: {}, createdAt: "t", server: "s1" },
    { id: "2", op: "x", payload: {}, createdAt: "t", server: "s2" },
    { id: "3", op: "x", payload: {}, createdAt: "t", workspaceId: B },
  ];
  const next = adoptUnstampedWorkspace(rows, A, (row) => row.server === "s1");
  assert.deepEqual(
    next.map((row) => row.workspaceId),
    [A, undefined, B],
  );
  // Untouched rows keep their identity.
  assert.equal(next[1], rows[1]);
});

test("isReplayableIn / isForeignWorkspace", () => {
  const members = new Set([A]);
  assert.equal(isReplayableIn({ workspaceId: A }, members), true);
  assert.equal(isReplayableIn({ workspaceId: B }, members), false);
  assert.equal(isReplayableIn({}, members), true);

  assert.equal(isForeignWorkspace({ workspaceId: A }, members), false);
  assert.equal(isForeignWorkspace({ workspaceId: B }, members), true);
  // Unstamped names no workspace to be foreign to.
  assert.equal(isForeignWorkspace({}, members), false);
  // No memberships known at all: every stamped row is held.
  assert.equal(isReplayableIn({ workspaceId: A }, new Set()), false);
});

test("a flush filtered by membership holds a left workspace's rows in place", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  await queue.enqueue("entries.start", { input: startInput("gone") }, "u", undefined, B);
  await queue.enqueue("entries.start", { input: startInput("here") }, "u", undefined, A);

  const members = new Set([A]);
  const ran: string[] = [];
  const result = await queue.flush(
    async (row) => {
      ran.push(row.workspaceId ?? "");
    },
    { filter: (row) => isReplayableIn(row, members) },
  );
  assert.deepEqual(ran, [A]);
  assert.equal(result.skipped, 1);
  const kept = await queue.list();
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.workspaceId, B);
});

test("decode carries the stamp only when the row has one", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  const stamped = await queue.enqueue("entries.start", { input: startInput("x") }, "u", undefined, A);
  const legacy = await queue.enqueue("entries.start", { input: startInput("y") }, "u");

  assert.equal(decodeOfflineMutation(stamped)?.workspaceId, A);
  const decodedLegacy = decodeOfflineMutation(legacy);
  assert.ok(decodedLegacy);
  assert.equal("workspaceId" in decodedLegacy, false);
});

const recordingMutators = (
  calls: Array<{ op: string; input: Record<string, unknown> }>,
): OfflineReplayMutators => {
  const record =
    (op: string) =>
    async (input: object): Promise<unknown> => {
      calls.push({ op, input: input as Record<string, unknown> });
      return { id: `real-${calls.length}` };
    };
  return {
    "entries.start": record("entries.start"),
    "entries.stop": record("entries.stop"),
    "entries.create": record("entries.create"),
    "entries.update": record("entries.update"),
    "entries.remove": record("entries.remove"),
    "entries.discard": record("entries.discard"),
  };
};

const watcher = { noteServerId: (): void => undefined };

test("replay sends the stamped workspace on every op, over anything in the payload", async () => {
  const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
  const mutators = recordingMutators(calls);
  const ops: Array<[string, Record<string, unknown>]> = [
    ["entries.start", startInput("s")],
    ["entries.stop", { id: "e1", end: "2026-09-14T10:00:00.000Z", originId: "o" }],
    ["entries.create", { ...startInput("c"), end: "2026-09-14T10:00:00.000Z" }],
    // A payload that somehow carries a different workspace loses to the stamp.
    ["entries.update", { id: "e1", description: "u", originId: "o", workspaceId: B }],
    ["entries.remove", { id: "e1", originId: "o" }],
    ["entries.discard", { originId: "o" }],
  ];
  for (const [op, input] of ops) {
    const decoded = decodeOfflineMutation({
      id: op,
      op,
      payload: { input },
      createdAt: new Date().toISOString(),
      workspaceId: A,
    });
    assert.ok(decoded);
    await replayOfflineMutation(mutators, watcher, decoded);
  }
  assert.equal(calls.length, ops.length);
  for (const call of calls) assert.equal(call.input.workspaceId, A, call.op);
});

test("replay of an unstamped row sends no workspace, leaving the client's own", async () => {
  const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
  const decoded = decodeOfflineMutation({
    id: "1",
    op: "entries.start",
    payload: { input: startInput("legacy") },
    createdAt: new Date().toISOString(),
  });
  assert.ok(decoded);
  await replayOfflineMutation(recordingMutators(calls), watcher, decoded);
  assert.equal("workspaceId" in (calls[0]?.input ?? {}), false);
});

test("a stamped replay through createApiClient is not overridden by the getter", async () => {
  const bodies: unknown[] = [];
  const api = createApiClient({
    baseUrl: "https://api.example",
    workspaceId: () => B,
    fetchImpl: (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ result: { data: { id: "e" } } }));
    }) as unknown as typeof fetch,
  });
  const decoded = decodeOfflineMutation({
    id: "1",
    op: "entries.start",
    payload: { input: startInput("queued in A") },
    createdAt: new Date().toISOString(),
    workspaceId: A,
  });
  assert.ok(decoded);
  const mutate = (path: string) => (input: object) => api.mutate(path, input);
  await replayOfflineMutation(
    {
      "entries.start": mutate("entries.start"),
      "entries.stop": mutate("entries.stop"),
      "entries.create": mutate("entries.create"),
      "entries.update": mutate("entries.update"),
      "entries.remove": mutate("entries.remove"),
      "entries.discard": mutate("entries.discard"),
    },
    watcher,
    decoded,
  );
  assert.equal((bodies[0] as { workspaceId?: string }).workspaceId, A);
});

test("describeQueuedMutation names the workspace through the lookup", async () => {
  const queue = createOfflineQueue({ storage: memoryStorage() });
  const inA = await queue.enqueue("entries.start", { input: startInput("Design") }, "u", undefined, A);
  const left = await queue.enqueue("entries.start", { input: startInput("Old") }, "u", undefined, B);
  const legacy = await queue.enqueue("entries.start", { input: startInput("Legacy") }, "u");
  const names = new Map([[A, "Acme"]]);
  const lookup = (id: string): string | null => names.get(id) ?? null;

  const a = describeQueuedMutation(inA, lookup);
  assert.equal(a.description, "Design");
  assert.equal(a.workspaceId, A);
  assert.equal(a.workspaceName, "Acme");

  const b = describeQueuedMutation(left, lookup);
  assert.equal(b.workspaceId, B);
  assert.equal(b.workspaceName, null);

  const l = describeQueuedMutation(legacy);
  assert.equal(l.workspaceId, null);
  assert.equal(l.workspaceName, null);
});

test("withWorkspaceId fills an object or undefined, never overrides, never wraps primitives", () => {
  assert.deepEqual(withWorkspaceId(undefined, A), { workspaceId: A });
  assert.deepEqual(withWorkspaceId({ id: "1" }, A), { id: "1", workspaceId: A });
  assert.deepEqual(withWorkspaceId({ workspaceId: B }, A), { workspaceId: B });
  assert.equal(withWorkspaceId("x", A), "x");
  assert.deepEqual(withWorkspaceId(["x"], A), ["x"]);
  assert.deepEqual(withWorkspaceId({ id: "1" }, null), { id: "1" });
});

test("createApiClient injects the getter's workspace into queries and mutations", async () => {
  const seen: Array<{ url: string; body: string | undefined }> = [];
  let current: string | null = A;
  const api = createApiClient({
    baseUrl: "https://api.example",
    workspaceId: () => current,
    fetchImpl: (async (url: string, init: RequestInit) => {
      seen.push({ url, body: init.body === undefined ? undefined : String(init.body) });
      return new Response(JSON.stringify({ result: { data: null } }));
    }) as unknown as typeof fetch,
  });

  await api.query("entries.current");
  await api.query("entries.list", { limit: 5 });
  await api.mutate("entries.stop", { end: "x" });
  current = null;
  await api.mutate("entries.stop", { end: "y" });

  const input0 = new URL(seen[0]?.url ?? "").searchParams.get("input");
  assert.deepEqual(JSON.parse(input0 ?? "null"), { workspaceId: A });
  const input1 = new URL(seen[1]?.url ?? "").searchParams.get("input");
  assert.deepEqual(JSON.parse(input1 ?? "null"), { limit: 5, workspaceId: A });
  assert.deepEqual(JSON.parse(seen[2]?.body ?? "null"), { end: "x", workspaceId: A });
  // Null sends the input unchanged.
  assert.deepEqual(JSON.parse(seen[3]?.body ?? "null"), { end: "y" });
});

test("without a getter the request is exactly what it was", async () => {
  const seen: string[] = [];
  const api = createApiClient({
    baseUrl: "https://api.example",
    fetchImpl: (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ result: { data: null } }));
    }) as unknown as typeof fetch,
  });
  await api.query("entries.current");
  assert.equal(new URL(seen[0] ?? "").searchParams.get("input"), null);
});

test("FORBIDDEN is a permanent refusal of the row; UNAUTHORIZED is not", () => {
  assert.equal(isPermanentRejection(new ApiError("no", "FORBIDDEN", 403)), true);
  assert.equal(isPermanentRejection(new ApiError("no", "UNAUTHORIZED", 401)), false);
});

test("5xx, 429 and 401 are never permanent, from an ApiError or a bare status", () => {
  for (const [code, status] of [
    ["INTERNAL_SERVER_ERROR", 500],
    ["SERVICE_UNAVAILABLE", 503],
    ["TOO_MANY_REQUESTS", 429],
    ["TIMEOUT", 408],
    ["UNAUTHORIZED", 401],
  ] as const) {
    assert.equal(isPermanentRejection(new ApiError("no", code, status)), false, code);
    assert.equal(isPermanentRejectionStatus(code, status), false, code);
  }
  assert.equal(isPermanentRejectionStatus("BAD_REQUEST", 400), true);
  assert.equal(isPermanentRejectionStatus("PARSE_ERROR", 404), false);
});

test("a 403 or 404 that is not a tRPC answer never drops a queued row", async () => {
  // A WAF's HTML block page, or a proxy answering /api with the web app's 404
  // page mid-deploy: a status with no tRPC envelope is no verdict on the row.
  for (const status of [403, 404]) {
    const api = createApiClient({
      baseUrl: "https://api.example",
      fetchImpl: (async () =>
        new Response("<html>blocked</html>", {
          status,
          headers: { "content-type": "text/html" },
        })) as unknown as typeof fetch,
    });
    const error = await api.mutate("entries.start", {}).catch((e: unknown) => e);
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "PARSE_ERROR");
    assert.equal(isPermanentRejection(error), false, `HTML ${status}`);
  }
  // The same statuses from the server itself still are.
  assert.equal(isPermanentRejection(new ApiError("no", "NOT_FOUND", 404)), true);
});

test("refusalKeepsRow: a NOT_FOUND keeps a stamped row unless its workspace is confirmed", async () => {
  const notFound = new ApiError("gone", "NOT_FOUND", 404);
  const stamped = { workspaceId: "ws-a" };
  const asked: string[] = [];
  const member = (answer: boolean) => async (id: string) => {
    asked.push(id);
    return answer;
  };

  // Removed from the workspace while the flush ran: kept.
  assert.equal(await refusalKeepsRow(notFound, stamped, member(false)), true);
  // The re-ask failed: kept — not knowing is no reason to delete.
  assert.equal(
    await refusalKeepsRow(notFound, stamped, async () => {
      throw new Error("offline");
    }),
    true
  );
  // Still a member, so the entry really is gone: dropped as before.
  assert.equal(await refusalKeepsRow(notFound, stamped, member(true)), false);
  assert.deepEqual(asked, ["ws-a", "ws-a"]);

  // Nothing to re-ask about: an unstamped row, or a refusal that is not NOT_FOUND.
  asked.length = 0;
  assert.equal(await refusalKeepsRow(notFound, {}, member(false)), false);
  assert.equal(
    await refusalKeepsRow(new ApiError("bad", "BAD_REQUEST", 400), stamped, member(false)),
    false
  );
  assert.equal(await refusalKeepsRow(new Error("x"), stamped, member(false)), false);
  assert.deepEqual(asked, []);
});
