// Tasks are a flat, workspace-wide catalog — an entry carries a task and a
// project side by side, and the task belongs to neither the project nor the
// client above it. `list` rolls up tracked seconds per task in one aggregation
// so the Tasks screen never fires a query per row.
import { TRPCError } from "@trpc/server";
import mongoose from "mongoose";
import {
  type CreateTaskInput,
  pickCatalogColor,
  projectRemoveResult,
  rollupVisibility,
  TASK_COLOR_OFFSET,
  type Task as TaskWire,
  type TaskListInput,
  type UpdateTaskInput,
} from "@starter/shared";
import { Task, toClientTask, type TaskDocLike } from "../../models/Task.js";
import { publishSync } from "../../ws/sync.js";
import type { CatalogRemoveResult } from "../../trpc/routers/catalog-cascade.js";
import { cascadeDeleteTask } from "../../trpc/routers/catalog-cascade.js";
import type { WorkspaceScope } from "../scope.js";
import { assertObjectId, findOwnedTask } from "./guards.js";
import { assertUniqueCatalogName } from "./names.js";
import { ownCascadeCollateral } from "./projects.js";
import { catalogEntryRollup } from "./rollup.js";

/** A task plus its rolled-up tracked time. */
export type TaskWithStats = TaskWire & {
  /** Number of entries booked on this task, under the same scope as `totalSec`. */
  entryCount: number;
  /**
   * Sum of `durationSec` across entries booked on this task, counted under
   * the CALLER's roll-up scope — their own entries only unless they may see
   * BOTH others' time and others' money (`rollupVisibility`). A whole-workspace
   * sum here is a colleague's hours, arrived at by the one route that never
   * asks who is looking — and priced against a project's `hourlyRate`, it is a
   * colleague's earnings too.
   */
  totalSec: number;
};

/** Raw shape produced by the `list` aggregation. */
type TaskAggregateRow = TaskDocLike & {
  stats: { entryCount: number; totalSec: number }[];
};

const notFound = (): TRPCError =>
  new TRPCError({ code: "NOT_FOUND", message: "Task not found" });

/**
 * Task names are unique per WORKSPACE. They used to be unique per project,
 * which stopped meaning anything once a task stopped belonging to one.
 */
const assertUniqueTaskName = (
  workspaceId: string,
  name: string,
  excludeId?: string,
): Promise<void> =>
  assertUniqueCatalogName({
    model: Task,
    filter: { workspaceId },
    name,
    ...(excludeId ? { excludeId } : {}),
    label: "task",
    message: (trimmed) => `A task named "${trimmed}" already exists.`,
  });

/**
 * The one pipeline behind both `list` and `get`, so the two cannot disagree
 * about what `totalSec` means.
 */
async function aggregateTasks(
  scope: WorkspaceScope,
  match: Record<string, unknown>,
): Promise<TaskWithStats[]> {
  const workspaceId = scope.workspaceId;
  const rows = await Task.aggregate<TaskAggregateRow>([
    { $match: { workspaceId, ...match } },
    // Author-scoped: see the note on `totalSec` above. Shared with the
    // projects roll-up, and narrowed through `rollupVisibility` for the same
    // reason it is there.
    catalogEntryRollup({
      workspaceId,
      visibility: rollupVisibility(scope.visibility),
      entryField: "taskId",
      as: "stats",
    }),
    { $addFields: { sortName: { $toLower: "$name" } } },
    { $sort: { sortName: 1 } },
  ]);

  return rows.map((row) => ({
    ...toClientTask(row),
    entryCount: row.stats[0]?.entryCount ?? 0,
    totalSec: row.stats[0]?.totalSec ?? 0,
  }));
}

export async function listTasks(
  scope: WorkspaceScope,
  input: TaskListInput,
): Promise<TaskWithStats[]> {
  return aggregateTasks(scope, {
    ...(input.includeArchived ? {} : { archived: false }),
  });
}

