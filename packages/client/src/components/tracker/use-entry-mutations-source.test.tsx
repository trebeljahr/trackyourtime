// @vitest-environment jsdom
/**
 * `source` is stamped once, at write time, and nothing later can fix it: a
 * manual entry created in the desktop app (an accepted activity suggestion
 * among them) says `desktop`, one created in a browser says `web`.
 *
 * Same fake-`@/lib/trpc` approach as use-entry-mutations-workspace.test.tsx.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

let shell: "web" | "electron" = "web";
vi.mock("@/lib/shell", async () => (await import("@/lib/shell-mock")).mockShellModule(() => shell));

const created: unknown[] = [];
const noop = (): void => undefined;
const asyncNoop = async (): Promise<void> => undefined;
const mutationStub = (path: string) => ({
  useMutation: () => ({
    mutate: (input: unknown) => {
      if (path === "entries.create") created.push(input);
    },
    mutateAsync: asyncNoop,
    isPending: false,
  }),
});

vi.mock("@/lib/trpc", () => {
  const utils = {
    entries: {
      current: { cancel: asyncNoop, getData: () => null, setData: noop },
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

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { useEntryMutations } = await import("@/components/tracker/use-entry-mutations");
type Mutations = ReturnType<typeof useEntryMutations>;

const mount = (): Mutations => {
  let mutations: Mutations | null = null;
  function Probe(): null {
    mutations = useEntryMutations();
    return null;
  }
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Probe />
    </QueryClientProvider>,
  );
  if (mutations === null) throw new Error("not mounted");
  return mutations;
};

const args = {
  description: "Editor",
  projectId: null,
  billable: false,
  start: "2026-09-22T09:00:00.000Z",
  end: "2026-09-22T09:25:00.000Z",
};

afterEach(() => {
  cleanup();
  created.length = 0;
});

describe("createManualEntry source", () => {
  it("is desktop in the desktop app", () => {
    shell = "electron";
    mount().createManualEntry(args);
    expect(created).toEqual([expect.objectContaining({ ...args, source: "desktop", taskId: null, tagIds: [] })]);
  });

  it("is web in a browser", () => {
    shell = "web";
    mount().createManualEntry(args);
    expect(created).toEqual([expect.objectContaining({ source: "web" })]);
  });
});
