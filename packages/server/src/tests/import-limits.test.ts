import assert from "node:assert/strict";
import test from "node:test";
import {
  ImportFileError,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_CELL_CHARS,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_METADATA_ROWS,
  MAX_IMPORT_ROWS,
  MAX_IMPORT_TAGS,
  importInputSchema,
} from "@starter/shared";
import { parseDelimited, readDelimitedFile } from "../services/import/delimited.js";
import { parseImportFile, workspaceJsonCatalog } from "../services/import/parse.js";

const entry = {
  description: "Review",
  start: "2026-10-23T09:00:00.000Z",
  end: "2026-10-23T10:00:00.000Z",
  durationSec: 3600,
  tagNames: ["work"],
};
const parse = (text: string) => parseImportFile(text, { timeZone: "UTC" });
const json = (record: unknown = entry) => JSON.stringify({ version: 2, entries: [record] });
const refuses = (run: () => unknown, message: RegExp): void => {
  assert.throws(run, (error: unknown) => error instanceof ImportFileError && message.test(error.message));
};

test("plaintext exports and CSV imports still produce time records", () => {
  const csv = "Description,Start,End,Tags\nReview,2026-10-23T09:00:00Z,2026-10-23T10:00:00Z,work";
  assert.equal(parse(csv).rows[0]?.durationSec, 3600);
  const restored = parse(`\uFEFF${json()}`);
  assert.equal(restored.format, "workspace-json");
  assert.equal(restored.rows[0]?.description, "Review");
  assert.deepEqual(restored.rows[0]?.tagNames, ["work"]);
});

test("arbitrary JSON is refused rather than reinterpreted as CSV", () => {
  for (const value of [{ payload: "opaque" }, [entry], { entries: "opaque" }]) {
    refuses(() => parse(JSON.stringify(value)), /plaintext workspace JSON/);
  }
  refuses(() => parse('{"entries":['), /plaintext workspace JSON/);
});

test("encrypted export envelopes and encrypted records are refused", () => {
  for (const encrypted of [
    { encrypted: true },
    { ciphertext: "opaque" },
    { cyphertext: "opaque" },
    { encryptedPayload: "opaque" },
  ]) {
    refuses(() => parse(JSON.stringify({ ...encrypted, entries: [entry] })), /Encrypted backups/);
    refuses(() => parse(json({ ...entry, ...encrypted })), /encrypted record/);
  }
  refuses(() => parse("Description,Start,End\n\0binary"), /plaintext CSV/);
});

test("the input schema counts UTF-8 bytes, including multi-byte characters", () => {
  for (const unit of ["x", "é", "€", "🕒", "\ud800", "\udfff"]) {
    const bytes = Buffer.byteLength(unit, "utf8");
    const atLimit = unit.repeat(Math.floor(MAX_IMPORT_BYTES / bytes)) + "x".repeat(MAX_IMPORT_BYTES % bytes);
    assert.equal(Buffer.byteLength(atLimit, "utf8"), MAX_IMPORT_BYTES);
    assert.equal(importInputSchema.safeParse({ text: atLimit }).success, true);
    assert.equal(importInputSchema.safeParse({ text: atLimit + "x" }).success, false);
  }
});

test("direct parser entry points enforce the file byte ceiling too", () => {
  const oversized = "🕒".repeat(MAX_IMPORT_BYTES / 4 + 1);
  assert.ok(oversized.length < MAX_IMPORT_BYTES);
  refuses(() => parse(oversized), /byte import limit/);
  refuses(() => readDelimitedFile(oversized), /byte import limit/);
  refuses(() => workspaceJsonCatalog(oversized), /byte import limit/);
});

test("CSV row limits include unreadable rows and exclude the header", () => {
  const atLimit = "Description,Start,End\n" + "bad,no,no\n".repeat(MAX_IMPORT_ROWS);
  assert.equal(readDelimitedFile(atLimit).rows.length, MAX_IMPORT_ROWS);
  refuses(() => readDelimitedFile(atLimit + "bad,no,no\n"), /at most 25,000 rows/);
});

test("JSON limits apply before unreadable entries can be discarded", () => {
  const entries = Array(MAX_IMPORT_ROWS).fill(null);
  // At the row limit, normal record validation runs instead of the row guard.
  refuses(() => workspaceJsonCatalog(JSON.stringify({ entries })), /invalid record/);
  refuses(() => workspaceJsonCatalog(JSON.stringify({ entries: [...entries, null] })), /at most 25,000 rows/);
});

