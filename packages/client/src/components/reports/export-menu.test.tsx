// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CsvExportResult,
  ExportPdfInput,
  PdfExportResult,
} from "@starter/shared";

/**
 * The download helper and the toaster are the two observable ends of an
 * export: what bytes reached the browser, and what the user was told. Both are
 * mocked so the test can assert on them without a DOM download or a portal.
 */
const downloadBlob = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@/lib/download", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/download")>()),
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

const { buildExportInput, canDownloadFiles, csvResultFile, exportReport, pdfResultFile } =
  await import("./export-menu");

type ExportedFile = { filename: string; blob: Blob };

const INPUT: ExportPdfInput = {
  from: "2026-08-01",
  to: "2026-08-31",
  report: "summary",
  groupBy: "project",
};

const PDF_RESULT: PdfExportResult = {
  filename: "summary-2026-08-01_2026-08-31.pdf",
  base64: btoa("%PDF-1.7 \u00ff"),
  mimeType: "application/pdf",
};

const CSV_RESULT: CsvExportResult = {
  filename: "summary-2026-08-01_2026-08-31.csv",
  csv: "Project,Duration\nWebsite,1:00:00\n",
};

const PDF_FILE: ExportedFile = {
  filename: PDF_RESULT.filename,
  blob: new Blob(["%PDF-1.7"], { type: "application/pdf" }),
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

describe("exportReport", () => {
  it("hands the fetched file to the downloader and says so", async () => {
    const fetchFile = vi.fn(async (): Promise<ExportedFile> => PDF_FILE);

    await exportReport("pdf", fetchFile, INPUT);

    expect(fetchFile).toHaveBeenCalledWith(INPUT);
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    expect(downloadBlob).toHaveBeenCalledWith(PDF_FILE.filename, PDF_FILE.blob);
    expect(toastSuccess).toHaveBeenCalledWith(`Exported ${PDF_FILE.filename}`);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("surfaces a failed render as a toast instead of throwing", async () => {
    const fetchFile = vi.fn(async (): Promise<ExportedFile> => {
      throw new Error("Report is too large to render");
    });

    // Resolving rather than rejecting is the point: the caller only flips its
    // pending flag back, so a throw here would escape as an unhandled rejection.
    await expect(exportReport("pdf", fetchFile, INPUT)).resolves.toBeUndefined();

    expect(downloadBlob).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("Report is too large to render");
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("falls back to a generic message when the failure is not an Error", async () => {
    const fetchFile = vi.fn(async (): Promise<ExportedFile> => {
      throw "nope";
    });

    await exportReport("csv", fetchFile, INPUT);

    expect(toastError).toHaveBeenCalledWith("Could not export the report");
  });

  it("shows the generic message for a server error, never its text", async () => {
    const failure = Object.assign(new Error("Internal server error"), {
      data: { code: "INTERNAL_SERVER_ERROR" },
    });
    await exportReport("csv", async () => Promise.reject(failure), INPUT);
    expect(toastError).toHaveBeenCalledWith("Could not export the report");
  });
});

describe("the tRPC fallback's answers as files", () => {
  it("prefixes a BOM to a CSV that has none", async () => {
    const file = csvResultFile(CSV_RESULT);
    expect(file.filename).toBe(CSV_RESULT.filename);
    expect(file.blob.type).toBe("text/csv;charset=utf-8;");
    // `blob.text()` decodes as UTF-8, and that algorithm strips a leading BOM —
    // so the bytes are the only place the BOM is still observable.
    const bytes = new Uint8Array(await file.blob.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    await expect(file.blob.text()).resolves.toBe(CSV_RESULT.csv);
  });

  it("never doubles the BOM the server already wrote", async () => {
    const file = csvResultFile({ ...CSV_RESULT, csv: `\uFEFF${CSV_RESULT.csv}` });
    const bytes = new Uint8Array(await file.blob.arrayBuffer());
    expect([...bytes.slice(0, 6)]).toEqual([0xef, 0xbb, 0xbf, 0x50, 0x72, 0x6f]);
  });

  it("decodes the PDF's base64 into the original bytes", async () => {
    const file = pdfResultFile(PDF_RESULT);
    expect(file.filename).toBe(PDF_RESULT.filename);
    expect(file.blob.type).toBe("application/pdf");
    const bytes = new Uint8Array(await file.blob.arrayBuffer());
    expect(bytes[bytes.length - 1]).toBe(0xff);
    expect(bytes.length).toBe(atob(PDF_RESULT.base64).length);
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
    const fetchFile = vi.fn(async (): Promise<ExportedFile> => PDF_FILE);

    await exportReport("pdf", fetchFile, INPUT);

    // No request is even made — nothing could have been done with the answer.
    expect(fetchFile).not.toHaveBeenCalled();
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(String(toastError.mock.calls[0]?.[0])).toContain("PDF");
  });

  it("blocks the CSV on the same shells, naming that format", async () => {
    asNative(true);
    const fetchFile = vi.fn(async (): Promise<ExportedFile> => PDF_FILE);

    await exportReport("csv", fetchFile, INPUT);

    expect(fetchFile).not.toHaveBeenCalled();
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(String(toastError.mock.calls[0]?.[0])).toContain("CSV");
  });
});
