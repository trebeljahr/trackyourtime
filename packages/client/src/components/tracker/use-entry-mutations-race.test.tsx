// @vitest-environment jsdom
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

vi.mock("@/mobile/network", () => ({
  getNetworkOnline: () => true,
  getServerNetworkOnline: () => true,
  subscribeNetwork: () => () => undefined,
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { error: vi.fn(), message: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

const enqueueOffline = vi.fn(async (): Promise<void> => undefined);
vi.mock("@/lib/offline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/offline")>()),
  enqueueOffline,
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
        .then(() => answer(op.path))
        .then(
          (data) => {
            if (!live) return;
            observer.next({ result: { type: "data", data } });
            observer.complete();
          },
          (error: unknown) => {
            if (live) observer.error(error);
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
  enqueueOffline.mockClear();
  mutations = null;
});

afterEach(cleanup);

const settleAll = async (): Promise<void> => {
  await waitFor(() => expect(queryClient.isMutating()).toBe(0));
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
};

describe("entry mutations racing each other", () => {
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
    await waitFor(() => expect(enqueueOffline).toHaveBeenCalledTimes(1));

    const [op, input, tempId] = enqueueOffline.mock.calls[0] as unknown as [
      string,
      { id?: string },
      string | undefined,
    ];
    expect(op).toBe("entries.stop");
    expect(input.id).toBe("e2");
    expect(tempId).toBeUndefined();
    expect(screen.queryByTestId("running")).toBeNull();
  });
});
