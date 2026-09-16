import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeVersioned,
  decodeVersionedValue,
  encodeVersioned,
  type VersionedSpec,
} from "../versioned-storage.js";
import {
  readRunningEntryLeniently,
  readStoredDetailedEntry,
  readStoredList,
  readStoredTimeEntry,
} from "../stored-entry.js";

type Point = { x: number };

const readPoint = (value: unknown): Point | null => {
  if (typeof value !== "object" || value === null) return null;
  const { x } = value as { x?: unknown };
  return typeof x === "number" ? { x } : null;
};

const spec: VersionedSpec<Point> = {
  version: 2,
  decode: readPoint,
  legacy: (value) => readPoint(value),
  older: {
    1: (data) =>
      typeof data === "number" ? { x: data } : null,
  },
};

test("round trips the current version", () => {
  const raw = encodeVersioned(2, { x: 3 });
  assert.deepEqual(JSON.parse(raw), { v: 2, data: { x: 3 } });
  assert.deepEqual(decodeVersioned(raw, spec), { x: 3 });
});

test("reads a legacy unversioned value through the legacy decoder", () => {
  assert.deepEqual(decodeVersioned(JSON.stringify({ x: 5 }), spec), { x: 5 });
  const withoutLegacy: VersionedSpec<Point> = { version: 2, decode: readPoint };
  assert.equal(decodeVersioned(JSON.stringify({ x: 5 }), withoutLegacy), null);
});

test("reads an older version only through its own reader", () => {
  assert.deepEqual(decodeVersioned(encodeVersioned(1, 9), spec), { x: 9 });
  const noOlder: VersionedSpec<Point> = { version: 2, decode: readPoint };
  assert.equal(decodeVersioned(encodeVersioned(1, 9), noOlder), null);
});

test("a higher version is a miss, even when its data looks readable", () => {
  assert.equal(decodeVersioned(encodeVersioned(3, { x: 1 }), spec), null);
});

test("garbage is a miss", () => {
  for (const raw of [null, undefined, "", "{nope", "42", "null", "[]", '"x"']) {
    assert.equal(decodeVersioned(raw, spec), null, String(raw));
  }
  assert.equal(decodeVersioned(encodeVersioned(2, { x: "1" }), spec), null);
  assert.equal(decodeVersioned(JSON.stringify({ v: "2", data: { x: 1 } }), spec), null);
  assert.equal(decodeVersioned(JSON.stringify({ v: 0, data: { x: 1 } }), spec), null);
});

test("never throws, whatever the decoders do", () => {
  const throwing: VersionedSpec<Point> = {
    version: 1,
    decode: () => {
      throw new Error("decode");
    },
    legacy: () => {
      throw new Error("legacy");
    },
  };
  assert.equal(decodeVersioned(encodeVersioned(1, {}), throwing), null);
  assert.equal(decodeVersioned("{}", throwing), null);
  assert.equal(decodeVersionedValue(undefined, throwing), null);
});

const entry = {
  id: "e1",
  workspaceId: "w",
  authorId: "u",
  description: "Work",
  projectId: "p",
  taskId: null,
  billable: true,
  start: "2026-09-01T09:00:00.000Z",
  end: null,
  durationSec: 0,
  hourlyRate: 80,
  currency: "EUR",
  source: "web",
  timeZone: "Europe/Berlin",
  runaway: null,
  tagIds: [],
  invoiceId: null,
  importId: null,
  createdAt: "2026-09-01T09:00:00.000Z",
  updatedAt: "2026-09-01T09:00:00.000Z",
};

test("a stored entry keeps unknown extra fields and rejects a bad rate", () => {
  assert.deepEqual(readStoredTimeEntry({ ...entry, future: 1 }), { ...entry, future: 1 });
  assert.equal(readStoredTimeEntry({ ...entry, hourlyRate: "80" }), null);
  assert.equal(readStoredTimeEntry({ ...entry, start: "yesterday" }), null);
  assert.equal(readStoredTimeEntry({ ...entry, tagIds: undefined }), null);
});

test("a stored detailed entry needs a numeric or null amount", () => {
  const detailed = {
    ...entry,
    projectName: "P",
    projectColor: "#fff",
    clientName: null,
    taskName: null,
    amount: 10,
  };
  assert.deepEqual(readStoredDetailedEntry(detailed), detailed);
  assert.equal(readStoredDetailedEntry({ ...detailed, amount: "10" }), null);
  assert.deepEqual(
    readStoredList([detailed, { id: 1 }, null], readStoredDetailedEntry),
    [detailed],
  );
  assert.deepEqual(readStoredList("nope", readStoredDetailedEntry), []);
});

test("the lenient running reader needs only id, start and no end", () => {
  const read = readRunningEntryLeniently({
    id: "e1",
    start: entry.start,
    end: null,
  });
  assert.equal(read?.id, "e1");
  assert.equal(read?.description, "");
  assert.deepEqual(read?.tagIds, []);
  assert.equal(readRunningEntryLeniently({ ...entry, end: entry.start }), null);
  assert.equal(readRunningEntryLeniently({ ...entry, id: "" }), null);
});
