// Parallel entries on an invoice: an entry that overlapped another entry of
// the same person bills only its even share of the shared time, so the same
// hour is never billed twice.
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { Types } from "mongoose";
import { UserPreferencesModel } from "../models/Settings.js";
import { WebhookSubscription } from "../models/WebhookSubscription.js";
import { invoicesRouter } from "../trpc/routers/invoices.js";
import { memoryCollection, stubModel } from "./support/in-memory-models.js";
import { CLIENT_ID, ENTRY_ID, OWNER, SECRET_RATE, contextFor, freshStore, installStore, resetStore } from "./support/shared-workspace.js";

const store = freshStore();
const restoreStore = installStore(store);
const restoreWebhooks = stubModel(WebhookSubscription, memoryCollection());
const restorePreferences = stubModel(UserPreferencesModel, memoryCollection());
after(() => {
  restoreStore();
  restoreWebhooks();
  restorePreferences();
});

const RANGE = { clientId: String(CLIENT_ID), from: "2026-09-01", to: "2026-09-30" };
const caller = () => invoicesRouter.createCaller(contextFor(OWNER));

beforeEach(() => {
  resetStore(store);
  const template = store.entries.rows.find((row) => String(row._id) === String(ENTRY_ID[OWNER]))!;
  // The owner's personal work, 09:30–10:30, overlapping their billable 09:00–10:00.
  store.entries.rows.push({
    ...template,
    _id: new Types.ObjectId("64b7f9c2e13a4d5f6a7b8d98"),
    projectId: null,
    clientId: null,
    project: null,
    client: null,
    billable: false,
    hourlyRate: null,
    start: new Date("2026-09-07T09:30:00.000Z"),
    end: new Date("2026-09-07T10:30:00.000Z"),
  });
});

describe("invoices bill the split share of parallel entries", () => {
  it("bills 45 minutes of an hour that shared 30 minutes with personal work", async () => {
    const preview = await caller().preview({ ...RANGE, groupBy: "project" });
    // Admin and member hours are whole; the owner's hour is 30 alone + 15 shared.
    assert.equal(preview.subtotal, 2.75 * SECRET_RATE);
    assert.equal(preview.entryIds.length, 3);
  });
});
