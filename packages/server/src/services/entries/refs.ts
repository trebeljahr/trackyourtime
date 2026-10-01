import { Client } from "../../models/Client.js";
// Validating the project/task an entry points at.
import { Project, type ProjectDocLike } from "../../models/Project.js";
import { Task } from "../../models/Task.js";
import { notFound, requireObjectId } from "./errors.js";

export type ResolvedRefs = {
  projectId: string | null;
  taskId: string | null;
  project: ProjectDocLike | null;
};

const loadProject = async (
  workspaceId: string,
  projectId: string,
): Promise<ProjectDocLike> => {
  const project = await Project.findOne({
    _id: requireObjectId(projectId, "Project not found"),
    workspaceId,
  }).lean();
  if (!project) throw notFound("Project not found");
  return project;
};

/**
 * Validate that the referenced project and task belong to the caller.
 *
 * The two are independent: a task does not belong to a project, so there is no
 * agreement to check between them and no project to infer from a task. Any
 * combination of the two — both, either, neither — is a legal entry.
 */
export const resolveRefs = async (
  workspaceId: string,
  projectId: string | null,
  taskId: string | null,
): Promise<ResolvedRefs> => {
  const project = projectId ? await loadProject(workspaceId, projectId) : null;

  if (!taskId) return { projectId, taskId: null, project };

  // `exists` rather than a full read: nothing downstream reads the task, and
  // the only question is whether it is one of this workspace's.
  const task = await Task.exists({
    _id: requireObjectId(taskId, "Task not found"),
    workspaceId,
  });
  if (!task) throw notFound("Task not found");

  return { projectId, taskId, project };
};

/** Explicit null clears the client; omission keeps legacy project defaults. */
export async function resolveClientId(
  workspaceId: string,
  clientId: string | null | undefined,
  project: ProjectDocLike | null,
): Promise<string | null> {
  const resolved =
    clientId === undefined ? (project?.clientId ?? null) : clientId;
  if (
    resolved !== null &&
    !(await Client.exists({
      _id: requireObjectId(resolved, "Client not found"),
      workspaceId,
    }))
  ) {
    throw notFound("Client not found");
  }
  return resolved;
}

/** Mongo expression preserves explicit 'no client' while reading old records. */
export const entryClientExpression = {
  $cond: [
    { $eq: [{ $type: "$clientId" }, "missing"] },
    "$project.clientId",
    "$clientId",
  ],
};

export function clientEntryFilter(
  clientIds: readonly string[],
  legacyProjectIds: readonly string[],
): Record<string, unknown> {
  return {
    $or: [
      { clientId: { $in: [...clientIds] } },
      {
        clientId: { $exists: false },
        projectId: { $in: [...legacyProjectIds] },
      },
    ],
  };
}
