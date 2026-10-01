import assert from "node:assert/strict";
import { test } from "node:test";
import { assertEntryClientSupported, createApiClient } from "../api-client.js";
import { buildQuickStartInput } from "../quick-start.js";
import { decodeOfflineMutation } from "../offline-ops.js";
import { quickStartKey } from "@starter/shared";

const quick = {
  description: "Shared",
  projectId: "project",
  taskId: null,
  billable: true,
};
test("independent clients distinguish quick starts and survive input construction", () => {
  assert.notEqual(
    quickStartKey({ ...quick, clientId: "a" }),
    quickStartKey({ ...quick, clientId: "b" }),
  );
  assert.notEqual(
    quickStartKey({ ...quick, clientId: null }),
    quickStartKey(quick),
  );
  assert.equal(
    buildQuickStartInput(
      { ...quick, clientId: "b" },
      { source: "web", timeZone: "UTC", originId: "test" },
    ).clientId,
    "b",
  );
  const decoded = decodeOfflineMutation({
    id: "q",
    op: "entries.start",
    createdAt: new Date().toISOString(),
    payload: { input: { ...quick, clientId: "b" } },
  });
  assert.equal(decoded?.op === "entries.start" && decoded.input.clientId, "b");
});
test("older servers cannot silently drop a selected client", async () => {
  let calls = 0;
  const client = createApiClient({
    baseUrl: "http://example.test",
    serverApiLevel: () => 6,
    fetchImpl: async () => {
      calls++;
      return new Response("{}");
    },
  });
  await assert.rejects(
    client.mutate("entries.start", { ...quick, clientId: "b" }),
    /Update the server/,
  );
  assert.equal(calls, 0);
  assert.doesNotThrow(() =>
    assertEntryClientSupported(
      "entries.update",
      { id: "e", description: "rename" },
      6,
    ),
  );
  assert.doesNotThrow(() =>
    assertEntryClientSupported(
      "entries.start",
      { ...quick, clientId: null },
      7,
    ),
  );
});
