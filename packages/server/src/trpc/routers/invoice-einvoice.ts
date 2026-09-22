// The e-invoice procedures of the invoices router: check, fill, and the two
// exports (ZUGFeRD PDF, XRechnung XML). Spread into `invoicesRouter`, so the
// client paths are `trpc.invoices.einvoiceCheck` and siblings.
//
// Three rules hold everything here together:
//
//  - The invoice gate first, before any query. Every procedure addresses an
//    invoice by id, so a refused caller reads NOT_FOUND, exactly like an id
//    that does not exist.
//  - A refusal is structured. `einvoiceNotReady` carries the issues as the
//    TRPCError's cause, and the errorFormatter lifts them into
//    `error.data.einvoiceIssues` — each naming its field and where to fix it.
//  - The amounts on an invoice never change. The fill writes only absent or
//    null snapshot values, and only when the EN 16931 totals of the frozen
//    lines equal the stored ones to the cent; the first export of a non-draft
//    invoice stores its XML once and every later export serves those bytes.
//  - An issued XML makes the snapshot final. Once either profile has one, the
//    fill is refused: the ZUGFeRD page is drawn from the snapshot around the
//    stored XML, and the two must never disagree.
import { TRPCError } from "@trpc/server";
import {
  attachEinvoiceDataSchema,
  einvoiceCheckSchema,
  einvoiceExportSchema,
  type EinvoiceCheckResult,
  type EinvoiceExportResult,
  type EinvoiceProfile,
  type Invoice as InvoiceWire,
} from "@starter/shared";
import mongoose from "mongoose";
import {
  Invoice,
  renderableInvoice,
  toClientInvoice,
  type InvoiceDocLike,
} from "../../models/Invoice.js";
import { buildCiiXml, xrechnungFilename } from "../../services/einvoice/cii.js";
import { EINVOICE_GENERATOR } from "../../services/einvoice/constants.js";
import {
  einvoiceFillRefused,
  einvoiceNotReady,
  toEinvoiceTrpcError,
} from "../../services/einvoice/errors.js";
import {
  planEinvoiceFill,
  previewIssuesAfterFill,
  totalsMismatchIssue,
} from "../../services/einvoice/fill.js";
import { decideIssuedXml } from "../../services/einvoice/issued-xml.js";
import { loadFillSources } from "../../services/einvoice/load.js";
import { renderZugferdPdf, zugferdPdfFilename } from "../../services/einvoice/pdfa3.js";
import {
  assertEinvoiceReady,
  validateEinvoice,
  type EinvoiceReadyInvoice,
} from "../../services/einvoice/validate.js";
import { publishSync } from "../../ws/sync.js";
import { workspaceProcedure } from "../trpc.js";
import { requireInvoiceById } from "./invoice-gate.js";

/**
 * The projection every invoice read uses except the two exports: the stored
 * XML can be hundreds of KB, never reaches the wire, and only an export needs
 * its bytes.
 */
export const WITHOUT_ISSUED_XML = "-einvoice.issuedXml";

/** Keeps whether an issued XML exists (its metadata) without loading the bytes. */
export const WITHOUT_ISSUED_XML_BYTES =
  "-einvoice.issuedXml.en16931.xml -einvoice.issuedXml.xrechnung.xml";

type StoredInvoiceDoc = InvoiceDocLike & { workspaceId: string; updatedAt: Date };

/** Whether an issued XML exists for either profile; the metadata is enough. */
export const hasAnyIssuedXml = (doc: Pick<InvoiceDocLike, "einvoice">): boolean =>
  Boolean(doc.einvoice?.issuedXml?.en16931 || doc.einvoice?.issuedXml?.xrechnung);

const FILL_LOCKED_MESSAGE =
  "An e-invoice was already issued for this invoice, so its details can no longer be filled.";

const notFound = (): TRPCError => new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });

const loadInvoiceDoc = async (
  workspaceId: string,
  id: string,
  projection: string,
): Promise<StoredInvoiceDoc> => {
  // An id that could not address a document reads as missing, never as a
  // CastError 500.
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const doc = await Invoice.findOne({ _id: id, workspaceId }).select(projection).lean();
  if (!doc) throw notFound();
  return doc as StoredInvoiceDoc;
};

