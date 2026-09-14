import { initTRPC, TRPCError } from "@trpc/server";
import type { Context } from "./context.js";
import {
  resolveWorkspace,
  workspaceIdFromInput,
} from "../auth/workspace.js";
import { EinvoiceFillRefusedError, EinvoiceNotReadyError } from "../services/einvoice/errors.js";

const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        // The structured refusal of an e-invoice export or fill: which field
        // is missing and where to fix it. null on every other error, so the
        // client reads typed issues and never parses a message.
        einvoiceIssues:
          error.cause instanceof EinvoiceNotReadyError ? [...error.cause.issues] : null,
        // A fill refusal with nothing to list, as a stable code to translate.
        einvoiceFillRefusal:
          error.cause instanceof EinvoiceFillRefusedError ? error.cause.code : null,
      },
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

/**
 * Protected procedure — throws UNAUTHORIZED if no session exists.
 * Narrows the context type so `ctx.session` and `ctx.user` are non-null.
 */
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.session || !ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      ...ctx,
      session: ctx.session,
      user: ctx.user,
    },
  });
});

/**
 * The procedure EVERY domain router must use.
 *
 * Authorization used to be a `{ ownerId }` literal repeated at ~180 query
 * sites — a convention, enforced by nothing, and one that a new router could
 * silently omit. This middleware is the single place a caller is tied to a
 * workspace, and `ctx.workspaceId` / `ctx.visibility` are the only sanctioned
 * way to scope a query.
 *
 * Two deliberate choices:
 *
 *  - An explicit `workspaceId` on the input wins over the session's active
 *    organization (Stage 0, decision 3).
 *  - A workspace the caller is not a member of answers NOT_FOUND, never
 *    FORBIDDEN — the existing rule for cross-owner ids, kept intact. A
 *    FORBIDDEN would confirm the workspace exists.
 */
export const workspaceProcedure = protectedProcedure.use(
  async ({ ctx, next, getRawInput }) => {
    const resolved = await resolveWorkspace({
      user: ctx.user,
      requested: workspaceIdFromInput(await getRawInput()),
      activeWorkspaceId: ctx.activeWorkspaceId,
    });

    if (!resolved) throw new TRPCError({ code: "NOT_FOUND" });

    return next({
      ctx: {
        ...ctx,
        workspaceId: resolved.workspaceId,
        membership: resolved.membership,
        visibility: resolved.visibility,
      },
    });
  },
);
