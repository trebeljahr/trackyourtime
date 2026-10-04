// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
/**
 * A stop followed at once by a start must not wipe the new timer off the list.
 *
 * The stop is optimistic, so the bar goes idle before the server answers and
 * Start can be clicked straight away. The start inserts a temp row. When the
 * stop then settles, its invalidation refetches `entries.list` — a request
 * that can reach the server before the start is committed. That stale answer
 * used to replace the cache, taking the temp row with it; the start's own
 * `replaceEntry` then found nothing to replace, and the list showed no running
 * entry (or the empty state) until the start's refetch landed, seconds later
 * on a loaded machine.
 *
 * Unlike the neighbouring specs this one keeps React Query and the tRPC React
 * bindings real and fakes only the transport, because the bug lives entirely
 * in the ordering of `onMutate`, `onSettled` and a refetch.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { DetailedEntry, TimeEntry } from "@starter/shared";
import type { TRPCLink } from "@trpc/client";
import { DurableQueuedWriteError, durableQueuedWrite } from "@starter/core";

vi.mock("@/mobile/network", () => ({
  getNetworkOnline: () => true,
  getServerNetworkOnline: () => true,
  subscribeNetwork: () => () => undefined,
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { error: vi.fn(), message: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

let scopeWorkspace: string | null = null;
let scopeOwner: string | null = null;
vi.mock("@/lib/active-workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/active-workspace")>()),
  getActiveWorkspaceId: () => scopeWorkspace,
  getKnownWorkspacesOwner: () => scopeOwner,
}));

const enqueueOffline = vi.fn<typeof import("@/lib/offline").enqueueOffline>(async (): Promise<void> => undefined);
const retained = vi.fn(async (error: unknown, _tempId?: string) => durableQueuedWrite(error) !== null);
const amendQueuedStart = vi.fn(async (): Promise<boolean> => false);
vi.mock("@/lib/offline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/offline")>()),
  enqueueOffline,
  retainDurableEntry: retained,
  amendQueuedStart,
  getOfflineQueueOwner: () => scopeOwner,
}));

vi.mock("@/lib/running-mirror", () => ({
  writeRunningMirror: async (): Promise<void> => undefined,
}));

// The real module wires native sessions and api origins; only the React
// bindings are wanted here, so the link is supplied by the spec.
vi.mock("@/lib/trpc", async () => {
  const { createTRPCReact } = await import("@trpc/react-query");
  return { trpc: createTRPCReact() };
});

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { trpc } = await import("@/lib/trpc");
const { timerStore } = await import("@/hooks/use-sync");
const { OfflineQueueScopeNotReadyError } = await import("@/lib/offline");
const { TRACKER_LIST_INPUT, useEntryMutations } = await import(
  "@/components/tracker/use-entry-mutations"
);
type Mutations = ReturnType<typeof useEntryMutations>;

// ── the fake server ──────────────────────────────────────────────────

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const entry = (over: Partial<DetailedEntry>): DetailedEntry =>
  ({
    workspaceId: "ws",
    authorId: "u1",
    description: "Work",
    projectId: null,
    taskId: null,
    billable: false,
    end: null,
    durationSec: 0,
    hourlyRate: null,
    currency: "EUR",
    tagIds: [],
    projectName: null,
    projectColor: null,
    clientName: null,
    taskName: null,
    amount: null,
    ...over,
  }) as DetailedEntry;

let serverEntries: DetailedEntry[] = [];
let listCalls = 0;
/** Mutations the spec wants to hold open, keyed by procedure path. */
const held = new Map<string, Deferred<unknown>>();
const heldCalls = new Map<string, number>();
/** Held procedures in the order their requests left the client. */
let callOrder: string[] = [];
const callInputs = new Map<string, unknown>();

const answer = (path: string): Promise<unknown> => {
  switch (path) {
    case "entries.list":
      listCalls += 1;
      return Promise.resolve({ entries: [...serverEntries], nextCursor: undefined });
    case "entries.current":
      return Promise.resolve(serverEntries.find((e) => e.end === null) ?? null);
    default: {
      heldCalls.set(path, (heldCalls.get(path) ?? 0) + 1);
      callOrder.push(path);
      const hold = held.get(path);
      if (hold === undefined) throw new Error(`unexpected call to ${path}`);
      return hold.promise;
    }
  }
};

