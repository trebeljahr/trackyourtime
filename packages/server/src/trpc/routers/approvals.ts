import { z } from "zod";
import { approvalActionSchema, approvalConfigureSchema, approvalSubmitSchema, approvalWeekSchema, workspaceScopeSchema } from "@starter/shared";
import { router, workspaceProcedure } from "../trpc.js";
import { actOnTimesheet, approvalEntries, approvalPolicy, configureApprovals, ownApprovalWeek, reviewQueue, submitTimesheet, type ApprovalActor } from "../../services/approvals/service.js";
import type { Visibility } from "@starter/shared";
const actorOf = (ctx: { workspaceId: string; user: { id: string }; membership: { role: string }; visibility: Visibility }): ApprovalActor => ({ workspaceId: ctx.workspaceId, userId: ctx.user.id, role: ctx.membership.role, visibility: ctx.visibility });
export const approvalsRouter = router({
  policy: workspaceProcedure.input(workspaceScopeSchema).query(({ ctx }) => approvalPolicy(actorOf(ctx))),
  configure: workspaceProcedure.input(approvalConfigureSchema).mutation(({ ctx, input }) => configureApprovals(actorOf(ctx), { enabled: input.enabled, timeZone: input.timeZone, requireApprovedForInvoices: input.requireApprovedForInvoices })),
  ownWeek: workspaceProcedure.input(approvalWeekSchema).query(({ ctx, input }) => ownApprovalWeek(actorOf(ctx), input.weekStart)),
  submit: workspaceProcedure.input(approvalSubmitSchema).mutation(({ ctx, input }) => submitTimesheet(actorOf(ctx), input)),
  act: workspaceProcedure.input(approvalActionSchema).mutation(({ ctx, input }) => actOnTimesheet(actorOf(ctx), input)),
  reviewQueue: workspaceProcedure.input(z.object({ workspaceId: z.string().min(1).max(64).optional(), page: z.number().int().min(0).max(100000).default(0) })).query(({ ctx, input }) => reviewQueue(actorOf(ctx), input.page)),
  entries: workspaceProcedure.input(z.object({ workspaceId: z.string().min(1).max(64).optional(), id: z.string().regex(/^[a-f0-9]{24}$/i), page: z.number().int().min(0).max(100000).default(0) })).query(({ ctx, input }) => approvalEntries(actorOf(ctx), input.id, input.page)),
});
