// `POST /api/reports/export` — a report's CSV or PDF, written to the response
// as it is produced.
//
// `reports.exportCsv` / `exportPdf` answer in JSON, so the whole file, then
// its JSON (or base64) copy, sit in memory before a byte leaves: 430–590 MB
// above the process's baseline for a 100k-entry detailed export, on a server
// that may be a 1 GB self-host box (52–127 MB here). Here the detailed report is read and
// written a page of entries at a time, and each page waits for the socket to
// drain before the next is read (`sink.ts`), so a slow reader makes the
// server slow down rather than buffer.
//
// The rules a client relies on:
//
//  - **Authorization is the tRPC query path, not a copy of it.** The request
//    becomes a tRPC context (`createRequestContext`) and is authorized by a
//    `workspaceProcedure` called through `createCaller`: the client API-level
//    floor, the session (cookie or bearer), the explicit-`workspaceId`-wins
//    rule and the visibility lookup all run exactly as for `reports.exportPdf`.
//    That procedure is in no router the HTTP adapter mounts.
//  - **Everything that can refuse runs before the headers** (`planReportExport`
//    resolves only once the input, the range and the first query have
//    succeeded), so a refusal is a status and a JSON body:
//    `{ error: { code, message, versionRefusal } }`, `code` being tRPC's.
//    A client can tell this route's 404 from an older server's (which has no
//    such route) by that `code`.
//  - **A failure after the headers cuts the connection.** A truncated file
//    must never look complete, and `fetch` rejects a body that ends without
//    its terminating chunk.
//  - **Two exports per person at a time, per process.** A streamed export
//    holds a database walk open for as long as its reader takes; a third is
//    answered 429 with `Retry-After`.
import type { Express, Request, Response } from "express";
import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { TRPCError } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import * as Sentry from "@sentry/node";
import {
  reportExportSchema,
  type ReportExportInput,
  type VersionRefusal,
} from "@starter/shared";
import { createRequestContext, type Context } from "../../trpc/context.js";
import { router, workspaceProcedure, VersionRefusalError } from "../../trpc/trpc.js";
import { planReportExport } from "../../trpc/routers/reports.js";
import { ExportAbortedError, writableSink } from "./sink.js";

export const REPORT_EXPORT_PATH = "/api/reports/export";

/** Streamed exports one person may have running at once, in this process. */
export const MAX_EXPORTS_PER_USER = 2;

/**
 * The authorization of an export, as a procedure. Never mounted: it is
 * reached only through `createCaller` below, so it is not part of the tRPC
 * contract and cannot be called over `/api/trpc`.
 */
const exportAuthorization = router({
  authorize: workspaceProcedure.input(reportExportSchema).query(({ ctx, input }) => ({
    scope: { workspaceId: ctx.workspaceId, visibility: ctx.visibility },
    userId: ctx.user.id,
    input,
  })),
});

type ExportErrorBody = {
  error: { code: string; message: string; versionRefusal: VersionRefusal | null };
};

const errorBody = (error: TRPCError): ExportErrorBody => ({
  error: {
    code: error.code,
    // The fixed string tRPC's own formatter would send for a 500: a server
    // never names its internals to the client.
    message:
      error.code === "INTERNAL_SERVER_ERROR" ? "Internal server error" : error.message,
    versionRefusal:
      error.cause instanceof VersionRefusalError ? error.cause.refusal : null,
  },
});

const asTrpcError = (error: unknown): TRPCError =>
  error instanceof TRPCError
    ? error
    : new TRPCError({ code: "INTERNAL_SERVER_ERROR", cause: error });

const report = (error: unknown): void => {
  Sentry.captureException(error);
  console.error("[report-export]", error);
};

/**
 * `attachment; filename="…"`. The name comes from `csvFilename`, which keeps
 * only `[0-9A-Za-z-_.]`, so it needs no quoting beyond the quotes.
 */
const attachment = (filename: string): string =>
  `attachment; filename="${filename.replace(/[^0-9A-Za-z._-]/g, "-")}"`;

/** What the handler needs from the rest of the server — swapped in the tests. */
export type ReportExportDeps = {
  /** The tRPC context for this request, as `createContext` builds it. */
  context: (req: Request, res: Response) => Promise<Context>;
  plan: typeof planReportExport;
};

const defaultDeps: ReportExportDeps = {
  context: (req, res) =>
    createRequestContext(
      req as unknown as CreateExpressContextOptions["req"],
      res as unknown as CreateExpressContextOptions["res"],
      "query",
    ),
  plan: planReportExport,
};

/** The handler. Each one keeps its own count of exports in flight. */
export function reportExportHandler(
  deps: ReportExportDeps = defaultDeps,
): (req: Request, res: Response) => Promise<void> {
  const running = new Map<string, number>();

  return async (req, res) => {
    // A write after the client went away must not become an unhandled "error".
    res.on("error", () => undefined);

    let exporter: string | null = null;
    try {
      const ctx = await deps.context(req, res);
      // Unchecked here on purpose: the procedure's own schema validates it,
      // and a body that fails is answered 400 like any tRPC input.
      const body = req.body as ReportExportInput;
      const authorized = await exportAuthorization.createCaller(ctx).authorize(body);

      const active = running.get(authorized.userId) ?? 0;
      if (active >= MAX_EXPORTS_PER_USER) {
        res.setHeader("Retry-After", "5");
        res.status(429).json({
          error: {
            code: "TOO_MANY_REQUESTS",
            message: "Another export is still running. Try again when it has finished.",
            versionRefusal: null,
          },
        } satisfies ExportErrorBody);
        return;
      }
      const { userId } = authorized;
      exporter = userId;
      running.set(userId, active + 1);

      const plan = await deps.plan(authorized.scope, authorized.input, userId);

      res.status(200);
      res.setHeader("Content-Type", plan.contentType);
      res.setHeader("Content-Disposition", attachment(plan.filename));
      res.setHeader("Cache-Control", "no-store");
      await plan.write(writableSink(res));
      res.end();
    } catch (caught) {
      if (res.headersSent) {
        // Mid-file. The reader leaving is not an error; anything else is.
        if (!(caught instanceof ExportAbortedError)) report(caught);
        res.destroy();
        return;
      }
      const error = asTrpcError(caught);
      if (error.code === "INTERNAL_SERVER_ERROR") report(caught);
      res.status(getHTTPStatusCodeFromError(error)).json(errorBody(error));
    } finally {
      if (exporter !== null) {
        const left = (running.get(exporter) ?? 1) - 1;
        if (left > 0) running.set(exporter, left);
        else running.delete(exporter);
      }
    }
  };
}

export function registerReportExportRoutes(app: Express): void {
  const handle = reportExportHandler();
  app.post(REPORT_EXPORT_PATH, (req, res) => {
    void handle(req, res);
  });
}
