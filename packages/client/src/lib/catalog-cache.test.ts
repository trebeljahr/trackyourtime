import { QueryClient } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { bindCatalogCaches } from "./catalog-cache";

const key = (procedure: string, input: object = { includeArchived: true }) => [["projects", procedure], { input, type: "query" }] as const;

it("reuses full catalog reads and optimistic edits in metadata, preserving list statistics", async () => {
  const client = new QueryClient();
  const dispose = bindCatalogCaches(client);
  const row = { id: "p1", name: "One", archived: false, totalSec: 50, entryCount: 2, progress: null };
  await client.fetchQuery({ queryKey: key("list"), queryFn: async () => [row] });
  expect(client.getQueryData(key("options"))).toEqual([{ id: "p1", name: "One", archived: false }]);
  client.setQueryData(key("list"), [{ ...row, name: "Renamed" }]);
  expect(client.getQueryData(key("options"))).toEqual([{ id: "p1", name: "Renamed", archived: false }]);
  expect(client.getQueryData(key("list"))).toEqual([{ ...row, name: "Renamed" }]);
  dispose(); client.clear();
});

it("filtered and explicitly scoped reads cannot seed the shared metadata cache", () => {
  const client = new QueryClient();
  const dispose = bindCatalogCaches(client);
  for (const input of [{}, { clientId: "c1" }, { includeArchived: true, workspaceId: "another" }]) {
    client.setQueryData(key("list", input), [{ id: "p1", name: "Filtered" }]);
  }
  expect(client.getQueryData(key("options"))).toBeUndefined();
  dispose(); client.clear();
});