export async function getTask(
  scope: WorkspaceScope,
  id: string,
): Promise<TaskWithStats> {
  assertObjectId(id);
  const [found] = await aggregateTasks(scope, {
    _id: new mongoose.Types.ObjectId(id),
  });
  if (!found) throw notFound();
  return found;
}

export async function createTask(
  scope: WorkspaceScope,
  input: CreateTaskInput,
): Promise<TaskWire> {
  const name = input.name.trim();
  await assertUniqueTaskName(scope.workspaceId, name);

  // Same rule as projects and tags: a create that names no color gets the
  // next palette entry, so a list of tasks is told apart at a glance.
  const existing = await Task.countDocuments({ workspaceId: scope.workspaceId });

  const created = await Task.create({
    workspaceId: scope.workspaceId,
    createdBy: scope.userId,
    name,
    color: input.color ?? pickCatalogColor(existing, TASK_COLOR_OFFSET),
    archived: false,
  });

  void publishSync(
    scope.workspaceId,
    { kind: "catalog.changed", scope: "task" },
    input.originId,
  );
  return toClientTask(created);
}

export async function updateTask(
  scope: WorkspaceScope,
  input: UpdateTaskInput,
): Promise<TaskWire> {
  await findOwnedTask(scope.workspaceId, input.id);
  if (input.name !== undefined) {
    await assertUniqueTaskName(scope.workspaceId, input.name, input.id);
  }

  const updated = await Task.findOneAndUpdate(
    { _id: input.id, workspaceId: scope.workspaceId },
    {
      $set: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.archived !== undefined ? { archived: input.archived } : {}),
      },
    },
    { returnDocument: "after" },
  ).lean();

  if (!updated) throw notFound();

  void publishSync(
    scope.workspaceId,
    { kind: "catalog.changed", scope: "task" },
    input.originId,
  );
  return toClientTask(updated);
}

export async function archiveTask(
  scope: WorkspaceScope,
  input: { id: string; archived?: boolean; originId?: string },
): Promise<TaskWire> {
  assertObjectId(input.id);

  const updated = await Task.findOneAndUpdate(
    { _id: input.id, workspaceId: scope.workspaceId },
    { $set: { archived: input.archived ?? true } },
    { returnDocument: "after" },
  ).lean();

  if (!updated) throw notFound();

  void publishSync(
    scope.workspaceId,
    { kind: "catalog.changed", scope: "task" },
    input.originId,
  );
  return toClientTask(updated);
}

/**
 * Always deletes. Entries booked on the task keep their tracked time and
 * their project, and simply fall back to "no task".
 */
export async function removeTask(
  scope: WorkspaceScope,
  input: { id: string; originId?: string },
): Promise<CatalogRemoveResult> {
  await findOwnedTask(scope.workspaceId, input.id);

  // Counted before the cascade, and reported instead of the workspace's
  // numbers to a caller who may not see others' work — same rule as
  // `removeProject`, and the same reason: `DELETE` must not hand back the
  // entry count the task's own roll-up withholds.
  const own = await ownCascadeCollateral(scope, { taskId: input.id });
  const result = await cascadeDeleteTask(scope.workspaceId, input.id);

  void publishSync(
    scope.workspaceId,
    {
      kind: "catalog.changed",
      scope: "task",
      entriesTouched: result.entriesDetached > 0,
    },
    input.originId,
  );
  // A detached pin still points somewhere it did not a moment ago, and
  // `catalog.changed` does not cover the favorites cache.
  //
  // FIXED IN THE MOVE: this used to pass the caller's USER id where
  // `publishSync` wants a workspace id, so it resolved to no members and the
  // event reached nobody — a pin silently went stale on every other device.
  // Mirrors `removeProject` now.
  if (result.favoritesDetached > 0) {
    void publishSync(
      scope.workspaceId,
      { kind: "favorites.changed" },
      input.originId,
    );
  }
  // The sync events above read the cascade's whole-workspace counts on
  // purpose — they decide whose caches are stale. Only the response narrows.
  return projectRemoveResult(result, own);
}
