"use client";

import * as React from "react";
import Link from "next/link";
import { AlertOctagon, Info, Loader2 } from "lucide-react";
import {
  DEFAULT_EXEMPTION_NOTES,
  emptyBusinessProfile,
  type BusinessProfile,
  type ClientBilling,
  type EinvoiceFillPreview,
  type EinvoiceIssue,
  type EinvoiceProfile,
  type Locale,
  type TotalsMismatch,
} from "@starter/shared";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import {
  fillFieldLabelKey,
  fillPathTarget,
  fillSourceValue,
  fixHref,
  needsExemptionNote,
  type TaxChoice,
} from "@/components/einvoice/billing-fields";
import { TaxChoiceSelect } from "@/components/einvoice/tax-choice-select";
import { CLIENT_LIST_INPUT } from "@/components/catalog/types";
import { useLocale } from "@/i18n/locale-store";
import { icuLocale } from "@/i18n/translator";
import { useT } from "@/i18n/use-t";
import { formatMoney } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { EinvoiceIssues } from "./einvoice-issues";
import { formatDate, type InvoiceRow } from "./types";
import { useAttachEinvoiceData, useEinvoiceCheck, type AttachEinvoiceVars } from "./use-einvoice";

type ZeroRateCategory = "E" | "AE" | "O" | "Z";

export type EinvoiceFillBodyProps = {
  invoice: Pick<
    InvoiceRow,
    | "id"
    | "number"
    | "status"
    | "clientId"
    | "clientName"
    | "issueDate"
    | "dueDate"
    | "subtotal"
    | "taxAmount"
    | "total"
    | "currency"
    | "locale"
  >;
  fill: EinvoiceFillPreview;
  issuesAfterFill: readonly EinvoiceIssue[];
  /** Today's business profile: what an issuer fill copies. */
  profile: BusinessProfile;
  /** null when the client was deleted. */
  clientBilling: ClientBilling | null;
  /** Issues of a refused attach (nothing was written). */
  refusal: readonly EinvoiceIssue[] | null;
  conflict: boolean;
  error: string | null;
  isPending: boolean;
  onSubmit: (vars: AttachEinvoiceVars) => void;
  onCancel: () => void;
  onReload: () => void;
  onDownloadPdf: () => void;
};

const zeroCategory = (choice: TaxChoice | null): ZeroRateCategory | null =>
  choice !== null && (choice.kind === "E" || choice.kind === "AE" || choice.kind === "O" || choice.kind === "Z")
    ? choice.kind
    : null;

