import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import ts from "typescript";

// Exercise the shipped API boundary, queue and overlay. Only the Raycast host
// identity/store and transport are replaced; the store receives synthetic data.
const root = await mkdtemp(join(tmpdir(), "raycast-durable-api-"));
// The server answers at this build's own level, so a row stamped by this
// build is never held as `server-too-old` — whatever the level is today.
const API_LEVEL = Number(
  /export const API_LEVEL = (\d+);/.exec(
    readFileSync(new URL("../src/vendor/shared/api-level.ts", import.meta.url), "utf8"),
  )?.[1],
);
assert.ok(Number.isInteger(API_LEVEL), "the vendored API_LEVEL is readable");
const values = new Map();
globalThis.__raycastProof = { values, root };
const mocks = new Map([
  [
    "@raycast/api",
    `const {values, root} = globalThis.__raycastProof;
    export const environment = {supportPath:root};
    export const LocalStorage = {getItem:async k=>values.get(k),setItem:async(k,v)=>values.set(k,v),
      removeItem:async k=>values.delete(k),allItems:async()=>Object.fromEntries(values)};`,
  ],
  [
    new URL("../src/lib/auth.ts", import.meta.url).href,
    `export const CLIENT_ID='raycast-proof';
    export const getStoredSession=async()=>({token:'synthetic-token'});
    export const getStoredUserId=async()=> 'owner'; export const getOriginId=async()=> 'proof-origin';`,
  ],
  [new URL("../src/lib/preferences.ts", import.meta.url).href, `export const apiUrl=()=> 'http://synthetic.invalid';`],
  [
    new URL("../src/lib/server-level.ts", import.meta.url).href,
    `export const knownServerApiLevel=async()=>${API_LEVEL};
    export const refreshServerLevel=async()=>null; export const noteClientTooOld=async()=>{};`,
  ],
]);
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (mocks.has(specifier)) return { url: `proof:${encodeURIComponent(specifier)}`, shortCircuit: true };
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
      const candidate = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL).href;
      if (mocks.has(candidate)) return { url: `proof:${encodeURIComponent(candidate)}`, shortCircuit: true };
      try {
        readFileSync(fileURLToPath(candidate));
        return { url: candidate, shortCircuit: true };
      } catch {}
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith("proof:"))
      return { format: "module", source: mocks.get(decodeURIComponent(url.slice(6))), shortCircuit: true };
    if (url.endsWith(".ts"))
      return {
        format: "module",
        source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        shortCircuit: true,
      };
    return next(url, context);
  },
});
const { getTrackYourTime } = await import("../src/lib/api.ts");
const { getOfflineQueue, cancelQueuedForTemp } = await import("../src/lib/offline.ts");
const { installWorkspaceList } = await import("../src/lib/workspace.ts");
const queue = getOfflineQueue();
const workspaces = [{ id: "workspace", name: "Synthetic", role: "owner", slug: "synthetic", isDefault: true }];
const originalFetch = globalThis.fetch;
let requests = [];
let fail = null;
const receipts = new Map();
globalThis.fetch = async (url, options) => {
  const path = new URL(url).pathname.split("/").pop();
  if (path === "workspaces.list") return Response.json({ result: { data: workspaces } });
  if (path === "entries.get")
    return Response.json({
      result: {
        data: {
          id: "known-entry",
          description: "Synthetic",
          clientId: null,
          projectId: null,
          taskId: null,
          billable: false,
          tagIds: ["tag"],
        },
      },
    });
  assert.equal(path, "entries.applyOperation", "entry writes must never fall back to an old mutation path");
  const envelope = JSON.parse(options.body);
  const rows = await queueStorageRows();
  assert.ok(
    rows.some((row) => row.submittedInput?.operationId === envelope.operationId),
    "the exact identity must persist before HTTP",
  );
  requests.push(envelope);
  if (fail === "old")
    return Response.json(
      {
        error: {
          message: 'No procedure found on path "entries.applyOperation"',
          data: { code: "NOT_FOUND", httpStatus: 404 },
        },
      },
      { status: 404 },
    );
  if (fail === "standalone")
    return Response.json(
      {
        error: {
          message: "DURABLE_REPLAY_REQUIRES_REPLICA_SET",
          data: { code: "PRECONDITION_FAILED", httpStatus: 412 },
        },
      },
      { status: 412 },
    );
  if (!receipts.has(envelope.operationId))
    receipts.set(envelope.operationId, {
      id: envelope.input.id ?? `entry-${receipts.size}`,
      ...envelope.input,
      end: null,
    });
  if (fail === "lost") {
    fail = null;
    throw new TypeError("Synthetic dropped response after commit");
  }
  return Response.json({ result: { data: receipts.get(envelope.operationId) } });
};
async function queueStorageRows() {
  const stored = JSON.parse(values.get("trackyourtime.offline-queue") ?? "{}");
  return stored.data ?? stored.rows ?? [];
}
after(async () => {
  globalThis.fetch = originalFetch;
  hook.deregister();
  delete globalThis.__raycastProof;
  await rm(root, { recursive: true, force: true });
});

