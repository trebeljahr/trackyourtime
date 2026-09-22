"use client";

import * as React from "react";
import { Loader2, RotateCw } from "lucide-react";
import { SUPPORTED_LOCALES, isLocale, type Locale } from "@starter/shared";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useFormat } from "@/i18n/use-format";
import { useT } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";
import {
  INITIAL_INVOICE_TAX_STATE,
  InvoiceTaxSection,
  lineTaxRenderer,
  missingExemptionNotes,
  pruneLineOverrides,
  stateFromResolvedTax,
  taxInputsFromState,
  type InvoiceTaxState,
} from "./invoice-tax-section";
import {
  buildUpdateInput,
  editorSubtotal,
  linesChanged,
  linesFromInvoice,
  type EditableLine,
} from "./line-editor";
import { ManualLinesEditor } from "./manual-lines-editor";
import { toDateInputValue, type InvoiceRow } from "./types";
import { useInvoiceMutations } from "./use-invoices";

export type InvoiceEditFormProps = {
  invoice: InvoiceRow;
  /** Called with the saved draft, so the detail can leave edit mode. */
  onSaved: (invoice: InvoiceRow) => void;
  onCancel: () => void;
};

/** The language select's value: keep the document's, or one supported locale. */
type LanguageChoice = "keep" | Locale;
const KEEP_LANGUAGE = "keep" as const satisfies LanguageChoice;

/** The VAT section's starting state: the stored categories and the breakdown's reasons. */
function taxStateFromInvoice(invoice: InvoiceRow): InvoiceTaxState {
  const resolved = invoice.lineItems.every((line) => line.taxCategory !== undefined)
    ? {
        lines: invoice.lineItems.map((line) => ({
          key: line.key,
          category: line.taxCategory ?? "S",
          rate: line.taxRate ?? 0,
        })),
      }
    : null;
  const notes: Record<string, string> = {};
  for (const row of invoice.taxBreakdown ?? []) {
    if ((row.category === "E" || row.category === "AE" || row.category === "O") && row.exemptionReason) {
      notes[row.category] = row.exemptionReason;
    }
  }
  return resolved ? stateFromResolvedTax(resolved, notes) : { ...INITIAL_INVOICE_TAX_STATE, notes };
}

type SaveProblem =
  | "invalid-lines"
  | "number"
  | "dates"
  | "tax"
  | "notes"
  | "nothing"
  | "conflict"
  | "number-taken"
  | "not-draft"
  | "einvoice-issued";

/**
 * A draft, edited in place.
 *
 * Everything the form holds is sent as one `invoices.update` guarded by the
 * `updatedAt` the invoice was read with. A CONFLICT is not a toast: the
 * person's edits stay on screen with a Reload button, so nothing typed is
 * lost to a race with another window. The VAT section is sent when it was
 * touched, or when the lines changed and it holds a real choice — a new
 * manual line then takes the invoice's VAT rather than the profile default.
 */
