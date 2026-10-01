import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { Client } from "../models/Client.js";
import { Favorite } from "../models/Favorite.js";
import { Project } from "../models/Project.js";
import { TimeEntry } from "../models/TimeEntry.js";
import { createEntry, updateEntry } from "../services/entries/crud.js";
import { listEntries } from "../services/entries/list.js";
import { startTimerDetailed, personReach } from "../services/entries/timer.js";
import { listClients } from "../services/catalog/clients.js";
import { buildDetailed } from "../trpc/routers/reports.js";
import { invoicesRouter } from "../trpc/routers/invoices.js";
import { favoritesRouter } from "../trpc/routers/favorites.js";
import {
  INTEGRATION_MODELS,
  OWNER,
  WORKSPACE,
  contextFor,
  seedWorkspace,
} from "./support/einvoice-db-fixture.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  dropTestDatabase,
  skipWithoutDatabase,
} from "./support/test-database.js";

const scope = {
  workspaceId: WORKSPACE,
  userId: OWNER,
  visibility: {
    userId: OWNER,
    canViewOthersTime: true,
    canViewOthersMoney: true,
  },
};
const range = { from: "2026-09-01", to: "2026-09-30" };
const past = {
  description: "Shared project work",
  start: "2026-09-10T09:00:00.000Z",
  end: "2026-09-10T10:00:00.000Z",
  billable: true,
};

describe("independent timer clients", { skip: skipWithoutDatabase }, () => {
  before(() =>
    connectTestDatabase("independent-clients", [
      ...INTEGRATION_MODELS,
      Favorite,
    ] as never),
  );
  afterEach(clearTestDatabase);
  after(dropTestDatabase);

  it("files the same project for different clients, including client-only time, in lists, reports and invoices", async () => {
    const seeded = await seedWorkspace();
    const second = await Client.create({
      workspaceId: WORKSPACE,
      createdBy: OWNER,
      name: "Second client",
      color: "#112233",
    });
    const clientId = String(second._id);
    const shared = await createEntry(scope, {
      ...past,
      projectId: seeded.projectId,
      clientId,
    });
    await createEntry(scope, { ...past, projectId: null, clientId });
    await createEntry(scope, {
      ...past,
      projectId: seeded.projectId,
      clientId: null,
    });
    assert.equal(shared.clientId, clientId);
    assert.equal(
      (await Project.findById(seeded.projectId).lean())?.clientId,
      seeded.clientId,
    );

    const list = await listEntries(scope, { ...range, clientIds: [clientId] });
    assert.equal(list.entries.length, 2);
    assert.ok(
      list.entries.every((entry) => entry.clientName === "Second client"),
    );
    const intersection = await listEntries(scope, {
      ...range,
      clientIds: [clientId],
      projectIds: [seeded.projectId],
    });
    assert.equal(intersection.entries.length, 1);
    const legacy = await listEntries(scope, {
      ...range,
      clientIds: [seeded.clientId],
    });
    assert.equal(
      legacy.entries.length,
      2,
      "explicit no-client does not inherit the project client",
    );
    const report = await buildDetailed(
      scope,
      { ...range, clientIds: [clientId] },
      {},
    );
    assert.equal(report.totalSec, 7200);
    assert.ok(
      report.entries.every((entry) => entry.clientName === "Second client"),
    );
    const invoice = await invoicesRouter
      .createCaller(contextFor(OWNER))
      .preview({ ...range, clientId, groupBy: "project" });
    assert.equal(
      invoice.lineItems.reduce((total, line) => total + line.seconds, 0),
      7200,
    );
    const clients = await listClients(scope, {});
    assert.equal(clients.find((row) => row.id === clientId)?.totalSec, 7200);
  });

  it("edits the client without changing project, and preserves it on project changes", async () => {
    const seeded = await seedWorkspace();
    const original = await createEntry(scope, {
      ...past,
      projectId: seeded.projectId,
    });
    assert.equal(original.clientId, seeded.clientId);
    const cleared = await updateEntry(scope, {
      id: original.id,
      clientId: null,
    });
    assert.equal(cleared.projectId, seeded.projectId);
    assert.equal(cleared.clientId, null);
    const moved = await updateEntry(scope, {
      id: original.id,
      projectId: null,
    });
    assert.equal(moved.clientId, null);
    const legacy = await TimeEntry.findOne({
      workspaceId: WORKSPACE,
      clientId: { $exists: false },
    }).lean();
    assert.ok(legacy);
    const movedLegacy = await updateEntry(scope, {
      id: String(legacy._id),
      projectId: null,
    });
    assert.equal(movedLegacy.clientId, seeded.clientId);
  });

  it("rejects another workspace's client before stopping the running timer", async () => {
    await seedWorkspace();
    const foreign = await Client.create({
      workspaceId: "foreign",
      createdBy: OWNER,
      name: "Foreign",
      color: "#112233",
    });
    const running = await startTimerDetailed(
      scope,
      { description: "Keep running" },
      personReach,
    );
    await assert.rejects(
      startTimerDetailed(scope, { clientId: String(foreign._id) }, personReach),
      /Client not found/,
    );
    assert.equal(
      (await TimeEntry.findById(running.entry.id).lean())?.end,
      null,
    );
  });

  it("keeps separate favorites for the same project under two clients", async () => {
    const seeded = await seedWorkspace();
    const second = await Client.create({
      workspaceId: WORKSPACE,
      createdBy: OWNER,
      name: "Second",
      color: "#112233",
    });
    const caller = favoritesRouter.createCaller(contextFor(OWNER));
    const common = {
      description: "Shared",
      projectId: seeded.projectId,
      billable: true,
    };
    const a = await caller.create({ ...common, clientId: seeded.clientId });
    const b = await caller.create({ ...common, clientId: String(second._id) });
    assert.notEqual(a.id, b.id);
    assert.equal(b.clientName, "Second");
    assert.equal(
      (await caller.create({ ...common, clientId: String(second._id) })).id,
      b.id,
    );
  });
});
