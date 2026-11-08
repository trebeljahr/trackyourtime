/**
 * Invoice and e-invoice refusals from an encrypted workspace's device, in the
 * shape the screens already read from a standard workspace's server: the tRPC
 * code (`errorCode`), the e-invoice issues and the fill refusal code
 * (`einvoiceIssuesFromError`, `einvoiceFillRefusalFromError`), carried on the
 * PrivateContentUnavailableError the tRPC client wraps as its cause.
 */
import { PrivateInvoiceRefusal, PRIVATE_INVOICE_PERMISSION_REQUIRED } from "@starter/core";
import { EinvoiceFillRefusedError, EinvoiceNotReadyError } from "@starter/invoice-pdf/einvoice/errors";
import { PrivateContentUnavailableError } from "./private-content-error";

export function privateInvoiceRefusal(error: unknown): PrivateContentUnavailableError | null {
  if (error instanceof PrivateInvoiceRefusal) return new PrivateContentUnavailableError(error.message, error.code);
  if (error instanceof EinvoiceNotReadyError) return new PrivateContentUnavailableError(error.message, "PRECONDITION_FAILED", { einvoiceIssues: [...error.issues] });
  if (error instanceof EinvoiceFillRefusedError) return new PrivateContentUnavailableError(error.message, "BAD_REQUEST", { einvoiceFillRefusal: error.code });
  if (error instanceof Error && error.message === PRIVATE_INVOICE_PERMISSION_REQUIRED) return new PrivateContentUnavailableError(error.message);
  return null;
}
