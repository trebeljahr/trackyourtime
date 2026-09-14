// A structured refusal of an e-invoice export or fill.
//
// The issues travel as the TRPCError's `cause`; the errorFormatter in
// trpc/trpc.ts copies them to `error.data.einvoiceIssues`, so the client reads
// typed issues and never parses a message.
import { TRPCError } from "@trpc/server";
import type { EinvoiceFillRefusalCode, EinvoiceIssue } from "@starter/shared";

export class EinvoiceNotReadyError extends Error {
  readonly issues: readonly EinvoiceIssue[];

  constructor(issues: readonly EinvoiceIssue[]) {
    super(summarize(issues));
    this.name = "EinvoiceNotReadyError";
    this.issues = issues;
  }
}

/** PRECONDITION_FAILED; message = first issue plus "(and N more)"; cause carries every issue. */
export function einvoiceNotReady(issues: readonly EinvoiceIssue[]): TRPCError {
  return new TRPCError({
    code: "PRECONDITION_FAILED",
    message: summarize(issues),
    cause: new EinvoiceNotReadyError(issues),
  });
}

/** A fill refusal that has no issues to list: a stable code the client translates. */
export class EinvoiceFillRefusedError extends Error {
  readonly code: EinvoiceFillRefusalCode;

  constructor(code: EinvoiceFillRefusalCode, message: string) {
    super(message);
    this.name = "EinvoiceFillRefusedError";
    this.code = code;
  }
}

/** BAD_REQUEST; the formatter copies `code` to `error.data.einvoiceFillRefusal`. */
export function einvoiceFillRefused(code: EinvoiceFillRefusalCode, message: string): TRPCError {
  return new TRPCError({ code: "BAD_REQUEST", message, cause: new EinvoiceFillRefusedError(code, message) });
}

/** Router boundary: an EinvoiceNotReadyError becomes einvoiceNotReady(issues); anything else is returned unchanged. */
export function toEinvoiceTrpcError(error: unknown): unknown {
  return error instanceof EinvoiceNotReadyError ? einvoiceNotReady(error.issues) : error;
}

function summarize(issues: readonly EinvoiceIssue[]): string {
  const [first] = issues;
  if (!first) return "The invoice is not ready for an e-invoice.";
  return issues.length === 1 ? first.message : `${first.message} (and ${issues.length - 1} more)`;
}
