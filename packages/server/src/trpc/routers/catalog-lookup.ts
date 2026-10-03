import { businessReads } from "../../services/business-transaction.js";
// Loading just enough catalog to label a handful of quick starts.
//
// This is deliberately not the `$lookup` pipeline `entries.list` uses. That
// one joins a page of fifty entries and is worth the aggregation; favorites
// and recents resolve a dozen ids at most, and three `$in` reads are both
// cheaper to run and far cheaper to read than a five-stage pipeline whose only
// job is to attach a name.
import mongoose from "mongoose";
import { Client } from "../../models/Client.js";
import { Project } from "../../models/Project.js";
import { Task } from "../../models/Task.js";
import {
  emptyCatalog,
  type CatalogLookup,
  type CatalogProject,
  type CatalogTask,
  type QuickStartRefs,
} from "./quick-start.js";

/**
 * Ids arrive from documents rather than from the wire, but a row written
 * before a schema change — or restored from a backup — can still carry
 * something Mongo will refuse to cast. Dropping those here turns a 500 into a
 * `projectMissing` flag, which is exactly what the client already renders.
 */
const objectIds = (ids: Iterable<string>): string[] =>
  [...ids].filter((id) => mongoose.isValidObjectId(id));

/**
 * Resolve every project, task and client referenced by `refs`.
 *
 * Archived rows are included on purpose: a favorite pointing at an archived
 * project should read "Acme (archived)", not "Project deleted". Only rows this
 * owner does not have at all come back missing.
 */
export async function loadCatalogLookup(
  workspaceId: string,
  refs: readonly QuickStartRefs[],
): Promise<CatalogLookup> {
  const clientIds = new Set<string>();
  const projectIds = new Set<string>();
  const taskIds = new Set<string>();
  for (const ref of refs) {
    if (ref.clientId) clientIds.add(ref.clientId);
    if (ref.projectId !== null) projectIds.add(ref.projectId);
    if (ref.taskId !== null) taskIds.add(ref.taskId);
  }
  if (projectIds.size === 0 && taskIds.size === 0 && clientIds.size === 0) return emptyCatalog();

  const [projectDocs, taskDocs] = await businessReads([
    () => (
    projectIds.size === 0
      ? []
      : Project.find({ workspaceId, _id: { $in: objectIds(projectIds) } })
          .select({ name: 1, color: 1, clientId: 1, archived: 1 })
          .lean()
    ),
    () => (
    taskIds.size === 0
      ? []
      : Task.find({ workspaceId, _id: { $in: objectIds(taskIds) } })
          .select({ name: 1 })
          .lean()
    )
  ]);

  const projects = new Map<string, CatalogProject>(
    projectDocs.map((project) => [
      String(project._id),
      {
        name: project.name,
        color: project.color,
        clientId: project.clientId ?? null,
        archived: project.archived,
      },
    ]),
  );

  const tasks = new Map<string, CatalogTask>(
    taskDocs.map((task) => [
      String(task._id),
      { name: task.name },
    ]),
  );

  // Include legacy defaults alongside independent entry clients.
  for (const project of projects.values()) {
    if (project.clientId !== null) clientIds.add(project.clientId);
  }

  const clientDocs =
    clientIds.size === 0
      ? []
      : await Client.find({ workspaceId, _id: { $in: objectIds(clientIds) } })
          .select({ name: 1 })
          .lean();

  return {
    projects,
    tasks,
    clients: new Map(
      clientDocs.map((client) => [String(client._id), client.name]),
    ),
  };
}
