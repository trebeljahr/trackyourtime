import assert from "node:assert/strict";
import test from "node:test";
import { buildOptimisticEntry, stoppedEntryShape, type EntryShapeContext } from "../entry-shape.js";
import { readStoredSettings } from "../stored-catalog.js";

const context: EntryShapeContext = {
  source: "web", projects: [],
  settings: { workspaceId: "w", userId: "u", currency: "EUR", defaultHourlyRate: 0, memberHourlyRate: 95 },
};
const input = { id: "temp", description: "Work", projectId: null, taskId: null, billable: true, start: "2026-09-15T09:00:00Z", end: null };

test("offline no-project entries and stops use only-member configured rate", () => {
  const entry = buildOptimisticEntry(context, input);
  assert.equal(entry.hourlyRate, 95);
  const stopped = stoppedEntryShape(context, entry, "2026-09-15T10:00:00Z");
  assert.equal(stopped.hourlyRate, 95); assert.equal(stopped.amount, 95);
});
test("offline explicit zero and older settings retain their distinct fallbacks", () => {
  assert.equal(buildOptimisticEntry({ ...context, settings: { ...context.settings!, defaultHourlyRate: 60, memberHourlyRate: 0 } }, input).hourlyRate, 0);
  const { memberHourlyRate: _rate, ...legacy } = context.settings!;
  assert.equal(buildOptimisticEntry({ ...context, settings: { ...legacy, defaultHourlyRate: 60 } }, input).hourlyRate, 60);
  assert.equal(readStoredSettings(context.settings)?.memberHourlyRate, 95);
  assert.equal(readStoredSettings({ ...legacy, memberHourlyRate: 0 })?.memberHourlyRate, 0);
  assert.equal(readStoredSettings(legacy)?.memberHourlyRate, undefined);
});
test("stopping a colleague or foreign-workspace row never uses the viewer's member rate", () => {
  const entry = { ...buildOptimisticEntry(context, input), hourlyRate: 33, currency: "CHF", authorId: "colleague" };
  assert.equal(stoppedEntryShape(context, entry, "2026-09-15T10:00:00Z").hourlyRate, 33);
  assert.equal(stoppedEntryShape(context, entry, "2026-09-15T10:00:00Z").currency, "CHF");
  assert.equal(stoppedEntryShape(context, { ...entry, authorId: "u", workspaceId: "foreign" }, "2026-09-15T10:00:00Z").hourlyRate, 33);
});

test("project override wins over member, including zero", () => {
  for (const rate of [120, 0]) {
    const withProject = { ...context, projects: [{ id: "p", name: "Project", color: "#000000", hourlyRate: rate }] };
    assert.equal(buildOptimisticEntry(withProject, { ...input, projectId: "p" }).hourlyRate, rate);
  }
});

test("approval conflicts retain offline edits instead of dropping them", async () => {
  const { classifyReplayOutcome } = await import("../offline-replay.js");
  const result = await classifyReplayOutcome({ message: "TIMESHEET_LOCKED", data: { code: "CONFLICT", httpStatus: 409 } }, { op: "entries.update" }, { isTransportFailure: () => false });
  assert.deepEqual(result, { kind: "hold", reason: "refused", message: "TIMESHEET_LOCKED", code: "CONFLICT" });
});