/** A terminating link answered by `answer`, standing in for HTTP. */
const fakeLink: TRPCLink<never> = () => ({ op }) =>
  ({
    subscribe: (observer: {
      next: (value: unknown) => void;
      complete: () => void;
      error: (error: unknown) => void;
    }) => {
      let live = true;
      void Promise.resolve()
        .then(() => { callInputs.set(op.path, op.input); return answer(op.path); })
        .then(
          (data) => {
            if (!live) return;
            observer.next({ result: { type: "data", data } });
            observer.complete();
          },
          (error: unknown) => {
            if (live) observer.error(error instanceof TypeError ? new DurableQueuedWriteError("saved-request", error) : error);
          }
        );
      return {
        unsubscribe: () => {
          live = false;
        },
      };
    },
  }) as unknown as ReturnType<ReturnType<TRPCLink<never>>>;

// ── the screen ───────────────────────────────────────────────────────

let mutations: Mutations | null = null;

function Probe(): React.ReactElement {
  const hook = useEntryMutations();
  React.useEffect(() => {
    mutations = hook;
  }, [hook]);
  const current = trpc.entries.current.useQuery(undefined);
  const list = trpc.entries.list.useInfiniteQuery(TRACKER_LIST_INPUT, {
    getNextPageParam: (page: { nextCursor?: string }) => page.nextCursor,
  });
  const rows = (list.data?.pages ?? []).flatMap(
    (page: { entries: DetailedEntry[] }) => page.entries
  );
  return (
    <>
      <output data-testid="current">{current.data?.id ?? ""}</output>
      <ul data-testid="rows">
        {rows.map((row: DetailedEntry) => (
          <li key={row.id} data-testid={row.end === null ? "running" : "stopped"}>
            {row.description}
          </li>
        ))}
      </ul>
    </>
  );
}

let queryClient = new QueryClient();

const mount = (): void => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = trpc.createClient({ links: [fakeLink] });
  render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>
    </trpc.Provider>
  );
};

const running = entry({
  id: "e1",
  description: "Before",
  start: new Date(Date.now() - 600_000).toISOString(),
});

const stoppedAt = (source: DetailedEntry, end: string): TimeEntry =>
  ({ ...source, end, durationSec: 600 }) as TimeEntry;

beforeEach(() => {
  serverEntries = [running];
  listCalls = 0;
  held.clear();
  heldCalls.clear();
  callOrder = [];
  callInputs.clear();
  retained.mockReset();
  retained.mockImplementation(async (error) => durableQueuedWrite(error) !== null);
  enqueueOffline.mockReset();
  enqueueOffline.mockResolvedValue(undefined);
  scopeWorkspace = null;
  scopeOwner = null;
  amendQueuedStart.mockReset();
  timerStore.getState().clear();
  mutations = null;
});

afterEach(cleanup);

const settleAll = async (): Promise<void> => {
  await waitFor(() => expect(queryClient.isMutating()).toBe(0));
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
};

