"use client";

import * as React from "react";
import { Download, Loader2, Trash2, X } from "lucide-react";

import { ConfirmDialog } from "@/components/catalog/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useLocale } from "@/i18n/locale-store";
import { useT } from "@/i18n/use-t";
import { EinvoicePanel } from "./einvoice-panel";
import { InvoiceLines } from "./invoice-lines";
import {
  canDeleteInvoice,
  formatDate,
  formatRange,
  linesHaveMixedTax,
  statusActionLabel,
  statusBadgeTone,
  statusLabel,
  statusTransitions,
  taxCategoryLabel,
  type InvoiceRow,
} from "./types";
import { useInvoiceMutations } from "./use-invoices";

export type InvoiceDetailProps = {
  invoice: InvoiceRow;
  onClose: () => void;
  /** Called after a successful delete, so the screen can drop the selection. */
  onDeleted: () => void;
};

/**
 * One invoice, in full.
 *
 * Everything on it is a SNAPSHOT — the rates, the client's name, the currency
 * — so nothing here re-derives a number from today's catalog. Status is the
 * only field that can still move, and only along the steps the server allows.
 */
export function InvoiceDetail({
  invoice,
  onClose,
  onDeleted,
}: InvoiceDetailProps): React.JSX.Element {
  const { setStatus, removeInvoice, downloadPdf, isBusy } =
    useInvoiceMutations();
  const t = useT("reports");
  const locale = useLocale();
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);

  const transitions = statusTransitions(invoice.status);
  const deletable = canDeleteInvoice(invoice.status);

  const handleDownload = async (): Promise<void> => {
    setDownloading(true);
    try {
      await downloadPdf(invoice);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <section
      className="space-y-4 rounded-lg border border-border p-4"
      data-testid="invoice-detail"
      data-invoice-id={invoice.id}
      data-status={invoice.status}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold" data-testid="invoice-detail-number">
              {invoice.number}
            </h2>
            <Badge
              variant={statusBadgeTone(invoice.status)}
              data-testid="invoice-detail-status"
            >
              {statusLabel(invoice.status, locale)}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground" data-testid="invoice-detail-client">
            {invoice.clientName}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label={t("invoices.detail.close")}
          data-testid="invoice-detail-close"
        >
          <X className="size-4" />
        </Button>
      </header>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">{t("invoices.columns.issued")}</dt>
          <dd data-testid="invoice-detail-issued">
            {formatDate(invoice.issueDate, locale)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("invoices.columns.due")}</dt>
          <dd data-testid="invoice-detail-due">{formatDate(invoice.dueDate, locale)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("invoices.columns.billedRange")}</dt>
          <dd data-testid="invoice-detail-range">
            {formatRange(invoice.from, invoice.to, locale)}
          </dd>
        </div>
        {/* The document's own language, snapshotted at creation. An invoice
            without one predates localisation and is English for good. */}
        <div>
          <dt className="text-muted-foreground">{t("invoices.columns.language")}</dt>
          <dd data-testid="invoice-detail-language">
            {t(`invoices.languages.${invoice.locale ?? "en"}`)}
          </dd>
        </div>
      </dl>

      <InvoiceLines
        lineItems={invoice.lineItems}
        subtotal={invoice.subtotal}
        taxRate={invoice.taxRate}
        taxAmount={invoice.taxAmount}
        total={invoice.total}
        currency={invoice.currency}
        testIdPrefix="invoice-detail"
        taxBreakdown={invoice.taxBreakdown ?? null}
        renderLineTax={
          linesHaveMixedTax(invoice.lineItems)
            ? (line) =>
                line.taxCategory === undefined
                  ? "—"
                  : taxCategoryLabel(line.taxCategory, line.taxRate ?? 0)
            : null
        }
      />

      {invoice.notes ? (
        <p
          className="whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-sm"
          data-testid="invoice-detail-notes"
        >
          {invoice.notes}
        </p>
      ) : null}

      <EinvoicePanel invoice={invoice} />

      <p className="text-xs text-muted-foreground" data-testid="invoice-detail-entries">
        {deletable
          ? t("invoices.detail.entriesDraft", { count: invoice.entryIds.length })
          : t("invoices.detail.entriesFinal", { count: invoice.entryIds.length })}
      </p>

      <Separator />

      <div className="flex flex-wrap items-center gap-2">
        {transitions.map((status) => (
          <Button
            key={status}
            type="button"
            size="sm"
            variant={status === "paid" ? "default" : "outline"}
            disabled={isBusy}
            onClick={() => setStatus(invoice.id, status)}
            data-testid={`invoice-status-set-${status}`}
          >
            {statusActionLabel(invoice.status, status, locale)}
          </Button>
        ))}

        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={downloading}
          onClick={() => void handleDownload()}
          data-testid="invoice-download-pdf"
        >
          {downloading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Download className="size-4" />
          )}
          {t("invoices.detail.downloadPdf")}
        </Button>

        {deletable ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive"
            disabled={isBusy}
            onClick={() => setConfirmDelete(true)}
            data-testid="invoice-delete"
          >
            <Trash2 className="size-4" />
            {t("invoices.detail.deleteDraft")}
          </Button>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("invoices.detail.deleteTitle", { number: invoice.number })}
        description={t("invoices.detail.deleteDescription", {
          count: invoice.entryIds.length,
        })}
        confirmLabel={t("invoices.detail.deleteDraft")}
        onConfirm={() => {
          removeInvoice(invoice.id);
          onDeleted();
        }}
        testId="invoice-delete-dialog"
      />
    </section>
  );
}
