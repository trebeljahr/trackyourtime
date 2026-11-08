import { expect, it, vi } from "vitest";

// What the query cache does when the private view epoch moves
// (lib/private-view-lifecycle.ts): a page's first private view re-reads in
// place, so open dialogs keep their state; any other change discards it all.
const lifecycle = vi.hoisted(() => ({ listeners: [] as ((change: "first-view" | "change") => void)[] }));
vi.mock("./private-view-lifecycle", async (original) => ({
  ...(await original<typeof import("./private-view-lifecycle")>()),
  subscribePrivateViewEpoch: (listener: (change: "first-view" | "change") => void) => { lifecycle.listeners.push(listener); return () => undefined; },
}));

it("keeps cached reads on a first private view but marks them for refetch, and clears them on any other change", async () => {
  const { createAppQueryClient } = await import("./query-client");
  const client = createAppQueryClient(), emit = (change: "first-view" | "change") => { for (const listener of lifecycle.listeners) listener(change); };
  client.setQueryData([["workspaces", "list"], { type: "query" }], [{ id: "w", name: "Workspace" }]);
  emit("first-view");
  const query = client.getQueryCache().find({ queryKey: [["workspaces", "list"], { type: "query" }] });
  expect(query?.state.data).toEqual([{ id: "w", name: "Workspace" }]);
  expect(query?.state.isInvalidated).toBe(true);
  emit("change");
  expect(client.getQueryCache().getAll()).toHaveLength(0);
});
