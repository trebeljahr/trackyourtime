"use client";

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  FileCode2,
  FileDown,
  Loader2,
  RotateCw,
} from "lucide-react";
import {
  recipientLegalName,
  type EinvoiceCheckResult,
  type EinvoiceIssue,
  type EinvoiceProfile,
} from "@starter/shared";

import { Button } from "@/components/ui/button";
import { OptionGroup } from "@/components/settings/option-group";
import { useT } from "@/i18n/use-t";
import { cn } from "@/lib/utils";
import { EinvoiceFillDialog } from "./einvoice-fill-dialog";
import { EinvoiceIssues } from "./einvoice-issues";
import { taxCategoryLabel, type InvoiceRow } from "./types";
import { useEinvoiceCheck } from "./use-einvoice";
import { useInvoiceMutations } from "./use-invoices";

export type EinvoiceFormat = "zugferd" | "xrechnung";

/** The validation profile a download format is checked against. */
export function profileForFormat(format: EinvoiceFormat): EinvoiceProfile {
  return format === "xrechnung" ? "xrechnung" : "en16931";
}

export type EinvoicePanelBodyProps = {
  invoice: Pick<InvoiceRow, "id" | "status" | "clientName" | "issuer" | "recipient" | "taxBreakdown">;
  check: EinvoiceCheckResult | undefined;
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  /** Issues from a refused download; they replace the check's list. */
  refusal: readonly EinvoiceIssue[] | null;
  onFill: () => void;
  onDownloadPdf: () => void;
};

