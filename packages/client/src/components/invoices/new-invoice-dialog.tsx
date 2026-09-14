"use client";

import * as React from "react";
import { AlertTriangle, Info, Loader2, ShieldCheck } from "lucide-react";
import {
  SUPPORTED_LOCALES,
  dueDateFromTerms,
  isLocale,
  resolveInvoiceLocale,
  type Locale,
} from "@starter/shared";

import { ClientFormDialog } from "@/components/catalog/client-form-dialog";
import { CLIENT_LIST_INPUT } from "@/components/catalog/types";
import {
  DateRangePicker,
  rangeForPreset,
  type DateRange,
} from "@/components/date-range-picker";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import { useFormatSettings } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { InvoiceIdentityWarnings } from "./identity-warnings";
import { InvoiceLines } from "./invoice-lines";
import {
  INITIAL_INVOICE_TAX_STATE,
  InvoiceTaxSection,
  lineTaxRenderer,
  missingExemptionNotes,
  noteCategoriesInUse,
  pruneLineOverrides,
  stateFromResolvedTax,
  taxInputsFromState,
  type InvoiceTaxState,
} from "./invoice-tax-section";
import {
  defaultInvoiceDates,
  emptyPreviewReason,
  exclusionNotices,
  previewIsBillable,
  reconcileDueDate,
  type InvoiceGroupBy,
  type InvoiceRow,
} from "./types";
import { useInvoiceMutations, type CreateInvoiceVars } from "./use-invoices";
import { userErrorMessage } from "@/lib/error-message";

export type NewInvoiceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the created invoice so the screen can select it. */
  onCreated: (invoice: InvoiceRow) => void;
};

const GROUP_OPTIONS = [
  { id: "project", labelKey: "invoices.form.perProject" },
  { id: "task", labelKey: "invoices.form.perTask" },
] as const satisfies readonly { id: InvoiceGroupBy; labelKey: string }[];

/** The language select's value: no override, or one supported locale. */
type LanguageChoice = "auto" | Locale;

const AUTO_LANGUAGE = "auto" as const satisfies LanguageChoice;

/**
 * The create flow.
 *
 * The body is only mounted while the dialog is open, so every field
 * re-initialises on each open without an effect syncing state — an invoice
 * half-built from last week's client and this week's range is the kind of
 * mistake that reaches a customer.
 */
