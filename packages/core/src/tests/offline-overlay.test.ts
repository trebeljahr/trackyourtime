import assert from "node:assert/strict";
import test from "node:test";
import {
  applyOverlay,
  emptyOverlay,
  isOverlayEmpty,
  overlayRunning,
  parseOverlay,
  decodeStoredOverlay,
  encodeStoredOverlay,
  resolveRunning,
  withOptimisticEntry,
  withOptimisticPatch,
  withOptimisticRemoval,
  withoutResolved,
  type OfflineOverlay,
} from "../offline-overlay.js";
import type { DetailedEntry } from "@starter/shared";

const entry = (
  id: string,
  start: string,
  overrides: Partial<DetailedEntry> = {},
): DetailedEntry => ({
  id,
  workspaceId: "w",
  authorId: "u",
  description: id,
  projectId: null,
  taskId: null,
  billable: false,
  start,
  end: null,
  durationSec: 0,
  hourlyRate: null,
  currency: "EUR",
  source: "api",
  timeZone: "Europe/Berlin",
  runaway: null,
  tagIds: [],
  invoiceId: null,
  importId: null,
  createdAt: start,
  updatedAt: start,
  projectName: null,
  projectColor: null,
  clientName: null,
  taskName: null,
  amount: 0,
  ...overrides,
});

test("an empty overlay leaves the server's entries exactly as they came", () => {
  const server = [entry("a", "2026-09-08T09:00:00.000Z")];
  assert.deepEqual(applyOverlay(server, emptyOverlay()), server);
});

test("a queued deletion hides the entry it names", () => {
  const server = [
    entry("a", "2026-09-08T09:00:00.000Z"),
    entry("b", "2026-09-08T10:00:00.000Z"),
  ];
  const overlay = withOptimisticRemoval(emptyOverlay(), "a");
  assert.deepEqual(
    applyOverlay(server, overlay).map((row) => row.id),
    ["b"],
  );
});

test("a queued edit is shown over the server's row", () => {
  const server = [entry("a", "2026-09-08T09:00:00.000Z")];
  const overlay = withOptimisticPatch(emptyOverlay(), "a", {
    description: "renamed",
  });
  assert.equal(applyOverlay(server, overlay)[0]?.description, "renamed");
});

test("a second edit builds on the first rather than replacing it", () => {
  let overlay = withOptimisticPatch(emptyOverlay(), "a", { description: "one" });
  overlay = withOptimisticPatch(overlay, "a", { billable: true });
  assert.deepEqual(overlay.patches.a, { description: "one", billable: true });
});

test("an edit to a local entry lands on the entry, not in the patch map", () => {
  const local = entry("temp-1", "2026-09-08T09:00:00.000Z");
  let overlay = withOptimisticEntry(emptyOverlay(), local);
  overlay = withOptimisticPatch(overlay, "temp-1", { description: "renamed" });

  assert.deepEqual(overlay.patches, {});
  assert.equal(overlay.entries[0]?.description, "renamed");
});

test("deleting a local entry forgets it; deleting a server entry remembers it", () => {
  const local = entry("temp-1", "2026-09-08T09:00:00.000Z");
  const withLocal = withOptimisticEntry(emptyOverlay(), local);

  const localGone = withOptimisticRemoval(withLocal, "temp-1");
  assert.deepEqual(localGone.entries, []);
  assert.deepEqual(localGone.removed, []);

  const serverGone = withOptimisticRemoval(emptyOverlay(), "a");
  assert.deepEqual(serverGone.removed, ["a"]);
  // Queuing the same deletion twice must not queue it twice.
  assert.deepEqual(withOptimisticRemoval(serverGone, "a").removed, ["a"]);
});

test("local entries are shown newest first alongside the server's", () => {
  const server = [entry("a", "2026-09-08T09:00:00.000Z")];
  const overlay = withOptimisticEntry(
    emptyOverlay(),
    entry("temp-1", "2026-09-08T11:00:00.000Z"),
  );
  assert.deepEqual(
    applyOverlay(server, overlay).map((row) => row.id),
    ["temp-1", "a"],
  );
});

test("a local entry outside the requested window is not shown in it", () => {
  const overlay = withOptimisticEntry(
    emptyOverlay(),
    entry("temp-1", "2026-09-01T09:00:00.000Z"),
  );
  const shown = applyOverlay([], overlay, {
    from: "2026-09-08T00:00:00.000Z",
    to: "2026-09-08T23:59:59.000Z",
  });
  assert.deepEqual(shown, []);
});