for (const [operation, run] of [
  ["entries.start", (api) => api.start({ description: "Synthetic" })],
  ["entries.stop", (api) => api.stop("known-entry")],
  [
    "entries.create",
    (api) => api.create({ description: "Synthetic", start: "2026-01-01T00:00:00Z", end: "2026-01-01T01:00:00Z" }),
  ],
  ["entries.update", (api) => api.update({ id: "known-entry", description: "Synthetic edit" })],
  ["entries.remove", (api) => api.remove("known-entry")],
  ["entries.discard", (api) => api.discard("known-entry")],
  [
    "entries.start",
    (api) =>
      api.continue("known-entry", {
        description: "Synthetic",
        clientId: null,
        projectId: null,
        taskId: null,
        billable: false,
      }),
  ],
])
  test(
    `${operation}: a committed lost response retains one immutable operation and replays once`,
    { skip: process.platform !== "darwin" },
    async () => {
      values.clear();
      receipts.clear();
      requests = [];
      fail = "lost";
      await installWorkspaceList(workspaces);
      const api = await getTrackYourTime();
      const result = await run(api);
      const rows = await queue.list();
      assert.equal(rows.length, 1);
      assert.equal(requests[0].operation, operation);
      assert.equal(rows[0].submittedInput.operationId, requests[0].operationId);
      if (result.id.startsWith("temp-")) await assert.rejects(cancelQueuedForTemp(result.id), /not synced/);
      assert.equal(await api.sync(), 0);
      assert.equal(receipts.size, 1);
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[1], requests[0]);
      assert.equal(await queue.size(), 0);
    },
  );

for (const refusal of ["old", "standalone"])
  test(
    `${refusal} server keeps the write without using legacy endpoints`,
    { skip: process.platform !== "darwin" },
    async () => {
      values.clear();
      receipts.clear();
      requests = [];
      fail = refusal;
      await installWorkspaceList(workspaces);
      const api = await getTrackYourTime();
      await api.start({ description: "Synthetic held write" });
      assert.equal(await queue.size(), 1);
      await api.sync();
      assert.equal(await queue.size(), 1);
      assert.equal(receipts.size, 0);
      assert.ok(requests.every((request) => request.operation === "entries.start"));
    },
  );

test(
  "ambiguous pre-receipt temp writes require recovery rather than automatic cancellation or replay",
  { skip: process.platform !== "darwin" },
  async () => {
    values.clear();
    receipts.clear();
    requests = [];
    fail = null;
    await installWorkspaceList(workspaces);
    const legacy = {
      id: "legacy",
      owner: "owner",
      server: "http://synthetic.invalid",
      workspaceId: "workspace",
      op: "entries.start",
      createdAt: new Date().toISOString(),
      apiLevel: 11,
      payload: { tempId: "temp-legacy", input: { description: "Synthetic legacy", start: "2026-01-01T00:00:00Z" } },
    };
    values.set("trackyourtime.offline-queue", JSON.stringify({ v: 2, data: [legacy] }));
    await assert.rejects(cancelQueuedForTemp("temp-legacy"), /not synced/);
    const api = await getTrackYourTime();
    await api.sync();
    assert.equal(requests.length, 0);
    assert.equal((await queue.list())[0].hold.code, "LEGACY_WRITE_OUTCOME_UNKNOWN");
  },
);
