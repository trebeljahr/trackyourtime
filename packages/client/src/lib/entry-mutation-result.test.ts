// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ workspace: null as string | null, owner: "owner" as string | null, server: "https://api.example.test" }));
vi.mock("@/lib/active-workspace", () => ({ getActiveWorkspaceId: () => state.workspace, getKnownWorkspacesOwner: () => state.owner }));
vi.mock("@/lib/api-origin", () => ({ getAbsoluteApiOrigin: () => state.server }));
vi.mock("@/lib/offline", () => ({ getOfflineQueueOwner: () => null, getOfflineQueueStampOwner: () => null }));
vi.mock("./private-local-result", () => ({ isPrivateLocalResult: () => false }));

const { entryMutationScope, sameEntryMutationScope } = await import("./entry-mutation-result");

beforeEach(() => { state.workspace = null; state.owner = "owner"; state.server = "https://api.example.test"; });

it("keeps a draft opened before the active workspace resolved", () => {
  const scope = entryMutationScope();
  state.workspace = "personal";
  expect(sameEntryMutationScope(scope)).toBe(true);
});

it("still refuses a move between two real workspaces, another owner or another server", () => {
  state.workspace = "first";
  const scope = entryMutationScope();
  state.workspace = "second";
  expect(sameEntryMutationScope(scope)).toBe(false);
  state.workspace = "first"; state.owner = "someone-else";
  expect(sameEntryMutationScope(scope)).toBe(false);
  state.owner = "owner"; state.server = "https://other.example.test";
  expect(sameEntryMutationScope(scope)).toBe(false);
});