test("CSV columns and individual cells are bounded even when ignored", () => {
  assert.equal(parseDelimited(Array(MAX_IMPORT_COLUMNS).fill("x").join(","), ",")[0]?.length, MAX_IMPORT_COLUMNS);
  refuses(() => parseDelimited(Array(MAX_IMPORT_COLUMNS + 1).fill("x").join(","), ","), /at most 512 columns/);
  assert.equal(parseDelimited("x".repeat(MAX_IMPORT_CELL_CHARS), ",")[0]?.[0]?.length, MAX_IMPORT_CELL_CHARS);
  refuses(() => parseDelimited("x".repeat(MAX_IMPORT_CELL_CHARS + 1), ","), /at most 16,000 characters/);
  refuses(() => parseDelimited(`a,b\n"${"x".repeat(MAX_IMPORT_CELL_CHARS + 1)}",ok`, ","), /at most 16,000 characters/);
});

test("delimiter detection tolerates wrong candidates exceeding the cell limit", () => {
  const file = `Description;Start;End;Ignored\n${"x".repeat(10_000)};2026-10-23T09:00:00Z;2026-10-23T10:00:00Z;${"y".repeat(10_000)}`;
  const parsed = parse(file);
  assert.equal(parsed.delimiter, ";");
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0]?.description.length, 500);
});

test("an unterminated quoted CSV cell is refused", () => {
  refuses(() => parse('Description,Start,End\n"Review,2026-10-23T09:00:00Z,2026-10-23T10:00:00Z'), /ends inside a quoted cell/);
});

test("metadata limits count records across all sections before filtering", () => {
  const clients = Array(MAX_IMPORT_METADATA_ROWS).fill(null);
  assert.deepEqual(workspaceJsonCatalog(JSON.stringify({ entries: [], clients }))?.clients, []);
  refuses(() => workspaceJsonCatalog(JSON.stringify({ entries: [], clients, favorites: [{}] })), /at most 25,000 catalog/);
  for (const key of ["clients", "projects", "tasks", "tags", "favorites", "invoices"]) {
    refuses(() => workspaceJsonCatalog(JSON.stringify({ entries: [], [key]: "opaque" })), /section must be an array/);
  }
});

test("JSON entry fields cannot coerce objects, arrays, or unexpected scalars into text", () => {
  for (const record of [
    null,
    "opaque",
    [],
    { ...entry, description: { ciphertext: "opaque" } },
    { ...entry, clientName: 42 },
    { ...entry, start: { iso: entry.start } },
    { ...entry, durationSec: "3600" },
    { ...entry, billable: "true" },
    { ...entry, tagNames: [{ ciphertext: "opaque" }] },
    { ...entry, description: "x".repeat(MAX_IMPORT_CELL_CHARS + 1) },
  ]) {
    refuses(() => parse(json(record)), /invalid .*field/);
  }
  refuses(() => parse('{"entries":[{"durationSec":1e999}]}'), /invalid durationSec field/);
});

test("both formats bound tags and preserve unique plaintext names", () => {
  const tags = Array.from({ length: MAX_IMPORT_TAGS }, (_, index) => `tag-${index}`);
  assert.deepEqual(parse(json({ ...entry, tagNames: tags })).rows[0]?.tagNames, tags);
  const csv = (names: string[]) => `Description,Start,End,Tags\nReview,${entry.start},${entry.end},"${names.join(",")}"`;
  assert.deepEqual(parse(csv(tags)).rows[0]?.tagNames, tags);
  refuses(() => parse(json({ ...entry, tagNames: [...tags, "extra"] })), /invalid tagNames/);
  refuses(() => parse(csv([...tags, "extra"])), /at most 20 tags/);
  refuses(() => parse(json({ ...entry, tagNames: ["x".repeat(61)] })), /invalid tagNames/);
  refuses(() => parse(csv(["x".repeat(61)])), /at most 60 characters/);
  assert.deepEqual(parse(csv(["work", "work"])).rows[0]?.tagNames, ["work"]);
  assert.deepEqual(parse(json({ ...entry, tagNames: ["work", " work "] })).rows[0]?.tagNames, ["work"]);
});

test("JSON nesting is bounded without interpreting brackets or escapes inside text", () => {
  const description = '["nested"] \\ '.repeat(100);
  assert.equal(parse(json({ ...entry, description })).rows.length, 1);
  const nested = '['.repeat(33) + '0' + ']'.repeat(33);
  refuses(() => parse(`{"entries":[],"futureSection":${nested}}`), /nested too deeply/);
});

test("invalid date-only rows do not poison later entries on the same day", () => {
  const parsed = parse("Description,Date,Hours\nBad,2026-10-23,9999\nGood,2026-10-23,1");
  assert.equal(parsed.issues[0]?.code, "implausible-duration");
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0]?.start, "2026-10-23T09:00:00.000Z");
});

test("JSON dates outside the Date range become issues rather than throwing", () => {
  const parsed = parse(json({ ...entry, start: "+275760-09-13T00:00:00.000Z" }));
  assert.equal(parsed.rows.length, 0);
  assert.equal(parsed.issues[0]?.code, "unparsable-end");
});
