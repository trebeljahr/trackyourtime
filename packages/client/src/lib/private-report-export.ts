import {
  csvFilename, detailedCsvColumns, detailedCsvRows, privateReportExportData,
  resolveTimeZone, summaryCsvColumns, summaryCsvRows, toCsv,
  weeklyCsvColumns, weeklyCsvRows,
} from "@starter/core";
import type { ReportExportFormat } from "@starter/shared";
import type { WorkspaceContentRoute } from "./private-content-route";
import { PrivateContentUnavailableError } from "./private-content-error";
import type { ExportedFile, ReportExportRequest } from "./report-export";
import { openPrivateWorkspaceSession } from "./private-workspace-session";

/** Explicit user export only. The downloaded file is plaintext by intent;
 * background recovery backups use their separate encrypted file format. */
export async function exportPrivateReportFile(route: WorkspaceContentRoute, format: ReportExportFormat, input: ReportExportRequest): Promise<ExportedFile> {
  route.check();
  if (route.mode !== "encrypted" || !route.scope.workspaceId) throw new PrivateContentUnavailableError();
  let session: Awaited<ReturnType<typeof openPrivateWorkspaceSession>> | null = null;
  try {
    session = await openPrivateWorkspaceSession(route.scope.userId, route.scope.workspaceId);
    const opened = session;
    const check = () => { route.check(); if (!opened.current()) throw new PrivateContentUnavailableError("Private data changed before export finished"); };
    check(); const view = await opened.read(); check();
    const now = Date.now(), timeZone = resolveTimeZone(input.timeZone);
    const data = privateReportExportData({ input: { ...input, format }, scope: opened.scope, directory: opened.directory, policy: opened.policy, records: view.records, now, current: () => { try { check(); return true; } catch { return false; } } });
    const filename = csvFilename(data.report, data.filenameRange.from, data.filenameRange.to).replace(/\.csv$/, `.${format}`);
    if (format === "csv") {
      const csv = data.report === "summary" ? toCsv(summaryCsvRows(data.result), summaryCsvColumns(data.result.moneyVisible))
        : data.report === "weekly" ? toCsv(weeklyCsvRows(data.result), weeklyCsvColumns(data.result))
        : toCsv(detailedCsvRows(data.result, timeZone, now), detailedCsvColumns(data.result.moneyVisible));
      check(); return { filename, blob: new Blob([csv], { type: "text/csv;charset=utf-8" }) };
    }
    // Match the existing local invoice renderer: bundled font metrics, no
    // filesystem, font download, HTTP request or server PDF conversion.
    const [pdf, standalone] = await Promise.all([import("@starter/invoice-pdf/report-pdf"), import("pdfkit-standalone")]);
    check();
    const PDFDocument = ((standalone as { default?: unknown }).default ?? standalone) as import("@starter/invoice-pdf/report-pdf").ReportPdfRenderOptions["PDFDocument"];
    const locale = input.locale ?? "en", kind = data.report === "summary" ? { kind: "summary" as const, groupBy: input.groupBy ?? "project" as const } : { kind: data.report };
    const currency = data.report === "weekly" ? data.currency : data.result.currency;
    const meta = { title: pdf.reportPdfTitle(locale, kind), locale, from: data.filenameRange.from, to: data.filenameRange.to, timeZone, currency, moneyVisible: data.result.moneyVisible, generatedAt: new Date(now).toISOString(), renderOptions: { PDFDocument, nowMs: now } };
    const bytes = data.report === "summary" ? await pdf.renderSummaryPdf(data.result, meta, input.groupBy ?? "project")
      : data.report === "weekly" ? await pdf.renderWeeklyPdf(data.result, meta)
      : await pdf.renderDetailedPdf(data.result, meta);
    check(); return { filename, blob: new Blob([bytes as BlobPart], { type: "application/pdf" }) };
  } catch (error) {
    if (error instanceof PrivateContentUnavailableError) throw error;
    throw new PrivateContentUnavailableError("Private report export could not be verified. Existing data was kept.");
  } finally { session?.close(); }
}
