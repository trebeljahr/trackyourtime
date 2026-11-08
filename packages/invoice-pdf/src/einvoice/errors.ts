// A structured refusal of an e-invoice export or fill.
//
// The server turns these into TRPCErrors (services/einvoice/errors.ts); an
// encrypted workspace's device shows the same issues from them directly.
import type { EinvoiceFillRefusalCode, EinvoiceIssue } from "@starter/shared";

export class EinvoiceNotReadyError extends Error {
  readonly issues: readonly EinvoiceIssue[];

  constructor(issues: readonly EinvoiceIssue[]) {
    super(summarizeEinvoiceIssues(issues));
    this.name = "EinvoiceNotReadyError";
    this.issues = issues;
  }
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

export function summarizeEinvoiceIssues(issues: readonly EinvoiceIssue[]): string {
  const [first] = issues;
  if (!first) return "The invoice is not ready for an e-invoice.";
  return issues.length === 1 ? first.message : `${first.message} (and ${issues.length - 1} more)`;
}