/** assertEinvoiceReady at the router boundary: the refusal becomes PRECONDITION_FAILED with issues. */
const assertReadyOrThrow = (invoice: InvoiceWire, profile: EinvoiceProfile): EinvoiceReadyInvoice => {
  try {
    return assertEinvoiceReady(invoice, profile);
  } catch (error) {
    throw toEinvoiceTrpcError(error);
  }
};

/**
 * The XML an export serves. A stored one wins, whatever the status. Otherwise
 * it is generated, and on a non-draft invoice stored — once, with a
 * conditional update that matches only an absent or null value, so two
 * exports racing each other cannot both write. The loser serves the winner's
 * bytes, so both downloads are identical. `timestamps: false`: storing the
 * issued file is not an edit, and `updatedAt` guards the fill.
 */
const issuedOrGeneratedXml = async (
  id: string,
  doc: StoredInvoiceDoc,
  invoice: InvoiceWire,
  profile: EinvoiceProfile,
): Promise<string> => {
  const decision = decideIssuedXml(doc.status, doc.einvoice?.issuedXml?.[profile]);
  if (decision.kind === "stored") return decision.xml;

  const xml = buildCiiXml(assertReadyOrThrow(invoice, profile), profile);
  if (!decision.persist) return xml;

  const path = `einvoice.issuedXml.${profile}`;
  const result = await Invoice.updateOne(
    { _id: id, workspaceId: doc.workspaceId, [path]: { $in: [null] } },
    { $set: { [path]: { xml, generatedAt: new Date(), generator: EINVOICE_GENERATOR } } },
    { timestamps: false },
  );
  if (result.modifiedCount === 1) return xml;

  const again = await Invoice.findOne({ _id: id, workspaceId: doc.workspaceId })
    .select(`${path}.xml`)
    .lean();
  return again?.einvoice?.issuedXml?.[profile]?.xml ?? xml;
};

