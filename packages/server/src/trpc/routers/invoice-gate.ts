// THE INVOICE GATE, in a module of its own so the invoice router and the
// e-invoice procedures ask the same question without importing each other.
import { TRPCError } from "@trpc/server";
import { canUseInvoices, type Visibility, type WorkspaceRole } from "@starter/shared";

/**
 * The refusal for a caller who may not use invoices at all, on the two
 * procedures that do not address an existing invoice. Stable, so the client
 * can explain it rather than printing a server string.
 */
export const INVOICE_PERMISSION_REQUIRED = "invoice-permission-required";

/** What the invoice gate reads off the request, and nothing more. */
export type InvoiceCaller = {
  membership: { role: WorkspaceRole };
  visibility: Visibility;
};

/**
 * Every invoice procedure asks the gate FIRST, before any query.
 *
 * An invoice merges whoever's billable hours fell in its range into one line,
 * so it discloses colleagues' time and money at once — `canUseInvoices` is
 * the rule (owner or admin, with both visibility flags). How a refusal reads
 * depends on what was asked:
 *
 *  - `list` answers an empty page: "no invoices you may see" is true, and a
 *    screen that lists nothing needs no error state.
 *  - Anything addressing an invoice BY ID answers NOT_FOUND, exactly as for an
 *    id that does not exist — the e-invoice check, fill and exports included.
 *    FORBIDDEN there would confirm that the id is a real invoice in this
 *    workspace. The gate runs before the lookup, so the two answers are
 *    indistinguishable in timing as well as shape.
 *  - `preview` and `create` address no existing document, so there is nothing
 *    to hide by pretending: FORBIDDEN with {@link INVOICE_PERMISSION_REQUIRED}.
 *    It is the only honest answer, and gathering first would have read every
 *    colleague's billable entries for somebody who may see none of them.
 *
 * `canUseInvoices` implies the business-profile read rule, so the e-invoice
 * procedures need no second check before reading today's profile.
 */
export function mayUseInvoices(caller: InvoiceCaller): boolean {
  return canUseInvoices(caller.membership.role, caller.visibility);
}

/** NOT_FOUND for a caller the gate refuses, on procedures that address an invoice by id. */
export function requireInvoiceById(caller: InvoiceCaller): void {
  if (!mayUseInvoices(caller)) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
  }
}

/** FORBIDDEN {@link INVOICE_PERMISSION_REQUIRED} for a caller the gate refuses, on preview and create. */
export function requireInvoiceAuthoring(caller: InvoiceCaller): void {
  if (!mayUseInvoices(caller)) {
    throw new TRPCError({ code: "FORBIDDEN", message: INVOICE_PERMISSION_REQUIRED });
  }
}
