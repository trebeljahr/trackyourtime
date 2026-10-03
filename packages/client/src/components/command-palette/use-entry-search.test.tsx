// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DetailedEntry } from "@starter/shared";
import { useEntrySearch, type EntrySearchScope, type FetchEntrySearch } from "./use-entry-search";

const scope = { userId: "user", workspaceId: "workspace", server: "https://time.example" };
function deferred(): { promise: Promise<{ entries: DetailedEntry[] }>; resolve: (value: { entries: DetailedEntry[] }) => void; reject: (error: Error) => void } {
  let resolve!: (value: { entries: DetailedEntry[] }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ entries: DetailedEntry[] }>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function debounce(): Promise<void> { await act(async () => { vi.advanceTimersByTime(300); }); }

describe("palette entry search", () => {
  it("debounces typing, caps the query and result page, and stamps the workspace", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<FetchEntrySearch>().mockResolvedValue({ entries: [] });
    const { rerender } = renderHook(({ search }) => useEntrySearch(search, scope, fetcher), { initialProps: { search: "r" } });
    act(() => vi.advanceTimersByTime(200));
    rerender({ search: "review" });
    act(() => vi.advanceTimersByTime(200)); expect(fetcher).not.toHaveBeenCalled();
    await debounce(); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toMatchObject({ search: "review", limit: 10, workspaceId: scope.workspaceId });
    rerender({ search: "x".repeat(250) }); await debounce();
    expect(fetcher.mock.calls[1]?.[0].search).toHaveLength(200);
  });
  it("hides old results immediately and ignores out-of-order answers after a query change", async () => {
    vi.useFakeTimers();
    const old = deferred(); const next = deferred();
    const fetcher = vi.fn<FetchEntrySearch>().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const { result, rerender } = renderHook(({ search }) => useEntrySearch(search, scope, fetcher), { initialProps: { search: "old" } });
    await debounce(); rerender({ search: "next" });
    expect(fetcher.mock.calls[0]?.[1].aborted).toBe(true); expect(result.current.entries).toEqual([]);
    await debounce();
    await act(async () => next.resolve({ entries: [{ id: "new", workspaceId: scope.workspaceId } as DetailedEntry] }));
    await act(async () => old.resolve({ entries: [{ id: "old", workspaceId: scope.workspaceId } as DetailedEntry] }));
    expect(result.current.entries.map((row) => row.id)).toEqual(["new"]);
  });
  it.each(["userId", "workspaceId", "server"] as const)("cancels stale %s results and never shows them in the new identity", async (part) => {
    vi.useFakeTimers(); const old = deferred();
    const fetcher = vi.fn<FetchEntrySearch>().mockReturnValue(old.promise);
    const { result, rerender } = renderHook(({ identity }: { identity: EntrySearchScope | null }) => useEntrySearch("review", identity, fetcher), { initialProps: { identity: scope as EntrySearchScope | null } });
    await debounce(); rerender({ identity: { ...scope, [part]: "different" } });
    expect(fetcher.mock.calls[0]?.[1].aborted).toBe(true);
    await act(async () => old.resolve({ entries: [{ id: "private", workspaceId: scope.workspaceId } as DetailedEntry] }));
    expect(result.current.entries).toEqual([]);
    rerender({ identity: null }); expect(result.current.entries).toEqual([]);
  });
  it("offers retry after an error and aborts the request on unmount", async () => {
    vi.useFakeTimers();
    const hung = deferred();
    const fetcher = vi.fn<FetchEntrySearch>().mockRejectedValueOnce(Error("offline")).mockReturnValueOnce(hung.promise);
    const { result, unmount } = renderHook(() => useEntrySearch("review", scope, fetcher));
    await debounce(); expect(result.current.status).toBe("error");
    act(() => result.current.retry()); await debounce(); expect(fetcher).toHaveBeenCalledTimes(2);
    unmount(); expect(fetcher.mock.calls[1]?.[1].aborted).toBe(true);
  });
});
