import type { QueryClient } from "@tanstack/react-query";

/** Full catalog reads and optimistic edits also refresh their shared metadata. */
export function bindCatalogCaches(client: QueryClient): () => void {
  return client.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success") return;
    const { query } = event;
    const [path, options] = query.queryKey as [string[], { input?: Record<string, unknown>; type?: string }];
    if (!Array.isArray(path) || path.length !== 2 || path[1] !== "list" || !["projects", "clients", "tasks"].includes(path[0])) return;
    if (options?.type !== "query" || options.input?.includeArchived !== true || Object.keys(options.input).length !== 1 || !Array.isArray(query.state.data)) return;
    const data = query.state.data.map(({ entryCount: _count, totalSec: _seconds, progress: _progress, projectIds: _projects, ...row }) => row);
    client.setQueryData([[path[0], "options"], { input: { includeArchived: true }, type: "query" }], data, { updatedAt: query.state.dataUpdatedAt });
  });
}
