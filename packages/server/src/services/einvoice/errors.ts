// A structured refusal of an e-invoice export or fill.
//
// The error classes live in `@starter/invoice-pdf/einvoice/errors`, shared with
// an encrypted workspace's device. Here they become TRPCErrors: the issues
// travel as the `cause`, and the errorFormatter in trpc/trpc.ts copies them to
// `error.data.einvoiceIssues`, so the client reads typed issues and never
// parses a message.
import { TRPCError } from "@trpc/server";
import type { EinvoiceFillRefusalCode, EinvoiceIssue } from "@starter/shared";
import { EinvoiceFillRefusedError, EinvoiceNotReadyError, summarizeEinvoiceIssues } from "@starter/invoice-pdf/einvoice/errors";

export { EinvoiceFillRefusedError, EinvoiceNotReadyError };

/** PRECONDITION_FAILED; message = first issue plus "(and N more)"; cause carries every issue. */
export function einvoiceNotReady(issues: readonly EinvoiceIssue[]): TRPCError {
  return new TRPCError({
    code: "PRECONDITION_FAILED",
    message: summarizeEinvoiceIssues(issues),
    cause: new EinvoiceNotReadyError(issues),
  });
}

/** BAD_REQUEST; the formatter copies `code` to `error.data.einvoiceFillRefusal`. */
export function einvoiceFillRefused(code: EinvoiceFillRefusalCode, message: string): TRPCError {
  return new TRPCError({ code: "BAD_REQUEST", message, cause: new EinvoiceFillRefusedError(code, message) });
}

/** Router boundary: an EinvoiceNotReadyError becomes einvoiceNotReady(issues); anything else is returned unchanged. */
export function toEinvoiceTrpcError(error: unknown): unknown {
  return error instanceof EinvoiceNotReadyError ? einvoiceNotReady(error.issues) : error;
}
