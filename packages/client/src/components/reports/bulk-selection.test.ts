import { describe, expect, it } from "vitest";
import type { DetailedEntry } from "@starter/shared";
import { bulkFailures, selectableBulkEntries } from "./bulk-selection";

describe("bulk selection", () => {
  it("keeps only failed targets selected after partial success", () => {
    expect([...bulkFailures({ atomic: false, phase: "write", results: [{ id: "done", success: true }, { id: "raced", success: false, reason: "conflict" }, { id: "unknown", success: false, reason: "unconfirmed" }] })]).toEqual(["raced", "unknown"]);
  });
  it("refuses temporary, foreign, colleague and unidentified rows while allowing own running entries", () => {
    const own = { id: "000000000000000000000001", authorId: "me", workspaceId: "here", end: null } as DetailedEntry;
    const rows = [own, { ...own, id: "temp-local" }, { ...own, authorId: "colleague" }, { ...own, workspaceId: "elsewhere" }];
    expect(selectableBulkEntries(rows, "me", "here")).toEqual([own]);
    expect(selectableBulkEntries(rows, null, "here")).toEqual([]);
    expect(selectableBulkEntries(rows, "me", null)).toEqual([]);
  });
});
