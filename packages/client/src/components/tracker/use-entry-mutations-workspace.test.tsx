// @vitest-environment jsdom
/**
 * The tracker's writes in a person with several workspaces.
 *
 *  - A start that ended a timer in ANOTHER workspace says so. One running timer
 *    per person is the rule, but the stop happened where the person is not
 *    looking, and a timer that silently vanishes reads as lost time.
 *  - A write that began in workspace A and settles after a switch to B does
 *    not touch the cache: the switch reset it for B, and A's answer patched
 *    in (or A's snapshot rolled back in) would put A's entries on B's screen.
 *  - A write that fails offline is queued in the workspace it began in.
 *
 * Same fake-`@/lib/trpc` approach as use-entry-mutations-offline.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { TimeEntry, WorkspaceSummary } from "@starter/core";

let online = true;
vi.mock("@/mobile/network", () => ({
  getNetworkOnline: () => online,
  getServerNetworkOnline: () => true,
  subscribeNetwork: () => () => undefined,
}));

const enqueued: Array<{ op: string; workspaceId: string | null | undefined }> = [];
vi.mock("@/lib/offline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/offline")>();
  return {
    ...actual,
    isDocumentUnloading: () => false,
    enqueueOffline: async (
      op: string,
      _input: unknown,
      _tempId?: string,
      workspaceId?: string | null,
    ): Promise<void> => {
      enqueued.push({ op, workspaceId });
    },
  };
});

const toastMessage = vi.fn();
const toastError = vi.fn();
vi.mock("@/components/ui/sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    message: (...args: unknown[]) => toastMessage(...args),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/lib/running-mirror", () => ({
  writeRunningMirror: async (): Promise<void> => undefined,
}));

type MutationOptions = {
  onMutate?: (input: unknown) => Promise<unknown>;
  onSuccess?: (data: unknown, input: unknown, context: unknown) => unknown;
  onError?: (error: unknown, input: unknown, context: unknown) => Promise<unknown> | unknown;
};
const options = new Map<string, MutationOptions>();
let currentData: TimeEntry | null | undefined;
const setCurrent = vi.fn((_key: undefined, next: TimeEntry | null) => {
  currentData = next;
});

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
      current: { cancel: asyncNoop, getData: () => currentData, setData: setCurrent },
      list: { cancel: asyncNoop, getInfiniteData: () => undefined, setInfiniteData: noop },
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

const { QueryClient } = await import("@tanstack/react-query");
const { useEntryMutations } = await import("@/components/tracker/use-entry-mutations");
const activeWorkspace = await import("@/lib/active-workspace");

const summary = (id: string, name: string, isDefault = false): WorkspaceSummary => ({
  id,
  name,
  role: "member",
  memberCount: 2,
  isDefault,
  permissions: {
    inviteMembers: false,
    inviteAdmins: false,
    changeRoles: false,
    editTimeVisibility: false,
    editMoneyVisibility: false,
    removeMembers: false,
    transferOwnership: false,
    invoices: false,
    viewOthersTime: false,
    viewOthersMoney: false,
  },
});
const A = summary("ws-a", "Acme", true);
const B = summary("ws-b", "Beta");

const entry = (over: Partial<TimeEntry> = {}): TimeEntry =>
  ({
    id: "e1",
    workspaceId: B.id,
    authorId: "u1",
    description: "Work",
    projectId: null,
    taskId: null,
    billable: false,
    start: new Date().toISOString(),
    end: null,
    durationSec: 0,
    hourlyRate: null,
    currency: "EUR",
    tagIds: [],
    ...over,
  }) as unknown as TimeEntry;

const startInput = {
  description: "Work",
  projectId: null,
  taskId: null,
  billable: false,
  start: new Date().toISOString(),
  source: "web",
  timeZone: "UTC",
  originId: "o",
};

function Probe(): null {
  useEntryMutations();
  return null;
}

const optionsFor = (path: string): MutationOptions => {
  const opts = options.get(path);
  if (!opts) throw new Error(`no mutation for ${path}`);
  return opts;
};

beforeEach(async () => {
  online = true;
  currentData = null;
  enqueued.length = 0;
  options.clear();
  toastMessage.mockClear();
  toastError.mockClear();
  setCurrent.mockClear();
  window.localStorage.clear();
  activeWorkspace.__resetActiveWorkspaceForTests();
  await activeWorkspace.applyWorkspaceList([A, B], "u1");
  await activeWorkspace.switchWorkspace(B.id, { queryClient: new QueryClient() });
  render(<Probe />);
});

afterEach(cleanup);

describe("entry mutations across workspaces", () => {
  it("says which workspace's timer a start stopped", async () => {
    const opts = optionsFor("entries.start");
    const context = await opts.onMutate?.(startInput);
    opts.onSuccess?.(
      {
        ...entry(),
        replaced: { entryId: "old", workspaceId: A.id, workspaceName: "Acme", end: "x" },
      },
      startInput,
      context,
    );
    expect(toastMessage).toHaveBeenCalledWith("Stopped your timer in Acme");
  });

  it("says nothing when nothing elsewhere was stopped", async () => {
    const opts = optionsFor("entries.start");
    const context = await opts.onMutate?.(startInput);
    opts.onSuccess?.({ ...entry(), replaced: null }, startInput, context);
    expect(toastMessage).not.toHaveBeenCalled();
  });

  it("does not write an answer into the cache after the user switched away", async () => {
    const opts = optionsFor("entries.start");
    const context = await opts.onMutate?.(startInput);
    setCurrent.mockClear();

    await activeWorkspace.switchWorkspace(A.id, { queryClient: new QueryClient() });
    opts.onSuccess?.({ ...entry(), replaced: null }, startInput, context);

    expect(setCurrent).not.toHaveBeenCalled();
  });

  it("does not roll back into another workspace's cache", async () => {
    const opts = optionsFor("entries.start");
    const context = await opts.onMutate?.(startInput);
    setCurrent.mockClear();

    await activeWorkspace.switchWorkspace(A.id, { queryClient: new QueryClient() });
    await opts.onError?.(
      Object.assign(new Error("nope"), { data: { code: "BAD_REQUEST" } }),
      startInput,
      context,
    );

    expect(setCurrent).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
  });

  it("queues an offline failure in the workspace the write began in", async () => {
    online = false;
    const opts = optionsFor("entries.start");
    const context = await opts.onMutate?.(startInput);
    await activeWorkspace.switchWorkspace(A.id, { queryClient: new QueryClient() });
    await opts.onError?.(new TypeError("Load failed"), startInput, context);

    expect(enqueued).toEqual([{ op: "entries.start", workspaceId: B.id }]);
  });
});
