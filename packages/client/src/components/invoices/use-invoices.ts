"use client";

import * as React from "react";
import type { CreateInvoiceInput, EinvoiceIssue, InvoiceStatus } from "@starter/shared";

import { errorMessage } from "@/components/catalog/types";
import { toast } from "@/components/ui/sonner";
import { ORIGIN_ID } from "@/hooks/use-sync";
import { translate } from "@/i18n/translate";
import { downloadBase64 } from "@/lib/download";
import { trpc } from "@/lib/trpc";
import { statusLabel, type InvoiceRow } from "./types";
import { einvoiceIssuesFromError } from "./use-einvoice";

/**
 * Mutations for the invoicing screens.
 *
 * Deliberately NOT optimistic, unlike the catalog's. An invoice is money: its
 * number is allocated by the server, its lines are re-gathered there rather
 * than accepted from the client, and creating it stamps `invoiceId` on every
 * entry it bills. A row painted before the server answered would be a
 * document with a number nobody issued, and rolling it back after the fact
 * would leave the user unsure whether a customer had been billed. Every write
 * here waits for the real answer and then invalidates.
 */

/** A refusal carrying e-invoice issues is returned for the panel to show, never toasted. */
export type EinvoiceDownloadOutcome =
  | { kind: "downloaded" }
  | { kind: "refused"; issues: EinvoiceIssue[] }
  | { kind: "error" };

/** `originId` is stamped by the hook, never by a caller. */
export type CreateInvoiceVars = Omit<CreateInvoiceInput, "originId">;

export type InvoiceMutations = {
  /** Resolves to the created invoice, or null when the server refused. */
  createInvoice: (vars: CreateInvoiceVars) => Promise<InvoiceRow | null>;
  setStatus: (id: string, status: InvoiceStatus) => void;
  removeInvoice: (id: string) => void;
  /** Fetches the server-rendered PDF and hands it to the browser. */
  downloadPdf: (invoice: Pick<InvoiceRow, "id" | "number">) => Promise<void>;
  /** PDF/A-3 with the EN 16931 XML embedded. */
  downloadZugferd: (invoice: Pick<InvoiceRow, "id" | "number">) => Promise<EinvoiceDownloadOutcome>;
  /** The XRechnung XML alone. */
  downloadXrechnung: (invoice: Pick<InvoiceRow, "id" | "number">) => Promise<EinvoiceDownloadOutcome>;
  isCreating: boolean;
  isBusy: boolean;
};

export function useInvoiceMutations(): InvoiceMutations {
  const utils = trpc.useUtils();
  const [isDownloading, setDownloading] = React.useState(false);

  /**
   * Invoicing writes reach further than the invoice list: creating one stamps
   * `invoiceId` on entries, deleting one clears it again, and both change what
   * the next preview may bill. Entries and reports refresh with it.
   */
  const settle = React.useCallback((): void => {
    void utils.invoices.invalidate();
    void utils.entries.invalidate();
    void utils.reports.invalidate();
  }, [utils]);

  const create = trpc.invoices.create.useMutation({
    onSuccess: (invoice) => {
      toast.success(
        translate("reports")("invoices.toast.created", { number: invoice.number }),
      );
    },
    onError: (error) => {
      toast.error(
        errorMessage(error, translate("reports")("invoices.toast.createFailed")),
      );
    },
    onSettled: settle,
  });

  const updateStatus = trpc.invoices.updateStatus.useMutation({
    onSuccess: (invoice) => {
      toast.success(
        translate("reports")("invoices.toast.statusChanged", {
          number: invoice.number,
          status: statusLabel(invoice.status),
        }),
      );
    },
    onError: (error) => {
      toast.error(
        errorMessage(error, translate("reports")("invoices.toast.statusFailed")),
      );
    },
    onSettled: settle,
  });

  const remove = trpc.invoices.remove.useMutation({
    onSuccess: (result) => {
      toast.success(
        translate("reports")("invoices.toast.deleted", {
          count: result.releasedEntries,
        }),
      );
    },
    onError: (error) => {
      toast.error(
        errorMessage(error, translate("reports")("invoices.toast.deleteFailed")),
      );
    },
    onSettled: settle,
  });

  const downloadPdf = React.useCallback(
    async (invoice: Pick<InvoiceRow, "id" | "number">): Promise<void> => {
      setDownloading(true);
      try {
        // The PDF is rendered server-side and crosses the wire base64-encoded,
        // because the tRPC transport is JSON. `downloadBase64` owns the
        // decode — passing the binary string to `new Blob` would UTF-8 it.
        const result = await utils.invoices.exportPdf.fetch({ id: invoice.id });
        downloadBase64(result.filename, result.base64, result.mimeType);
      } catch (error) {
        toast.error(
          errorMessage(
            error,
            translate("reports")("invoices.toast.pdfFailed", { number: invoice.number }),
          ),
        );
      } finally {
        setDownloading(false);
      }
    },
    [utils],
  );

  /**
   * Same transport as the plain PDF. `utils.….fetch` uses the default
   * `staleTime` of 0, so a second click after fixing the profile really asks
   * the server again — do not give these fetches a staleTime.
   */
  const downloadEinvoice = React.useCallback(
    async (
      invoice: Pick<InvoiceRow, "id" | "number">,
      format: "zugferd" | "xrechnung",
    ): Promise<EinvoiceDownloadOutcome> => {
      setDownloading(true);
      try {
        const result =
          format === "zugferd"
            ? await utils.invoices.exportZugferd.fetch({ id: invoice.id })
            : await utils.invoices.exportXrechnung.fetch({ id: invoice.id });
        downloadBase64(result.filename, result.base64, result.mimeType);
        return { kind: "downloaded" };
      } catch (error) {
        const issues = einvoiceIssuesFromError(error);
        if (issues !== null && issues.length > 0) return { kind: "refused", issues };
        toast.error(
          errorMessage(
            error,
            translate("einvoice")("panel.downloadError", { number: invoice.number }),
          ),
        );
        return { kind: "error" };
      } finally {
        setDownloading(false);
      }
    },
    [utils],
  );

  return {
    createInvoice: (vars) =>
      create.mutateAsync({ ...vars, originId: ORIGIN_ID }).catch(() => null),
    setStatus: (id, status) => {
      updateStatus.mutate({ id, status, originId: ORIGIN_ID });
    },
    removeInvoice: (id) => {
      remove.mutate({ id, originId: ORIGIN_ID });
    },
    downloadPdf,
    downloadZugferd: (invoice) => downloadEinvoice(invoice, "zugferd"),
    downloadXrechnung: (invoice) => downloadEinvoice(invoice, "xrechnung"),
    isCreating: create.isPending,
    isBusy:
      create.isPending ||
      updateStatus.isPending ||
      remove.isPending ||
      isDownloading,
  };
}
