/**
 * E-invoices (ZUGFeRD, XRechnung) in an encrypted workspace, on the device
 * (docs/private-workspace-protocol.md → "Invoices in an encrypted workspace").
 *
 * The same rules as the server's `invoice-einvoice.ts` router, from
 * `@starter/invoice-pdf/einvoice/*`: the check and the fill read today's
 * business profile and client billing from the decrypted copy; the first export
 * of a non-draft invoice stores its XML in the invoice record, and every later
 * export serves those bytes. A refusal is the package's `EinvoiceNotReadyError`
 * (issues) or `EinvoiceFillRefusedError` (a code), as on the server.
 */
import { z } from "zod";
import {
  attachEinvoiceDataSchema, clientBillingSchema, einvoiceCheckSchema, einvoiceExportSchema, normalizeClientBilling,
  type EinvoiceCheckResult, type EinvoiceProfile, type Invoice,
} from "@starter/shared";
import { buildCiiXml, xrechnungFilename } from "@starter/invoice-pdf/einvoice/cii";
import { EINVOICE_GENERATOR } from "@starter/invoice-pdf/einvoice/constants";
import { EinvoiceFillRefusedError, EinvoiceNotReadyError } from "@starter/invoice-pdf/einvoice/errors";
import { planEinvoiceFill, previewIssuesAfterFill, totalsMismatchIssue, type FillSources } from "@starter/invoice-pdf/einvoice/fill";
import { assertEinvoiceReady, validateEinvoice, type EinvoiceReadyInvoice } from "@starter/invoice-pdf/einvoice/validate";
import { privateBusinessProfileQuery } from "./business-profile-view.js";
import type { PlainPrivateRecord } from "./records.js";
import { privateViewSource, type PrivateViewOptions } from "./view-source.js";
import { assertPrivateInvoiceAccess, privateInvoiceFromRecord, privateInvoiceRows, privateRenderableInvoice, PrivateInvoiceRefusal } from "./invoice-view.js";

type Source = ReturnType<typeof privateViewSource>;
type IssuedXml = { xml: string; generatedAt: string; generator: string };
const FILL_LOCKED_MESSAGE = "An e-invoice was already issued for this invoice, so its details can no longer be filled.";

/** The stored issued XML of one profile, when there is one. */
export function storedIssuedXml(value: Record<string, unknown>, profile: EinvoiceProfile): string | null {
  const issued = (value.einvoice as { issuedXml?: Partial<Record<EinvoiceProfile, IssuedXml | null>> } | undefined)?.issuedXml?.[profile];
  return issued && typeof issued.xml === "string" && issued.xml.length > 0 ? issued.xml : null;
}
const hasAnyIssuedXml = (value: Record<string, unknown>) => storedIssuedXml(value, "en16931") !== null || storedIssuedXml(value, "xrechnung") !== null;

function findInvoice(source: Source, id: string) {
  const found = privateInvoiceRows(source).find(({ invoice }) => invoice.id === id);
  if (!found) throw new PrivateInvoiceRefusal("Invoice not found");
  return { ...found, value: source.value(found.record) };
}

/** Today's business profile and the client's billing — the server's `loadFillSources`. */
async function fillSources(options: PrivateViewOptions, source: Source, clientId: string): Promise<FillSources> {
  const { workspaceId: _workspace, updatedAt: _updated, logo: _logo, ...profile } = await privateBusinessProfileQuery({ ...options, input: {} }); void _workspace; void _updated; void _logo;
  const clientRow = source.ofKind("clients").find((row) => row.id === clientId);
  if (!clientRow) return { profile, client: null };
  const money = source.paired(clientRow, "clientMoney");
  return { profile, client: { billing: money.billing ? normalizeClientBilling(clientBillingSchema.parse(money.billing)) : null } };
}

