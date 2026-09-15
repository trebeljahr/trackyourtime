import { describe, expect, it } from "vitest";

import {
  DEFAULT_REPORT_VIEW,
  REPORTS_PATH,
  legacyReportRedirect,
  parseReportView,
  reportsHref,
} from "./report-links";

const params = (href: string): URLSearchParams => {
  const index = href.indexOf("?");
  return new URLSearchParams(index === -1 ? "" : href.slice(index + 1));
};

describe("parseReportView", () => {
  it("reads entries, and everything else as totals", () => {
    expect(parseReportView("entries")).toBe("entries");
    expect(parseReportView("totals")).toBe("totals");
    expect(parseReportView(null)).toBe(DEFAULT_REPORT_VIEW);
    expect(parseReportView("weekly")).toBe("totals");
  });
});

describe("reportsHref", () => {
  it("is the bare path for Totals with nothing to carry", () => {
    expect(reportsHref("totals")).toBe(REPORTS_PATH);
    expect(reportsHref("totals", "")).toBe("/app/reports");
    expect(reportsHref("totals", "?")).toBe("/app/reports");
  });

  it("omits view for Totals, even when the params carried one", () => {
    const href = reportsHref("totals", "view=entries&from=2026-09-01");

    expect(href).toBe("/app/reports?from=2026-09-01");
    expect(params(href).get("view")).toBeNull();
  });

  it("sets view=entries for Entries, once", () => {
    const href = reportsHref("entries", { view: "totals", projects: "p1" });

    expect(href.startsWith("/app/reports?")).toBe(true);
    expect(params(href).getAll("view")).toEqual(["entries"]);
    expect(params(href).get("projects")).toBe("p1");
  });

  it("drops the retired week parameter", () => {
    expect(reportsHref("totals", "week=2026-09-07")).toBe("/app/reports");
    expect(params(reportsHref("entries", "week=2026-09-07&q=x")).get("week")).toBeNull();
  });

  it("accepts a record, URLSearchParams and a string with or without ?", () => {
    const expected = "/app/reports?from=2026-09-01&to=2026-09-07";

    expect(reportsHref("totals", { from: "2026-09-01", to: "2026-09-07" })).toBe(
      expected,
    );
    expect(
      reportsHref("totals", new URLSearchParams("from=2026-09-01&to=2026-09-07")),
    ).toBe(expected);
    expect(reportsHref("totals", "from=2026-09-01&to=2026-09-07")).toBe(expected);
    expect(reportsHref("totals", "?from=2026-09-01&to=2026-09-07")).toBe(expected);
  });

  it("never mutates the URLSearchParams it was given", () => {
    const source = new URLSearchParams("view=entries&week=2026-09-07");
    reportsHref("totals", source);

    expect(source.toString()).toBe("view=entries&week=2026-09-07");
  });
});

describe("legacyReportRedirect", () => {
  const TODAY = new Date(2026, 8, 16, 12); // Wednesday 16 September 2026, local

  it("sends summary to Totals and keeps the grouping", () => {
    const href = legacyReportRedirect(
      "summary",
      "?from=2026-09-01&to=2026-09-07&group=client",
      1,
    );

    expect(href.startsWith("/app/reports?")).toBe(true);
    expect(params(href).get("view")).toBeNull();
    expect(params(href).get("group")).toBe("client");
    expect(params(href).get("from")).toBe("2026-09-01");
  });

  it("sends a bare summary link to the bare Reports path", () => {
    expect(legacyReportRedirect("summary", "", 1)).toBe("/app/reports");
  });

  it("sends detailed to Entries, dropping group and keeping sort", () => {
    const href = legacyReportRedirect(
      "detailed",
      "?group=tag&sort=duration&dir=asc&tags=t1",
      1,
    );
    const read = params(href);

    expect(read.get("view")).toBe("entries");
    expect(read.get("group")).toBeNull();
    expect(read.get("sort")).toBe("duration");
    expect(read.get("dir")).toBe("asc");
    expect(read.get("tags")).toBe("t1");
  });

  it("turns a Monday-start week into that week's Totals by day", () => {
    const href = legacyReportRedirect("weekly", "?week=2026-09-10", 1, TODAY);

    expect(href).toBe("/app/reports?from=2026-09-07&to=2026-09-13&group=day");
  });

  it("snaps the same week to Sunday for a Sunday-start workspace", () => {
    const read = params(legacyReportRedirect("weekly", "?week=2026-09-10", 0, TODAY));

    expect(read.get("from")).toBe("2026-09-06");
    expect(read.get("to")).toBe("2026-09-12");
    expect(read.get("group")).toBe("day");
  });

  it("crosses a month boundary", () => {
    const read = params(legacyReportRedirect("weekly", "week=2026-09-29", 1, TODAY));

    expect(read.get("from")).toBe("2026-09-28");
    expect(read.get("to")).toBe("2026-10-04");
  });

  it("uses the current week when week is missing or invalid", () => {
    for (const search of ["", "?week=nope", "?week=2026-02-30", "?week=2026-9-10"]) {
      const read = params(legacyReportRedirect("weekly", search, 1, TODAY));

      expect(read.get("from")).toBe("2026-09-14");
      expect(read.get("to")).toBe("2026-09-20");
    }
    const sunday = params(legacyReportRedirect("weekly", "", 0, TODAY));
    expect(sunday.get("from")).toBe("2026-09-13");
    expect(sunday.get("to")).toBe("2026-09-19");
  });

  it("keeps the catalogue filters and drops everything the grid ignored", () => {
    const href = legacyReportRedirect(
      "weekly",
      "?week=2026-09-10&projects=p1,p2&clients=c1&tasks=k1&tags=t1&billable=yes&q=design" +
        "&sort=duration&dir=asc&from=2020-01-01&to=2020-12-31&group=client&view=entries",
      1,
      TODAY,
    );
    const read = params(href);

    expect(read.get("projects")).toBe("p1,p2");
    expect(read.get("clients")).toBe("c1");
    expect(read.get("tasks")).toBe("k1");
    expect(read.get("tags")).toBe("t1");
    expect(read.get("billable")).toBe("yes");
    expect(read.get("q")).toBe("design");
    expect(read.get("from")).toBe("2026-09-07");
    expect(read.get("to")).toBe("2026-09-13");
    expect(read.get("group")).toBe("day");
    for (const dropped of ["week", "sort", "dir", "view"]) {
      expect(read.get(dropped)).toBeNull();
    }
    expect(read.getAll("from")).toHaveLength(1);
  });
});
