// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TimesheetApprovalWire } from "@starter/shared";

const state = vi.hoisted(() => ({
  queue: { online: true, pending: 0, held: 0, isFlushing: false, authBlocked: false },
  mutate: vi.fn(async () => ({})), invalidate: vi.fn(), isMutating: 0,
  refresh: vi.fn(async () => 0), workspaceId: "w", userId: "u", origin: "https://example.test",
}));
vi.mock("@tanstack/react-query", () => ({ useIsMutating: () => state.isMutating }));
vi.mock("@/providers/offline-queue-provider", () => ({ useOfflineQueueState: () => state.queue }));
vi.mock("@/lib/offline", () => ({ isOnline: () => state.queue.online, refreshPendingCount: () => state.refresh(), getHeldCount: () => state.queue.held, isNetworkError: () => false }));
vi.mock("@/components/members/use-active-workspace", () => ({ useActiveWorkspace: () => ({ workspace: { id: state.workspaceId } }) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: state.userId } }) }));
vi.mock("@/lib/entry-mutation-result", () => ({
  entryMutationScope: () => ({ owner: state.userId, workspaceId: state.workspaceId, server: state.origin }),
  sameEntryMutationScope: (scope: { owner: string; workspaceId: string; server: string }) => scope.owner === state.userId && scope.workspaceId === state.workspaceId && scope.server === state.origin,
}));
vi.mock("@/lib/api-origin", () => ({ getApiOrigin: () => state.origin }));
vi.mock("@/lib/format", () => ({ useFormatSettings: () => ({ duration: (value: number) => `${value}s` }) }));
vi.mock("@/lib/trpc", () => ({ trpc: {
  useUtils: () => ({ invalidate: state.invalidate }),
  approvals: {
    submit: { useMutation: () => ({ mutateAsync: state.mutate, isPending: false }) },
    act: { useMutation: () => ({ mutate: state.mutate, isPending: false }) },
    entries: { useQuery: () => ({ data: { entries: [], hasMore: false } }) },
    reviewQueue: { useQuery: () => ({ data: { records: [], hasMore: false } }) },
  },
} }));
import { ApprovalControls, periodIsLocked } from "./approval-controls";

const record: TimesheetApprovalWire = {
  id: "period", workspaceId: "w", authorId: "u", authorName: "Member", weekStart: "2026-09-14",
  weekStartsOn: 1, timeZone: "UTC", start: "2026-09-14T00:00:00Z", end: "2026-09-21T00:00:00Z",
  status: "submitted", revision: 1, totalSec: 0, history: [],
};
function mount(records: TimesheetApprovalWire[] = []): void {
  render(<ApprovalControls weekStart="2026-09-14" records={records} canReview={false} busy={false} />);
}
beforeEach(() => {
  state.queue = { online: true, pending: 0, held: 0, isFlushing: false, authBlocked: false };
  state.isMutating = 0; state.mutate.mockClear(); state.refresh.mockReset(); state.refresh.mockResolvedValue(0);
  state.workspaceId = "w"; state.userId = "u"; state.origin = "https://example.test";
});
afterEach(cleanup);
describe("approval submission", () => {
  it("requires explicit confirmation and waits for the online mutation", async () => {
    mount(); const button = screen.getByRole("button", { name: "Submit week" });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(button);
    await waitFor(() => expect(state.mutate).toHaveBeenCalledWith({ workspaceId: "w", weekStart: "2026-09-14", confirmedOnline: true, pendingLocalEdits: false }));
  });
  it.each(["pending", "held"] as const)("blocks %s local edits", (field) => {
    state.queue[field] = 1; mount(); fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Submit week" })).toBeDisabled();
  });
  it("rechecks storage before sending", async () => {
    state.refresh.mockResolvedValue(1); mount();
    fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Submit week" }));
    await waitFor(() => expect(state.refresh).toHaveBeenCalled());
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it("blocks offline submission", () => {
    state.queue.online = false; mount(); fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Submit week" })).toBeDisabled();
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it.each(["origin", "userId", "workspaceId"] as const)("does not submit after %s changes while checking local edits", async (key) => {
    let resolve!: (value: number) => void;
    state.refresh.mockImplementationOnce(() => new Promise<number>((done) => { resolve = done; }));
    mount(); fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Submit week" }));
    state[key] = "changed"; resolve(0);
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit week" })).not.toBeDisabled());
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it("locks an empty submitted period and offers withdrawal", () => {
    mount([record]); expect(screen.queryByRole("button", { name: "Submit week" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Withdraw submission" }));
    expect(state.mutate).toHaveBeenCalledWith({ workspaceId: "w", id: "period", revision: 1, action: "withdraw", reason: "" });
    expect(periodIsLocked([record])).toBe(true);
    expect(periodIsLocked([{ ...record, status: "approved" }])).toBe(true);
    expect(periodIsLocked([{ ...record, status: "future-status" }])).toBe(true);
    expect(periodIsLocked([{ ...record, status: "rejected" }])).toBe(false);
  });
});
