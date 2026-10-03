import { transactional } from "../../services/business-transaction.js";
// Cascading deletes for the catalog (Client → Project, and Task alongside).
//
// Deleting a catalog row never deletes tracked time. Entries keep their
// start/end/duration and simply lose the reference — `TimeEntry.projectId`
// and `TimeEntry.taskId` are both nullable precisely so a "project-less"
// entry is a normal, representable state. The same holds one level up: a
// project whose client is deleted keeps its time and becomes client-less.
import { snapshotProjectClients } from "../../services/entries/refs.js";
import type { CatalogRemoveResult } from "@starter/shared";
import { Client } from "../../models/Client.js";
import { Favorite } from "../../models/Favorite.js";
import { Project } from "../../models/Project.js";
import { Task } from "../../models/Task.js";
import { TimeEntry } from "../../models/TimeEntry.js";

/** Re-exported: every catalog router imports the shape from here. */
export type { CatalogRemoveResult };

const EMPTY_RESULT: CatalogRemoveResult = {
  entriesDetached: 0,
  tasksDeleted: 0,
  projectsDetached: 0,
  favoritesDetached: 0,
};

/**
 * Delete a project. Entries pointing at it keep their tracked time and their
 * task, and lose only the project.
 *
 * Tasks are deliberately untouched: they are a workspace-wide catalog, not a
 * project's children, so "Design review" outliving the project it happened on
 * is the correct outcome rather than collateral.
 */
async function cascadeDeleteProjectImpl(
  workspaceId: string,
  projectId: string,
): Promise<CatalogRemoveResult> {
  await snapshotProjectClients(workspaceId, projectId);
  const detached = await TimeEntry.updateMany(
    { workspaceId, projectId },
    { $set: { projectId: null } },
  );

  // Favorites are detached, not deleted, for the same reason entries are: a
  // pin is a statement about work the user does, and losing the project it was
  // filed under is no reason to silently unpin it. It degrades to a
  // project-less pin, which every surface already renders.
  const favorites = await Favorite.updateMany(
    { workspaceId, projectId },
    { $set: { projectId: null } },
  );

  await Project.deleteOne({ _id: projectId, workspaceId });

  return {
    ...EMPTY_RESULT,
    entriesDetached: detached.modifiedCount,
    favoritesDetached: favorites.modifiedCount,
  };
}

/**
 * Delete a task. Entries booked on it keep their project and fall back to
 * "no task".
 */
async function cascadeDeleteTaskImpl(
  workspaceId: string,
  taskId: string,
): Promise<CatalogRemoveResult> {
  const detached = await TimeEntry.updateMany(
    { workspaceId, taskId },
    { $set: { taskId: null } },
  );
  const favorites = await Favorite.updateMany(
    { workspaceId, taskId },
    { $set: { taskId: null } },
  );
  await Task.deleteOne({ _id: taskId, workspaceId });

  return {
    ...EMPTY_RESULT,
    entriesDetached: detached.modifiedCount,
    favoritesDetached: favorites.modifiedCount,
  };
}

/**
 * Delete a client. Its projects survive — they are detached, not deleted, so
 * no tracked time is orphaned by removing a grouping level above it.
 */
async function cascadeDeleteClientImpl(
  workspaceId: string,
  clientId: string,
): Promise<CatalogRemoveResult> {
  const detached = await Project.updateMany(
    { workspaceId, clientId },
    { $set: { clientId: null } },
  );
  await TimeEntry.updateMany(
    { workspaceId, clientId },
    { $set: { clientId: null } },
  );
  await Favorite.updateMany(
    { workspaceId, clientId },
    { $set: { clientId: null } },
  );
  await Client.deleteOne({ _id: clientId, workspaceId });

  return { ...EMPTY_RESULT, projectsDetached: detached.modifiedCount };
}

export const cascadeDeleteProject = transactional(cascadeDeleteProjectImpl);

export const cascadeDeleteTask = transactional(cascadeDeleteTaskImpl);

export const cascadeDeleteClient = transactional(cascadeDeleteClientImpl);
