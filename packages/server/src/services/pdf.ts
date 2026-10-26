/** Node adapters around the portable report renderer. Keep the existing
 * Buffer results and streamed sink contract for REST/tRPC callers. */
import type { DetailedEntry } from "@starter/shared";
import * as portable from "@starter/invoice-pdf/report-pdf";
import type { ExportSink } from "./report-export/sink.js";
export * from "@starter/invoice-pdf/report-pdf";
export async function renderSummaryPdf(...args: Parameters<typeof portable.renderSummaryPdf>): Promise<Buffer> {
  return Buffer.from(await portable.renderSummaryPdf(...args));
}
export async function renderDetailedPdf(...args: Parameters<typeof portable.renderDetailedPdf>): Promise<Buffer> {
  return Buffer.from(await portable.renderDetailedPdf(...args));
}
export async function renderWeeklyPdf(...args: Parameters<typeof portable.renderWeeklyPdf>): Promise<Buffer> {
  return Buffer.from(await portable.renderWeeklyPdf(...args));
}
export async function writeDetailedPdf(
  totals: portable.DetailedPdfTotals,
  meta: portable.PdfReportMeta,
  batches: Iterable<readonly DetailedEntry[]> | AsyncIterable<readonly DetailedEntry[]>,
  nowMs: number,
  sink: ExportSink,
): Promise<void> {
  await portable.writeDetailedPdf(totals, meta, batches, nowMs, {
    write: (chunk) => sink.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    ready: () => sink.ready(),
  });
}