export function InvoiceEditForm({ invoice, onSaved, onCancel }: InvoiceEditFormProps): React.JSX.Element {
  const t = useT("reports");
  const te = useT("einvoice");
  const f = useFormat();
  const utils = trpc.useUtils();
  const { updateInvoice, isBusy } = useInvoiceMutations();

  const [number, setNumber] = React.useState(invoice.number);
  const [issueDate, setIssueDate] = React.useState(() => toDateInputValue(invoice.issueDate));
  const [dueDate, setDueDate] = React.useState(() => toDateInputValue(invoice.dueDate));
  const [notes, setNotes] = React.useState(invoice.notes ?? "");
  const [language, setLanguage] = React.useState<LanguageChoice>(KEEP_LANGUAGE);
  const [lines, setLines] = React.useState<EditableLine[]>(() => linesFromInvoice(invoice));
  const [taxState, setTaxState] = React.useState<InvoiceTaxState>(() => taxStateFromInvoice(invoice));
  const [problem, setProblem] = React.useState<SaveProblem | null>(null);
  const [saving, setSaving] = React.useState(false);

  const lineKeys = lines.map((line) => line.key);
  const known = lines.map((line) => ({ key: line.key, label: line.label }));
  const taxResult = taxInputsFromState(taxState, lineKeys);
  const notesMissing = taxState.touched ? missingExemptionNotes(taxState, lineKeys) : [];
  const changed = linesChanged(invoice, lines);
  const sendTax = taxState.touched || (changed && taxState.all.kind !== "unset");

  const changeLines = (next: EditableLine[]): void => {
    setProblem(null);
    setLines(next);
    // A removed line takes its VAT override with it.
    const pruned = pruneLineOverrides(taxState, next.map((line) => line.key));
    if (pruned !== taxState) setTaxState(pruned);
  };
  const changeTax = (next: InvoiceTaxState): void => {
    setProblem(null);
    setTaxState(next);
  };

  const save = async (): Promise<void> => {
    if (sendTax && !taxResult.ok) {
      setProblem("tax");
      return;
    }
    if (sendTax && notesMissing.length > 0) {
      setProblem("notes");
      return;
    }
    const built = buildUpdateInput(invoice, {
      number,
      issueDate,
      dueDate,
      notes,
      locale: language === KEEP_LANGUAGE ? null : language,
      lines,
      tax: sendTax && taxResult.ok ? taxResult.inputs : null,
    });
    if (!built.ok) {
      setProblem(built.reason);
      return;
    }
    if (!built.changed) {
      setProblem("nothing");
      return;
    }
    setSaving(true);
    try {
      const outcome = await updateInvoice(built.input);
      switch (outcome.kind) {
        case "updated":
          onSaved(outcome.invoice);
          return;
        case "conflict":
          setProblem("conflict");
          return;
        case "number-taken":
          setProblem("number-taken");
          return;
        case "refused":
          setProblem(outcome.code === "invoice-not-draft" ? "not-draft" : "einvoice-issued");
          return;
        case "error":
          return;
      }
    } finally {
      setSaving(false);
    }
  };

  const reload = (): void => {
    void utils.invoices.invalidate();
    onCancel();
  };

  const problemText = (): string | null => {
    switch (problem) {
      case null:
        return null;
      case "invalid-lines":
        return t("invoices.edit.invalidLines");
      case "number":
        return t("invoices.edit.invalidNumber");
      case "dates":
        return t("invoices.edit.invalidDates");
      case "tax":
        return !taxResult.ok && taxResult.errorKey === "oMixed" ? te("tax.oMixed") : te("tax.rate");
      case "notes":
        return te("tax.noteRequired");
      case "nothing":
        return t("invoices.edit.nothingChanged");
      case "conflict":
        return t("invoices.edit.conflict");
      case "number-taken":
        return t("invoices.edit.numberTaken");
      case "not-draft":
        return t("invoices.edit.notDraft");
      case "einvoice-issued":
        return t("invoices.edit.einvoiceIssued");
    }
  };
  const message = problemText();
  const busy = saving || isBusy;

  return (
    <form
      className="space-y-4"
      data-testid="invoice-edit-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h3 className="text-sm font-semibold">{t("invoices.edit.title", { number: invoice.number })}</h3>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="invoice-edit-number">{t("invoices.edit.number")}</Label>
          <Input
            id="invoice-edit-number"
            value={number}
            maxLength={40}
            aria-invalid={problem === "number" || problem === "number-taken"}
            disabled={busy}
            onChange={(event) => {
              setProblem(null);
              setNumber(event.target.value);
            }}
            data-testid="invoice-edit-number"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="invoice-edit-locale">{t("invoices.form.language")}</Label>
          <Select
            value={language}
            onValueChange={(next) => {
              setProblem(null);
              setLanguage(isLocale(next) ? next : KEEP_LANGUAGE);
            }}
          >
            <SelectTrigger id="invoice-edit-locale" data-testid="invoice-edit-locale" disabled={busy}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={KEEP_LANGUAGE}>
                {t(`invoices.languages.${invoice.locale ?? "en"}`)}
              </SelectItem>
              {SUPPORTED_LOCALES.filter((locale) => locale !== (invoice.locale ?? "en")).map((locale) => (
                <SelectItem key={locale} value={locale} lang={locale}>
                  {t(`invoices.languages.${locale}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="invoice-edit-issue-date">{t("invoices.form.issueDate")}</Label>
          <Input
            id="invoice-edit-issue-date"
            type="date"
            value={issueDate}
            disabled={busy}
            aria-invalid={problem === "dates"}
            onChange={(event) => {
              if (event.target.value === "") return;
              setProblem(null);
              setIssueDate(event.target.value);
            }}
            data-testid="invoice-edit-issue-date"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="invoice-edit-due-date">{t("invoices.form.dueDate")}</Label>
          <Input
            id="invoice-edit-due-date"
            type="date"
            value={dueDate}
            disabled={busy}
            aria-invalid={problem === "dates"}
            onChange={(event) => {
              if (event.target.value === "") return;
              setProblem(null);
              setDueDate(event.target.value);
            }}
            data-testid="invoice-edit-due-date"
          />
        </div>
      </div>

      <ManualLinesEditor
        lines={lines}
        onChange={changeLines}
        currency={invoice.currency}
        testIdPrefix="invoice-edit-lines"
        disabled={busy}
        renderLineTax={lineTaxRenderer(taxState, changeTax, (line) => te("tax.lineLabel", { line }))}
      />
      <p className="text-right text-sm text-muted-foreground" data-testid="invoice-edit-subtotal">
        {t("invoices.subtotal")}: {f.money(editorSubtotal(lines), invoice.currency)}
      </p>

      <InvoiceTaxSection
        lines={known}
        value={taxState}
        onChange={changeTax}
        hasBuyerVatId={(invoice.recipient?.vatId ?? null) !== null}
        clientId={null}
        onEditClientBilling={() => undefined}
        unsetAllowed={invoice.lineItems.every((line) => line.taxCategory === undefined)}
      />

      <div className="space-y-2">
        <Label htmlFor="invoice-edit-notes">{t("invoices.form.notes")}</Label>
        <Textarea
          id="invoice-edit-notes"
          rows={2}
          value={notes}
          maxLength={2000}
          disabled={busy}
          onChange={(event) => {
            setProblem(null);
            setNotes(event.target.value);
          }}
          data-testid="invoice-edit-notes"
        />
      </div>

      {message ? (
        <p
          className="flex flex-wrap items-center gap-2 text-sm text-destructive"
          role="alert"
          data-testid="invoice-edit-problem"
          data-problem={problem}
        >
          <span>{message}</span>
          {problem === "conflict" ? (
            <Button type="button" size="sm" variant="outline" onClick={reload} data-testid="invoice-edit-reload">
              <RotateCw className="size-4" />
              {t("invoices.edit.reload")}
            </Button>
          ) : null}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel} data-testid="invoice-edit-cancel">
          {t("invoices.edit.cancel")}
        </Button>
        <Button type="submit" disabled={busy} data-testid="invoice-edit-save">
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          {t("invoices.edit.save")}
        </Button>
      </div>
    </form>
  );
}
