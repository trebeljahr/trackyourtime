// The tRPC surface over the project services. Logic lives in
// `services/catalog/projects.ts`, which the public REST API calls directly.
import {
  createProjectSchema,
  idInputSchema,
  projectBillingImpactSchema,
  projectListSchema,
  updateProjectWithEntriesSchema,
  type Project as ProjectWire,
  type ProjectBillingImpact,
  type ProjectUpdateResult,
} from "@starter/shared";
import { scopeFromContext } from "../../services/scope.js";
import {
  archiveProject,
  createProject,
  listProjects,
  removeProject,
  updateProjectWithEntries,
  type ProjectWithStats,
} from "../../services/catalog/projects.js";
import { projectBillingImpact } from "../../services/catalog/project-entry-billing.js";
import { assertObjectId } from "../../services/catalog/guards.js";
import { workspaceProcedure, router } from "../trpc.js";
import type { CatalogRemoveResult } from "./catalog-cascade.js";
import { archiveInputSchema } from "./clients.js";

/** Re-exported: the client and the sibling routers import it from here. */
export type { ProjectWithStats };

export const projectsRouter = router({
  list: workspaceProcedure
    .input(projectListSchema)
    .query(async ({ ctx, input }): Promise<ProjectWithStats[]> =>
      listProjects(scopeFromContext(ctx), input),
    ),

  create: workspaceProcedure
    .input(createProjectSchema)
    .mutation(async ({ ctx, input }): Promise<ProjectWire> =>
      createProject(scopeFromContext(ctx), input),
    ),

  /**
   * `applyToEntries` also rewrites the billable flag and rate of the caller's
   * un-invoiced entries on the project. REST has no equivalent on purpose —
   * see `updateProjectWithEntriesSchema`.
   */
  update: workspaceProcedure
    .input(updateProjectWithEntriesSchema)
    .mutation(async ({ ctx, input }): Promise<ProjectUpdateResult> =>
      updateProjectWithEntries(scopeFromContext(ctx), input),
    ),

  /** What `update` with `applyToEntries` would reach, for the prompt. */
  billingImpact: workspaceProcedure
    .input(projectBillingImpactSchema)
    .query(async ({ ctx, input }): Promise<ProjectBillingImpact> => {
      assertObjectId(input.id);
      return projectBillingImpact(scopeFromContext(ctx), input.id);
    }),

  archive: workspaceProcedure
    .input(archiveInputSchema)
    .mutation(async ({ ctx, input }): Promise<ProjectWire> =>
      archiveProject(scopeFromContext(ctx), input),
    ),

  /**
   * Always deletes. Tasks go with the project; entries booked on either keep
   * their tracked time and become project-less. Use `archive` to keep the
   * project around instead.
   */
  remove: workspaceProcedure
    .input(idInputSchema)
    .mutation(async ({ ctx, input }): Promise<CatalogRemoveResult> =>
      removeProject(scopeFromContext(ctx), input),
    ),
});