export const invoiceEinvoiceProcedures = {
  /**
   * Whether the invoice can be exported in `profile` right now, what is
   * missing and where to fix it, and what "Fill missing details" would write
   * from today's business profile and client. Read-only.
   */
  einvoiceCheck: workspaceProcedure
    .input(einvoiceCheckSchema)
    .query(async ({ ctx, input }): Promise<EinvoiceCheckResult> => {
      requireInvoiceById(ctx);
      const doc = await loadInvoiceDoc(ctx.workspaceId, input.id, WITHOUT_ISSUED_XML_BYTES);
      const invoice = toClientInvoice(doc);
      const sources = await loadFillSources(ctx.workspaceId, invoice.clientId);

      // A stored issued XML is served regardless of today's rules, so the
      // export is ready by definition.
      const hasIssuedXml = Boolean(doc.einvoice?.issuedXml?.[input.profile]);
      const issues = hasIssuedXml ? [] : validateEinvoice(invoice, input.profile);

      // An XML issued in either profile freezes the snapshot: no fill, and
      // what is missing now stays missing.
      const fillLocked = hasAnyIssuedXml(doc);
      const plan = planEinvoiceFill(invoice, sources, {});
      const fillable = !fillLocked && (plan.fields.length > 0 || plan.needsChoice);

      return {
        ready: issues.length === 0,
        issues,
        fill: fillable
          ? {
              fields: plan.fields,
              lineTax: plan.lineTax,
              fixedTax: plan.fixedTax,
              mismatch: plan.mismatch,
            }
          : null,
        issuesAfterFill: hasIssuedXml
          ? []
          : fillLocked
            ? issues
            : previewIssuesAfterFill(invoice, plan, input.profile),
        preferredFormat: sources.client?.billing?.preferredFormat ?? null,
        hasIssuedXml,
        fillLocked,
      };
    }),

  /**
   * "Fill missing details", after the user confirmed the exact list: absent
   * or null snapshot values from TODAY's profile and client, VAT categories
   * for a legacy invoice's lines, a breakdown from the frozen line amounts.
   * Allowed in every status — sent legacy invoices are why it exists. Never
   * changes a stored non-null value or an amount, and refused once an XML was
   * issued in either profile.
   */
  attachEinvoiceData: workspaceProcedure
    .input(attachEinvoiceDataSchema)
    .mutation(async ({ ctx, input }): Promise<InvoiceWire> => {
      requireInvoiceById(ctx);
      const workspaceId = ctx.workspaceId;
      const doc = await loadInvoiceDoc(workspaceId, input.id, WITHOUT_ISSUED_XML_BYTES);
      if (hasAnyIssuedXml(doc)) {
        throw einvoiceFillRefused("FILL_LOCKED_BY_ISSUED_XML", FILL_LOCKED_MESSAGE);
      }
      const invoice = toClientInvoice(doc);
      const sources = await loadFillSources(workspaceId, invoice.clientId);
      const plan = planEinvoiceFill(invoice, sources, {
        zeroRateCategory: input.zeroRateCategory,
        exemptionNotes: input.exemptionNotes,
      });

      // Refusals, each writing nothing.
      if (plan.lineTax === "fixed" && input.zeroRateCategory !== undefined) {
        const rate = plan.fixedTax?.rate ?? invoice.taxRate ?? 0;
        throw einvoiceFillRefused(
          "FILL_CATEGORY_NOT_APPLICABLE",
          `This invoice was issued with ${rate} % tax, so its lines are standard rated. No category choice applies.`,
        );
      }
      if (plan.needsChoice) {
        throw einvoiceFillRefused(
          "FILL_CATEGORY_REQUIRED",
          "Choose the VAT category for the 0 % lines: exempt, reverse charge, not subject to VAT or zero rated.",
        );
      }
      if (plan.mismatch) {
        throw einvoiceNotReady([totalsMismatchIssue(plan.mismatch, invoice.currency)]);
      }

      // Nothing to fill: a retried confirm succeeds without a write.
      if (plan.fields.length === 0) return invoice;

      // The plan was computed from exactly this document; the `updatedAt`
      // guard is what keeps "never overwrite a non-null value" true when
      // another window changed it in between. `plan.writes` names the filled
      // leaves, never a normalised party, so the fill invents no value the
      // snapshot did not have. Storing an issued XML does not
      // touch `updatedAt`, so the filter also requires that none exists: an
      // export racing this fill wins, and the fill reads as a conflict. `previewParties` is for the
      // preview only and is never written.
      const updated = await Invoice.findOneAndUpdate(
        {
          _id: input.id,
          workspaceId,
          updatedAt: doc.updatedAt,
          "einvoice.issuedXml.en16931": { $in: [null] },
          "einvoice.issuedXml.xrechnung": { $in: [null] },
        },
        {
          $set: plan.writes,
          $push: { "einvoice.fills": { at: new Date(), by: ctx.user.id, fields: plan.fields } },
        },
        { returnDocument: "after", projection: { "einvoice.issuedXml": 0 } },
      ).lean();
      if (!updated) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This invoice changed in another window. Reload it.",
        });
      }

      void publishSync(workspaceId, { kind: "invoice.changed", id: input.id }, input.originId);
      return toClientInvoice(updated);
    }),

  /** The ZUGFeRD / Factur-X EN 16931 PDF/A-3b, with the (stored or fresh) XML embedded. */
  exportZugferd: workspaceProcedure
    .input(einvoiceExportSchema)
    .query(async ({ ctx, input }): Promise<EinvoiceExportResult> => {
      requireInvoiceById(ctx);
      const doc = await loadInvoiceDoc(ctx.workspaceId, input.id, "-einvoice.issuedXml.xrechnung");
      // With the logo bytes: the visible page draws them, the XML does not.
      const invoice = renderableInvoice(doc);
      // The visible part renders from the snapshot fields, so they must be
      // complete even when a stored XML exists.
      const ready = assertReadyOrThrow(invoice, "en16931");
      const xml = await issuedOrGeneratedXml(input.id, doc, invoice, "en16931");
      const bytes = await renderZugferdPdf(ready, xml, { generatedAt: new Date().toISOString() });
      return {
        filename: zugferdPdfFilename(invoice.number),
        base64: bytes.toString("base64"),
        mimeType: "application/pdf",
      };
    }),

  /** The XRechnung 3.0 CII XML: the stored issued file, or a fresh one. */
  exportXrechnung: workspaceProcedure
    .input(einvoiceExportSchema)
    .query(async ({ ctx, input }): Promise<EinvoiceExportResult> => {
      requireInvoiceById(ctx);
      const doc = await loadInvoiceDoc(ctx.workspaceId, input.id, "-einvoice.issuedXml.en16931");
      const invoice = toClientInvoice(doc);
      const xml = await issuedOrGeneratedXml(input.id, doc, invoice, "xrechnung");
      return {
        filename: xrechnungFilename(invoice.number),
        base64: Buffer.from(xml, "utf8").toString("base64"),
        mimeType: "application/xml",
      };
    }),
};
