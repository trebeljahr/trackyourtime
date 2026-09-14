// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DetailedEntry, SummaryGroup } from "@starter/shared";

import { DetailedTable, DEFAULT_DETAILED_SORT } from "./detailed-table";
import { MONEY_WITHHELD, formatReportMoney, sumReportMoney } from "./report-money";
import { SummaryTable } from "./summary-table";

/*
 * What these pin: a report amount the server withheld (`null`, for a member
 * who may see colleagues' time but not their money) renders as a dash — never
 * as "0.00", which reads as "earned nothing", and never as an empty cell,
 * which reads as a rendering bug. A sum over rows that include a withheld
 * amount is itself withheld rather than a partial total.
 */

afterEach(cleanup);

const money = (amount: number): string => `€${amount.toFixed(2)}`;
const duration = (seconds: number): string => `${seconds / 3600}h`;

describe("formatReportMoney / sumReportMoney", () => {
  it("formats a number and dashes a null", () => {
    expect(formatReportMoney(12.5, money)).toBe("€12.50");
    expect(formatReportMoney(0, money)).toBe("€0.00");
    expect(formatReportMoney(null, money)).toBe(MONEY_WITHHELD);
  });

  it("sums numbers, and one withheld amount withholds the sum", () => {
    expect(sumReportMoney([1, 2, 3])).toBe(6);
    expect(sumReportMoney([])).toBe(0);
    expect(sumReportMoney([1, null, 3])).toBeNull();
  });
});

const group = (key: string, amount: number | null): SummaryGroup => ({
  key,
  label: `Group ${key}`,
  color: null,
  seconds: 3600,
  billableSec: 3600,
  amount,
});

describe("SummaryTable with withheld money", () => {
  it("shows a dash for every withheld group amount and for the total", () => {
    render(
      <SummaryTable
        groups={[group("a", null), group("b", null)]}
        totalSec={7200}
        billableSec={7200}
        totalAmount={null}
        duration={duration}
        money={money}
        dimensionLabel="Member"
      />
    );

    for (const key of ["a", "b"]) {
      const row = screen.getByTestId(`summary-row-${key}`);
      expect(within(row).getByText(MONEY_WITHHELD)).toBeInTheDocument();
      expect(within(row).queryByText(/€/)).toBeNull();
    }
    expect(screen.getByTestId("summary-total-amount")).toHaveTextContent(MONEY_WITHHELD);
    // Time is still shown — it is what this caller may see.
    expect(screen.getByTestId("summary-total-duration")).toHaveTextContent("2h");
  });

  it("still formats visible money, zero included", () => {
    render(
      <SummaryTable
        groups={[group("a", 0)]}
        totalSec={3600}
        billableSec={3600}
        totalAmount={0}
        duration={duration}
        money={money}
        dimensionLabel="Project"
      />
    );
    expect(screen.getByTestId("summary-total-amount")).toHaveTextContent("€0.00");
    expect(screen.queryByText(MONEY_WITHHELD)).toBeNull();
  });
});

const entry = (id: string, amount: number | null, hourlyRate: number | null): DetailedEntry => ({
  id,
  workspaceId: "ws",
  authorId: `author-${id}`,
  description: `Entry ${id}`,
  projectId: null,
  taskId: null,
  billable: true,
  start: "2026-09-07T09:00:00.000Z",
  end: "2026-09-07T10:00:00.000Z",
  durationSec: 3600,
  hourlyRate,
  currency: "EUR",
  source: "web",
  timeZone: "UTC",
  runaway: null,
  tagIds: [],
  invoiceId: null,
  importId: null,
  createdAt: "2026-09-07T09:00:00.000Z",
  updatedAt: "2026-09-07T10:00:00.000Z",
  projectName: null,
  projectColor: null,
  clientName: null,
  taskName: null,
  amount,
});

describe("DetailedTable with a colleague's withheld row", () => {
  it("dashes the colleague's amount and formats the caller's own", () => {
    render(
      <DetailedTable
        entries={[entry("colleague", null, null), entry("own", 90, 90)]}
        selected={new Set()}
        onToggle={() => undefined}
        onToggleAll={() => undefined}
        sort={DEFAULT_DETAILED_SORT}
        onSort={() => undefined}
        duration={duration}
        money={money}
        clock={(iso) => iso.slice(11, 16)}
      />
    );

    // The amount is the row's last cell; the project cell dashes too when a
    // row is unfiled, so the assertion is on the cell, not on the page.
    const amountCell = (rowId: string): Element | undefined => {
      const cells = screen.getByTestId(`detailed-row-${rowId}`).querySelectorAll("td");
      return cells[cells.length - 1];
    };

    expect(amountCell("colleague")).toHaveTextContent(MONEY_WITHHELD);
    expect(within(screen.getByTestId("detailed-row-colleague")).queryByText(/€/)).toBeNull();
    expect(amountCell("own")).toHaveTextContent("€90.00");
  });
});
