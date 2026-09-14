// @vitest-environment jsdom
/**
 * The tracker list, the runaway guard and the calendar show only the viewer's
 * own entries, even when `entries.list` answers with a colleague's too (which
 * it does for anybody allowed to see colleagues' time).
 *
 * The failure each test guards against is concrete: an admin getting edit and
 * delete controls on a colleague's row, being asked about a colleague's
 * runaway timer, or dragging a colleague's block around their calendar.
 */
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, renderHook, screen } from "@testing-library/react";
import { TEMP_ID_PREFIX } from "@starter/core";
import type { DetailedEntry } from "@starter/shared";

const auth: { user: { id: string } | null } = { user: { id: "me" } };
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));

let settingsUserId: string | undefined;
let listEntries: DetailedEntry[] = [];
let hasNextPage = false;

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({}),
    settings: {
      get: { useQuery: () => ({ data: settingsUserId ? { userId: settingsUserId } : undefined }) },
    },
    projects: { list: { useQuery: () => ({ data: [] }) } },
    entries: {
      current: { useQuery: () => ({ data: null }) },
      list: {
        useQuery: () => ({ data: { entries: listEntries }, isPending: false }),
        useInfiniteQuery: () => ({
          data: { pages: [{ entries: listEntries, nextCursor: undefined }] },
          isPending: false,
          isError: false,
          hasNextPage,
          isFetchingNextPage: false,
          fetchNextPage: vi.fn(),
          refetch: vi.fn(),
        }),
      },
    },
  },
}));

const toastCustom = vi.fn();
vi.mock("sonner", () => ({ toast: { custom: toastCustom, dismiss: vi.fn() } }));
vi.mock("@/components/tracker/runaway-prompt", () => ({ RunawayPrompt: () => null }));
vi.mock("@/components/tracker/use-entry-mutations", () => ({
  TRACKER_LIST_INPUT: { limit: 50 },
  useEntryMutations: () => ({}),
}));
vi.mock("@/hooks/use-favorites", () => ({ useQuickStarts: () => ({}) }));
vi.mock("@/components/tracker/entry-row", () => ({
  EntryRow: ({ entry }: { entry: DetailedEntry }) => (
    <div data-testid={`entry-row-${entry.id}`} data-author={entry.authorId} />
  ),
}));
vi.mock("@/components/tracker/entry-edit-dialog", () => ({ EntryEditDialog: () => null }));
vi.mock("@/components/tracker/live-duration", () => ({ LiveDuration: () => null }));
vi.mock("@/lib/format", () => ({
  useFormatSettings: () => ({
    currency: "EUR",
    money: (amount: number) => String(amount),
    duration: (seconds: number) => String(seconds),
  }),
}));
vi.mock("@/hooks/use-sync", () => ({ ORIGIN_ID: "origin" }));

class IntersectionObserverStub {
  observe(): void {}
  disconnect(): void {}
}
globalThis.IntersectionObserver =
  globalThis.IntersectionObserver ??
  (IntersectionObserverStub as unknown as typeof IntersectionObserver);

const { isOwnEntry, ownEntries } = await import("./own-entries");
const { EntryList } = await import("./entry-list");
const { useRunawayGuard } = await import("./use-runaway-guard");
const { useCalendarEntries } = await import("@/components/calendar/use-calendar-entries");

const entry = (overrides: Partial<DetailedEntry> & Pick<DetailedEntry, "id" | "authorId">): DetailedEntry =>
  ({
    workspaceId: "ws-1",
    description: "",
    projectId: null,
    taskId: null,
    billable: false,
    start: "2026-09-14T09:00:00.000Z",
    end: "2026-09-14T10:00:00.000Z",
    durationSec: 3600,
    hourlyRate: null,
    currency: "EUR",
    source: "web",
    timeZone: null,
    runaway: null,
    tagIds: [],
    invoiceId: null,
    importId: null,
    createdAt: "2026-09-14T10:00:00.000Z",
    updatedAt: "2026-09-14T10:00:00.000Z",
    projectName: null,
    projectColor: null,
    clientName: null,
    taskName: null,
    amount: null,
    ...overrides,
  }) as DetailedEntry;

const mine = entry({ id: "e-mine", authorId: "me" });
const colleagues = entry({ id: "e-colleague", authorId: "colleague" });
const pendingOffline = entry({ id: `${TEMP_ID_PREFIX}abc`, authorId: "" });

beforeEach(() => {
  auth.user = { id: "me" };
  settingsUserId = undefined;
  listEntries = [mine, colleagues];
  hasNextPage = false;
  toastCustom.mockClear();
});

afterEach(cleanup);

describe("ownEntries", () => {
  it("keeps the viewer's entries and entries not yet sent from this device", () => {
    expect(ownEntries([mine, colleagues, pendingOffline], "me").map((e) => e.id)).toEqual([
      "e-mine",
      pendingOffline.id,
    ]);
  });

  it("keeps nothing attributable when there is no viewer", () => {
    expect(isOwnEntry(mine, null)).toBe(false);
    expect(isOwnEntry(pendingOffline, null)).toBe(true);
  });
});

describe("EntryList", () => {
  it("renders the viewer's entries and not a colleague's", () => {
    render(<EntryList />);
    expect(screen.getByTestId("entry-row-e-mine")).toBeInTheDocument();
    expect(screen.queryByTestId("entry-row-e-colleague")).not.toBeInTheDocument();
  });

  it("falls back to settings.userId before the session store has resolved", () => {
    auth.user = null;
    settingsUserId = "me";
    render(<EntryList />);
    expect(screen.getByTestId("entry-row-e-mine")).toBeInTheDocument();
    expect(screen.queryByTestId("entry-row-e-colleague")).not.toBeInTheDocument();
  });

  it("keeps loading instead of claiming nothing was tracked when a page is all colleagues'", () => {
    listEntries = [colleagues];
    hasNextPage = true;
    render(<EntryList />);
    expect(screen.queryByTestId("entries-empty")).not.toBeInTheDocument();
    expect(screen.getByTestId("entries-load-more")).toBeInTheDocument();
  });
});

describe("useRunawayGuard", () => {
  const runaway = {
    behavior: "ask",
    thresholdSec: 28_800,
    markedAt: "2026-09-14T18:00:00.000Z",
    resolvedAt: null,
  } as unknown as DetailedEntry["runaway"];

  it("prompts about the viewer's runaway timer only", () => {
    listEntries = [
      entry({ id: "r-mine", authorId: "me", runaway }),
      entry({ id: "r-colleague", authorId: "colleague", runaway }),
    ];
    renderHook(() =>
      useRunawayGuard({ resolveRunaway: vi.fn() } as unknown as Parameters<typeof useRunawayGuard>[0]),
    );
    const ids = toastCustom.mock.calls.map((call) => (call[1] as { id: string }).id);
    expect(ids).toEqual(["runaway:r-mine"]);
  });
});

describe("useCalendarEntries", () => {
  it("returns the viewer's entries only", () => {
    const { result } = renderHook(() =>
      useCalendarEntries({ from: "2026-09-14", to: "2026-09-15" } as Parameters<
        typeof useCalendarEntries
      >[0]),
    );
    expect(result.current.entries.map((e) => e.id)).toEqual(["e-mine"]);
  });
});

// Keep React in scope for the JSX in the mocks above.
void React;
