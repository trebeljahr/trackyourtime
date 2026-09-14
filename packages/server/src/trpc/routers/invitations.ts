// Invitations: sent and managed inside a workspace, answered from outside it.
//
// Three procedure kinds, each for a reason:
//  - `list`/`create`/`cancel` are `workspaceProcedure` — an owner or admin
//    acting in their own workspace (permission matrix in
//    services/membership/permissions.ts).
//  - `accept`/`decline` are `protectedProcedure` — the invitee is by
//    definition NOT yet a member, so there is no workspace to resolve them
//    into. The invitation id plus the signed-in account's email is the whole
//    authorization; see the header of services/membership/invitations.ts.
//  - `preview` is `publicProcedure` — the invite page has to say whose
//    workspace it is before the person has an account to sign in with. It
//    answers by id only and never lists members or other invitations.
import {
  cancelInvitationSchema,
  invitationIdSchema,
  inviteMemberSchema,
  workspaceScopeSchema,
  type InvitationPreview,
  type InviteResult,
  type PendingInvitation,
} from "@starter/shared";
import {
  acceptInvitation,
  cancelInvitation,
  createInvitation,
  declineInvitation,
  listInvitations,
  previewInvitation,
  type InvitationActor,
} from "../../services/membership/invitations.js";
import { invitationDeps } from "../../services/membership/production.js";
import { asRole } from "../../services/membership/records.js";
import { productionMembershipStore } from "../../services/membership/stores.js";
import {
  protectedProcedure,
  publicProcedure,
  router,
  workspaceProcedure,
} from "../trpc.js";

const actorOf = (ctx: {
  workspaceId: string;
  user: { id: string };
  membership: { role?: unknown };
}): InvitationActor => ({
  workspaceId: ctx.workspaceId,
  userId: ctx.user.id,
  role: asRole(ctx.membership.role),
});

const signedIn = (user: { id: string; email?: string | null; name?: string | null }) => ({
  id: user.id,
  email: user.email ?? "",
  name: user.name ?? null,
});

export const invitationsRouter = router({
  list: workspaceProcedure
    .input(workspaceScopeSchema)
    .query(
      async ({ ctx }): Promise<PendingInvitation[]> =>
        listInvitations(await invitationDeps(), actorOf(ctx)),
    ),

  create: workspaceProcedure
    .input(inviteMemberSchema)
    .mutation(
      async ({ ctx, input }): Promise<InviteResult> =>
        createInvitation(await invitationDeps(), actorOf(ctx), input),
    ),

  cancel: workspaceProcedure
    .input(cancelInvitationSchema)
    .mutation(
      async ({ ctx, input }): Promise<{ ok: true }> =>
        cancelInvitation(await invitationDeps(), actorOf(ctx), input),
    ),

  preview: publicProcedure
    .input(invitationIdSchema)
    .query(
      async ({ input }): Promise<InvitationPreview> =>
        previewInvitation(
          { store: await productionMembershipStore(), now: () => new Date() },
          input,
        ),
    ),

  accept: protectedProcedure
    .input(invitationIdSchema)
    .mutation(
      async ({ ctx, input }): Promise<{ workspaceId: string }> =>
        acceptInvitation(await invitationDeps(), signedIn(ctx.user), {
          id: input.id,
          sessionId: ctx.sessionId,
        }),
    ),

  decline: protectedProcedure
    .input(invitationIdSchema)
    .mutation(
      async ({ ctx, input }): Promise<{ ok: true }> =>
        declineInvitation(await invitationDeps(), signedIn(ctx.user), input),
    ),
});
