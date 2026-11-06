// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ keys: true, rows: [{ workspaceId: "personal", mode: "standard" }], update: vi.fn(), flush: vi.fn(), close: vi.fn() }));
vi.mock("./private-session", () => ({ privateSession: () => (state.keys ? {} : null) }));
vi.mock("./private-inventory-sync", () => ({
  openPrivateAccountInventorySync: async () => ({
    read: async () => ({ inventory: { signed: { inventory: { workspaces: state.rows } } } }),
    update: state.update, flushOne: state.flush, close: state.close,
  }),
}));
const { reconcileJoinedWorkspaces } = await import("./private-inventory-reconcile");

beforeEach(() => { state.keys = true; state.update.mockReset(); state.flush.mockReset().mockResolvedValue({ pending: 0 }); state.close.mockReset(); });

it("adds a joined workspace as standard, signs it and delivers it", async () => {
  await reconcileJoinedWorkspaces("user", [{ id: "personal" }, { id: "joined-team" }]);
  expect(state.update).toHaveBeenCalledWith([{ workspaceId: "personal", mode: "standard" }, { workspaceId: "joined-team", mode: "standard" }]);
  expect(state.flush).toHaveBeenCalled();
  expect(state.close).toHaveBeenCalledOnce();
});

it("changes nothing for known workspaces, and nothing at all without keys", async () => {
  await reconcileJoinedWorkspaces("user", [{ id: "personal" }]);
  expect(state.update).not.toHaveBeenCalled();
  state.keys = false;
  await reconcileJoinedWorkspaces("user", [{ id: "another" }]);
  expect(state.update).not.toHaveBeenCalled();
  expect(state.close).toHaveBeenCalledOnce();
});
