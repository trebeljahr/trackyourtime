// @vitest-environment jsdom
/**
 * One socket per person, carrying every workspace they belong to — and
 * colleagues' entry events in a shared workspace. What the shell does with an
 * event therefore depends on where it happened and who caused it.
 */
import { describe, expect, it, vi } from "vitest";
import type { SyncEvent, TimeEntry } from "@starter/core";

vi.mock("@/lib/trpc", () => ({ trpc: {} }));
vi.mock("@/lib/running-mirror", () => ({ writeRunningMirror: async () => undefined }));
vi.mock("@/lib/native-session", () => ({
  clearNativeToken: async () => undefined,
  getNativeToken: () => null,
  setNativeToken: vi.fn(),
}));
vi.mock("better-auth/react", () => ({
  createAuthClient: () => ({
    signOut: async () => ({ data: null, error: null }),
    signIn: vi.fn(),
    signUp: vi.fn(),
    useSession: vi.fn(),
    getSession: vi.fn(),
  }),
}));
vi.mock("better-auth/client/plugins", () => ({
  deviceAuthorizationClient: () => ({}),
  twoFactorClient: () => ({}),
}));

const { isOwnActivity, syncEventReach, timerStore } = await import("./use-sync");
const { signOut } = await import("@/lib/auth-client");

const entry = (authorId: string, workspaceId = "ws-a"): TimeEntry =>
  ({ id: "e", authorId, workspaceId, end: null, start: new Date().toISOString() }) as TimeEntry;

describe("syncEventReach", () => {
  const upserted: SyncEvent = { kind: "entry.upserted", entry: entry("me") };

  it("applies everything from the workspace on screen, and person-level events", () => {
    expect(syncEventReach(upserted, "ws-a", "ws-a")).toBe("all");
    expect(syncEventReach({ kind: "settings.changed" }, undefined, "ws-a")).toBe("all");
    // Nothing resolved yet: behave as a single-workspace client always did.
    expect(syncEventReach(upserted, "ws-b", null)).toBe("all");
  });

  it("from another workspace, touches only the person's running timer", () => {
    expect(syncEventReach(upserted, "ws-b", "ws-a")).toBe("timer");
    expect(syncEventReach({ kind: "timer.started", entry: entry("me", "ws-b") }, "ws-b", "ws-a")).toBe("timer");
    expect(syncEventReach({ kind: "entry.deleted", id: "x" }, "ws-b", "ws-a")).toBe("timer");
  });

  it("ignores another workspace's catalog, invoices and imports", () => {
    expect(syncEventReach({ kind: "catalog.changed", scope: "project" }, "ws-b", "ws-a")).toBe("ignore");
    expect(syncEventReach({ kind: "invoice.changed" } as SyncEvent, "ws-b", "ws-a")).toBe("ignore");
    expect(syncEventReach({ kind: "data.imported" } as SyncEvent, "ws-b", "ws-a")).toBe("ignore");
  });

  it("refreshes only the workspace list for another workspace's membership change", () => {
    expect(
      syncEventReach({ kind: "membership.changed", workspaceId: "ws-b", reason: "removed" }, "ws-b", "ws-a"),
    ).toBe("membership");
  });
});

describe("isOwnActivity", () => {
  it("counts this person's entry events and nobody else's", () => {
    expect(isOwnActivity({ kind: "timer.started", entry: entry("me") }, "ws-a", "me")).toBe(true);
    expect(isOwnActivity({ kind: "timer.started", entry: entry("colleague") }, "ws-a", "me")).toBe(false);
  });

  it("counts person-level events, not another member's workspace changes", () => {
    expect(isOwnActivity({ kind: "settings.changed" }, undefined, "me")).toBe(true);
    expect(isOwnActivity({ kind: "catalog.changed", scope: "tag" }, "ws-a", "me")).toBe(false);
  });
});

describe("the running timer on sign-out", () => {
  it("is cleared, so the next account in this tab never sees it", async () => {
    timerStore.getState().setRunning(entry("previous-account"));
    await signOut();
    expect(timerStore.getState().running).toBeNull();
  });
});
