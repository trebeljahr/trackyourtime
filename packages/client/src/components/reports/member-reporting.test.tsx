// @vitest-environment jsdom
/**
 * Reports by member: who is offered the filter and the grouping, what the
 * filter sends, and what a report with withheld money says.
 *
 * None of this is access control — the server intersects `memberIds` with the
 * caller's scope and nulls money it may not show. What is pinned here is that
 * a viewer who sees only their own time is not offered a control that could
 * only ever answer with their own row or nothing, and that dashes where money
 * would be are explained as a permission rather than left to look like a bug.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { WorkspaceSummary } from "@starter/shared";

import { workspaceFor } from "@/components/members/member-fixtures";

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver =
  globalThis.ResizeObserver ?? (ResizeObserverStub as unknown as typeof ResizeObserver);

let active: WorkspaceSummary | null = null;
vi.mock("@/components/members/use-active-workspace", () => ({
  useActiveWorkspace: () => ({
    workspace: active,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

const membersQuery = vi.fn();
const emptyList = { data: [], isPending: false };
vi.mock("@/lib/trpc", () => ({
  trpc: {
    members: {
      list: {
        useQuery: (...args: unknown[]) => {
          membersQuery(...args);
          return {
            data: [
              { memberId: "m1", userId: "u1", name: "Olivia", email: "o@example.com" },
              { memberId: "m2", userId: "u2", name: "Mia", email: "m@example.com" },
            ],
          };
        },
      },
    },
    clients: { list: { useQuery: () => emptyList } },
    projects: { list: { useQuery: () => emptyList } },
    tasks: { list: { useQuery: () => emptyList } },
    reports: { trackedSpan: { useQuery: () => ({ data: undefined }) } },
  },
}));
vi.mock("@/components/tags/tag-filter", () => ({
  TagFilter: () => <div data-testid="filter-tags" />,
}));
vi.mock("@/components/date-range-picker", () => ({
  DateRangePicker: () => <div data-testid="filter-range" />,
}));
vi.mock("@/components/catalog/client-form-dialog", () => ({ ClientFormDialog: () => null }));
vi.mock("@/components/catalog/project-form-dialog", () => ({ ProjectFormDialog: () => null }));
vi.mock("@/components/catalog/task-form-dialog", () => ({ TaskFormDialog: () => null }));

const { MoneyHiddenNote, useMemberReporting } = await import("./member-reporting");
const { ReportFiltersBar } = await import("./report-filters");
const { effectiveGroupBy, groupByOptionsFor, PARAM_FOR_GROUP_BY } = await import("./group-by");
const { toReportFilters, REPORT_PARAM } = await import("./use-report-filters");
type Filters = import("./use-report-filters").UseReportFiltersResult;

const setIds = vi.fn();
const filtersStub = (): Filters =>
  ({
    state: {
      range: { from: "2026-09-07", to: "2026-09-13" },
      projectIds: [],
      clientIds: [],
      taskIds: [],
      tagIds: [],
      memberIds: [],
      billable: "all",
      search: "",
    },
    filters: { from: "2026-09-07", to: "2026-09-13" },
    weekStartsOn: "monday",
    view: "totals",
    setView: vi.fn(),
    isFiltered: false,
    setRange: vi.fn(),
    setIds,
    setBillable: vi.fn(),
    setSearch: vi.fn(),
    getParam: () => null,
    setParam: vi.fn(),
    setParams: vi.fn(),
    clearFilters: vi.fn(),
  }) as unknown as Filters;

function ReportingProbe(): React.JSX.Element {
  return <span data-testid="probe">{String(useMemberReporting())}</span>;
}

beforeEach(() => {
  membersQuery.mockClear();
  setIds.mockClear();
});

afterEach(cleanup);

describe("who is offered member reporting", () => {
  it.each([
    ["owner", workspaceFor("owner"), true],
    ["admin of a shared workspace", workspaceFor("admin"), true],
    ["closed member", workspaceFor("member"), false],
    [
      "member who may see colleagues' time",
      workspaceFor("member", {}, { canViewOthersTime: true, canViewOthersMoney: false }),
      true,
    ],
    ["owner alone in a personal workspace", workspaceFor("owner", { memberCount: 1 }), false],
  ] as const)("%s → %s", (_label, workspace, expected) => {
    active = workspace;
    render(<ReportingProbe />);
    expect(screen.getByTestId("probe")).toHaveTextContent(String(expected));
  });
});

describe("ReportFiltersBar member filter", () => {
  it("is rendered when offered, listing workspace members", () => {
    active = workspaceFor("owner");
    render(<ReportFiltersBar filters={filtersStub()} memberFilter />);
    expect(screen.getByTestId("filter-members")).toBeInTheDocument();
    expect(membersQuery).toHaveBeenCalled();
  });

  it("is absent — and never lists members — when not offered", () => {
    active = workspaceFor("member");
    render(<ReportFiltersBar filters={filtersStub()} />);
    expect(screen.queryByTestId("filter-members")).not.toBeInTheDocument();
    expect(membersQuery).not.toHaveBeenCalled();
  });
});

describe("member groupBy", () => {
  it("offers Member only with member reporting", () => {
    expect(groupByOptionsFor(true).map((option) => option.id)).toContain("member");
    expect(groupByOptionsFor(false).map((option) => option.id)).not.toContain("member");
  });

  it("ignores a shared group=member link for a viewer not offered it", () => {
    expect(effectiveGroupBy("member", false)).toBe("project");
    expect(effectiveGroupBy("member", true)).toBe("member");
    expect(effectiveGroupBy("tag", false)).toBe("tag");
  });

  it("drills a member row into the members filter", () => {
    expect(PARAM_FOR_GROUP_BY.member).toBe(REPORT_PARAM.members);
  });

  it("sends memberIds only when some are chosen", () => {
    const base = filtersStub().state;
    expect(toReportFilters(base)).not.toHaveProperty("memberIds");
    expect(toReportFilters({ ...base, memberIds: ["u2"] }).memberIds).toEqual(["u2"]);
  });
});

describe("MoneyHiddenNote", () => {
  it("explains withheld amounts when moneyVisible is false", () => {
    render(<MoneyHiddenNote moneyVisible={false} />);
    expect(screen.getByTestId("report-money-hidden")).toHaveTextContent(
      "Amounts are hidden for your role.",
    );
  });

  it("says nothing when money is visible or the report has not loaded", () => {
    const { rerender } = render(<MoneyHiddenNote moneyVisible />);
    expect(screen.queryByTestId("report-money-hidden")).not.toBeInTheDocument();
    rerender(<MoneyHiddenNote moneyVisible={undefined} />);
    expect(screen.queryByTestId("report-money-hidden")).not.toBeInTheDocument();
  });
});