/** What the panel says, by state. Presentational. */
export function EinvoicePanelBody({
  invoice,
  check,
  isLoading = false,
  isError = false,
  onRetry,
  refusal,
  onFill,
  onDownloadPdf,
}: EinvoicePanelBodyProps): React.JSX.Element {
  const t = useT("einvoice");
  const tc = useT("common");
  const isDraft = invoice.status === "draft";
  const issuesProps = {
    invoiceId: invoice.id,
    clientName: invoice.clientName,
    isDraft,
    onFill,
    onDownloadPdf,
  };

  if (refusal !== null && refusal.length > 0) {
    return (
      <div className="space-y-2">
        <p className="flex items-center gap-2 text-sm font-medium text-destructive">
          <AlertTriangle className="size-4" />
          {t("panel.refused")}
        </p>
        <EinvoiceIssues {...issuesProps} issues={refusal} testIdPrefix="einvoice-refusal" />
      </div>
    );
  }
  if (isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="einvoice-checking">
        <Loader2 className="size-4 animate-spin" />
        {t("panel.checking")}
      </p>
    );
  }
  if (isError || check === undefined) {
    return (
      <p className="flex items-center gap-2 text-sm text-destructive">
        {t("panel.checkError")}
        {onRetry ? (
          <Button type="button" size="sm" variant="ghost" onClick={onRetry} data-testid="einvoice-check-retry">
            <RotateCw className="size-3.5" />
            {tc("actions.retry")}
          </Button>
        ) : null}
      </p>
    );
  }
  if (check.hasIssuedXml) {
    return (
      <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400" data-testid="einvoice-issued">
        <CheckCircle2 className="size-4" />
        {t("panel.issued")}
      </p>
    );
  }
  if (check.ready) {
    const categories = (invoice.taxBreakdown ?? []).map((row) => taxCategoryLabel(row.category, row.rate));
    return (
      <div className="space-y-2">
        <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400" data-testid="einvoice-ready">
          <CheckCircle2 className="size-4" />
          {t("panel.ready")}
        </p>
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2" data-testid="einvoice-snapshot-summary">
          <SummaryItem label={t("panel.summary.issuer")} value={invoice.issuer?.legalName ?? null} />
          <SummaryItem
            label={t("panel.summary.recipient")}
            value={invoice.recipient ? recipientLegalName(invoice.recipient) : null}
          />
          <SummaryItem label={t("panel.summary.reference")} value={invoice.recipient?.reference ?? null} />
          <SummaryItem label={t("panel.summary.vat")} value={categories.length > 0 ? categories.join(", ") : null} />
        </dl>
      </div>
    );
  }
  if (check.fill !== null) {
    return (
      <div className="space-y-3">
        <div
          className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
          data-testid="einvoice-fill-callout"
        >
          <p className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
            {t("panel.fillCallout")}
          </p>
          <Button type="button" size="sm" variant="outline" onClick={onFill} data-testid="einvoice-fill-open">
            {t("panel.fillOpen")}
          </Button>
        </div>
        {check.issuesAfterFill.length > 0 ? (
          <div className="space-y-2">
            <h4 className="text-sm font-medium">{t("panel.stillNeeded")}</h4>
            <EinvoiceIssues {...issuesProps} issues={check.issuesAfterFill} testIdPrefix="einvoice-issues" />
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">{t("panel.missing")}</h4>
      {check.fillLocked ? (
        <p className="text-sm text-muted-foreground" data-testid="einvoice-fill-locked">
          {t("panel.fillLocked")}
        </p>
      ) : null}
      <EinvoiceIssues
        {...issuesProps}
        issues={check.issues}
        locked={check.fillLocked}
        testIdPrefix="einvoice-issues"
      />
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string | null }): React.JSX.Element | null {
  if (value === null || value === "") return null;
  return (
    <div className="flex gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

export type EinvoicePanelProps = {
  invoice: InvoiceRow;
};

/**
 * "Can I send this as an e-invoice, and if not, what do I fix and where?"
 *
 * The download buttons are never disabled by the check (the server is the
 * authority, and a stored issued XML serves even when today's check would
 * complain). A refusal comes back as issues and is shown right here.
 */
export function EinvoicePanel({ invoice }: EinvoicePanelProps): React.JSX.Element {
  const t = useT("einvoice");
  const { downloadPdf, downloadZugferd, downloadXrechnung } = useInvoiceMutations();
  const [chosen, setChosen] = React.useState<EinvoiceFormat | null>(null);
  const [expandedByUser, setExpandedByUser] = React.useState<boolean | null>(null);
  const [refusal, setRefusal] = React.useState<{ format: EinvoiceFormat; issues: EinvoiceIssue[] } | null>(null);
  const [downloading, setDownloading] = React.useState<EinvoiceFormat | null>(null);
  const [filling, setFilling] = React.useState(false);

  // The first check runs for ZUGFeRD; the client's preferred format then
  // decides the default, until the user picks one.
  const [preferred, setPreferred] = React.useState<EinvoiceFormat | null>(null);
  const format: EinvoiceFormat = chosen ?? preferred ?? "zugferd";
  const check = useEinvoiceCheck(invoice.id, profileForFormat(format));
  const preferredFormat = check.data?.preferredFormat ?? null;
  if (check.data && preferred === null && preferredFormat === "xrechnung") {
    setPreferred("xrechnung");
  }

  const prefersEinvoice = preferredFormat === "zugferd" || preferredFormat === "xrechnung";
  const ready = check.data ? check.data.ready || check.data.hasIssuedXml : null;
  const activeRefusal = refusal !== null && refusal.format === format ? refusal.issues : null;
  const expanded =
    activeRefusal !== null || (expandedByUser ?? (ready === false && prefersEinvoice));

  const download = async (target: EinvoiceFormat): Promise<void> => {
    setDownloading(target);
    try {
      const outcome = target === "zugferd" ? await downloadZugferd(invoice) : await downloadXrechnung(invoice);
      if (outcome.kind === "refused") {
        setChosen(target);
        setRefusal({ format: target, issues: outcome.issues });
        check.refetch();
      } else if (outcome.kind === "downloaded") {
        // Only a download in the refused format answers that refusal. The
        // other format succeeding says nothing about it.
        setRefusal((current) => (current?.format === target ? null : current));
      }
    } finally {
      setDownloading(null);
    }
  };

  const buttonVariant = (target: EinvoiceFormat): "default" | "outline" =>
    preferredFormat === target ? "default" : "outline";

  return (
    <section
      className="space-y-3 rounded-md border border-border p-3"
      data-testid="einvoice-panel"
      data-ready={ready === null ? "unknown" : ready ? "true" : "false"}
      data-format={format}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          className="flex items-center gap-2 text-sm font-semibold"
          aria-expanded={expanded}
          onClick={() => setExpandedByUser(!expanded)}
          data-testid="einvoice-panel-toggle"
        >
          <ChevronDown className={cn("size-4 transition-transform", expanded ? "" : "-rotate-90")} />
          {t("panel.title")}
          {ready === true ? <CheckCircle2 className="size-4 text-emerald-600" /> : null}
          {ready === false ? <AlertTriangle className="size-4 text-amber-600" /> : null}
        </button>
        <OptionGroup<EinvoiceFormat>
          label={t("panel.formatLabel")}
          value={format}
          onChange={(next) => setChosen(next)}
          options={[
            { value: "zugferd", label: t("panel.format.zugferd"), testId: "einvoice-format-zugferd" },
            { value: "xrechnung", label: t("panel.format.xrechnung"), testId: "einvoice-format-xrechnung" },
          ]}
        />
      </header>

      {expanded ? (
        <div data-testid="einvoice-panel-body">
          <EinvoicePanelBody
            invoice={invoice}
            check={check.data}
            isLoading={check.isLoading}
            isError={check.isError}
            onRetry={check.refetch}
            refusal={activeRefusal}
            onFill={() => setFilling(true)}
            onDownloadPdf={() => void downloadPdf(invoice)}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant={buttonVariant("zugferd")}
          disabled={downloading !== null}
          onClick={() => void download("zugferd")}
          data-testid="invoice-download-zugferd"
        >
          {downloading === "zugferd" ? <Loader2 className="size-4 animate-spin" /> : <FileDown className="size-4" />}
          {t("panel.download.zugferd")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={buttonVariant("xrechnung")}
          disabled={downloading !== null}
          onClick={() => void download("xrechnung")}
          data-testid="invoice-download-xrechnung"
        >
          {downloading === "xrechnung" ? <Loader2 className="size-4 animate-spin" /> : <FileCode2 className="size-4" />}
          {t("panel.download.xrechnung")}
        </Button>
      </div>

      {filling ? (
        <EinvoiceFillDialog
          invoice={invoice}
          profile={profileForFormat(format)}
          onClose={() => {
            setFilling(false);
            setRefusal(null);
          }}
          onDownloadPdf={() => void downloadPdf(invoice)}
        />
      ) : null}
    </section>
  );
}
