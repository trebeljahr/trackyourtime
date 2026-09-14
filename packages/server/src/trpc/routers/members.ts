// Member management for the caller's workspace.
//
// One line per procedure over `services/membership/members.ts`, which finds
// the target inside `ctx.workspaceId` first (NOT_FOUND otherwise), then applies
// the permission matrix, then writes both membership records. The caller's
// role comes from `ctx.membership` — the `WorkspaceMember` mirror the
// middleware already resolved, the same record every other permission reads.
import {
  memberIdSchema,
  updateRoleSchema,
  updateVisibilitySchema,
  workspaceScopeSchema,
  type WorkspaceMemberRow,
} from "@starter/shared";
import { asRole } from "../../services/membership/records.js";
import {
  leaveWorkspace,
  listMembers,
  removeMember,
  transferOwnership,
  updateMemberRole,
  updateMemberVisibility,
  type WorkspaceActor,
} from "../../services/membership/members.js";
import { membershipDeps } from "../../services/membership/production.js";
import { router, workspaceProcedure } from "../trpc.js";

const actorOf = (ctx: {
  workspaceId: string;
  user: { id: string };
  membership: { role?: unknown };
}): WorkspaceActor => ({
  workspaceId: ctx.workspaceId,
  userId: ctx.user.id,
  role: asRole(ctx.membership.role),
});

export const membersRouter = router({
  list: workspaceProcedure
    .input(workspaceScopeSchema)
    .query(
      async ({ ctx }): Promise<WorkspaceMemberRow[]> =>
        listMembers(await membershipDeps(), actorOf(ctx)),
    ),

  updateRole: workspaceProcedure
    .input(updateRoleSchema)
    .mutation(
      async ({ ctx, input }): Promise<WorkspaceMemberRow> =>
        updateMemberRole(await membershipDeps(), actorOf(ctx), input),
    ),

  updateVisibility: workspaceProcedure
    .input(updateVisibilitySchema)
    .mutation(
      async ({ ctx, input }): Promise<WorkspaceMemberRow> =>
        updateMemberVisibility(await membershipDeps(), actorOf(ctx), input),
    ),

  remove: workspaceProcedure
    .input(memberIdSchema)
    .mutation(
      async ({ ctx, input }): Promise<{ ok: true }> =>
        removeMember(await membershipDeps(), actorOf(ctx), input),
    ),

  leave: workspaceProcedure
    .input(workspaceScopeSchema)
    .mutation(
      async ({ ctx }): Promise<{ nextWorkspaceId: string }> =>
        leaveWorkspace(await membershipDeps(), {
          ...actorOf(ctx),
          user: ctx.user,
          sessionId: ctx.sessionId,
          activeWorkspaceId: ctx.activeWorkspaceId,
        }),
    ),

  transferOwnership: workspaceProcedure
    .input(memberIdSchema)
    .mutation(
      async ({ ctx, input }): Promise<{ ok: true }> =>
        transferOwnership(await membershipDeps(), actorOf(ctx), input),
    ),
});