describe("entry mutations racing each other", () => {
  it("shows a stopped row before Entries has loaded on a cold launch", async () => {
    timerStore.getState().setRunning(running);
    const stop = deferred<unknown>();
    held.set("entries.stop", stop);
    mount();

    act(() => mutations?.stopTimer());
    await waitFor(() => expect(screen.getByTestId("stopped").textContent).toBe("Before"));
    expect(screen.getByTestId("current").textContent).toBe("");
    expect(heldCalls.get("entries.stop")).toBe(1);

    const stopped = stoppedAt(running, new Date().toISOString());
    serverEntries = [entry(stopped)];
    await act(async () => stop.resolve(stopped));
    await settleAll();
  });

  it("does not revive an offline timer stopped while its start-time edit is being stored", async () => {
    const offline = entry({ id: "temp-offline", description: "Offline", start: "2026-09-30T09:00:00.000Z" });
    serverEntries = [offline];
    mount();
    await screen.findByText("Offline");
    timerStore.getState().setRunning(offline);
    const amend = deferred<boolean>();
    amendQueuedStart.mockReturnValueOnce(amend.promise);
    const stop = deferred<unknown>();
    held.set("entries.stop", stop);
    act(() => { void mutations?.updateEntry({ id: offline.id, start: "2026-09-30T08:00:00.000Z" }); });
    act(() => mutations?.stopTimer());
    await waitFor(() => expect(heldCalls.get("entries.stop")).toBe(1));
    expect(screen.getByTestId("current").textContent).toBe("");
    await act(async () => amend.resolve(true));
    expect(screen.getByTestId("current").textContent).toBe("");
    const stopped = entry({ ...offline, id: "real-id", end: "2026-09-30T10:00:00.000Z" });
    serverEntries = [stopped];
    await act(async () => stop.resolve(stopped));
    await settleAll();
  });

  it("saves a start-time edit made before Start answers, before a queued Stop", async () => {
    serverEntries = [];
    mount();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    const start = deferred<unknown>();
    const update = deferred<unknown>();
    const stop = deferred<unknown>();
    held.set("entries.start", start);
    held.set("entries.update", update);
    held.set("entries.stop", stop);
    act(() => mutations?.startTimer({ description: "New", projectId: null, billable: false }));
    await waitFor(() => expect(heldCalls.get("entries.start")).toBe(1));
    const tempId = screen.getByTestId("current").textContent!;
    const earlier = "2026-09-30T08:00:00.000Z";
    act(() => { void mutations?.updateEntry({ id: tempId, start: earlier }); });
    const current = queryClient.getQueryCache().findAll().find((q) =>
      JSON.stringify(q.queryKey).includes('"current"'))?.state.data as TimeEntry;
    expect(current.start).toBe(earlier);
    act(() => mutations?.stopTimer());
    await waitFor(() => expect(screen.getByTestId("current").textContent).toBe(""));
    const created = entry({ id: "real-id", description: "New", start: "2026-09-30T09:00:00.000Z" });
    await act(async () => start.resolve(created));
    await waitFor(() => expect(heldCalls.get("entries.update")).toBe(1));
    expect(callInputs.get("entries.update")).toMatchObject({ id: "real-id", start: earlier });
    expect(heldCalls.get("entries.stop")).toBeUndefined();
    expect(screen.getByTestId("current").textContent).toBe("");
    await act(async () => update.resolve({ ...created, start: earlier }));
    await waitFor(() => expect(heldCalls.get("entries.stop")).toBe(1));
    expect(screen.getByTestId("current").textContent).toBe("");
    const stopped = entry({ ...created, start: earlier, end: "2026-09-30T10:00:00.000Z" });
    serverEntries = [stopped];
    await act(async () => stop.resolve(stopped));
    await settleAll();
    expect(callOrder).toEqual(["entries.start", "entries.update", "entries.stop"]);
  });

  it("retains the submitted start without minting another identity after connection loss", async () => {
    serverEntries = [];
    mount();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    const start = deferred<unknown>();
    held.set("entries.start", start);
    act(() => mutations?.startTimer({ description: "Offline", projectId: null, billable: false }));
    await waitFor(() => expect(heldCalls.get("entries.start")).toBe(1));
    const tempId = screen.getByTestId("current").textContent!;
    const earlier = "2026-09-30T08:00:00.000Z";
    act(() => { void mutations?.updateEntry({ id: tempId, start: earlier }); });
    await act(async () => start.reject(new TypeError("Failed to fetch")));
    await waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(durableQueuedWrite(retained.mock.calls[0]?.[0])).not.toBeNull();
    expect(retained.mock.calls[0]?.[1]).toBe(tempId);
    expect(enqueueOffline).toHaveBeenCalledWith("entries.update", expect.objectContaining({ id: tempId, start: earlier }), tempId, null, expect.objectContaining({ owner: null }));
  });

  it("keeps a just-started timer on the list when an earlier stop settles", async () => {
    mount();
    await screen.findByText("Before");

    const stop = deferred<unknown>();
    const start = deferred<unknown>();
    held.set("entries.stop", stop);
    held.set("entries.start", start);

    act(() => mutations?.stopTimer());
    await waitFor(() => expect(heldCalls.get("entries.stop")).toBe(1));

    act(() =>
      mutations?.startTimer({ description: "After", projectId: null, billable: false })
    );
    // On screen at once, but the request waits for the stop ahead of it.
    await waitFor(() =>
      expect(screen.getByTestId("running").textContent).toBe("After")
    );
    expect(heldCalls.get("entries.start")).toBeUndefined();

    // The stop commits and answers. The start has not reached the database,
    // so any list read from here on is from before it.
    const stopEnd = new Date().toISOString();
    serverEntries = [entry(stoppedAt(running, stopEnd))];
    await act(async () => {
      stop.resolve(stoppedAt(running, stopEnd));
    });
    await waitFor(() => expect(heldCalls.get("entries.start")).toBe(1));
    await waitFor(() => expect(queryClient.isMutating()).toBe(1));
    // Past the macrotask on which a settled write decides whether to refetch.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));

    expect(screen.getByTestId("running").textContent).toBe("After");
    expect(screen.getByTestId("stopped").textContent).toBe("Before");

    // Then the start commits; its settle is the one that refetches.
    const started = entry({ id: "e2", description: "After", start: stopEnd });
    serverEntries = [started, ...serverEntries];
    const callsBeforeStart = listCalls;
    await act(async () => {
      start.resolve(started);
    });
    await settleAll();

    expect(listCalls).toBeGreaterThan(callsBeforeStart);
    expect(screen.getByTestId("running").textContent).toBe("After");
    expect(screen.getByTestId("stopped").textContent).toBe("Before");
  });

  it("refetches once when two writes settle together", async () => {
    mount();
    await screen.findByText("Before");

    const stop = deferred<unknown>();
    const start = deferred<unknown>();
    held.set("entries.stop", stop);
    held.set("entries.start", start);

    act(() => mutations?.stopTimer());
    await waitFor(() => expect(heldCalls.get("entries.stop")).toBe(1));
    act(() =>
      mutations?.startTimer({ description: "After", projectId: null, billable: false })
    );
    await waitFor(() => expect(queryClient.isMutating()).toBe(2));

    // Both answers are ready before either is read; neither write may conclude
    // that the other will refetch.
    const stopEnd = new Date().toISOString();
    const started = entry({ id: "e2", description: "After", start: stopEnd });
    serverEntries = [started, entry(stoppedAt(running, stopEnd))];
    const callsBefore = listCalls;
    await act(async () => {
      stop.resolve(stoppedAt(running, stopEnd));
      start.resolve(started);
    });
    await settleAll();

    expect(listCalls).toBeGreaterThan(callsBefore);
    expect(screen.getByTestId("running").textContent).toBe("After");
    expect(screen.getByTestId("stopped").textContent).toBe("Before");
  });

  it("still refetches after a stop with nothing else in flight", async () => {
    mount();
    await screen.findByText("Before");

    const stop = deferred<unknown>();
    held.set("entries.stop", stop);
    act(() => mutations?.stopTimer());
    await waitFor(() => expect(heldCalls.get("entries.stop")).toBe(1));

    const callsBeforeStop = listCalls;
    const stopEnd = new Date().toISOString();
    serverEntries = [entry(stoppedAt(running, stopEnd))];
    await act(async () => {
      stop.resolve(stoppedAt(running, stopEnd));
    });
    await settleAll();

    expect(listCalls).toBeGreaterThan(callsBeforeStop);
    expect(screen.queryByTestId("running")).toBeNull();
  });
});

