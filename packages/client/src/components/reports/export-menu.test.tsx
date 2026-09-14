// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CsvExportResult,
  ExportCsvInput,
  ExportPdfInput,
  PdfExportResult,
} from "@starter/shared";

/**
 * The download helpers and the toaster are the two observable ends of an
 * export: what bytes reached the browser, and what the user was told. Both are
 * mocked so the test can assert on them without a DOM download or a portal.
 */
const downloadBase64 = vi.fn();
const downloadBlob = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@/lib/download", () => ({
  downloadBase64: (...args: unknown[]) => downloadBase64(...args),
  downloadBlob: (...args: unknown[]) => downloadBlob(...args),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

// `trpc` is only touched by the component, but importing the module pulls the
// real client in, which wants env config at import time.
vi.mock("@/lib/trpc", () => ({
  trpc: { useUtils: () => ({ reports: {} }) },
}));

const { buildExportInput, canDownloadFiles, exportCsvReport, exportPdfReport } =
  await import("./export-menu");

const INPUT: ExportPdfInput = {
  from: "2026-08-01",
  to: "2026-08-31",
  report: "summary",
  groupBy: "project",
};

const PDF_RESULT: PdfExportResult = {
  filename: "summary-2026-08-01_2026-08-31.pdf",
  base64: btoa("%PDF-1.7"),
  mimeType: "application/pdf",
};

const CSV_RESULT: CsvExportResult = {
  filename: "summary-2026-08-01_2026-08-31.csv",
  csv: "Project,Duration\nWebsite,1:00:00\n",
};

beforeEach(() => {
  vi.clearAllMocks();
  delete (window as { Capacitor?: unknown }).Capacitor;
});

afterEach(() => {
  delete (window as { Capacitor?: unknown }).Capacitor;
});

describe("buildExportInput", () => {
  const filters = { from: "2026-08-01", to: "2026-08-31", timeZone: "UTC" };

  it("sends the grouping with the summary", () => {
    expect(
      buildExportInput({ report: "summary", filters, groupBy: "client" }),
    ).toEqual({ ...filters, report: "summary", groupBy: "client" });
  });

  it("never sends a grouping with the detailed report", () => {
    // The screen keeps `group` in the URL while Entries shows, so a caller
    // handing it over must not turn into a grouped detailed export.
    const input = buildExportInput({
      report: "detailed",
      filters,
      groupBy: "tag",
    });
    expect(input).toEqual({ ...filters, report: "detailed" });
    expect("groupBy" in input).toBe(false);
  });
});

describe("exportPdfReport", () => {
  it("hands the server's filename, bytes and mime type to the downloader", async () => {
    const fetchPdf = vi.fn(
      async (_input: ExportPdfInput): Promise<PdfExportResult> => PDF_RESULT,
    );

    await exportPdfReport(fetchPdf, INPUT);

    expect(fetchPdf).toHaveBeenCalledWith(INPUT);
    expect(downloadBase64).toHaveBeenCalledWith(
      PDF_RESULT.filename,
      PDF_RESULT.base64,
      "application/pdf",
    );
    // The PDF never goes through the CSV path — no double download.
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith(`Exported ${PDF_RESULT.filename}`);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("surfaces a failed render as a toast instead of throwing", async () => {
    const fetchPdf = vi.fn(async (): Promise<PdfExportResult> => {
      throw new Error("Report is too large to render");
    });

    // Resolving rather than rejecting is the point: the caller only flips its
    // pending flag back, so a throw here would escape as an unhandled rejection.
    await expect(exportPdfReport(fetchPdf, INPUT)).resolves.toBeUndefined();

    expect(downloadBase64).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("Report is too large to render");
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("falls back to a generic message when the failure is not an Error", async () => {
    const fetchPdf = vi.fn(async (): Promise<PdfExportResult> => {
      throw "nope";
    });

    await exportPdfReport(fetchPdf, INPUT);

    expect(toastError).toHaveBeenCalledWith("Could not export the report");
  });
});

describe("exportCsvReport", () => {
  it("prefixes a BOM and downloads the server's CSV", async () => {
    const fetchCsv = vi.fn(
      async (_input: ExportCsvInput): Promise<CsvExportResult> => CSV_RESULT,
    );

    await exportCsvReport(fetchCsv, INPUT);

    expect(fetchCsv).toHaveBeenCalledWith(INPUT);
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [filename, blob] = downloadBlob.mock.calls[0] as [string, Blob];
    expect(filename).toBe(CSV_RESULT.filename);
    expect(blob.type).toBe("text/csv;charset=utf-8;");
    // `blob.text()` decodes as UTF-8, and that algorithm strips a leading BOM \u2014
    // so the bytes are the only place the BOM is still observable.
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    await expect(blob.text()).resolves.toBe(CSV_RESULT.csv);
    expect(toastSuccess).toHaveBeenCalledWith(`Exported ${CSV_RESULT.filename}`);
  });

  it("reports a failure rather than throwing", async () => {
    const fetchCsv = vi.fn(async (): Promise<CsvExportResult> => {
      throw new Error("Session expired");
    });

    await expect(exportCsvReport(fetchCsv, INPUT)).resolves.toBeUndefined();
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("Session expired");
  });
});

describe("native shells that cannot save a file", () => {
  const asNative = (isNative: boolean): void => {
    (window as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => isNative,
    };
  };

  it("treats a plain browser as capable", () => {
    expect(canDownloadFiles()).toBe(true);
  });

  it("treats the Capacitor web view as incapable", () => {
    asNative(true);
    expect(canDownloadFiles()).toBe(false);
  });

  it("still downloads when Capacitor reports the web build", () => {
    asNative(false);
    expect(canDownloadFiles()).toBe(true);
  });

  it("degrades loudly instead of silently doing nothing", async () => {
    asNative(true);
    const fetchPdf = vi.fn(async (): Promise<PdfExportResult> => PDF_RESULT);

    await exportPdfReport(fetchPdf, INPUT);

    // No request is even made — nothing could have been done with the answer.
    expect(fetchPdf).not.toHaveBeenCalled();
    expect(downloadBase64).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(String(toastError.mock.calls[0]?.[0])).toContain("PDF");
  });

  it("blocks the CSV on the same shells, naming that format", async () => {
    asNative(true);
    const fetchCsv = vi.fn(async (): Promise<CsvExportResult> => CSV_RESULT);

    await exportCsvReport(fetchCsv, INPUT);

    expect(fetchCsv).not.toHaveBeenCalled();
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(String(toastError.mock.calls[0]?.[0])).toContain("CSV");
  });
});
