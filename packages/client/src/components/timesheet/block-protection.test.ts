import { describe, expect, it } from "vitest";
import { buildOptimisticEntry } from "@starter/core";
import { blockProtection } from "./block-protection";

const entry = buildOptimisticEntry({ projects: [], tasks: [], settings: null, source: "web" }, {
  id: "entry", description: "Work", projectId: null, taskId: null, billable: false,
  start: "2026-10-02T21:30:00.000Z", end: "2026-10-03T01:30:00.000Z",
});
const own = { ...entry, authorId: "me", workspaceId: "workspace", timeZone: "Europe/Berlin" };

describe("timesheet block protection", () => {
  it("allows editing a complete cross-midnight entry, never its cell slice", () => {
    expect(blockProtection(own, "me", "workspace")).toBeNull();
  });
  it.each([
    [undefined, "missing"],
    [{ ...own, end: null }, "running"],
    [{ ...own, invoiceId: "invoice" }, "invoiced"],
    [{ ...own, id: "temp-new" }, "syncing"],
    [{ ...own, authorId: "colleague" }, "foreign"],
    [{ ...own, workspaceId: "elsewhere" }, "foreign"],
  ] as const)("protects %j with %s", (candidate, reason) => {
    expect(blockProtection(candidate, "me", "workspace")).toBe(reason);
  });
  it("requires a known user and workspace", () => {
    expect(blockProtection(own, null, "workspace")).toBe("foreign");
    expect(blockProtection(own, "me", null)).toBe("foreign");
  });
});
