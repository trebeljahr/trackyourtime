// @vitest-environment jsdom
/**
 * One desktop notification per runaway timer.
 *
 * The desktop app runs the guard in the tracker bar on /app/track and in
 * `DesktopAttentionGuards` on every other screen, so navigating across that
 * line starts a fresh hook, and a reload starts a fresh document. A hidden
 * window has usually posted the notice already, from the sync event that
 * delivered the mark; each new guard used to post it again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { DetailedEntry } from "@starter/shared";

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "me" } }) }));

let listEntries: DetailedEntry[] = [];
vi.mock("@/lib/trpc", () => ({
  trpc: {
    settings: { get: { useQuery: () => ({ data: undefined }) } },
    entries: {
      list: {
        useInfiniteQuery: () => ({ data: { pages: [{ entries: listEntries, nextCursor: undefined }] } }),
      },
    },
  },
}));

const toastCustom = vi.fn();
vi.mock("sonner", () => ({ toast: { custom: toastCustom, dismiss: vi.fn() } }));
vi.mock("@/components/tracker/runaway-prompt", () => ({ RunawayPrompt: () => null }));
vi.mock("@/components/tracker/use-entry-mutations", () => ({ TRACKER_LIST_INPUT: { limit: 50 } }));

const flagged = (id: string, detectedAt: string): DetailedEntry =>
  ({
    id,
    authorId: "me",
    description: "Forgot to stop",
    start: "2026-10-19T06:00:00.000Z",
    end: null,
    runaway: { detectedAt, elapsedSec: 10_800, limitSec: 3600, action: "flagged", resolvedAt: null },
  }) as unknown as DetailedEntry;

const mutations = { resolveRunaway: vi.fn(), stopTimer: vi.fn() } as unknown as Parameters<
  typeof import("./use-runaway-guard").useRunawayGuard
>[0];

const mountGuard = async (): Promise<() => void> => {
  const { useRunawayGuard } = await import("./use-runaway-guard");
  return renderHook(() => useRunawayGuard(mutations)).unmount;
};

let notify: ReturnType<typeof vi.fn>;

beforeEach(() => {
  notify = vi.fn(() => Promise.resolve(true));
  (window as { electronAPI?: unknown }).electronAPI = { isDesktop: true, desktop: { notify } };
  listEntries = [flagged("e1", "2026-10-19T09:00:00.000Z")];
  toastCustom.mockClear();
});

afterEach(() => {
  cleanup();
  delete (window as { electronAPI?: unknown }).electronAPI;
  window.sessionStorage.clear();
  vi.resetModules();
});

describe("useRunawayGuard in the desktop app", () => {
  it("posts one notice when the guard moves between the tracker bar and the other screens", async () => {
    (await mountGuard())();
    await mountGuard();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "runaway", tag: "runaway:e1" }));
    // The prompt itself is raised again: a fresh guard has no toast on screen to rely on.
    expect(toastCustom).toHaveBeenCalledTimes(2);
  });

  it("posts one notice across a reload of the window", async () => {
    (await mountGuard())();
    vi.resetModules();
    await mountGuard();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("posts again for a new mark on the same entry", async () => {
    (await mountGuard())();
    listEntries = [flagged("e1", "2026-10-19T11:00:00.000Z")];
    await mountGuard();
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
