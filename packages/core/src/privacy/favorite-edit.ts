import { z } from "zod";
import { createFavoriteSchema, idInputSchema, MAX_FAVORITES, projectBillableByDefault, quickStartKey, reorderFavoritesSchema, resolveHourlyRate, type DetailedFavorite, type PrivateKind } from "@starter/shared";
import { privateFavoriteQuery } from "./favorite-view.js";
import { privateViewSource, type PrivateViewOptions } from "./view-source.js";
import type { PlainPrivateRecord } from "./records.js";
const paths = ["favorites.create", "favorites.remove", "favorites.reorder"] as const;
export type PrivateFavoriteEditPath = typeof paths[number];
export const isPrivateFavoriteEdit = (path: string): path is PrivateFavoriteEditPath => (paths as readonly string[]).includes(path);
export const PRIVATE_FAVORITE_EDIT_KINDS: readonly PrivateKind[] = ["favorites", "clients", "projects", "projectMoney", "tasks", "settings", "settingsMoney", "members", "memberMoney"];
const rate = z.number().finite().nonnegative().nullish().transform((value) => value ?? null);
const id = z.string().min(1).max(100);
/** Pure domain plan, called inside the replica transaction. Source records are
 * never modified. Only this person's favorites may enter the resulting edit. */
export function privateFavoriteEdit(options: PrivateViewOptions & { path: PrivateFavoriteEditPath; input: unknown; now?: number; newId?: () => string }) {
  const source = privateViewSource(options), { check, ofKind, value, paired } = source;
  const rows = privateFavoriteQuery({ ...options, input: {} });
  const input = z.record(z.string(), z.unknown()).parse(options.input ?? {});
  if (input.workspaceId !== undefined && input.workspaceId !== options.scope.workspaceId) throw new Error("Private favorite intent belongs to another workspace");
  const { workspaceId: _workspace, ...args } = input; void _workspace;
  const timestamp = new Date(options.now ?? Date.now()).toISOString();
  const byId = new Map(ofKind("favorites").map((row) => [row.id, row]));
  let records: PlainPrivateRecord[] = [], remove: Pick<PlainPrivateRecord, "id" | "kind" | "authorId">[] = [];
  const ordered = (ids: readonly string[]) => ids.flatMap((id, order) => {
    const row = byId.get(id); if (!row) throw new Error("Private favorite is missing");
    return value(row).order === order ? [] : [{ ...row, value: { ...row.value, order, updatedAt: timestamp } }];
  });
  const projectClient = (projectId: string | null) => {
    const row = ofKind("projects").find((row) => row.id === projectId);
    return row ? id.nullish().parse(value(row).clientId) ?? null : null;
  };
  let selected: string | null = null;
  switch (options.path) {
    case "favorites.create": {
      const argsParsed = createFavoriteSchema.strict().parse(args), projectId = argsParsed.projectId ?? null, taskId = argsParsed.taskId ?? null;
      const project = projectId === null ? null : ofKind("projects").find((row) => row.id === projectId);
      if (projectId !== null && !project) throw new Error("Project not found");
      if (taskId !== null && !ofKind("tasks").some((row) => row.id === taskId)) throw new Error("Task not found");
      const clientId = argsParsed.clientId === undefined ? projectClient(projectId) : argsParsed.clientId;
      if (clientId !== null && !ofKind("clients").some((row) => row.id === clientId)) throw new Error("Client not found");
      // Validate referenced payloads even when an explicit billable flag avoids
      // reading rates. A signed id cannot make a foreign payload local.
      for (const row of [...ofKind("tasks").filter((row) => row.id === taskId), ...ofKind("clients").filter((row) => row.id === clientId)]) value(row);
      const projectValue = project ? value(project) : null;
      let billable = argsParsed.billable;
      if (billable === undefined) {
        billable = false;
        if (project && projectValue) {
          const billableDefault = z.boolean().parse(projectValue.billableDefault);
          if (billableDefault) {
            const settings = ofKind("settings"); if (settings.length > 1) throw new Error("Duplicate private workspace settings");
            const defaultRate = settings.length ? rate.parse(paired(settings[0]!, "settingsMoney").defaultHourlyRate) : null;
            const member = ofKind("members").find((row) => row.authorId === options.scope.userId);
            const memberRate = member ? rate.parse(paired(member, "memberMoney").hourlyRate) : null;
            const effective = resolveHourlyRate({ billable: true, projectRate: null, memberRate, defaultRate }) ?? 0;
            billable = projectBillableByDefault({ billableDefault, hourlyRate: rate.parse(paired(project, "projectMoney").hourlyRate) }, effective);
          }
        }
      }
      const description = argsParsed.description.trim(), key = quickStartKey({ description, clientId, projectId, taskId, billable });
      const existing = rows.find((row) => quickStartKey({ description: row.description.trim(), clientId: row.clientId === undefined ? projectClient(row.projectId) : row.clientId, projectId: row.projectId, taskId: row.taskId, billable: row.billable }) === key);
      if (existing) { selected = existing.id; break; }
      if (rows.length >= MAX_FAVORITES) throw new Error("Favorite limit reached");
      const favoriteId = z.uuid().parse((options.newId ?? (() => crypto.randomUUID()))());
      if (byId.has(favoriteId)) throw new Error("New favorite identity already exists");
      records = [...ordered(rows.map((row) => row.id)), { kind: "favorites", id: favoriteId, authorId: options.scope.userId,
        value: { _id: favoriteId, workspaceId: options.scope.workspaceId, userId: options.scope.userId, description, clientId, projectId, taskId, billable, order: rows.length, createdAt: timestamp, updatedAt: timestamp } }];
      selected = favoriteId; break;
    }
    case "favorites.remove": {
      const argsParsed = idInputSchema.strict().parse(args);
      if (!byId.has(argsParsed.id)) throw new Error("Favorite not found");
      remove = [{ kind: "favorites", id: argsParsed.id, authorId: options.scope.userId }];
      records = ordered(rows.filter((row) => row.id !== argsParsed.id).map((row) => row.id));
      selected = argsParsed.id; break;
    }
    case "favorites.reorder": {
      const argsParsed = reorderFavoritesSchema.strict().parse(args), requested = [...new Set(argsParsed.ids.filter((id) => byId.has(id)))];
      const seen = new Set(requested); records = ordered([...requested, ...rows.map((row) => row.id).filter((id) => !seen.has(id))]); break;
    }
    default: throw new Error("Unsupported private favorite operation");
  }
  const changed = new Map(records.map((row) => [row.id, row])), removed = new Set(remove.map((row) => row.id));
  const next = options.records.filter((row) => row.kind !== "favorites" || (!changed.has(row.id) && !removed.has(row.id))).concat(records);
  const resultRows = privateFavoriteQuery({ ...options, records: next, input: {} });
  let result: DetailedFavorite | DetailedFavorite[] | { success: true; id: string };
  if (options.path === "favorites.remove") result = { success: true, id: selected! };
  else if (options.path === "favorites.create") { const row = resultRows.find((row) => row.id === selected); if (!row) throw new Error("Prepared favorite is missing"); result = row; }
  else result = resultRows;
  check(); return { records, remove, result };
}
