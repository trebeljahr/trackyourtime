// A workspace export's version decides what an ABSENT section means: in a v1
// file no `favorites` means "this file predates pins", in v2 and anything
// later it means "there were none". So a file from a newer build must read as
// the newest version this reader knows — never fall back to v1 — and the
// preview must be able to say the file is newer than the reader.
import assert from "node:assert/strict";
import test from "node:test";
import { WORKSPACE_EXPORT_VERSION } from "@starter/shared";
import {
  readExportVersion,
  workspaceJsonCatalog,
} from "../services/import/parse.js";

const readWith = (version: unknown) => {
  const doc = workspaceJsonCatalog(
    JSON.stringify({
      ...(version === undefined ? {} : { version }),
      exportedAt: "2026-09-01T00:00:00.000Z",
      workspaceId: "workspace-0",
      currency: "EUR",
      entries: [],
    }),
  );
  assert.ok(doc, "the document should read as one of our exports");
  return doc;
};

test("a v1 file reads as v1 and claims to be no newer", () => {
  const doc = readWith(1);
  assert.equal(doc.version, 1);
  assert.equal(doc.newerVersion, undefined);
});

test("a file with no version reads as v1, the only format that omitted it", () => {
  const doc = readWith(undefined);
  assert.equal(doc.version, 1);
  assert.equal(doc.newerVersion, undefined);
});

test("a v2 file reads as v2", () => {
  const doc = readWith(2);
  assert.equal(doc.version, 2);
  assert.equal(doc.newerVersion, undefined);
});

test("a v3 file reads as the newest known version, not as v1", () => {
  const doc = readWith(3);
  assert.equal(doc.version, WORKSPACE_EXPORT_VERSION);
  assert.equal(doc.newerVersion, 3);
  // Absent favorites stay absent: under v2 that reads as "none", which is
  // what a newer file with no favorites key means too.
  assert.equal(doc.favorites, undefined);
});

test("a version that is not a number reads as v1", () => {
  for (const value of ["2", null, Number.NaN, 0, -3, true]) {
    assert.deepEqual(readExportVersion(value), { version: 1 }, String(value));
  }
});

test("the reader's own version is never reported as newer", () => {
  assert.deepEqual(readExportVersion(WORKSPACE_EXPORT_VERSION), {
    version: WORKSPACE_EXPORT_VERSION,
  });
});