describe("a stop pressed while the start is still in flight", () => {
  const idle = entry({
    id: "e1",
    description: "Before",
    start: new Date(Date.now() - 600_000).toISOString(),
    end: new Date(Date.now() - 300_000).toISOString(),
    durationSec: 300,
  });

  /** Start, then Stop before the start has answered. */
  const startThenStop = async (): Promise<{
    start: Deferred<unknown>;
    stop: Deferred<unknown>;
  }> => {
    serverEntries = [idle];
    mount();
    await screen.findByText("Before");

    const start = deferred<unknown>();
    const stop = deferred<unknown>();
    held.set("entries.start", start);
    held.set("entries.stop", stop);

    act(() =>
      mutations?.startTimer({ description: "After", projectId: null, billable: false })
    );
    await waitFor(() => expect(heldCalls.get("entries.start")).toBe(1));
    act(() => mutations?.stopTimer());

    // The screen answers the click at once; the request waits its turn.
    await waitFor(() => expect(screen.queryByTestId("running")).toBeNull());
    expect(screen.getByTestId("current").textContent).toBe("");
    expect(heldCalls.get("entries.stop")).toBeUndefined();
    return { start, stop };
  };

  it("sends the stop only after the start has answered, and never shows the timer again", async () => {
    const { start, stop } = await startThenStop();

    // The start commits late. Only now may the id-less stop go out, or it
    // would find nothing running and the start would open a timer after it.
    const started = entry({ id: "e2", description: "After", start: new Date().toISOString() });
    serverEntries = [started, idle];
    await act(async () => {
      start.resolve(started);
    });
    await waitFor(() => expect(heldCalls.get("entries.stop")).toBe(1));
    expect(callOrder).toEqual(["entries.start", "entries.stop"]);

    // Between the two answers the stopped timer must not come back.
    expect(screen.queryByTestId("running")).toBeNull();
    expect(screen.getByTestId("current").textContent).toBe("");

    const end = new Date().toISOString();
    const stopped = { ...started, end, durationSec: 0 } as TimeEntry;
    serverEntries = [entry(stopped), idle];
    await act(async () => {
      stop.resolve(stopped);
    });
    await settleAll();

    expect(screen.queryByTestId("running")).toBeNull();
    expect(screen.getByTestId("current").textContent).toBe("");
    expect(screen.getAllByTestId("stopped").map((row) => row.textContent)).toEqual([
      "After",
      "Before",
    ]);
  });

  it("queues a stop that loses the network with the id the start was given", async () => {
    const { start, stop } = await startThenStop();

    const started = entry({ id: "e2", description: "After", start: new Date().toISOString() });
    serverEntries = [started, idle];
    await act(async () => {
      start.resolve(started);
    });
    await waitFor(() => expect(heldCalls.get("entries.stop")).toBe(1));

    await act(async () => {
      stop.reject(new TypeError("Failed to fetch"));
    });
    await waitFor(() => expect(retained).toHaveBeenCalledTimes(1));
    expect(callInputs.get("entries.stop")).toMatchObject({ id: "e2" });
    expect(enqueueOffline).not.toHaveBeenCalled();
    expect(screen.queryByTestId("running")).toBeNull();
  });
});


