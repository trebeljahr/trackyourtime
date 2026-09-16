import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readStoredClient,
  readStoredFavorite,
  readStoredProject,
  readStoredSettings,
  readStoredTag,
  readStoredTask,
} from "../stored-catalog.js";
import { readStoredList } from "../stored-entry.js";
import { buildOptimisticEntry } from "../entry-shape.js";

const project = {
  id: "p1",
  workspaceId: "w1",
  createdBy: "u1",
  name: "Client work",
  color: "#123456",
  clientId: null,
  billableDefault: true,
  hourlyRate: 120,
  estimatedHours: null,
  budgetAmount: null,
  archived: false,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  clientName: null,
  clientColor: null,
  entryCount: 3,
  totalSec: 900,
};

test("a cached project keeps its rate and unknown fields, and a bad rate drops it", () => {
  assert.deepEqual(readStoredProject({ ...project, newer: "x" }), { ...project, newer: "x" });
  assert.equal(readStoredProject({ ...project, hourlyRate: "120" }), null);
  assert.equal(readStoredProject({ ...project, billableDefault: "yes" }), null);
  // Stats a newer build dropped are informational: they default.
  const { entryCount: _count, totalSec: _total, ...withoutStats } = project;
  assert.equal(readStoredProject(withoutStats)?.totalSec, 0);
});

test("settings missing the money fields read as not loaded", () => {
  const settings = {
    workspaceId: "w1",
    userId: "u1",
    currency: "EUR",
    defaultHourlyRate: 50,
    weekStartsOn: 1,
  };
  assert.deepEqual(readStoredSettings(settings), settings);
  assert.equal(readStoredSettings({ ...settings, currency: "" }), null);
  assert.equal(readStoredSettings({ ...settings, defaultHourlyRate: null }), null);
  assert.equal(readStoredSettings("nope"), null);
});

test("a shape from another build cannot produce NaN money", () => {
  const projects = readStoredList(
    [project, { ...project, id: "p2", hourlyRate: "lots" }],
    readStoredProject,
  );
  assert.deepEqual(projects.map((row) => row.id), ["p1"]);

  const settings = readStoredSettings({ workspaceId: "w1", userId: "u1", currency: "EUR", defaultHourlyRate: "50" });
  const shaped = buildOptimisticEntry(
    { projects, settings, source: "api" },
    {
      id: "temp-1",
      description: "",
      projectId: "p2",
      taskId: null,
      billable: true,
      start: "2026-09-01T09:00:00.000Z",
      end: "2026-09-01T10:00:00.000Z",
    },
  );
  assert.ok(shaped.hourlyRate === null || Number.isFinite(shaped.hourlyRate));
  assert.ok(shaped.amount === null || Number.isFinite(shaped.amount));
});

test("tasks, tags, clients and favorites need their names and ids", () => {
  assert.equal(readStoredTask({ id: "t1", name: "Design" })?.totalSec, 0);
  assert.equal(readStoredTask({ id: "t1" }), null);
  assert.equal(readStoredTag({ id: "g1", name: "deep", color: "#fff" })?.archived, false);
  assert.equal(readStoredTag({ id: "g1", name: "deep" }), null);
  assert.equal(readStoredClient({ id: "c1", name: "Acme", color: "#000" })?.name, "Acme");
  assert.equal(readStoredClient({ id: "", name: "Acme", color: "#000" }), null);
  const favorite = { id: "f1", description: "Mail", projectId: null, taskId: null, billable: false };
  assert.equal(readStoredFavorite(favorite)?.projectMissing, false);
  assert.equal(readStoredFavorite({ ...favorite, billable: 1 }), null);
});
