// @vitest-environment jsdom
/**
 * What `useEntryMutations` puts in the offline queue, and when.
 *
 * Two regressions, both of which lose tracked time silently and neither of
 * which any existing spec could see, because they only happen on the paths
 * where the query cache has never answered:
 *
 *  1. **An offline mutation during a page teardown was dropped.** The unload
 *     guard exists to stop a mutation whose bytes the server already has from
 *     being replayed as a duplicate. But `isNetworkError()` is unconditionally
 *     true while offline, so an airplane-mode start or stop that coincided
 *     with a reload or a tab close reached the same guard and was thrown away
 *     — in exactly the case the queue exists for. The guard now also requires
 *     the device to have been online, because with no radio there are no bytes
 *     for the server to have received.
 *
 *  2. **A stop queued after a cold offline launch named no entry.** The
 *     running timer is restored from the mirror into the timer store, not into
 *     the React Query cache, so `entries.current.getData()` is `undefined` and
 *     the queued `entries.stop` carried neither `id` nor `tempId`. On replay
 *     that degrades to "stop whatever is running", which days later is a
 *     different entry, possibly on another device.
 *
 * The hook is driven through a fake `@/lib/trpc`: `useMutation` records the
 * options object it is handed, and the spec calls `onMutate`/`onError` the way
 * React Query would. That keeps the real `handleError`, the real payload
 * construction and the real `isNetworkError` in the test — only the transport
 * and the network verdict are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { TimeEntry } from "@starter/shared";
import type { OfflineOp, OfflinePayloadMap } from "@starter/core";

// ── the fakes ────────────────────────────────────────────────────────

let online = true;
vi.mock("@/mobile/network", () => ({
  getNetworkOnline: () => online,
  getServerNetworkOnline: () => true,
  subscribeNetwork: () => () => undefined,
}));

let unloading = false;
const enqueued: Array<{
  op: OfflineOp;
  input: unknown;
  tempId: string | undefined;
}> = [];

vi.mock("@/lib/offline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/offline")>();
  return {
    ...actual,
    isDocumentUnloading: () => unloading,
    enqueueOffline: async (
      op: OfflineOp,
      input: unknown,
      tempId?: string,
    ): Promise<void> => {
      enqueued.push({ op, input, tempId });
    },
    cancelQueuedForTemp: async (): Promise<void> => undefined,
  };
});

const toastError = vi.fn();
vi.mock("@/components/ui/sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    message: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/lib/running-mirror", () => ({
  writeRunningMirror: async (): Promise<void> => undefined,
}));

/** Options React Query would have been given, keyed by router path. */
type MutationOptions = {
  onMutate?: (input: unknown) => Promise<unknown>;
  onError?: (
    error: unknown,
    input: unknown,
    context: unknown,
  ) => Promise<unknown> | unknown;
  networkMode?: string;
};
const options = new Map<string, MutationOptions>();

/** What `entries.current.getData()` answers. `undefined` = never answered. */
let currentData: TimeEntry | null | undefined;

const noop = (): void => undefined;
const asyncNoop = async (): Promise<void> => undefined;

const mutationStub = (path: string) => ({
  useMutation: (opts: MutationOptions = {}) => {
    options.set(path, opts);
    return { mutate: noop, mutateAsync: asyncNoop, isPending: false };
  },
});

vi.mock("@/lib/trpc", () => {
  const utils = {
    entries: {
      current: {
        cancel: asyncNoop,
        getData: () => currentData,
        setData: (_key: undefined, next: TimeEntry | null) => {
          currentData = next;
        },
      },
      list: {
        cancel: asyncNoop,
        getInfiniteData: () => undefined,
        setInfiniteData: noop,
      },
      invalidate: asyncNoop,
    },
    projects: { list: { getData: () => [] } },
    settings: { get: { getData: () => null } },
    reports: { invalidate: asyncNoop },
  };

  return {
    trpc: {
      useUtils: () => utils,
      entries: {
        start: mutationStub("entries.start"),
        stop: mutationStub("entries.stop"),
        create: mutationStub("entries.create"),
        update: mutationStub("entries.update"),
        remove: mutationStub("entries.remove"),
        resolveRunaway: mutationStub("entries.resolveRunaway"),
        discard: mutationStub("entries.discard"),
      },
    },
  };
});

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { timerStore } = await import("@/hooks/use-sync");
const { useEntryMutations } = await import(
  "@/components/tracker/use-entry-mutations"
);

// ── fixtures ─────────────────────────────────────────────────────────

const entry = (over: Partial<TimeEntry> = {}): TimeEntry =>
  ({
    id: "server-entry-1",
    workspaceId: "w1",
    authorId: "u1",
    description: "Deep work",
    projectId: null,
    taskId: null,
    billable: false,
    start: new Date(Date.now() - 600_000).toISOString(),
    end: null,
    durationSec: 0,
    hourlyRate: null,
    currency: "EUR",
    tagIds: [],
    ...over,
  }) as unknown as TimeEntry;

/** A dead radio: no `data.code`, and `isNetworkError` sees `isOnline()` false. */
const transportFailure = new TypeError("Load failed");

function Probe(): null {
  useEntryMutations();
  return null;
}

