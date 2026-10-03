import {
  invoiceCreditSchema,
  invoicePaymentSchema,
  invoiceReminderSchema,
  invoiceBalance,
  idInputSchema,
  type Invoice as InvoiceWire,
  type PdfExportResult,
} from "@starter/shared";
import { workspaceProcedure } from "../trpc.js";
import { requireInvoiceById } from "./invoice-gate.js";
import {
  appendInvoicePayment,
  changeFollowThrough,
  creditInvoice,
  creditIssueDate,
  ensureReplacement,
  invoiceRefusal,
  loadFollowThrough,
} from "../../services/invoice-follow-through.js";
import { Invoice, renderableInvoice } from "../../models/Invoice.js";
import {
  renderInvoicePdf,
  invoicePdfFilename,
} from "../../services/invoice-pdf.js";
import { publishSync } from "../../ws/sync.js";
import { previewInvoiceReminder } from "../../services/scheduler/invoice-reminders.js";

export const invoiceFollowThroughProcedures = {
  recordPayment: workspaceProcedure
    .input(invoicePaymentSchema)
    .mutation(async ({ ctx, input }): Promise<InvoiceWire> => {
      requireInvoiceById(ctx);
      const result = await changeFollowThrough(
        input.id,
        ctx.workspaceId,
        (wire) => appendInvoicePayment(wire, input, ctx.user.id, new Date()),
      );
      void publishSync(
        ctx.workspaceId,
        { kind: "invoice.changed", id: input.id },
        input.originId,
      );
      return result;
    }),
  credit: workspaceProcedure
    .input(invoiceCreditSchema)
    .mutation(async ({ ctx, input }): Promise<InvoiceWire> => {
      requireInvoiceById(ctx);
      const original = await loadFollowThrough(input.id, ctx.workspaceId);
      if (
        await Invoice.exists({
          workspaceId: ctx.workspaceId,
          number: `CN-${original.number}`,
        })
      )
        throw invoiceRefusal("invoice-credit-number-conflict");
      const result = await changeFollowThrough(
        input.id,
        ctx.workspaceId,
        (wire) => creditInvoice(wire, input, ctx.user.id, new Date()),
      );
      await ensureReplacement(
        await loadFollowThrough(input.id, ctx.workspaceId),
      );
      void publishSync(
        ctx.workspaceId,
        { kind: "invoice.changed", id: input.id },
        input.originId,
      );
      return result;
    }),
  setReminders: workspaceProcedure
    .input(invoiceReminderSchema)
    .mutation(async ({ ctx, input }): Promise<InvoiceWire> => {
      requireInvoiceById(ctx);
      const result = await changeFollowThrough(
        input.id,
        ctx.workspaceId,
        (wire) => {
          if (
            input.enabled &&
            (wire.status === "draft" ||
              wire.followThrough?.credit ||
              invoiceBalance(wire).outstandingMinor === 0)
          )
            throw invoiceRefusal("invoice-reminder-ineligible");
          const f = structuredClone(wire.followThrough ?? {});
          // Snapshot recipient, consent, and timezone. Preserve the finite delivery history even after re-enabling.
          f.reminders = {
            enabled: input.enabled,
            recipient: input.recipient,
            timezone: input.timezone,
            consentAt: new Date().toISOString(),
            consentBy: ctx.user.id,
            sentDays: f.reminders?.sentDays ?? [],
            skippedDays: f.reminders?.skippedDays ?? [],
            ...(f.reminders?.lastOutcome
              ? {
                  lastOutcome: f.reminders.lastOutcome,
                  lastAttemptAt: f.reminders.lastAttemptAt,
                }
              : {}),
          };
          return f;
        },
      );
      void publishSync(
        ctx.workspaceId,
        { kind: "invoice.changed", id: input.id },
        input.originId,
      );
      return result;
    }),
  reminderPreview: workspaceProcedure
    .input(invoiceReminderSchema)
    .query(async ({ ctx, input }) => {
      requireInvoiceById(ctx);
      const doc = await loadFollowThrough(input.id, ctx.workspaceId);
      return previewInvoiceReminder(
        renderableInvoice(doc),
        input.recipient,
        input.timezone,
        new Date(),
      );
    }),
  exportCreditXml: workspaceProcedure
    .input(idInputSchema)
    .query(async ({ ctx, input }): Promise<never> => {
      requireInvoiceById(ctx);
      await loadFollowThrough(input.id, ctx.workspaceId);
      throw invoiceRefusal("invoice-credit-xml-unsupported");
    }),
  exportCreditPdf: workspaceProcedure
    .input(idInputSchema)
    .query(async ({ ctx, input }): Promise<PdfExportResult> => {
      requireInvoiceById(ctx);
      const doc = await loadFollowThrough(input.id, ctx.workspaceId);
      const credit = doc.followThrough?.credit;
      if (!credit) throw invoiceRefusal("invoice-no-credit");
      const original = renderableInvoice(doc);
      const invoice = {
        ...original,
        ...credit.snapshot,
        issuer: original.issuer,
        number: credit.number,
        documentKind: "credit" as const,
        creditReference: {
          number: credit.originalNumber,
          reason: credit.reason,
        },
        issueDate: creditIssueDate(credit),
        notes: credit.reason,
        paymentTerms: null,
      };
      const bytes = await renderInvoicePdf(invoice, { generatedAt: credit.at });
      return {
        filename: invoicePdfFilename(credit.number).replace(
          /^invoice-/,
          "credit-",
        ),
        mimeType: "application/pdf",
        base64: bytes.toString("base64"),
      };
    }),
};