/** `invoices.einvoiceCheck`: what is missing, where to fix it, and what a fill would write. Read-only. */
export async function privateEinvoiceCheck(options: PrivateViewOptions & { input: unknown }): Promise<EinvoiceCheckResult> {
  const source = privateViewSource(options); assertPrivateInvoiceAccess(source);
  const { workspaceId: _scope, ...input } = z.record(z.string(), z.unknown()).parse(options.input ?? {}); void _scope;
  const args = einvoiceCheckSchema.parse(input), found = findInvoice(source, args.id), invoice = found.invoice;
  const sources = await fillSources(options, source, invoice.clientId); source.check();
  const hasIssuedXml = storedIssuedXml(found.value, args.profile) !== null;
  const issues = hasIssuedXml ? [] : validateEinvoice(invoice, args.profile);
  const fillLocked = hasAnyIssuedXml(found.value);
  const plan = planEinvoiceFill(invoice, sources, {});
  const fillable = !fillLocked && (plan.fields.length > 0 || plan.needsChoice);
  return {
    ready: issues.length === 0, issues,
    fill: fillable ? { fields: plan.fields, lineTax: plan.lineTax, fixedTax: plan.fixedTax, mismatch: plan.mismatch } : null,
    issuesAfterFill: hasIssuedXml ? [] : fillLocked ? issues : previewIssuesAfterFill(invoice, plan, args.profile),
    preferredFormat: sources.client?.billing?.preferredFormat ?? null, hasIssuedXml, fillLocked,
  };
}

/**
 * The XML an export uses: the stored one, else a fresh build. `persist` says
 * the caller must store it first (a non-draft's first export), through
 * `invoices.issueEinvoiceXml`, which rebuilds it from the record itself.
 */
export function privateEinvoiceXml(options: PrivateViewOptions & { input: unknown }, profile: EinvoiceProfile): { xml: string; persist: boolean; number: string } {
  const source = privateViewSource(options); assertPrivateInvoiceAccess(source);
  const { workspaceId: _scope, ...input } = z.record(z.string(), z.unknown()).parse(options.input ?? {}); void _scope;
  const args = einvoiceExportSchema.parse(input), found = findInvoice(source, args.id);
  const stored = storedIssuedXml(found.value, profile);
  if (stored !== null) { source.check(); return { xml: stored, persist: false, number: found.invoice.number }; }
  const xml = buildCiiXml(assertEinvoiceReady(found.invoice, profile), profile); source.check();
  return { xml, persist: found.invoice.status !== "draft", number: found.invoice.number };
}

/** The ZUGFeRD page's invoice: renderable (logo bytes) and checked ready for EN 16931, as the server checks the snapshot even with a stored XML. */
export async function privateZugferdInvoice(options: PrivateViewOptions & { input: unknown }): Promise<EinvoiceReadyInvoice & { issuer: EinvoiceReadyInvoice["issuer"] & { logo?: { data: Uint8Array } | null } }> {
  const renderable = await privateRenderableInvoice(options);
  const ready = assertEinvoiceReady(renderable as unknown as Invoice, "en16931");
  return { ...ready, issuer: { ...ready.issuer, logo: renderable.issuer?.logo ?? null } };
}

export { xrechnungFilename };

/** Mongo-style `$set` paths as the fill plan writes them: dotted keys, array indexes and `$[]` (every element). */
function applyWrites(target: Record<string, unknown>, writes: Record<string, unknown>): void {
  const assign = (node: unknown, segments: string[], value: unknown): void => {
    if (node === null || typeof node !== "object") throw new Error("E-invoice fill path leads through a missing value");
    const [head, ...rest] = segments;
    if (head === "$[]") { for (const item of node as unknown[]) assign(item, rest, structuredClone(value)); return; }
    const key = Array.isArray(node) ? Number(head) : head!;
    if (rest.length === 0) { (node as Record<string | number, unknown>)[key] = structuredClone(value); return; }
    assign((node as Record<string | number, unknown>)[key], rest, value);
  };
  for (const [path, value] of Object.entries(writes)) assign(target, path.split("."), value);
}