const mountHook = (): void => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Probe />
    </QueryClientProvider>,
  );
};

const optionsFor = (path: string): MutationOptions => {
  const opts = options.get(path);
  if (opts === undefined) throw new Error(`no mutation registered for ${path}`);
  return opts;
};

/** Run one mutation's optimistic + error path, as React Query would. */
const failMutation = async (path: string, input: unknown): Promise<void> => {
  const opts = optionsFor(path);
  const context = await opts.onMutate?.(input);
  await opts.onError?.(transportFailure, input, context);
};

beforeEach(() => {
  online = true;
  unloading = false;
  currentData = undefined;
  enqueued.length = 0;
  options.clear();
  toastError.mockClear();
  timerStore.getState().setRunning(null);
});

afterEach(() => {
  cleanup();
});

// ── 1. the unload guard ──────────────────────────────────────────────

describe("a mutation that fails while the document is unloading", () => {
  const startInput = {
    description: "Deep work",
    projectId: null,
    taskId: null,
    billable: false,
    start: new Date().toISOString(),
    source: "web",
    timeZone: "Europe/Berlin",
    originId: "origin-1",
  };

  it("is queued when the device was offline — the bytes never left", async () => {
    online = false;
    unloading = true;
    currentData = null;
    mountHook();

    await failMutation("entries.start", startInput);

    expect(enqueued.map((row) => row.op)).toEqual(["entries.start"]);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("is dropped when the device was online — the server likely has it", async () => {
    online = true;
    unloading = true;
    currentData = null;
    mountHook();

    await failMutation("entries.start", startInput);

    expect(enqueued).toEqual([]);
    // Not a rollback either: the reload about to happen re-reads the server.
    expect(toastError).not.toHaveBeenCalled();
  });

  it("is queued in the ordinary offline case, with no teardown at all", async () => {
    online = false;
    unloading = false;
    currentData = null;
    mountHook();

    await failMutation("entries.start", startInput);

    expect(enqueued.map((row) => row.op)).toEqual(["entries.start"]);
  });

  it("queues an offline stop caught by a teardown, and names the entry", async () => {
    online = false;
    unloading = true;
    currentData = entry();
    mountHook();

    await failMutation("entries.stop", {
      end: new Date().toISOString(),
      originId: "origin-1",
    });

    expect(enqueued).toHaveLength(1);
    const row = enqueued[0]!;
    expect(row.op).toBe("entries.stop");
    expect((row.input as OfflinePayloadMap["entries.stop"]).id).toBe(
      "server-entry-1",
    );
  });
});

// ── 2. the stop after a relaunch that restored from the mirror ───────

describe("a stop queued after a relaunch that restored from the mirror", () => {
  const stopInput = { end: new Date().toISOString(), originId: "origin-1" };

  it("carries the restored entry's real id", async () => {
    online = false;
    // The cold offline launch: `entries.current` has never answered, and the
    // only thing that knows a timer is running is the store the mirror seeded.
    currentData = undefined;
    timerStore.getState().setRunning(entry({ id: "mirrored-entry" }));
    mountHook();

    await failMutation("entries.stop", stopInput);

    expect(enqueued).toHaveLength(1);
    const payload = enqueued[0]!.input as OfflinePayloadMap["entries.stop"];
    expect(payload.id).toBe("mirrored-entry");
    expect(payload.end).toBe(stopInput.end);
  });

  it("carries the temp id when the restored timer was started offline", async () => {
    online = false;
    currentData = undefined;
    timerStore.getState().setRunning(entry({ id: "temp-abc123" }));
    mountHook();

    await failMutation("entries.stop", stopInput);

    expect(enqueued).toHaveLength(1);
    const row = enqueued[0]!;
    // No `id`: the server has never seen `temp-abc123`. The `tempId` is what
    // lets the replay name the entry once the queued start ahead of it lands.
    expect((row.input as OfflinePayloadMap["entries.stop"]).id).toBeUndefined();
    expect(row.tempId).toBe("temp-abc123");
  });

  it("still trusts an answered null over a stale store", async () => {
    online = false;
    // The query DID answer, with "nothing is running" — a timer stopped on
    // another device. That answer beats whatever the store happens to hold.
    currentData = null;
    timerStore.getState().setRunning(entry({ id: "stale-entry" }));
    mountHook();

    await failMutation("entries.stop", stopInput);

    expect(enqueued).toHaveLength(1);
    expect(
      (enqueued[0]!.input as OfflinePayloadMap["entries.stop"]).id,
    ).toBeUndefined();
  });
});

// ── 3. the option that makes any of this reachable ───────────────────

describe("the mutations that fill the queue", () => {
  it("run in networkMode 'always', so onError fires while offline", () => {
    mountHook();

    for (const path of [
      "entries.start",
      "entries.stop",
      "entries.create",
      "entries.update",
      "entries.remove",
    ]) {
      expect(optionsFor(path).networkMode).toBe("always");
    }
  });

  it("leaves the runaway resolution on React Query's pause-and-resume", () => {
    mountHook();
    // It queues nothing, so pausing offline is right for it.
    expect(optionsFor("entries.resolveRunaway").networkMode).toBeUndefined();
  });
});
