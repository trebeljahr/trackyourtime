"use client";

import * as React from "react";
import { Download, FileSpreadsheet, FileText, Loader2 } from "lucide-react";
import type {
  CsvExportResult,
  ExportCsvInput,
  ExportPdfInput,
  PdfExportResult,
  ReportFilters,
  ReportGroupBy,
} from "@starter/shared";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { shippedLocale } from "@/i18n/config";
import { useLocale } from "@/i18n/locale-store";
import { translate } from "@/i18n/translate";
import { useT } from "@/i18n/use-t";
import { downloadBase64, downloadBlob } from "@/lib/download";
import { trpc } from "@/lib/trpc";
import { userErrorMessage } from "@/lib/error-message";

/** The server also renders a weekly export; no screen in this app offers it. */
export type ExportReportKind = "summary" | "detailed";

export type ExportMenuProps = {
  report: ExportReportKind;
  filters: ReportFilters;
  /** Required by the server for `report === "summary"`. */
  groupBy?: ReportGroupBy;
  disabled?: boolean;
};

/**
 * Whether this runtime can actually receive a generated file.
 *
 * The download path is the object-URL + `<a download>` dance in
 * `@/lib/download`. A browser tab honours it, and so does Electron — its
 * renderer is Chromium, which routes blob downloads through the session's
 * download manager even when the app was loaded from `file://`. Capacitor's
 * web views do NOT: WKWebView ignores the `download` attribute outright and
 * Android's WebView needs a native DownloadListener that this shell does not
 * register (see `packages/client/src/mobile/bridge.ts` — it wires lifecycle,
 * splash and orientation, and nothing that can write a file).
 *
 * So on native mobile the click would be a silent no-op. Detect it up front
 * and say so instead, rather than spinning and pretending it worked.
 */
export function canDownloadFiles(): boolean {
  if (typeof window === "undefined") return false;
  const capacitor = (
    window as unknown as {
      Capacitor?: { isNativePlatform?: () => boolean };
    }
  ).Capacitor;
  try {
    return capacitor?.isNativePlatform?.() !== true;
  } catch {
    // A shell that throws out of its own bridge is not one we can save through.
    return false;
  }
}

/**
 * The export request for what is on screen. Only the summary is grouped: the
 * screen keeps `group` in the URL while Entries is showing, so a grouping handed
 * over for the detailed report is ignored here rather than sent along.
 */
export function buildExportInput({
  report,
  filters,
  groupBy,
}: {
  report: ExportReportKind;
  filters: ReportFilters;
  groupBy?: ReportGroupBy;
}): ExportCsvInput {
  return {
    ...filters,
    report,
    ...(report === "summary" && groupBy ? { groupBy } : {}),
  };
}

const unsupportedMessage = (format: "CSV" | "PDF"): string =>
  translate("reports")("exportMenu.unsupported", { format });

const exportedMessage = (filename: string): string =>
  translate("reports")("exportMenu.exported", { filename });

const failedMessage = (error: unknown): string =>
  userErrorMessage(error, translate("reports")("exportMenu.failed"));

/**
 * Fetch the server-rendered CSV and hand it to the browser.
 *
 * Takes the fetcher rather than reaching for `trpc.useUtils()` itself so the
 * whole path — request shape, filename, failure handling — is testable without
 * a tRPC provider. Never throws: every outcome becomes a toast.
 */
export async function exportCsvReport(
  fetchCsv: (input: ExportCsvInput) => Promise<CsvExportResult>,
  input: ExportCsvInput,
): Promise<void> {
  if (!canDownloadFiles()) {
    toast.error(unsupportedMessage("CSV"));
    return;
  }
  try {
    const result = await fetchCsv(input);
    // The BOM keeps Excel from mangling non-ASCII project names.
    downloadBlob(
      result.filename,
      new Blob([`\uFEFF${result.csv}`], { type: "text/csv;charset=utf-8;" }),
    );
    toast.success(exportedMessage(result.filename));
  } catch (error) {
    toast.error(failedMessage(error));
  }
}

/**
 * Fetch the server-rendered PDF and hand it to the browser.
 *
 * The bytes arrive base64-encoded because the tRPC transport is JSON; the
 * decoding lives in `@/lib/download` so the invoice PDF can reuse it. Never
 * throws: every outcome becomes a toast.
 */
export async function exportPdfReport(
  fetchPdf: (input: ExportPdfInput) => Promise<PdfExportResult>,
  input: ExportPdfInput,
): Promise<void> {
  if (!canDownloadFiles()) {
    toast.error(unsupportedMessage("PDF"));
    return;
  }
  try {
    const result = await fetchPdf(input);
    downloadBase64(result.filename, result.base64, result.mimeType);
    toast.success(exportedMessage(result.filename));
  } catch (error) {
    toast.error(failedMessage(error));
  }
}

/**
 * CSV + PDF export, shared by both report views. Both files are
 * rendered server-side (`reports.exportCsv` / `reports.exportPdf`) so they
 * always cover the whole filtered range, not just the page currently on
 * screen — and so the PDF is a real document rather than whatever the
 * browser's print dialog made of the live DOM.
 */
export function ExportMenu(props: ExportMenuProps): React.JSX.Element {
  const { report, filters, groupBy, disabled = false } = props;
  const utils = trpc.useUtils();
  const t = useT("reports");
  const tc = useT("common");
  const locale = useLocale();
  const [pending, setPending] = React.useState(false);

  const input = React.useMemo(
    (): ExportCsvInput => buildExportInput({ report, filters, groupBy }),
    [filters, groupBy, report],
  );

  const run = React.useCallback((task: () => Promise<void>): void => {
    setPending(true);
    void (async () => {
      try {
        await task();
      } finally {
        setPending(false);
      }
    })();
  }, []);

  const handleCsv = React.useCallback((): void => {
    run(() =>
      exportCsvReport(
        (payload) => utils.reports.exportCsv.fetch(payload),
        input,
      ),
    );
  }, [input, run, utils]);

  const handlePdf = React.useCallback((): void => {
    run(() =>
      exportPdfReport(
        (payload) => utils.reports.exportPdf.fetch(payload),
        { ...input, locale: shippedLocale(locale) },
      ),
    );
  }, [input, locale, run, utils]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled || pending}
          data-testid="report-export"
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Download className="size-4" />
          )}
          {tc("actions.export")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="report-export-menu">
        <DropdownMenuLabel>{t("exportMenu.title")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={handleCsv} data-testid="report-export-csv">
          <FileSpreadsheet className="size-4" />
          {t("exportMenu.csv")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handlePdf} data-testid="report-export-pdf">
          <FileText className="size-4" />
          {t("exportMenu.pdf")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
