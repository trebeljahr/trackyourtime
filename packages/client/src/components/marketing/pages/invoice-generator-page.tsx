"use client";

/**
 * The public invoice generator: a form that turns into a PDF in the browser.
 *
 * A client component because it holds the form state and renders the PDF on
 * the device — nothing is sent anywhere. The `@starter/invoice-pdf` renderer
 * and pdfkit are heavy, so they are pulled in through a dynamic `import()` on
 * the first "Download PDF" click, never in the page's first load.
 *
 * Hydration rule (static export): the prerendered HTML and the first client
 * render are the empty form. The saved draft is read from `localStorage` in an
 * effect AFTER mount, so the two builds (English at `/invoice-generator/`,
 * German at `/de/rechnung-erstellen/`) agree with their served HTML. Every
 * `localStorage` touch is wrapped, because a private window throws on it.
 *
 * The data model, the totals and the wire mapping are `lib/invoice-generator.ts`
 * — pure and unit-tested. This file is the UI and the browser side only.
 */
import * as React from "react";
import { Download, Plus, Trash2 } from "lucide-react";
import {
  BUSINESS_LOGO_MAX_BYTES,
  businessLogoMimeOf,
  imageDataUrl,
  parseImageDataUrl,
  TAX_CATEGORIES,
  type BusinessLogoUpload,
  type Locale,
  type TaxCategory,
  type InvoiceLineUnit,
} from "@starter/shared";

import { PrimaryLink } from "@/components/marketing/blocks";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { marketingT } from "@/i18n/marketing";
import type { Translator } from "@/i18n/translator";
import { EINVOICE_DOCS_URL } from "@/lib/site-links";
import {
  buildInvoice,
  computeTotals,
  emptyForm,
  emptyLine,
  GENERATOR_CURRENCIES,
  readDraft,
  removeDraft,
  validLines,
  writeDraft,
  type InvoiceForm,
  type IssuerForm,
  type LineForm,
  type LogoState,
  type RecipientForm,
} from "@/lib/invoice-generator";

type MarketingTranslator = Translator<"marketing">;