/** `invoices.attachEinvoiceData`: the confirmed fill, never overwriting a stored value, refused once an XML was issued. */
export async function privateEinvoiceFill(options: PrivateViewOptions & { input: unknown; now?: number }): Promise<{ records: PlainPrivateRecord[]; result: Invoice }> {
  const source = privateViewSource(options); assertPrivateInvoiceAccess(source);
  const { workspaceId: _scope, originId: _origin, ...input } = z.record(z.string(), z.unknown()).parse(options.input ?? {}); void _scope; void _origin;
  const args = attachEinvoiceDataSchema.omit({ originId: true }).parse(input), found = findInvoice(source, args.id), invoice = found.invoice;
  if (hasAnyIssuedXml(found.value) || invoice.followThrough?.credit) throw new EinvoiceFillRefusedError("FILL_LOCKED_BY_ISSUED_XML", FILL_LOCKED_MESSAGE);
  const sources = await fillSources(options, source, invoice.clientId); source.check();
  const plan = planEinvoiceFill(invoice, sources, { zeroRateCategory: args.zeroRateCategory, exemptionNotes: args.exemptionNotes });
  if (plan.lineTax === "fixed" && args.zeroRateCategory !== undefined) {
    const rate = plan.fixedTax?.rate ?? invoice.taxRate ?? 0;
    throw new EinvoiceFillRefusedError("FILL_CATEGORY_NOT_APPLICABLE", `This invoice was issued with ${rate} % tax, so its lines are standard rated. No category choice applies.`);
  }
  if (plan.needsChoice) throw new EinvoiceFillRefusedError("FILL_CATEGORY_REQUIRED", "Choose the VAT category for the 0 % lines: exempt, reverse charge, not subject to VAT or zero rated.");
  if (plan.mismatch) throw new EinvoiceNotReadyError([totalsMismatchIssue(plan.mismatch, invoice.currency)]);
  if (plan.fields.length === 0) return { records: [], result: invoice };
  const stamp = new Date(options.now ?? Date.now()).toISOString();
  const body = structuredClone(found.value) as Record<string, unknown>;
  applyWrites(body, plan.writes);
  const einvoice = (body.einvoice ?? {}) as { fills?: unknown[] };
  body.einvoice = { ...einvoice, fills: [...(einvoice.fills ?? []), { at: stamp, by: options.scope.userId, fields: plan.fields }] };
  body.updatedAt = stamp;
  const value = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  source.check(); return { records: [{ ...found.record, value }], result: privateInvoiceFromRecord(value) };
}

/** Store the first XML of a non-draft invoice, rebuilt here from the record; a stored one wins and nothing is written. */
export function privateIssueEinvoiceXml(options: PrivateViewOptions & { input: unknown; now?: number }): { records: PlainPrivateRecord[]; result: { xml: string } } {
  const source = privateViewSource(options); assertPrivateInvoiceAccess(source);
  const args = z.object({ id: z.string().min(1).max(100), profile: z.enum(["en16931", "xrechnung"]) }).strict().parse(options.input ?? {});
  const found = findInvoice(source, args.id), stored = storedIssuedXml(found.value, args.profile);
  if (stored !== null) return { records: [], result: { xml: stored } };
  if (found.invoice.status === "draft") throw new PrivateInvoiceRefusal("A draft's e-invoice is never stored");
  const xml = buildCiiXml(assertEinvoiceReady(found.invoice, args.profile), args.profile);
  const body = structuredClone(found.value) as Record<string, unknown>;
  const einvoice = (body.einvoice ?? {}) as { issuedXml?: Record<string, unknown> };
  // Like the server, storing the XML leaves `updatedAt` alone.
  body.einvoice = { ...einvoice, issuedXml: { ...(einvoice.issuedXml ?? {}), [args.profile]: { xml, generatedAt: new Date(options.now ?? Date.now()).toISOString(), generator: EINVOICE_GENERATOR } } };
  source.check(); return { records: [{ ...found.record, value: body }], result: { xml } };
}
