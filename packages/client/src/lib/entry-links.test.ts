import { describe, expect, it } from "vitest";

import { entriesHref } from "./entry-links";

const RANGE = { from: "2024-01-01", to: "2026-09-07" };

const params = (href: string): URLSearchParams =>
  new URLSearchParams(href.slice(href.indexOf("?") + 1));

describe("entriesHref", () => {
  it("points at Reports → Entries, filtered to the row", () => {
    const href = entriesHref({ dimension: "client", id: "c1" }, RANGE);

    expect(href.startsWith("/app/reports?")).toBe(true);
    expect(params(href).get("view")).toBe("entries");
    expect(params(href).get("clients")).toBe("c1");
  });

  it("carries the range, so a lifetime total opens a lifetime log", () => {
    const href = entriesHref({ dimension: "project", id: "p1" }, RANGE);

    expect(params(href).get("from")).toBe("2024-01-01");
    expect(params(href).get("to")).toBe("2026-09-07");
    expect(params(href).get("projects")).toBe("p1");
  });

  it("writes each dimension to its own report parameter", () => {
    expect(params(entriesHref({ dimension: "tag", id: "t1" }, RANGE)).get("tags")).toBe(
      "t1",
    );
    expect(
      params(entriesHref({ dimension: "task", id: "k1" }, RANGE)).get("tasks"),
    ).toBe("k1");
  });

  // Tasks are workspace-wide, so filtering by one must not narrow the report
  // to a project the user never picked.
  it("leaves the project filter alone when linking to a task", () => {
    const href = entriesHref({ dimension: "task", id: "k1" }, RANGE);

    expect(params(href).get("tasks")).toBe("k1");
    expect(params(href).get("projects")).toBeNull();
  });
});