test("a local entry the server's page already carries is not shown twice", () => {
  const server = [entry("temp-1", "2026-09-08T09:00:00.000Z")];
  const overlay = withOptimisticEntry(
    emptyOverlay(),
    entry("temp-1", "2026-09-08T09:00:00.000Z"),
  );
  assert.equal(applyOverlay(server, overlay).length, 1);
});

test("a locally started timer outranks the server's answer", () => {
  const local = entry("temp-1", "2026-09-08T11:00:00.000Z");
  const overlay = withOptimisticEntry(emptyOverlay(), local);
  assert.equal(overlayRunning(overlay)?.id, "temp-1");
  assert.equal(resolveRunning(null, overlay)?.id, "temp-1");
});

test("a queued stop hides the server's running entry", () => {
  const running = entry("a", "2026-09-08T09:00:00.000Z");
  const overlay = withOptimisticPatch(emptyOverlay(), "a", {
    end: "2026-09-08T10:00:00.000Z",
  });
  assert.equal(resolveRunning(running, overlay), null);
});

test("a queued deletion hides the server's running entry", () => {
  const running = entry("a", "2026-09-08T09:00:00.000Z");
  const overlay = withOptimisticRemoval(emptyOverlay(), "a");
  assert.equal(resolveRunning(running, overlay), null);
});

test("a queued edit that does not end the entry keeps it running, edited", () => {
  const running = entry("a", "2026-09-08T09:00:00.000Z");
  const overlay = withOptimisticPatch(emptyOverlay(), "a", {
    description: "renamed",
  });
  const resolved = resolveRunning(running, overlay);
  assert.equal(resolved?.id, "a");
  assert.equal((resolved as DetailedEntry).description, "renamed");
});

test("a replayed start's local copy is dropped once it has a real id", () => {
  const overlay = withOptimisticEntry(
    emptyOverlay(),
    entry("temp-1", "2026-09-08T09:00:00.000Z"),
  );
  const after = withoutResolved(overlay, new Map([["temp-1", "real-1"]]));
  assert.deepEqual(after.entries, []);
  assert.ok(isOverlayEmpty(after));
});

test("an unreadable stored overlay reads as no overlay at all", () => {
  assert.ok(isOverlayEmpty(parseOverlay(null)));
  assert.ok(isOverlayEmpty(parseOverlay("nonsense")));
  assert.ok(isOverlayEmpty(parseOverlay({ entries: "no" })));

  const real: OfflineOverlay = {
    entries: [],
    patches: { a: { description: "x" } },
    removed: ["b"],
  };
  assert.deepEqual(parseOverlay(JSON.parse(JSON.stringify(real))), real);
});

test("a stored overlay round trips through the envelope and reads the bare shape", () => {
  const overlay = withOptimisticEntry(
    emptyOverlay(),
    entry("temp-1", "2026-09-08T09:00:00.000Z"),
  );
  const raw = encodeStoredOverlay(overlay);
  assert.equal((JSON.parse(raw) as { v: number }).v, 1);
  assert.deepEqual(decodeStoredOverlay(raw), overlay);
  assert.deepEqual(decodeStoredOverlay(JSON.stringify(overlay)), overlay);
});

test("a newer build's overlay, or rows another build shaped wrongly, are dropped", () => {
  const good = entry("temp-1", "2026-09-08T09:00:00.000Z");
  const overlay = { entries: [good], patches: {}, removed: [] };
  assert.ok(isOverlayEmpty(decodeStoredOverlay(JSON.stringify({ v: 2, data: overlay }))));
  assert.ok(isOverlayEmpty(decodeStoredOverlay("{broken")));

  const mixed = decodeStoredOverlay(
    JSON.stringify({
      entries: [good, { ...good, id: "temp-2", hourlyRate: "80" }],
      patches: { a: { description: "x" }, b: { hourlyRate: "NaN" }, c: 4 },
      removed: ["d", 5],
    }),
  );
  assert.deepEqual(mixed.entries.map((row) => row.id), ["temp-1"]);
  assert.deepEqual(mixed.patches, { a: { description: "x" } });
  assert.deepEqual(mixed.removed, ["d"]);
});
