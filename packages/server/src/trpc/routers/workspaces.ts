// Which workspaces a person is in, and which one their session defaults to.
//
// `protectedProcedure`, not `workspaceProcedure`: these answer questions about
// the PERSON across every workspace, before any one of them is chosen — the
// switcher has to list workspaces the request is not addressed to. Neither
// procedure reads or writes anything inside a workspace; `setActive` refuses a
// workspace the caller is not a member of with the same NOT_FOUND an unknown
// id gets.
import {
  createWorkspaceSchema,
  setActiveWorkspaceSchema,
  type WorkspaceSummary,
} from "@starter/shared";
import { workspaceCreationDeps } from "../../services/membership/production.js";
import { productionMembershipStore } from "../../services/membership/stores.js";
import {
  createTeamWorkspace,
  listWorkspaces,
  setActiveWorkspace,
} from "../../services/membership/workspaces.js";
import { protectedProcedure, router } from "../trpc.js";

export const workspacesRouter = router({
  list: protectedProcedure.query(
    async ({ ctx }): Promise<WorkspaceSummary[]> =>
      listWorkspaces(await productionMembershipStore(), {
        userId: ctx.user.id,
        activeWorkspaceId: ctx.activeWorkspaceId,
      }),
  ),

  setActive: protectedProcedure
    .input(setActiveWorkspaceSchema)
    .mutation(
      async ({ ctx, input }): Promise<{ workspaceId: string }> =>
        setActiveWorkspace(await productionMembershipStore(), {
          userId: ctx.user.id,
          sessionId: ctx.sessionId,
          workspaceId: input.workspaceId,
        }),
    ),

  /**
   * A new team workspace, owned by the caller. Not a `workspaceProcedure`:
   * it is addressed to no existing workspace.
   */
  create: protectedProcedure
    .input(createWorkspaceSchema)
    .mutation(
      async ({ ctx, input }): Promise<{ workspaceId: string }> =>
        createTeamWorkspace(await workspaceCreationDeps(), ctx.user, input),
    ),
});
