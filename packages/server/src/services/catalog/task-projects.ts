// Which projects a task is weakly associated with.
//
// A task still belongs to no project: an entry carries both references side
// by side and any combination is legal. But a task picker that offers every
// task of the workspace whatever project is picked buries the three that go
// with this project under forty that never have. So the pickers ask which
// projects a task has actually been booked on, and suggest those first.
//
// The association is derived, never stored, from two sources:
//
// - time entries carrying both ids, under the caller's roll-up scope — the
//   same `authorScopeFilter` the task totals use, so a member who cannot see
//   colleagues' time does not learn which tasks they book where;
// - the stray `projectId` a task written before tasks became independent may
//   still carry. The strict schema drops it on read, so it is read off the raw
//   collection; it is exactly the project that task was created under.
import type { PipelineStage } from "mongoose";
import type { Visibility } from "@starter/shared/types";
import { rollupVisibility } from "@starter/shared/visibility";
import { Task } from "../../models/Task.js";
import { TimeEntry } from "../../models/TimeEntry.js";
import type { WorkspaceScope } from "../scope.js";
import { scopeRollupMatch } from "./rollup.js";

/** Task id → the ids of the projects it goes with. */
export type TaskProjectLinks = Map<string, Set<string>>;

/** Distinct (task, project) pairs booked in the workspace, as a pipeline. */
export function taskProjectPairsPipeline(
  workspaceId: string,
  visibility: Visibility,
): PipelineStage[] {
  return [
    {
      $match: scopeRollupMatch(
        {
          workspaceId,
          taskId: { $type: "string" },
          projectId: { $type: "string" },
        },
        rollupVisibility(visibility),
      ),
    },
    { $group: { _id: { taskId: "$taskId", projectId: "$projectId" } } },
  ];
}

/** Adds one pair to `links`, ignoring blanks. */
function link(links: TaskProjectLinks, taskId: string, projectId: unknown): void {
  if (typeof projectId !== "string" || projectId === "") return;
  const set = links.get(taskId);
  if (set) set.add(projectId);
  else links.set(taskId, new Set([projectId]));
}

export async function taskProjectLinks(
  scope: WorkspaceScope,
): Promise<TaskProjectLinks> {
  const [pairs, legacy] = await Promise.all([
    TimeEntry.aggregate<{ _id: { taskId: string; projectId: string } }>(
      taskProjectPairsPipeline(scope.workspaceId, scope.visibility),
    ),
    Task.collection
      .find(
        { workspaceId: scope.workspaceId, projectId: { $type: "string" } },
        { projection: { projectId: 1 } },
      )
      .toArray(),
  ]);

  const links: TaskProjectLinks = new Map();
  for (const doc of legacy) link(links, String(doc._id), doc.projectId);
  for (const { _id } of pairs) link(links, _id.taskId, _id.projectId);
  return links;
}

/** Decorates each task with the projects it goes with, sorted for stable output. */
export function withProjectIds<T extends { id: string }>(
  tasks: T[],
  links: TaskProjectLinks,
): (T & { projectIds: string[] })[] {
  return tasks.map((task) => ({
    ...task,
    projectIds: [...(links.get(task.id) ?? [])].sort(),
  }));
}