export function NewInvoiceDialog({
  open,
  onOpenChange,
  onCreated,
}: NewInvoiceDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-3xl"
        data-testid="invoice-dialog"
      >
        {open ? (
          <NewInvoiceForm
            onCreated={(invoice) => {
              onCreated(invoice);
              onOpenChange(false);
            }}
            onCancel={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type NewInvoiceFormProps = {
  onCreated: (invoice: InvoiceRow) => void;
  onCancel: () => void;
};

/**
 * PREVIEW IS FREE, CREATE IS NOT.
 *
 * Everything above the separator re-runs a server-side dry run on every change
 * and writes nothing. The button below it allocates a number, persists a
 * document and stamps `invoiceId` on every entry it bills — the point at which
 * that time stops being billable, permanently. So the two are not one button
 * at the bottom of a form: creating is reached through its own confirmation
 * strip that restates the money and says plainly what it costs, and ANY edit
 * to the form drops back out of it. You confirm the numbers you are looking
 * at, never the ones you were looking at a moment ago.
 */
function NewInvoiceForm({
  onCreated,
  onCancel,
}: NewInvoiceFormProps): React.JSX.Element {
  const format = useFormatSettings();
  const f = useFormat();
  const t = useT("reports");
  const tc = useT("common");
  const { createInvoice, isCreating } = useInvoiceMutations();

  const [clientId, setClientId] = React.useState<string | null>(null);
  const [range, setRange] = React.useState<DateRange>(() =>
    rangeForPreset("thisMonth", format.weekStartsOn),
  );
  const [groupBy, setGroupBy] = React.useState<InvoiceGroupBy>("project");
  const te = useT("einvoice");
  const [taxState, setTaxState] = React.useState<InvoiceTaxState>(INITIAL_INVOICE_TAX_STATE);
  // The server's resolution is adopted once per client, and never after an edit.
  const [adoptedFor, setAdoptedFor] = React.useState<string | null>(null);
  // Whether the client and profile defaults alone resolved every line.
  const [defaultsResolved, setDefaultsResolved] = React.useState(false);
  // Line keys from the last preview answer. Held apart from the query so a
  // pending re-fetch (data undefined) cannot flip the request back and forth.
  const [knownLines, setKnownLines] = React.useState<Array<{ key: string; label: string }>>([]);
  // The selected client's billing details, opened over this dialog so the
  // half-built invoice survives adding a VAT ID.
  const [editingClientBilling, setEditingClientBilling] = React.useState(false);
  const utils = trpc.useUtils();
  const [dates, setDates] = React.useState(() => defaultInvoiceDates());
  // Once the person picks a due date it is theirs; until then it follows the
  // business profile's payment terms, when there are any.
  const [dueTouched, setDueTouched] = React.useState(false);
  const [notes, setNotes] = React.useState("");
  const [language, setLanguage] = React.useState<LanguageChoice>(AUTO_LANGUAGE);
  const [confirming, setConfirming] = React.useState(false);

  const clients = trpc.clients.list.useQuery(CLIENT_LIST_INPUT);
  // A refusal (a role that may not read the profile) simply means no terms
  // and no warning — creating the invoice is decided on the server.
  const profile = trpc.settings.businessProfile.useQuery(undefined, {
    retry: false,
  });
  const selectedClient =
    (clients.data ?? []).find((client) => client.id === clientId) ?? null;
  const termsDays = profile.data?.paymentTermsDays ?? null;
  const suggestedDue = dueTouched
    ? null
    : dueDateFromTerms(dates.issueDate, termsDays);
  const dueDate = suggestedDue ?? dates.dueDate;
  const clientOptions = React.useMemo(
    () =>
      (clients.data ?? [])
        .filter((client) => !client.archived)
        .map((client) => ({
          value: client.id,
          label: client.name,
          color: client.color,
        })),
    [clients.data],
  );

  const lineKeys = knownLines.map((line) => line.key);
  const taxResult = taxInputsFromState(taxState, lineKeys);
  const tax = { ok: taxResult.ok };
  // Untouched: send no tax at all and let the server resolve client → profile
  // defaults, which is exactly what the section then shows. Preview and create
  // read this ONE object, so the two cannot drift.
  const taxInputs = taxState.touched && taxResult.ok ? taxResult.inputs : {};
  const notesMissing = taxState.touched ? missingExemptionNotes(taxState, lineKeys) : [];

  // What "Automatic" resolves to right now, named on the option so nobody has
  // to guess. The server resolves it again with the same function and
  // snapshots the answer onto the invoice.
  const automaticLanguage = resolveInvoiceLocale({
    clientLocale: selectedClient?.invoiceLocale ?? null,
    issuerPreference: format.settings.locale,
  });
  const languageName = (locale: Locale): string => t(`invoices.languages.${locale}`);

  // A dry run, re-fetched on every edit. `enabled` keeps it from firing with a
  // placeholder client id, and `staleTime: 0` keeps it honest — another tab
  // may have invoiced this range since the last look.
  const preview = trpc.invoices.preview.useQuery(
    {
      clientId: clientId ?? "",
      from: range.from,
      to: range.to,
      groupBy,
      ...taxInputs,
    },
    { enabled: clientId !== null && tax.ok, staleTime: 0 },
  );

  const data = preview.data;

  if (data && data.lineItems.map((line) => line.key).join("\n") !== lineKeys.join("\n")) {
    const nextLines = data.lineItems.map((line) => ({ key: line.key, label: line.label }));
    setKnownLines(nextLines);
    // Another range or grouping: keep each override whose line is still billed.
    const pruned = pruneLineOverrides(taxState, nextLines.map((line) => line.key));
    if (pruned !== taxState) setTaxState(pruned);
  }
  if (data && clientId !== null && adoptedFor !== clientId && !taxState.touched) {
    setAdoptedFor(clientId);
    setDefaultsResolved(data.resolvedTax !== null);
    setTaxState(stateFromResolvedTax(data.resolvedTax, data.exemptionNotes));
  }
  // A category chosen after adoption gets the server's default reason once.
  if (data && taxState.touched) {
    const unfilled = noteCategoriesInUse(taxState, lineKeys).filter(
      (category) => taxState.notes[category] === undefined && data.exemptionNotes[category],
    );
    if (unfilled.length > 0) {
      const filled = { ...taxState.notes };
      for (const category of unfilled) filled[category] = data.exemptionNotes[category] ?? "";
      setTaxState({ ...taxState, notes: filled });
    }
  }

  const changeTax = (next: InvoiceTaxState): void => {
    setConfirming(false);
    setTaxState(next);
  };
  const billable = previewIsBillable(data);
  const notices = data ? exclusionNotices(data, f.locale) : [];

  const setIssueDate = (next: string): void => {
    if (next === "") return;
    setConfirming(false);
    setDates((current) => ({
      issueDate: next,
      dueDate: reconcileDueDate(next, dueTouched ? current.dueDate : dueDate),
    }));
  };

  const setDueDate = (next: string): void => {
    if (next === "") return;
    setConfirming(false);
    setDueTouched(true);
    setDates((current) => ({
      issueDate: current.issueDate,
      // The server refuses a due date before the issue date; clamp rather
      // than send a request that can only come back as an error.
      dueDate: next < current.issueDate ? current.issueDate : next,
    }));
  };

  const submit = async (): Promise<void> => {
    if (clientId === null || !taxResult.ok || !billable || notesMissing.length > 0) return;
    const vars: CreateInvoiceVars = {
      clientId,
      from: range.from,
      to: range.to,
      groupBy,
      ...taxInputs,
      issueDate: dates.issueDate,
      dueDate,
      ...(notes.trim() === "" ? {} : { notes: notes.trim() }),
      // Omitted unless chosen, so the client's own language keeps deciding.
      ...(language === AUTO_LANGUAGE ? {} : { locale: language }),
    };
    const created = await createInvoice(vars);
    if (!created) {
      // The toast already said why. Stay open with the form intact so the
      // range can be narrowed, or the preview reloaded, and tried again.
      setConfirming(false);
      return;
    }
    onCreated(created);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("invoices.form.title")}</DialogTitle>
        <DialogDescription>{t("invoices.form.description")}</DialogDescription>
      </DialogHeader>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="invoice-client">{tc("fields.client")}</Label>
          <Combobox
            id="invoice-client"
            className="w-full"
            options={clientOptions}
            value={clientId}
            onChange={(next) => {
              setConfirming(false);
              setClientId(next);
              // Another client has other defaults and other line keys.
              setTaxState(INITIAL_INVOICE_TAX_STATE);
              setAdoptedFor(null);
              setDefaultsResolved(false);
              setKnownLines([]);
            }}
            placeholder={t("invoices.form.selectClient")}
            searchPlaceholder={t("filters.clients.search")}
            emptyText={t("filters.clients.empty")}
            data-testid="invoice-client-combobox"
          />
        </div>

        <div className="space-y-2">
          <Label>{t("invoices.columns.billedRange")}</Label>
          <DateRangePicker
            value={range}
            onChange={(next) => {
              setConfirming(false);
              setRange(next);
            }}
            weekStartsOn={format.weekStartsOn}
            className="w-full"
            testId="invoice-range"
          />
        </div>

        <div className="space-y-2">
          <Label>{t("invoices.form.lines")}</Label>
          <div className="flex flex-wrap gap-2" data-testid="invoice-groupby">
            {GROUP_OPTIONS.map((option) => (
              <Button
                key={option.id}
                type="button"
                size="sm"
                variant={groupBy === option.id ? "secondary" : "outline"}
                onClick={() => {
                  setConfirming(false);
                  setGroupBy(option.id);
                }}
                aria-pressed={groupBy === option.id}
                data-testid={`invoice-groupby-${option.id}`}
              >
                {t(option.labelKey)}
              </Button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="invoice-issue-date">{t("invoices.form.issueDate")}</Label>
          <Input
            id="invoice-issue-date"
            type="date"
            value={dates.issueDate}
            onChange={(event) => setIssueDate(event.target.value)}
            data-testid="invoice-issue-date"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="invoice-due-date">{t("invoices.form.dueDate")}</Label>
          <Input
            id="invoice-due-date"
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
            data-testid="invoice-due-date"
          />
          {suggestedDue !== null && termsDays !== null ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="invoice-due-from-terms"
            >
              {t("invoiceIdentity.dueFromTerms", { days: termsDays })}
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="invoice-locale">{t("invoices.form.language")}</Label>
          <Select
            value={language}
            onValueChange={(next) => {
              // Changes the document, not the preview: nothing to re-run, but
              // the confirmation strip must restate what is being created.
              setConfirming(false);
              setLanguage(isLocale(next) ? next : AUTO_LANGUAGE);
            }}
          >
            <SelectTrigger id="invoice-locale" data-testid="invoice-locale">
              <SelectValue />
            </SelectTrigger>
            <SelectContent data-testid="invoice-locale-content">
              <SelectItem value={AUTO_LANGUAGE} data-testid="invoice-locale-auto">
                {t("invoices.form.languageAuto", {
                  language: languageName(automaticLanguage),
                })}
              </SelectItem>
              {SUPPORTED_LOCALES.map((locale) => (
                <SelectItem
                  key={locale}
                  value={locale}
                  lang={locale}
                  data-testid={`invoice-locale-${locale}`}
                >
                  {languageName(locale)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("invoices.form.languageHint")}</p>
        </div>
      </div>

      <InvoiceTaxSection
        lines={knownLines}
        value={taxState}
        onChange={changeTax}
        hasBuyerVatId={
          selectedClient === null ? null : (selectedClient.billing?.vatId ?? null) !== null
        }
        clientId={clientId}
        onEditClientBilling={() => setEditingClientBilling(true)}
        unsetAllowed={!defaultsResolved}
      />

      <ClientFormDialog
        open={editingClientBilling && selectedClient !== null}
        onOpenChange={(next) => {
          if (next) return;
          setEditingClientBilling(false);
          // A VAT ID or default category added there changes the warning and
          // the preview's resolved tax; the client list refreshes itself.
          void utils.invoices.preview.invalidate();
        }}
        client={selectedClient}
        focusBillingField="vatId"
        issuerCountry={profile.data?.country ?? null}
      />

      <div className="space-y-2">
        <Label htmlFor="invoice-notes">{t("invoices.form.notes")}</Label>
        <Textarea
          id="invoice-notes"
          rows={2}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder={t("invoices.form.notesPlaceholder")}
          data-testid="invoice-notes"
        />
      </div>

      <InvoiceIdentityWarnings
        profile={profile.data}
        client={selectedClient}
      />

      <Separator />

      <section className="space-y-3" data-testid="invoice-preview">
        <header className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t("invoices.form.preview")}</h3>
          {data ? (
            <span
              className="text-xs text-muted-foreground"
              data-testid="invoice-preview-number"
            >
              {t("invoices.form.nextNumber", { number: data.suggestedNumber })}
            </span>
          ) : null}
        </header>

        {clientId === null ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="invoice-preview-idle"
          >
            {t("invoices.form.pickClient")}
          </p>
        ) : !tax.ok ? (
          <p className="text-sm text-muted-foreground" data-testid="invoice-preview-tax-invalid">
            {!taxResult.ok && taxResult.errorKey === "oMixed" ? te("tax.oMixed") : te("tax.rate")}
          </p>
        ) : preview.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("invoices.form.gathering")}
          </p>
        ) : preview.error ? (
          <p className="text-sm text-destructive" data-testid="invoice-preview-error">
            {userErrorMessage(preview.error, undefined, tc)}
          </p>
        ) : data ? (
          <>
            {notices.map((notice) => (
              <p
                key={notice.id}
                className={cn(
                  "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
                  notice.tone === "warning"
                    ? "border-destructive/40 text-destructive"
                    : "border-border text-muted-foreground",
                )}
                data-testid={
                  notice.id === "missing-rate"
                    ? "invoice-preview-skipped-rate"
                    : "invoice-preview-skipped-invoiced"
                }
              >
                {notice.tone === "warning" ? (
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                ) : (
                  <ShieldCheck className="mt-0.5 size-4 shrink-0" />
                )}
                <span>{notice.message}</span>
              </p>
            ))}

            {billable ? (
              <InvoiceLines
                lineItems={data.lineItems}
                subtotal={data.subtotal}
                taxRate={data.taxRate}
                taxAmount={data.taxAmount}
                total={data.total}
                currency={data.currency}
                testIdPrefix="invoice-preview"
                taxBreakdown={data.taxBreakdown}
                renderLineTax={lineTaxRenderer(taxState, changeTax, (line) =>
                  te("tax.lineLabel", { line }),
                )}
              />
            ) : (
              <p
                className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground"
                data-testid="invoice-preview-empty"
              >
                {t("invoices.form.nothingToBill", {
                  reason: emptyPreviewReason(data, f.locale),
                })}
              </p>
            )}
          </>
        ) : null}
      </section>

      <Separator />

      {confirming && data && billable ? (
        <div
          className="space-y-3 rounded-lg border-2 border-destructive/50 bg-destructive/5 p-4"
          data-testid="invoice-create-confirm-panel"
        >
          <p className="flex items-start gap-2 text-sm">
            <Info className="mt-0.5 size-4 shrink-0" />
            <span>
              {t.rich("invoices.form.confirm", {
                number: data.suggestedNumber,
                client: data.clientName,
                total: f.money(data.total, data.currency),
                count: data.entryIds.length,
                b: (chunks) => <strong>{chunks}</strong>,
              })}
            </span>
          </p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirming(false)}
              data-testid="invoice-create-back"
            >
              {t("invoices.form.backToPreview")}
            </Button>
            <Button
              type="button"
              onClick={() => void submit()}
              disabled={isCreating}
              data-testid="invoice-create-confirm"
            >
              {isCreating ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("invoices.form.createNumbered", { number: data.suggestedNumber })}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            data-testid="invoice-cancel"
          >
            {tc("actions.cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={!billable || !tax.ok || notesMissing.length > 0 || isCreating}
            data-testid="invoice-create"
          >
            {t("invoices.form.create")}
          </Button>
        </div>
      )}
    </>
  );
}