/** A unique-enough id for a new line; the invoice key is derived from it. */
function newLineId(): string {
  return `line-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function InvoiceGeneratorPage({ locale }: { locale: Locale }): React.ReactElement {
  const t = marketingT(locale);
  // The empty form is the prerendered state and the first client render. The
  // draft, if any, replaces it after mount.
  const [form, setForm] = React.useState<InvoiceForm>(emptyForm);
  const [hydrated, setHydrated] = React.useState(false);
  const [logoError, setLogoError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const draft = readDraft(window.localStorage);
    if (draft) setForm(draft);
    setHydrated(true);
  }, []);

  // Persist after every change, but only once the draft has been read — so an
  // early render never overwrites a saved draft with the empty form.
  React.useEffect(() => {
    if (hydrated) writeDraft(window.localStorage, form);
  }, [form, hydrated]);

  const setIssuer = <K extends keyof IssuerForm>(key: K, value: IssuerForm[K]): void =>
    setForm((prev) => ({ ...prev, issuer: { ...prev.issuer, [key]: value } }));
  const setRecipient = <K extends keyof RecipientForm>(key: K, value: RecipientForm[K]): void =>
    setForm((prev) => ({ ...prev, recipient: { ...prev.recipient, [key]: value } }));
  const setField = <K extends keyof InvoiceForm>(key: K, value: InvoiceForm[K]): void =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const setLine = (id: string, patch: Partial<LineForm>): void =>
    setForm((prev) => ({
      ...prev,
      lines: prev.lines.map((line) => (line.id === id ? { ...line, ...patch } : line)),
    }));
  const addLine = (): void =>
    setForm((prev) => ({ ...prev, lines: [...prev.lines, emptyLine(newLineId())] }));
  const removeLine = (id: string): void =>
    setForm((prev) => ({
      ...prev,
      lines: prev.lines.length > 1 ? prev.lines.filter((line) => line.id !== id) : prev.lines,
    }));

  const clearAll = (): void => {
    removeDraft(window.localStorage);
    setForm(emptyForm());
    setLogoError(null);
  };

  const onLogo = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    if (businessLogoMimeOf(file.type) === null) {
      setLogoError(t("invoiceGenerator.form.logoErrorFormat"));
      return;
    }
    if (file.size > BUSINESS_LOGO_MAX_BYTES) {
      setLogoError(t("invoiceGenerator.form.logoErrorTooLarge", { max: LOGO_MAX_KB }));
      return;
    }
    const logo = await readLogo(file);
    if (!logo) {
      setLogoError(t("invoiceGenerator.form.logoErrorRead"));
      return;
    }
    setLogoError(null);
    setField("logo", logo);
  };

  const lines = validLines(form);
  const totals = computeTotals(lines, locale);
  const money = React.useMemo(
    () => new Intl.NumberFormat(locale, { style: "currency", currency: form.currency }),
    [locale, form.currency],
  );

  const download = async (): Promise<void> => {
    // The renderer and pdfkit arrive only now — kept out of the first load.
    const { renderInvoicePdf, invoicePdfFilename } = await import("@starter/invoice-pdf/invoice-pdf");
    const generatedAt = new Date().toISOString();
    const invoice = buildInvoice(form, locale, generatedAt);
    const bytes = await renderInvoicePdf(invoice, { generatedAt });
    const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = invoicePdfFilename(invoice.number);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Let the download start before the blob is revoked.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  return (
    <MarketingShell locale={locale} path="/invoice-generator/">
      <section className="mx-auto max-w-6xl px-6 pt-16 pb-8 sm:pt-24">
        <div className="max-w-3xl space-y-6">
          <p className="text-sm font-medium text-brand">{t("invoiceGenerator.hero.eyebrow")}</p>
          <h1
            className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl"
            data-testid="marketing-title"
          >
            {t("invoiceGenerator.hero.title")}
          </h1>
          <div className="space-y-4 text-lg text-muted-foreground">
            <p>{t("invoiceGenerator.hero.body")}</p>
            <p className="text-base">{t("invoiceGenerator.hero.privacy")}</p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-12" data-testid="invoice-generator">
        <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
          <div className="space-y-10">
            <FieldGroup title={t("invoiceGenerator.form.yourDetails")}>
              <TextField
                id="issuer-legalName"
                label={t("invoiceGenerator.form.legalName")}
                value={form.issuer.legalName}
                onChange={(v) => setIssuer("legalName", v)}
              />
              <TextArea
                id="issuer-address"
                label={t("invoiceGenerator.form.address")}
                value={form.issuer.addressLines}
                onChange={(v) => setIssuer("addressLines", v)}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  id="issuer-postalCode"
                  label={t("invoiceGenerator.form.postalCode")}
                  value={form.issuer.postalCode}
                  onChange={(v) => setIssuer("postalCode", v)}
                />
                <TextField
                  id="issuer-city"
                  label={t("invoiceGenerator.form.city")}
                  value={form.issuer.city}
                  onChange={(v) => setIssuer("city", v)}
                />
              </div>
              <TextField
                id="issuer-country"
                label={t("invoiceGenerator.form.country")}
                value={form.issuer.country}
                onChange={(v) => setIssuer("country", v)}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  id="issuer-vatId"
                  label={t("invoiceGenerator.form.vatId")}
                  value={form.issuer.vatId}
                  onChange={(v) => setIssuer("vatId", v)}
                />
                <TextField
                  id="issuer-taxNumber"
                  label={t("invoiceGenerator.form.taxNumber")}
                  value={form.issuer.taxNumber}
                  onChange={(v) => setIssuer("taxNumber", v)}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  id="issuer-email"
                  label={t("invoiceGenerator.form.email")}
                  value={form.issuer.email}
                  onChange={(v) => setIssuer("email", v)}
                  type="email"
                />
                <TextField
                  id="issuer-phone"
                  label={t("invoiceGenerator.form.phone")}
                  value={form.issuer.phone}
                  onChange={(v) => setIssuer("phone", v)}
                />
              </div>
              <TextArea
                id="issuer-paymentDetails"
                label={t("invoiceGenerator.form.paymentDetails")}
                value={form.issuer.paymentDetails}
                onChange={(v) => setIssuer("paymentDetails", v)}
              />
              <TextField
                id="issuer-paymentTermsDays"
                label={t("invoiceGenerator.form.paymentTermsDays")}
                value={form.issuer.paymentTermsDays}
                onChange={(v) => setIssuer("paymentTermsDays", v)}
                type="number"
                inputMode="numeric"
              />
              <LogoField
                t={t}
                logo={form.logo}
                error={logoError}
                onPick={(file) => void onLogo(file)}
                onRemove={() => {
                  setField("logo", null);
                  setLogoError(null);
                }}
              />
            </FieldGroup>

            <FieldGroup title={t("invoiceGenerator.form.billTo")}>
              <TextField
                id="recipient-name"
                label={t("invoiceGenerator.form.recipientName")}
                value={form.recipient.name}
                onChange={(v) => setRecipient("name", v)}
              />
              <TextField
                id="recipient-legalName"
                label={t("invoiceGenerator.form.recipientLegalName")}
                value={form.recipient.legalName}
                onChange={(v) => setRecipient("legalName", v)}
              />
              <TextArea
                id="recipient-address"
                label={t("invoiceGenerator.form.address")}
                value={form.recipient.addressLines}
                onChange={(v) => setRecipient("addressLines", v)}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  id="recipient-postalCode"
                  label={t("invoiceGenerator.form.postalCode")}
                  value={form.recipient.postalCode}
                  onChange={(v) => setRecipient("postalCode", v)}
                />
                <TextField
                  id="recipient-city"
                  label={t("invoiceGenerator.form.city")}
                  value={form.recipient.city}
                  onChange={(v) => setRecipient("city", v)}
                />
              </div>
              <TextField
                id="recipient-country"
                label={t("invoiceGenerator.form.country")}
                value={form.recipient.country}
                onChange={(v) => setRecipient("country", v)}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  id="recipient-vatId"
                  label={t("invoiceGenerator.form.vatId")}
                  value={form.recipient.vatId}
                  onChange={(v) => setRecipient("vatId", v)}
                />
                <TextField
                  id="recipient-reference"
                  label={t("invoiceGenerator.form.reference")}
                  value={form.recipient.reference}
                  onChange={(v) => setRecipient("reference", v)}
                />
              </div>
              <TextField
                id="recipient-email"
                label={t("invoiceGenerator.form.email")}
                value={form.recipient.email}
                onChange={(v) => setRecipient("email", v)}
                type="email"
              />
            </FieldGroup>

            <FieldGroup title={t("invoiceGenerator.form.invoice")}>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  id="invoice-number"
                  label={t("invoiceGenerator.form.number")}
                  value={form.number}
                  onChange={(v) => setField("number", v)}
                />
                <div className="space-y-1.5">
                  <Label htmlFor="invoice-currency">{t("invoiceGenerator.form.currency")}</Label>
                  <select
                    id="invoice-currency"
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                    value={form.currency}
                    onChange={(e) => setField("currency", e.target.value)}
                    data-testid="generator-currency"
                  >
                    {GENERATOR_CURRENCIES.map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  id="invoice-issueDate"
                  label={t("invoiceGenerator.form.issueDate")}
                  value={form.issueDate}
                  onChange={(v) => setField("issueDate", v)}
                  type="date"
                />
                <TextField
                  id="invoice-dueDate"
                  label={t("invoiceGenerator.form.dueDate")}
                  value={form.dueDate}
                  onChange={(v) => setField("dueDate", v)}
                  type="date"
                />
              </div>
            </FieldGroup>

            <FieldGroup title={t("invoiceGenerator.form.lines")}>
              <div className="space-y-6">
                {form.lines.map((line, index) => (
                  <LineRow
                    key={line.id}
                    t={t}
                    line={line}
                    index={index}
                    canRemove={form.lines.length > 1}
                    onChange={(patch) => setLine(line.id, patch)}
                    onRemove={() => removeLine(line.id)}
                  />
                ))}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addLine}
                data-testid="generator-add-line"
              >
                <Plus />
                {t("invoiceGenerator.form.addLine")}
              </Button>
            </FieldGroup>

            <FieldGroup title={t("invoiceGenerator.form.extras")}>
              <TextArea
                id="invoice-notes"
                label={t("invoiceGenerator.form.notes")}
                value={form.notes}
                onChange={(v) => setField("notes", v)}
              />
              <TextArea
                id="invoice-footer"
                label={t("invoiceGenerator.form.footer")}
                value={form.footer}
                onChange={(v) => setField("footer", v)}
              />
            </FieldGroup>
          </div>

          <aside className="lg:sticky lg:top-6 lg:h-fit">
            <div className="space-y-4 rounded-xl border p-5">
              <p className="text-sm font-semibold">{t("invoiceGenerator.form.summary")}</p>
              <dl className="space-y-2 text-sm">
                <TotalRow
                  label={t("invoiceGenerator.form.subtotal")}
                  value={money.format(totals.subtotal)}
                  testid="generator-subtotal"
                />
                <TotalRow
                  label={t("invoiceGenerator.form.tax")}
                  value={money.format(totals.taxAmount)}
                  testid="generator-tax"
                />
                <div className="flex items-center justify-between border-t pt-2 text-base font-semibold">
                  <dt>{t("invoiceGenerator.form.total")}</dt>
                  <dd data-testid="generator-total">{money.format(totals.total)}</dd>
                </div>
              </dl>
              <p className="text-xs text-muted-foreground" data-testid="generator-line-count">
                {t("invoiceGenerator.form.lineCount", { count: lines.length })}
              </p>
              <Button
                type="button"
                className="w-full"
                disabled={lines.length === 0}
                onClick={() => void download()}
                data-testid="generator-download"
              >
                <Download />
                {t("invoiceGenerator.form.download")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full"
                onClick={clearAll}
                data-testid="generator-clear"
              >
                <Trash2 />
                {t("invoiceGenerator.form.clear")}
              </Button>
              <p className="text-xs text-muted-foreground">{t("invoiceGenerator.form.localOnly")}</p>
            </div>
          </aside>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-14">
        <h2 className="mb-6 max-w-3xl text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
          {t("invoiceGenerator.privacy.title")}
        </h2>
        <div className="max-w-2xl space-y-4 leading-relaxed text-muted-foreground">
          <p>{t("invoiceGenerator.privacy.local")}</p>
          <p>{t("invoiceGenerator.privacy.draft")}</p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-14 pb-24">
        <h2 className="mb-6 max-w-3xl text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
          {t("invoiceGenerator.cta.title")}
        </h2>
        <div className="max-w-2xl space-y-4 leading-relaxed text-muted-foreground">
          <p>{t("invoiceGenerator.cta.body")}</p>
          <p>
            {t.rich("invoiceGenerator.cta.einvoice", {
              docs: (chunks) => (
                <a href={EINVOICE_DOCS_URL} className="text-foreground underline underline-offset-4">
                  {chunks}
                </a>
              ),
            })}
          </p>
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          <PrimaryLink href="/signup/">{t("invoiceGenerator.cta.signup")}</PrimaryLink>
        </div>
      </section>
    </MarketingShell>
  );
}

/** The visible KB cap, as the copy states it. */
const LOGO_MAX_KB = String(Math.round(BUSINESS_LOGO_MAX_BYTES / 1024));

/** A picked image as the form keeps it: a data URL for the draft, bytes to render. */
async function readLogo(file: Blob): Promise<LogoState> {
  const upload = await new Promise<BusinessLogoUpload | null>((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onabort = () => resolve(null);
    reader.onload = () => resolve(parseImageDataUrl(reader.result));
    reader.readAsDataURL(file);
  });
  if (!upload) return null;
  const bytes = base64ToBytes(upload.base64);
  return { dataUrl: imageDataUrl(upload), bytes };
}

/** base64 → a plain number[] the draft can serialise and `buildInvoice` can render. */
function base64ToBytes(base64: string): number[] {
  const binary = atob(base64);
  const bytes = new Array<number>(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function FieldGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  type = "text",
  inputMode,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
}): React.ReactElement {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        inputMode={inputMode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={id}
      />
    </div>
  );
}

function TextArea({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}): React.ReactElement {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} data-testid={id} rows={3} />
    </div>
  );
}

function TotalRow({
  label,
  value,
  testid,
}: {
  label: string;
  value: string;
  testid: string;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd data-testid={testid}>{value}</dd>
    </div>
  );
}

function LineRow({
  t,
  line,
  index,
  canRemove,
  onChange,
  onRemove,
}: {
  t: MarketingTranslator;
  line: LineForm;
  index: number;
  canRemove: boolean;
  onChange: (patch: Partial<LineForm>) => void;
  onRemove: () => void;
}): React.ReactElement {
  const isStandard = line.taxCategory === "S";
  return (
    <div className="space-y-3 rounded-lg border p-4" data-testid={`generator-line-${index}`}>
      <div className="space-y-1.5">
        <Label htmlFor={`generator-line-${index}-label`}>{t("invoiceGenerator.form.lineLabel")}</Label>
        <Input
          id={`generator-line-${index}-label`}
          value={line.label}
          onChange={(e) => onChange({ label: e.target.value })}
          data-testid={`generator-line-${index}-label`}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={`generator-line-${index}-quantity`}>
            {t("invoiceGenerator.form.quantity")}
          </Label>
          <Input
            id={`generator-line-${index}-quantity`}
            type="number"
            inputMode="decimal"
            min="0"
            step="0.001"
            value={line.quantity}
            onChange={(e) => onChange({ quantity: e.target.value })}
            data-testid={`generator-line-${index}-quantity`}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`generator-line-${index}-unit`}>{t("invoiceGenerator.form.unit")}</Label>
          <select
            id={`generator-line-${index}-unit`}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
            value={line.unit}
            onChange={(e) => onChange({ unit: e.target.value as InvoiceLineUnit })}
            data-testid={`generator-line-${index}-unit`}
          >
            <option value="hour">{t("invoiceGenerator.form.unitHour")}</option>
            <option value="day">{t("invoiceGenerator.form.unitDay")}</option>
            <option value="piece">{t("invoiceGenerator.form.unitPiece")}</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`generator-line-${index}-unit-price`}>
            {t("invoiceGenerator.form.unitPrice")}
          </Label>
          <Input
            id={`generator-line-${index}-unit-price`}
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={line.unitPrice}
            onChange={(e) => onChange({ unitPrice: e.target.value })}
            data-testid={`generator-line-${index}-unit-price`}
          />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`generator-line-${index}-tax`}>
            {t("invoiceGenerator.form.taxCategory")}
          </Label>
          <select
            id={`generator-line-${index}-tax`}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
            value={line.taxCategory}
            onChange={(e) => onChange({ taxCategory: e.target.value as TaxCategory })}
            data-testid={`generator-line-${index}-tax`}
          >
            {TAX_CATEGORIES.map((code) => (
              <option key={code} value={code}>
                {t(`invoiceGenerator.form.taxCategories.${code}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`generator-line-${index}-rate`}>{t("invoiceGenerator.form.vatRate")}</Label>
          <Input
            id={`generator-line-${index}-rate`}
            type="number"
            inputMode="decimal"
            min="0"
            max="100"
            step="0.01"
            value={isStandard ? line.vatRate : "0"}
            disabled={!isStandard}
            onChange={(e) => onChange({ vatRate: e.target.value })}
            data-testid={`generator-line-${index}-rate`}
          />
        </div>
      </div>
      {canRemove ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRemove}
          data-testid={`generator-line-${index}-remove`}
        >
          <Trash2 />
          {t("invoiceGenerator.form.removeLine")}
        </Button>
      ) : null}
    </div>
  );
}

