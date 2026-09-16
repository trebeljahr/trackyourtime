import { initTRPC, TRPCError } from "@trpc/server";
import type { Context } from "./context.js";
import {
  resolveWorkspace,
  workspaceIdFromInput,
} from "../auth/workspace.js";
import { EinvoiceFillRefusedError, EinvoiceNotReadyError } from "../services/einvoice/errors.js";
import { CLIENT_TOO_OLD_MESSAGE, versionRefusalFor } from "../auth/client-version.js";
import type { VersionRefusal } from "@starter/shared";

/**
 * Carried as a `TRPCError`'s cause so the formatter below can put the refusal
 * code on the wire as `data.versionRefusal`.
 */
export class VersionRefusalError extends Error {
  readonly refusal: VersionRefusal;

  constructor(refusal: VersionRefusal) {
    super(CLIENT_TOO_OLD_MESSAGE);
    this.name = "VersionRefusalError";
    this.refusal = refusal;
  }
}

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
        // `CLIENT_TOO_OLD` when the request declared an API level below this
        // server's floor, null on every other error. A stable code, so every
        // client can say "update the app" without reading the message.
        versionRefusal:
          error.cause instanceof VersionRefusalError ? error.cause.refusal : null,
      },
    };
  },
});

export const router = t.router;

/**
 * The client API-level floor, on every procedure but `health.*`.
 *
 * `health.check` stays answerable to any client so a refused one can still
 * learn the server's level and say which side needs updating. A request that
 * declares no level is a pre-handshake client and passes (see
 * `versionRefusalFor`).
 *
 * PRECONDITION_FAILED (412), deliberately: the offline queue drops a row on a
 * permanent status (400/403/404/409/410/422), and version skew must never
 * delete somebody's queued time. A 412 keeps the row for the build that can
 * send it.
 */
const versionFloor = t.middleware(({ ctx, path, next }) => {
  if (!path.startsWith("health.")) {
    const refusal = versionRefusalFor(ctx.req?.headers);
    if (refusal !== null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: CLIENT_TOO_OLD_MESSAGE,
        cause: new VersionRefusalError(refusal),
      });
    }
  }
  return next();
});

export const publicProcedure = t.procedure.use(versionFloor);

/**
 * Protected procedure — throws UNAUTHORIZED if no session exists.
 * Narrows the context type so `ctx.session` and `ctx.user` are non-null.
 */
export const protectedProcedure = publicProcedure.use(async ({ ctx, next }) => {
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