/** The fill confirmation. Presentational: data and the attach call come in as props. */
export function EinvoiceFillBody({
  invoice,
  fill,
  issuesAfterFill,
  profile,
  clientBilling,
  refusal,
  conflict,
  error,
  isPending,
  onSubmit,
  onCancel,
  onReload,
  onDownloadPdf,
}: EinvoiceFillBodyProps): React.JSX.Element {
  const t = useT("einvoice");
  const tc = useT("common");
  const uiLocale = icuLocale(useLocale());
  const noteLocale: Locale = invoice.locale ?? uiLocale;
  const [choice, setChoice] = React.useState<TaxChoice | null>(null);
  const [note, setNote] = React.useState("");
  const [checked, setChecked] = React.useState(false);

  const money = (amount: number): string => formatMoney(amount, invoice.currency);
  const lineTax = fill.lineTax;
  const category = zeroCategory(choice);
  const needsNote = category !== null && needsExemptionNote(category);
  // Everything a fill writes is drawn on the invoice PDF too, so the dialog
  // names each kind of change to the printed page before the user confirms.
  const copiesParties = fill.fields.some(
    (path) => path.startsWith("issuer") || path.startsWith("recipient"),
  );
  const addsTaxRows =
    lineTax === "choose" ||
    fill.fields.some((path) => path.startsWith("taxBreakdown") || path.startsWith("lineItems"));
  const writesTerms = fill.fields.includes("paymentTerms");
  const inconsistent = lineTax === "inconsistent";
  const blockingRefusal = refusal !== null && refusal.length > 0 ? refusal : null;
  const count = Math.max(fill.fields.length, lineTax === "choose" ? 1 : 0);

  const pick = (next: TaxChoice): void => {
    setChoice(next);
    const nextCategory = zeroCategory(next);
    if (nextCategory !== null && needsExemptionNote(nextCategory)) {
      setNote(
        nextCategory === "E" && profile.smallBusiness && profile.smallBusinessNote
          ? profile.smallBusinessNote
          : DEFAULT_EXEMPTION_NOTES[noteLocale][nextCategory],
      );
    } else {
      setNote("");
    }
  };

  const canConfirm =
    checked &&
    !isPending &&
    (lineTax !== "choose" || (category !== null && (!needsNote || note.trim() !== "")));

  const submit = (): void => {
    if (!canConfirm) return;
    const vars: AttachEinvoiceVars = { id: invoice.id, confirm: true };
    if (lineTax === "choose" && category !== null) {
      vars.zeroRateCategory = category;
      if (category !== "Z") vars.exemptionNotes = { [category]: note.trim() };
    }
    onSubmit(vars);
  };

  const mismatchView = (mismatch: TotalsMismatch | null): React.JSX.Element => (
    <div className="space-y-3 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm" data-testid="einvoice-fill-mismatch">
      <p className="flex items-start gap-2 font-medium text-destructive">
        <AlertOctagon className="mt-0.5 size-4 shrink-0" />
        {t("fill.mismatch.title")}
      </p>
      {mismatch ? (
        <>
          <p>{t("fill.mismatch.body")}</p>
          <table className="w-full text-right tabular-nums" data-testid="einvoice-fill-mismatch-table">
            <thead>
              <tr className="text-muted-foreground">
                <th />
                <th className="font-normal">{t("fill.mismatch.stored")}</th>
                <th className="font-normal">{t("fill.mismatch.standard")}</th>
              </tr>
            </thead>
            <tbody>
              {(["subtotal", "taxAmount", "total"] as const).map((key) => {
                const differs = mismatch.stored[key] !== mismatch.recomputed[key];
                return (
                  <tr key={key} data-testid={`einvoice-fill-mismatch-${key}`} data-differs={differs ? "true" : "false"}>
                    <th className="text-left font-normal">
                      {t(`fill.mismatch.${key === "taxAmount" ? "tax" : key}`)}
                    </th>
                    <td className={cn(differs && "font-semibold text-destructive")}>{money(mismatch.stored[key])}</td>
                    <td className={cn(differs && "font-semibold text-destructive")}>{money(mismatch.recomputed[key])}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      ) : null}
      <p>{t("fill.mismatch.after")}</p>
      <Button type="button" size="sm" variant="outline" onClick={onDownloadPdf} data-testid="einvoice-fill-download-pdf">
        {t("issues.downloadPdf")}
      </Button>
    </div>
  );

  const header = (
    <>
      <DialogHeader>
        <DialogTitle>{t("fill.title", { number: invoice.number })}</DialogTitle>
        <DialogDescription data-testid="einvoice-fill-frozen">
          {t("fill.frozen", {
            subtotal: money(invoice.subtotal),
            tax: money(invoice.taxAmount),
            total: money(invoice.total),
          })}
        </DialogDescription>
      </DialogHeader>
    </>
  );

  const closeOnly = (
    <DialogFooter>
      <Button type="button" variant="outline" onClick={onCancel} data-testid="einvoice-fill-cancel">
        {tc("actions.close")}
      </Button>
    </DialogFooter>
  );

  if (fill.mismatch !== null || blockingRefusal?.some((issue) => issue.code === "TOTALS_MISMATCH")) {
    return (
      <div className="space-y-4">
        {header}
        {mismatchView(fill.mismatch)}
        {closeOnly}
      </div>
    );
  }
  if (inconsistent) {
    return (
      <div className="space-y-4">
        {header}
        <p className="rounded-md border border-destructive/40 p-3 text-sm" data-testid="einvoice-fill-inconsistent">
          {t("fill.inconsistent")}
        </p>
        {closeOnly}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {header}
      {fill.fields.length > 0 ? (
        <section className="space-y-2" data-testid="einvoice-fill-fields">
          <p className="flex items-start gap-2 text-sm font-semibold">
            <Info className="mt-0.5 size-4 shrink-0" />
            {t("fill.today", { date: formatDate(invoice.issueDate) })}
          </p>
          <ul className="divide-y divide-border rounded-md border border-border text-sm">
            {fill.fields.map((path) => {
              const labelKey = fillFieldLabelKey(path);
              const source = fillSourceValue(path, profile, clientBilling, invoice.clientName);
              const target = fillPathTarget(path);
              const editHref =
                source === null || target === null || (source.source === "client" && clientBilling === null)
                  ? null
                  : fixHref(target.fixIn, target.field, {
                      invoiceId: invoice.id,
                      clientId: invoice.clientId,
                    });
              return (
                <li key={path} className="flex items-start justify-between gap-3 p-2" data-testid="einvoice-fill-field" data-path={path}>
                  <div className="min-w-0 space-y-0.5">
                    <p className="font-medium">{labelKey ? t(`fill.fieldLabels.${labelKey}`) : path}</p>
                    {path === "paymentTerms" ? (
                      <p className="text-muted-foreground" data-testid="einvoice-fill-payment-terms-due">
                        {t("fill.paymentTermsFromDueDate", { date: formatDate(invoice.dueDate) })}
                      </p>
                    ) : null}
                    {source !== null ? (
                      <p className="whitespace-pre-line break-words text-muted-foreground">
                        {source.value ??
                          (source.source === "client" && clientBilling === null
                            ? t("fill.clientDeleted")
                            : t("fill.noValue"))}
                      </p>
                    ) : null}
                  </div>
                  {source !== null ? (
                    <div className="flex shrink-0 flex-col items-end gap-1 text-xs">
                      <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                        {t(`fill.source.${source.source}`)}
                      </span>
                      {editHref ? (
                        <Link href={editHref} className="underline underline-offset-2" data-testid="einvoice-fill-edit-link">
                          {t("fill.edit")}
                        </Link>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {lineTax === "fixed" && fill.fixedTax ? (
        <p className="rounded-md bg-muted/50 p-3 text-sm" data-testid="einvoice-fill-tax-fixed">
          {t("fill.fixed", { rate: String(fill.fixedTax.rate) })}
        </p>
      ) : null}

      {lineTax === "choose" ? (
        <section className="space-y-2" data-field="zeroRateCategory">
          <Label htmlFor="einvoice-fill-zero-category">{t("fill.choose")}</Label>
          <TaxChoiceSelect
            id="einvoice-fill-zero-category"
            mode="zeroRate"
            value={choice}
            onChange={pick}
            optionTag={profile.smallBusiness ? { E: t("fill.yourProfile") } : undefined}
            testId="einvoice-fill-zero-category"
          />
          {category !== null ? (
            <p className="text-xs text-muted-foreground" data-testid="einvoice-fill-choose-help">
              {t(`fill.chooseHelp.${category}`)}
            </p>
          ) : null}
          {needsNote ? (
            <div className="space-y-1">
              <Label htmlFor="einvoice-fill-exemption-note">{t("fill.noteLabel")}</Label>
              <Textarea
                id="einvoice-fill-exemption-note"
                rows={2}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                aria-invalid={note.trim() === ""}
                data-testid="einvoice-fill-exemption-note"
              />
              {note.trim() === "" ? (
                <p className="text-xs text-destructive">{t("tax.noteRequired")}</p>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {copiesParties || addsTaxRows || writesTerms ? (
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground" data-testid="einvoice-fill-also-on-pdf">
          {copiesParties ? <li data-testid="einvoice-fill-pdf-parties">{t("fill.alsoOnPdf")}</li> : null}
          {addsTaxRows ? <li data-testid="einvoice-fill-pdf-tax">{t("fill.alsoOnPdfTax")}</li> : null}
          {writesTerms ? <li data-testid="einvoice-fill-pdf-terms">{t("fill.alsoOnPdfTerms")}</li> : null}
        </ul>
      ) : null}

      {issuesAfterFill.length > 0 || blockingRefusal ? (
        <section className="space-y-2">
          <h4 className="text-sm font-medium">{t("fill.remaining")}</h4>
          <EinvoiceIssues
            issues={blockingRefusal ?? issuesAfterFill}
            invoiceId={invoice.id}
            clientName={invoice.clientName}
            isDraft={invoice.status === "draft"}
            onDownloadPdf={onDownloadPdf}
            testIdPrefix="einvoice-fill-remaining"
          />
        </section>
      ) : null}

      {conflict ? (
        <p className="flex items-center gap-2 text-sm text-destructive" role="alert" data-testid="einvoice-fill-conflict">
          {t("fill.conflict")}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setChecked(false);
              onReload();
            }}
            data-testid="einvoice-fill-reload"
          >
            {t("fill.reload")}
          </Button>
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert" data-testid="einvoice-fill-error">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Checkbox
          id="einvoice-fill-confirm-check"
          checked={checked}
          onCheckedChange={(value) => setChecked(value === true)}
          data-testid="einvoice-fill-confirm-check"
        />
        <Label htmlFor="einvoice-fill-confirm-check">{t("fill.confirmCheck")}</Label>
      </div>

      <DialogFooter className="gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} data-testid="einvoice-fill-cancel">
          {tc("actions.cancel")}
        </Button>
        <Button type="button" disabled={!canConfirm} onClick={submit} data-testid="einvoice-fill-confirm">
          {isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          {t("fill.confirm", { count })}
        </Button>
      </DialogFooter>
    </div>
  );
}

export type EinvoiceFillDialogProps = {
  invoice: InvoiceRow;
  profile: EinvoiceProfile;
  onClose: () => void;
  onDownloadPdf: () => void;
};

/** Mounted only while open; re-runs the check so it renders from a fresh answer. */
export function EinvoiceFillDialog({
  invoice,
  profile,
  onClose,
  onDownloadPdf,
}: EinvoiceFillDialogProps): React.JSX.Element {
  const t = useT("einvoice");
  const language = useLocale();
  const check = useEinvoiceCheck(invoice.id, profile);
  const businessProfile = trpc.settings.businessProfile.useQuery(undefined, { staleTime: 0 });
  // The same list every catalog screen reads; archived clients are in it. A
  // client missing from a loaded list was deleted, so there is nothing to copy.
  const clients = trpc.clients.list.useQuery(CLIENT_LIST_INPUT, { staleTime: 0 });
  const clientBilling =
    clients.data?.find((client) => client.id === invoice.clientId)?.billing ?? null;
  const { attach, isPending } = useAttachEinvoiceData();
  const [refusal, setRefusal] = React.useState<EinvoiceIssue[] | null>(null);
  const [conflict, setConflict] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const loading = check.isLoading || businessProfile.isPending || clients.isPending;

  const submit = async (vars: AttachEinvoiceVars): Promise<void> => {
    setError(null);
    setConflict(false);
    const outcome = await attach(vars);
    switch (outcome.kind) {
      case "attached":
        toast.success(t("fill.done", { number: invoice.number }));
        onClose();
        return;
      case "refused":
        setRefusal(outcome.issues);
        return;
      case "conflict":
        setConflict(true);
        return;
      case "declined":
        setError(t(`fill.refusals.${outcome.code}`));
        // A lock means the check the dialog rendered from is stale.
        if (outcome.code === "FILL_LOCKED_BY_ISSUED_XML") check.refetch();
        return;
      case "error":
        // Server messages are English; show them only to an English reader.
        setError(language === "en" && outcome.message ? outcome.message : t("fill.error"));
        return;
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg" data-testid="einvoice-fill-dialog">
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <DialogTitle className="sr-only">{t("fill.title", { number: invoice.number })}</DialogTitle>
            <Loader2 className="size-4 animate-spin" />
            {t("panel.checking")}
          </p>
        ) : check.data?.fill ? (
          <EinvoiceFillBody
            invoice={invoice}
            fill={check.data.fill}
            issuesAfterFill={check.data.issuesAfterFill}
            profile={businessProfile.data ?? emptyBusinessProfile(invoice.workspaceId)}
            clientBilling={clientBilling}
            refusal={refusal}
            conflict={conflict}
            error={error}
            isPending={isPending}
            onSubmit={(vars) => void submit(vars)}
            onCancel={onClose}
            onReload={() => {
              setConflict(false);
              setRefusal(null);
              check.refetch();
            }}
            onDownloadPdf={onDownloadPdf}
          />
        ) : (
          <div className="space-y-3">
            <DialogTitle>{t("fill.title", { number: invoice.number })}</DialogTitle>
            <p className="text-sm text-muted-foreground" data-testid="einvoice-fill-nothing">
              {check.isError ? t("panel.checkError") : t("panel.ready")}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
