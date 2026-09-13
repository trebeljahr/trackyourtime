// Carrying a project's billing change onto booked time.
//
// The rewrite is one `updateMany`, so a mistake in it is silent: every
// entry comes back well-formed, just with somebody's deliberate non-billable
// flag overwritten, or an invoiced entry repriced behind its invoice. These
// pin the write itself, without a database.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { entryBillingWrite } from "../services/catalog/project-entry-billing.js";

const BASE = {
  workspaceId: "ws-1",
  projectId: "project-1",
  authorId: "user-me",
  invoiceId: null,
};
const SETTINGS = { defaultHourlyRate: 80, currency: "EUR" };

describe("entryBillingWrite", () => {
  it("reprices only billable entries when the rate alone changed", () => {
    const write = entryBillingWrite(
      BASE,
      { billableDefault: true, billableChanged: false, projectRate: 120 },
      SETTINGS,
    );
    // No `billable` in the set: an entry deliberately marked non-billable
    // keeps its flag.
    assert.deepEqual(write, {
      filter: { ...BASE, billable: true },
      set: { hourlyRate: 120, currency: "EUR" },
    });
  });

  it("falls back to the workspace default when the project rate is cleared", () => {
    const write = entryBillingWrite(
      BASE,
      { billableDefault: true, billableChanged: false, projectRate: null },
      SETTINGS,
    );
    assert.equal(write.set.hourlyRate, 80);
  });

  it("sets every entry billable, at the resolved rate, when the default turns on", () => {
    const write = entryBillingWrite(
      BASE,
      { billableDefault: true, billableChanged: true, projectRate: null },
      SETTINGS,
    );
    assert.deepEqual(write, {
      filter: BASE,
      set: { billable: true, hourlyRate: 80, currency: "EUR" },
    });
  });

  it("clears the rate on every entry when the default turns off", () => {
    const write = entryBillingWrite(
      BASE,
      { billableDefault: false, billableChanged: true, projectRate: 120 },
      SETTINGS,
    );
    assert.deepEqual(write, {
      filter: BASE,
      set: { billable: false, hourlyRate: null, currency: "EUR" },
    });
  });

  it("never widens the caller's filter", () => {
    for (const billableChanged of [true, false]) {
      const { filter } = entryBillingWrite(
        BASE,
        { billableDefault: true, billableChanged, projectRate: 50 },
        SETTINGS,
      );
      // Author-only and invoice-excluded, whatever the change.
      assert.equal(filter.authorId, "user-me");
      assert.equal(filter.invoiceId, null);
      assert.equal(filter.projectId, "project-1");
    }
  });
});