describe("draft mutation completion", () => {
  const manual = {
    description: "Draft",
    projectId: null,
    billable: false,
    start: "2026-10-01T09:00:00.000Z",
    end: "2026-10-01T10:00:00.000Z",
  };

  for (const operation of ["create", "update"] as const) {
    const begin = (): ReturnType<Mutations["createManualEntry"]> => {
      if (!mutations) throw new Error("not mounted");
      return operation === "create" ? mutations.createManualEntry(manual) : mutations.updateEntry({ id: "e1", description: "Draft" });
    };
    const path = `entries.${operation}`;

    it(`${operation} waits for deferred server success`, async () => {
      const request = deferred<unknown>();
      held.set(path, request);
      mount();
      await screen.findByText("Before");
      let settled = false;
      let result!: ReturnType<typeof begin>;
      act(() => { result = begin(); void result.then(() => { settled = true; }); });
      await waitFor(() => expect(heldCalls.get(path)).toBe(1));
      expect(settled).toBe(false);
      const saved = entry({ ...manual, id: operation === "create" ? "e2" : "e1" });
      serverEntries = [saved];
      await act(async () => { request.resolve(saved); expect(await result).toEqual({ ok: true, saved: "server", entry: expect.objectContaining({ id: saved.id, start: saved.start, end: saved.end }) }); });
      expect(enqueueOffline).not.toHaveBeenCalled();
    });

    it(`${operation} returns refusal and rolls back optimism`, async () => {
      const request = deferred<unknown>();
      held.set(path, request);
      mount();
      await screen.findByText("Before");
      let result!: ReturnType<typeof begin>;
      act(() => { result = begin(); });
      await screen.findByText("Draft");
      const refusal = Object.assign(new Error("Entry is invoiced"), { data: { code: "FORBIDDEN" } });
      await act(async () => { request.reject(refusal); expect(await result).toEqual({ ok: false, message: "Entry is invoiced" }); });
      await waitFor(() => expect(screen.getByTestId("rows")).not.toHaveTextContent("Draft"));
      expect(enqueueOffline).not.toHaveBeenCalled();
    });

    it(`${operation} waits for the saved row metadata to settle`, async () => {
      const request = deferred<unknown>();
      const storage = deferred<void>();
      retained.mockReturnValueOnce(storage.promise.then(() => true));
      held.set(path, request);
      mount();
      await screen.findByText("Before");
      let result!: ReturnType<typeof begin>;
      let settled = false;
      act(() => { result = begin(); void result.then(() => { settled = true; }); });
      await waitFor(() => expect(heldCalls.get(path)).toBe(1));
      await act(async () => request.reject(new TypeError("Failed to fetch")));
      await waitFor(() => expect(retained).toHaveBeenCalledTimes(1));
      expect(settled).toBe(false);
      expect(screen.getByTestId("rows")).toHaveTextContent("Draft");
      await act(async () => { storage.resolve(); expect(await result).toEqual({ ok: true, saved: "offline", entry: expect.objectContaining({ description: "Draft" }) }); });
    });

    it(`${operation} returns failure and rolls back when storage fails`, async () => {
      const request = deferred<unknown>();
      held.set(path, request);
      mount();
      await screen.findByText("Before");
      let result!: ReturnType<typeof begin>;
      act(() => { result = begin(); });
      await waitFor(() => expect(heldCalls.get(path)).toBe(1));
      await act(async () => {
        request.reject(new Error("Storage quota exceeded"));
        expect(await result).toEqual({ ok: false, message: expect.any(String) });
      });
      await waitFor(() => expect(screen.getByTestId("rows")).not.toHaveTextContent("Draft"));
    });

    it(`${operation} keeps the draft unsaved when its original identity is unresolved`, async () => {
      const request = deferred<unknown>();
      held.set(path, request);
      mount();
      await screen.findByText("Before");
      let result!: ReturnType<typeof begin>;
      act(() => { result = begin(); });
      await waitFor(() => expect(heldCalls.get(path)).toBe(1));
      await act(async () => {
        request.reject(new OfflineQueueScopeNotReadyError());
        expect(await result).toEqual({ ok: false, message: expect.any(String) });
      });
      await waitFor(() => expect(screen.getByTestId("rows")).not.toHaveTextContent("Draft"));
    });

    it(`${operation} stamps the original workspace/account after an offline failure`, async () => {
      scopeWorkspace = "ws-a";
      scopeOwner = "u-a";
      const request = deferred<unknown>();
      held.set(path, request);
      mount();
      await screen.findByText("Before");
      let result!: ReturnType<typeof begin>;
      act(() => { result = begin(); });
      await waitFor(() => expect(heldCalls.get(path)).toBe(1));
      expect(callInputs.get(path)).toMatchObject({ workspaceId: "ws-a" });
      scopeWorkspace = "ws-b";
      scopeOwner = "u-b";
      const other = entry({ id: "other", description: "Other workspace", start: manual.start });
      serverEntries = [other];
      queryClient.setQueryData([["entries", "list"], { input: TRACKER_LIST_INPUT, type: "infinite" }], { pages: [{ entries: [other] }], pageParams: [null] });
      await act(async () => { request.reject(new TypeError("Failed to fetch")); await result; });
      expect(callInputs.get(path)).toMatchObject({ __durableScope: { workspaceId: "ws-a", owner: "u-a" } });
      expect(retained).toHaveBeenCalledTimes(1);
      expect(enqueueOffline).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.getByTestId("rows")).toHaveTextContent("Other workspace"));
      await waitFor(() => expect(screen.getByTestId("rows")).not.toHaveTextContent("Draft"));
    });
  }

  it("returns the exact durable temp entry without a mounted tracker list", async () => {
    scopeWorkspace = "ws-a";
    scopeOwner = "u-a";
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const client = trpc.createClient({ links: [fakeLink] });
    function EditorOnly(): null {
      const hook = useEntryMutations();
      React.useEffect(() => { mutations = hook; }, [hook]);
      return null;
    }
    render(<trpc.Provider client={client} queryClient={queryClient}><QueryClientProvider client={queryClient}><EditorOnly /></QueryClientProvider></trpc.Provider>);
    expect(queryClient.getQueryData([["entries", "list"], { input: TRACKER_LIST_INPUT, type: "infinite" }])).toBeUndefined();
    const request = deferred<unknown>();
    held.set("entries.create", request);
    let result!: Promise<import("@/lib/entry-mutation-result").EntryMutationResult>;
    act(() => { result = mutations!.createManualEntry(manual); });
    await waitFor(() => expect(heldCalls.get("entries.create")).toBe(1));
    // The consumer can even discard the optional tracker cache before failure.
    queryClient.removeQueries({ predicate: (query) => JSON.stringify(query.queryKey).includes('"entries","list"') });
    await act(async () => request.reject(new TypeError("Failed to fetch")));
    const saved = await result;
    expect(saved).toMatchObject({ ok: true, saved: "offline", entry: { workspaceId: "ws-a", authorId: "u-a", description: "Draft", start: manual.start, end: manual.end, source: "web" } });
    if (!saved.ok || !saved.entry) throw new Error("missing created entry");
    expect(saved.entry.id).toBe(retained.mock.calls[0]?.[1]);
    expect(saved.entry.id).toMatch(/^temp-/);
    expect(queryClient.getQueryData([["entries", "list"], { input: TRACKER_LIST_INPUT, type: "infinite" }])).toBeUndefined();
  });

  it("a temporary entry still syncing is not a completed save", async () => {
    mount();
    await screen.findByText("Before");
    expect(await mutations?.updateEntry({ id: "temp-unsynced", description: "Draft" })).toEqual({ ok: false, message: expect.stringContaining("syncing") });
    expect(heldCalls.get("entries.update")).toBeUndefined();
  });

  it("does not resume idle work after the offline stop failed to persist", async () => {
    const stop = deferred<unknown>();
    held.set("entries.stop", stop);
    mount();
    await screen.findByText("Before");
    act(() => mutations!.splitAtIdle({ end: "2026-10-01T09:00:00.000Z", resume: { description: "Resume", projectId: null, billable: false } }));
    await waitFor(() => expect(heldCalls.get("entries.stop")).toBe(1));
    await act(async () => stop.reject(new Error("Disk full")));
    await settleAll();
    expect(heldCalls.get("entries.start")).toBeUndefined();
  });

  it("does not queue a request when snapshot fails before transport", async () => {
    mount();
    await screen.findByText("Before");
    vi.spyOn(queryClient, "cancelQueries").mockRejectedValueOnce(new TypeError("Cancellation failed"));
    let result!: Promise<import("@/lib/entry-mutation-result").EntryMutationResult>;
    await act(async () => { result = mutations!.createManualEntry(manual); await result; });
    expect(await result).toMatchObject({ ok: false });
    expect(heldCalls.get("entries.create")).toBeUndefined();
    expect(enqueueOffline).not.toHaveBeenCalled();
  });

  it("never sends a create when the account changes during snapshot cancellation", async () => {
    scopeWorkspace = "ws-a";
    scopeOwner = "u-a";
    mount();
    await screen.findByText("Before");
    const cancel = deferred<void>();
    vi.spyOn(queryClient, "cancelQueries").mockReturnValueOnce(cancel.promise);
    let result!: Promise<import("@/lib/entry-mutation-result").EntryMutationResult>;
    act(() => { result = mutations!.createManualEntry(manual); });
    await act(async () => { scopeOwner = "u-b"; cancel.resolve(); });
    expect(await result).toEqual({ ok: false, message: expect.stringContaining("account or workspace") });
    expect(heldCalls.get("entries.create")).toBeUndefined();
    expect(enqueueOffline).not.toHaveBeenCalled();
  });
});
