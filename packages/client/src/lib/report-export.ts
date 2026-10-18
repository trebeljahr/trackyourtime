/**
 * Fetching a report export as a file.
 *
 * A server at API level 14 streams the file from `POST /api/reports/export`
 * as it is produced (packages/server/src/services/report-export/route.ts), so
 * a 100k-entry report never sits in its memory. An older server only has the
 * tRPC procedures, which answer with the whole file in JSON; the caller hands
 * that path in as `legacy`, and it is used when the server's level says so —
 * or, with the level still unknown, when the route turns out not to exist.
 *
 * The request carries what every tRPC request carries, decided the same way
 * as in `lib/trpc.ts`: the cookie on web, the bearer token and the chosen
 * server on the shells, the client label and the version headers, and the
 * active workspace in the body (`withWorkspaceId`, never over an explicit one).
 */
import { CLIENT_TOO_OLD, versionHeaders, withWorkspaceId } from "@starter/core";
import type { ReportExportFormat, ReportExportInput } from "@starter/shared";

import { getActiveWorkspaceId, whenActiveWorkspaceReady } from "@/lib/active-workspace";
import { rebaseApiUrl, whenApiOriginReady } from "@/lib/api-origin";
import { APP_VERSION } from "@/lib/app-version";
import { getNativeToken } from "@/lib/native-session";
import { noteClientTooOld, serverSupportsNow } from "@/lib/server-level";
import { clientId, isTokenShell } from "@/lib/shell";

export const REPORT_EXPORT_PATH = "/api/reports/export";

/** A generated file, ready to hand to the browser. */
export type ExportedFile = { filename: string; blob: Blob };

/** The request, minus the format the call names separately. */
export type ReportExportRequest = Omit<ReportExportInput, "format">;

/**
 * The route answered with a refusal. Shaped like a tRPC client error
 * (`data.code`), so `userErrorMessage` treats it the same way: a 500 becomes
 * the caller's fallback text, anything else keeps the server's message.
 */
export class ReportExportError extends Error {
  readonly data: { code: string };

  constructor(code: string, message: string) {
    super(message);
    this.name = "ReportExportError";
    this.data = { code };
  }
}

/** The server has no streamed export route: it predates API level 14. */
export class ReportExportUnavailableError extends Error {
  constructor() {
    super("This server has no streamed report export.");
    this.name = "ReportExportUnavailableError";
  }
}

const FILENAME = /filename="([^"]+)"/;

const fallbackFilename = (
  input: ReportExportRequest,
  format: ReportExportFormat,
): string => `trackyourtime-${input.report}-${input.from}_${input.to}.${format}`;

/** The route's refusal body, or null when the answer is not one of its own. */
const readRefusal = async (
  response: Response,
): Promise<{ code: string; message: string; versionRefusal: unknown } | null> => {
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const { code, message, versionRefusal } = error as Record<string, unknown>;
  if (typeof code !== "string") return null;
  return {
    code,
    message: typeof message === "string" ? message : "",
    versionRefusal,
  };
};

/** One streamed export, as a Blob. Throws on any refusal or transport failure. */
export async function fetchReportExport(
  format: ReportExportFormat,
  input: ReportExportRequest,
): Promise<ExportedFile> {
  // On the shells the server and the workspace are read from storage first,
  // exactly as the tRPC link waits for them; on web both are already known.
  if (isTokenShell()) await whenApiOriginReady();
  await whenActiveWorkspaceReady();

  const token = getNativeToken();
  const headers = new Headers({
    "content-type": "application/json",
    "x-trackyourtime-client": clientId(),
    ...versionHeaders(APP_VERSION),
  });
  if (token) headers.set("authorization", `Bearer ${token}`);

  const response = await fetch(
    rebaseApiUrl(`${process.env.NEXT_PUBLIC_API_URL || ""}${REPORT_EXPORT_PATH}`),
    {
      method: "POST",
      headers,
      credentials: token ? "omit" : "include",
      body: JSON.stringify(
        withWorkspaceId({ ...input, format }, getActiveWorkspaceId()),
      ),
    },
  );

  if (!response.ok) {
    const refusal = await readRefusal(response);
    // An older server answers its generic 404 for a route it does not have —
    // no `code`, which every refusal of the route itself carries.
    if (refusal === null && response.status === 404) {
      throw new ReportExportUnavailableError();
    }
    if (refusal?.versionRefusal === CLIENT_TOO_OLD) noteClientTooOld();
    throw new ReportExportError(
      refusal?.code ?? "INTERNAL_SERVER_ERROR",
      refusal?.message ?? `HTTP ${response.status}`,
    );
  }

  // Rejects when the server cut the file short, so a truncated export is
  // never saved as if it were complete.
  const blob = await response.blob();
  const named = FILENAME.exec(response.headers.get("content-disposition") ?? "");
  return { filename: named?.[1] ?? fallbackFilename(input, format), blob };
}

/**
 * The export as a file: streamed when the server can, else through `legacy`
 * (the tRPC procedure, converted to a file by the caller).
 */
export async function exportReportFile(
  format: ReportExportFormat,
  input: ReportExportRequest,
  legacy: () => Promise<ExportedFile>,
): Promise<ExportedFile> {
  if (!serverSupportsNow("reports.exportStream")) return legacy();
  try {
    return await fetchReportExport(format, input);
  } catch (error) {
    // The level was unknown and the server turned out to be older.
    if (error instanceof ReportExportUnavailableError) return legacy();
    throw error;
  }
}
