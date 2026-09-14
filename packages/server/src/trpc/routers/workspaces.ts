// Which workspaces a person is in, and which one their session defaults to.
//
// `protectedProcedure`, not `workspaceProcedure`: these answer questions about
// the PERSON across every workspace, before any one of them is chosen — the
// switcher has to list workspaces the request is not addressed to. Neither
// procedure reads or writes anything inside a workspace; `setActive` refuses a
// workspace the caller is not a member of with the same NOT_FOUND an unknown
// id gets.
import {
  setActiveWorkspaceSchema,
  type WorkspaceSummary,
} from "@starter/shared";
import { productionMembershipStore } from "../../services/membership/stores.js";
import {
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
});
