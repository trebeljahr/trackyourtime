// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ImportPreview } from "@starter/shared";

import { ImportPreviewView } from "./import-preview";

const preview = (overrides: Partial<ImportPreview> = {}): ImportPreview => ({
  format: "delimited",
  delimiter: ",",
  shape: "start-end",
  dateOrder: "dmy",
  dateOrderAmbiguous: false,
  columns: [
    {
      index: 0,
      header: "Description",
      role: "description",
      overridden: false,
      sample: "Wrote the importer",
    },
    {
      index: 1,
      header: "Start",
      role: "start",
      overridden: false,
      sample: "2026-08-21T09:00:00Z",
    },
  ],
  timeZone: "Europe/Berlin",
  totalRows: 3,
  readyRows: 2,
  skippedRows: 0,
  duplicateRows: 1,
  totalSec: 5400,
  firstStart: "2026-08-21T07:00:00.000Z",
  lastStart: "2026-08-22T07:00:00.000Z",
  newClients: ["Internal"],
  newProjects: ["trackyourtime"],
  newTasks: [],
  newTags: ["deep work"],
  issues: [],
  sample: [],
  // A delimited file carries no sections; a workspace export overrides this.
  sections: {
    version: 1,
    newerVersion: null,
    settings: false,
    favorites: 0,
    invoices: 0,
    moneyRedacted: false,
  },
  ...overrides,
});

const noop = (): void => {};

const renderPreview = (value: ImportPreview) =>
  render(
    <ImportPreviewView
      preview={value}
      onRoleChange={noop}
      onDateOrderChange={noop}
      busy={false}
    />,
  );

afterEach(cleanup);

describe("import preview", () => {
  it("counts what would be written, what is already here, and what failed", () => {
    renderPreview(preview());

    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("entries to import")).toBeTruthy();
    // 3 rows, 2 ready, 1 duplicate — nothing unreadable.
    expect(screen.getByText("rows not readable")).toBeTruthy();
    expect(screen.getByText("already here")).toBeTruthy();
  });

  it("names the catalog it would create, so nothing appears by surprise", () => {
    renderPreview(preview());

    expect(screen.getByTestId("import-new-projects").textContent).toContain(
      "trackyourtime",
    );
    expect(screen.getByTestId("import-new-tags").textContent).toContain(
      "deep work",
    );
  });

  it("warns when no date in the file settles day-first from month-first", () => {
    // The one mistake that cannot be seen after the fact: both readings are
    // valid dates, so a wrong guess silently moves entries by months.
    renderPreview(preview({ dateOrderAmbiguous: true }));

    expect(screen.getByText(/could be read either way round/)).toBeTruthy();
  });

  it("says so when the clock times in a date-only file are invented", () => {
    renderPreview(preview({ shape: "date-duration" }));

    expect(screen.getByText(/laid out back-to-back/)).toBeTruthy();
  });

  it("says nothing about either when the file settles both questions", () => {
    renderPreview(preview());

    expect(screen.queryByText(/could be read either way round/)).toBeNull();
    expect(screen.queryByText(/laid out back-to-back/)).toBeNull();
  });

  it("reads a file with nothing new as nothing to do", () => {
    renderPreview(preview({ readyRows: 0, duplicateRows: 3 }));

    expect(screen.getByTestId("import-range").textContent).toContain(
      "Nothing new in this file",
    );
  });

  it("shows each column's own first value beside the role it was given", () => {
    renderPreview(preview());

    expect(screen.getByText("Wrote the importer")).toBeTruthy();
    expect(screen.getByTestId("import-column-0")).toBeTruthy();
    expect(screen.getByTestId("import-column-1")).toBeTruthy();
  });
});

describe("singular counts", () => {
  it("says entry, not entries, for one row", () => {
    renderPreview(preview({ readyRows: 1, totalRows: 1, duplicateRows: 0 }));

    expect(screen.getByText("entry to import")).toBeTruthy();
  });
});

describe("what the file carries besides entries", () => {
  it("warns that a redacted file's money is missing before it is written", () => {
    // The stamp exists to be READ. A restore approved as complete, from a file
    // whose rates were blanked on the way out, is discovered months later when
    // the history reports the wrong money.
    renderPreview(
      preview({
        sections: {
          version: 2,
          newerVersion: null,
          settings: true,
          favorites: 0,
          invoices: 0,
          moneyRedacted: true,
        },
      }),
    );

    expect(screen.getByTestId("import-money-redacted").textContent).toMatch(
      /money was blanked when it was exported/i,
    );
  });

  it("says the invoices in the file are not coming back", () => {
    renderPreview(
      preview({
        sections: {
          version: 2,
          newerVersion: null,
          settings: false,
          favorites: 0,
          invoices: 3,
          moneyRedacted: false,
        },
      }),
    );

    expect(screen.getByTestId("import-invoices-dropped").textContent).toMatch(
      /3 invoices in this file/i,
    );
  });

  it("says a file from a newer version skips what this version does not know", () => {
    renderPreview(
      preview({
        sections: {
          version: 2,
          newerVersion: 3,
          settings: false,
          favorites: 0,
          invoices: 0,
          moneyRedacted: false,
        },
      }),
    );

    expect(screen.getByTestId("import-newer-version").textContent).toMatch(
      /newer version of Track Your Time.*export format 3/i,
    );
  });

  it("says nothing about either when the file states neither", () => {
    renderPreview(preview());

    expect(screen.queryByTestId("import-money-redacted")).toBeNull();
    expect(screen.queryByTestId("import-invoices-dropped")).toBeNull();
    expect(screen.queryByTestId("import-newer-version")).toBeNull();
  });
});
