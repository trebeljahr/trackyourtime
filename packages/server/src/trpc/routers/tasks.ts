// The tRPC surface over the task services. Logic lives in
// `services/catalog/tasks.ts`, which the public REST API calls directly.
import {
  createTaskSchema,
  idInputSchema,
  taskListSchema,
  updateTaskSchema,
  type Task as TaskWire,
} from "@starter/shared";
import { scopeFromContext } from "../../services/scope.js";
import {
  archiveTask,
  createTask,
  listTasks,
  removeTask,
  updateTask,
  type TaskWithStats,
} from "../../services/catalog/tasks.js";
import {
  taskProjectLinks,
  withProjectIds,
} from "../../services/catalog/task-projects.js";
import { workspaceProcedure, router } from "../trpc.js";
import type { CatalogRemoveResult } from "./catalog-cascade.js";
import { archiveInputSchema } from "./clients.js";

/** Re-exported: the client imports it from here. */
export type { TaskWithStats };

/**
 * A task plus the projects it has been booked on, which the pickers use to
 * suggest a project's own tasks first. tRPC only: REST's task shape stays
 * `TaskWithStats`, and the association is a hint for a picker, not data.
 */
export type TaskWithProjects = TaskWithStats & { projectIds: string[] };

export const tasksRouter = router({
  list: workspaceProcedure
    .input(taskListSchema)
    .query(async ({ ctx, input }): Promise<TaskWithProjects[]> => {
      const scope = scopeFromContext(ctx);
      const [tasks, links] = await Promise.all([
        listTasks(scope, input),
        taskProjectLinks(scope),
      ]);
      return withProjectIds(tasks, links);
    }),

  create: workspaceProcedure
    .input(createTaskSchema)
    .mutation(async ({ ctx, input }): Promise<TaskWire> =>
      createTask(scopeFromContext(ctx), input),
    ),

  update: workspaceProcedure
    .input(updateTaskSchema)
    .mutation(async ({ ctx, input }): Promise<TaskWire> =>
      updateTask(scopeFromContext(ctx), input),
    ),

  archive: workspaceProcedure
    .input(archiveInputSchema)
    .mutation(async ({ ctx, input }): Promise<TaskWire> =>
      archiveTask(scopeFromContext(ctx), input),
    ),

  /**
   * Always deletes. Entries booked on the task keep their tracked time and
   * their project, and simply fall back to "no task".
   */
  remove: workspaceProcedure
    .input(idInputSchema)
    .mutation(async ({ ctx, input }): Promise<CatalogRemoveResult> =>
      removeTask(scopeFromContext(ctx), input),
    ),
});
