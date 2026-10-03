// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheScope } from "@/lib/query-persistence";
import { useQueryPersistence } from "./use-query-persistence";

const mock = vi.hoisted(() => ({
  auth: { user: { id: "u1" } as { id: string } | null, isLoading: false },
  origin: { ready: true },
  snapshot: { activeId: "w1" as string | null },
  owner: "u1",
  membership: { data: [{ id: "w1", role: "member", permissions: { money: false } }], isError: false },
  activate: vi.fn(async (_scope: CacheScope) => {}), pause: vi.fn(), forget: vi.fn(async () => {}),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mock.auth }));
vi.mock("@/hooks/use-api-origin", () => ({ useApiOrigin: () => mock.origin }));
vi.mock("@/lib/api-origin", () => ({ getAbsoluteApiOrigin: () => "https://one.test" }));
vi.mock("@/lib/active-workspace", () => ({
  getActiveWorkspaceSnapshot: () => mock.snapshot,
  getServerActiveWorkspaceSnapshot: () => mock.snapshot,
  getKnownWorkspacesOwner: () => mock.owner,
  subscribeActiveWorkspace: () => () => {},
}));
vi.mock("@/lib/app-query-persistence", () => ({ getQueryPersistence: () => ({ activate: mock.activate, pause: mock.pause, forget: mock.forget }) }));
vi.mock("@/lib/trpc", () => ({ trpc: { workspaces: { list: { useQuery: () => mock.membership } } } }));
function Probe() { useQueryPersistence(); return null; }
function mount() {
  const client = new QueryClient();
  const tree = () => <QueryClientProvider client={client}><Probe /></QueryClientProvider>;
  const view = render(tree());
  return { ...view, update: () => view.rerender(tree()) };
}
beforeEach(() => {
  mock.auth = { user: { id: "u1" }, isLoading: false }; mock.origin = { ready: true };
  mock.snapshot = { activeId: "w1" }; mock.owner = "u1";
  mock.membership = { data: [{ id: "w1", role: "member", permissions: { money: false } }], isError: false };
  mock.activate.mockClear(); mock.pause.mockClear(); mock.forget.mockClear();
});
afterEach(cleanup);

describe("persistence access gate", () => {
  it("activates only after session, server and membership resolution", async () => {
    mount();
    await waitFor(() => expect(mock.activate).toHaveBeenCalledWith({ server: "https://one.test", userId: "u1", workspaceId: "w1", access: '["member",[["money",false]]]' }));
  });
  it.each(["session", "loading", "server", "workspace", "membership", "owner", "error"])("does not use disk to bypass missing %s", async (missing) => {
    if (missing === "session") mock.auth.user = null;
    if (missing === "loading") mock.auth.isLoading = true;
    if (missing === "server") mock.origin.ready = false;
    if (missing === "workspace") mock.snapshot.activeId = null;
    if (missing === "membership") mock.membership.data = [];
    if (missing === "owner") mock.owner = "another-account";
    if (missing === "error") mock.membership.isError = true;
    mount(); await waitFor(() => expect(mock.pause.mock.calls.length + mock.forget.mock.calls.length).toBeGreaterThan(0));
    expect(mock.activate).not.toHaveBeenCalled();
  });
  it("changes scope when permissions change", async () => {
    const view = mount(); await waitFor(() => expect(mock.activate).toHaveBeenCalledTimes(1));
    mock.membership = { data: [{ id: "w1", role: "member", permissions: { money: true } }], isError: false };
    view.update(); await waitFor(() => expect(mock.activate).toHaveBeenCalledTimes(2));
    expect(mock.activate.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ access: '["member",[["money",true]]]' }));
  });
  it("pauses when membership is revoked and on shell unmount", async () => {
    const view = mount(); await waitFor(() => expect(mock.activate).toHaveBeenCalledTimes(1));
    mock.membership = { data: [], isError: false }; view.update();
    await waitFor(() => expect(mock.forget).toHaveBeenCalledTimes(1));
    view.unmount(); expect(mock.pause).toHaveBeenCalledTimes(1);
  });
});