function LogoField({
  t,
  logo,
  error,
  onPick,
  onRemove,
}: {
  t: MarketingTranslator;
  logo: LogoState;
  error: string | null;
  onPick: (file: File | undefined) => void;
  onRemove: () => void;
}): React.ReactElement {
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-2" data-testid="generator-logo">
      <Label>{t("invoiceGenerator.form.logo")}</Label>
      <div className="flex flex-wrap items-center gap-4">
        {logo ? (
          // A data URL of the picked bytes: nothing to fetch or optimise.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logo.dataUrl}
            alt={t("invoiceGenerator.form.logoAlt")}
            className="h-14 w-auto max-w-40 rounded-md border border-border bg-white object-contain p-1"
            data-testid="generator-logo-preview"
          />
        ) : null}
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => inputRef.current?.click()}
            data-testid="generator-logo-upload"
          >
            {logo ? t("invoiceGenerator.form.logoReplace") : t("invoiceGenerator.form.logoUpload")}
          </Button>
          {logo ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onRemove}
              data-testid="generator-logo-remove"
            >
              {t("invoiceGenerator.form.logoRemove")}
            </Button>
          ) : null}
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          onPick(file);
        }}
        data-testid="generator-logo-file"
      />
      {error ? (
        <p className="text-sm text-destructive" data-testid="generator-logo-error">
          {error}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t("invoiceGenerator.form.logoHint", { max: LOGO_MAX_KB })}
        </p>
      )}
    </div>
  );
}
