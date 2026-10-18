import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_LEVEL } from "@starter/shared";

/**
 * The streamed export's request, asserted the way `trpc.test.ts` asserts the
 * tRPC link's: on web the cookie and no `authorization`, on a token shell the
 * bearer token and no cookie, and on both the client label, the version
 * headers and the active workspace. Then what each answer becomes — a file,
 * a refusal the toast can word, or "this server is too old, use tRPC".
 */
const state = {
  shell: "web" as "web" | "capacitor" | "electron",
  token: null as string | null,
  supports: true,
  workspace: "ws-active" as string | null,
};
const noteClientTooOld = vi.fn();

vi.mock("@/lib/shell", async () =>
  (await import("@/lib/shell-mock")).mockShellModule(() => state.shell),
);
vi.mock("@/lib/native-session", () => ({ getNativeToken: () => state.token }));
vi.mock("@/lib/app-version", () => ({ APP_VERSION: "9.8.7" }));
vi.mock("@/lib/server-level", () => ({
  serverSupportsNow: () => state.supports,
  noteClientTooOld: () => noteClientTooOld(),
}));
vi.mock("@/lib/active-workspace", () => ({
  whenActiveWorkspaceReady: () => Promise.resolve(),
  getActiveWorkspaceId: () => state.workspace,
}));
vi.mock("@/lib/api-origin", () => ({
  whenApiOriginReady: () => Promise.resolve(),
  rebaseApiUrl: (url: string) => (state.shell === "web" ? url : url.replace(/^[^/]*\/\/[^/]+/, "https://chosen.example")),
}));

const {
  exportReportFile,
  fetchReportExport,
  ReportExportError,
  ReportExportUnavailableError,
} = await import("./report-export");

const INPUT = {
  from: "2026-08-01",
  to: "2026-08-31",
  report: "detailed" as const,
  timeZone: "Europe/Berlin",
};

type Seen = { url: string; init: RequestInit };
let seen: Seen[] = [];
const answer = (response: () => Response): void => {
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return response();
  }) as typeof fetch;
};
const original = globalThis.fetch;

beforeEach(() => {
  state.shell = "web";
  state.token = null;
  state.supports = true;
  state.workspace = "ws-active";
  seen = [];
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example");
});

afterEach(() => {
  globalThis.fetch = original;
  vi.unstubAllEnvs();
});

const csvResponse = (): Response =>
  new Response("﻿Date,Start\r\n", {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="trackyourtime-detailed-2026-08-01_2026-08-31.csv"',
    },
  });

describe("fetchReportExport — the request", () => {
  it("on web: the cookie, no authorization, the label, the version and the workspace", async () => {
    answer(csvResponse);
    await fetchReportExport("csv", INPUT);

    expect(seen).toHaveLength(1);
    const [{ url, init }] = seen as [Seen];
    expect(url).toBe("https://api.example/api/reports/export");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-trackyourtime-client")).toBe("web");
    expect(headers.get("x-trackyourtime-client-version")).toBe("9.8.7");
    expect(headers.get("x-trackyourtime-api-level")).toBe(String(API_LEVEL));
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({
      ...INPUT,
      format: "csv",
      workspaceId: "ws-active",
    });
  });

  it("on the desktop shell: the bearer token, no cookie, the chosen server", async () => {
    state.shell = "electron";
    state.token = "tok-123";
    answer(csvResponse);
    await fetchReportExport("pdf", { ...INPUT, locale: "de" });

    const [{ url, init }] = seen as [Seen];
    expect(url).toBe("https://chosen.example/api/reports/export");
    expect(init.credentials).toBe("omit");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer tok-123");
    expect(headers.get("x-trackyourtime-client")).toBe("trackyourtime-desktop");
    expect(JSON.parse(String(init.body))).toMatchObject({ format: "pdf", locale: "de" });
  });

  it("never overwrites a workspace the input names", async () => {
    answer(csvResponse);
    await fetchReportExport("csv", { ...INPUT, workspaceId: "ws-named" } as typeof INPUT);
    expect(JSON.parse(String(seen[0]!.init.body)).workspaceId).toBe("ws-named");
  });
});

describe("fetchReportExport — the answer", () => {
  it("returns the body as a Blob under the server's filename", async () => {
    answer(csvResponse);
    const file = await fetchReportExport("csv", INPUT);
    expect(file.filename).toBe("trackyourtime-detailed-2026-08-01_2026-08-31.csv");
    const bytes = new Uint8Array(await file.blob.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("names the file itself when the header is unreadable", async () => {
    answer(() => new Response("%PDF", { status: 200 }));
    const file = await fetchReportExport("pdf", INPUT);
    expect(file.filename).toBe("trackyourtime-detailed-2026-08-01_2026-08-31.pdf");
  });

  it("turns a refusal into an error carrying tRPC's code and the message", async () => {
    answer(() => Response.json(
      { error: { code: "BAD_REQUEST", message: "`to` must be after `from`", versionRefusal: null } },
      { status: 400 },
    ));
    const failure = await fetchReportExport("csv", INPUT).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReportExportError);
    expect((failure as InstanceType<typeof ReportExportError>).data.code).toBe("BAD_REQUEST");
    expect((failure as Error).message).toBe("`to` must be after `from`");
    expect(noteClientTooOld).not.toHaveBeenCalled();
  });

  it("records a CLIENT_TOO_OLD refusal for the banner", async () => {
    answer(() => Response.json(
      { error: { code: "PRECONDITION_FAILED", message: "update", versionRefusal: "CLIENT_TOO_OLD" } },
      { status: 412 },
    ));
    await expect(fetchReportExport("csv", INPUT)).rejects.toBeInstanceOf(ReportExportError);
    expect(noteClientTooOld).toHaveBeenCalledTimes(1);
  });

  it("tells a missing route (an older server's 404) from the route's own NOT_FOUND", async () => {
    answer(() => Response.json({ error: "Not found" }, { status: 404 }));
    await expect(fetchReportExport("csv", INPUT)).rejects.toBeInstanceOf(ReportExportUnavailableError);

    answer(() => Response.json(
      { error: { code: "NOT_FOUND", message: "NOT_FOUND", versionRefusal: null } },
      { status: 404 },
    ));
    await expect(fetchReportExport("csv", INPUT)).rejects.toBeInstanceOf(ReportExportError);
  });

  it("reads a non-JSON failure (a proxy page) as a server error", async () => {
    answer(() => new Response("<html>Bad gateway</html>", { status: 502 }));
    const failure = await fetchReportExport("csv", INPUT).catch((error: unknown) => error);
    expect((failure as InstanceType<typeof ReportExportError>).data.code).toBe("INTERNAL_SERVER_ERROR");
  });
});

describe("exportReportFile — streamed first, tRPC when the server is older", () => {
  const legacyFile = { filename: "legacy.csv", blob: new Blob(["x"]) };

  it("streams when the server supports it, without touching tRPC", async () => {
    answer(csvResponse);
    const legacy = vi.fn(async () => legacyFile);
    const file = await exportReportFile("csv", INPUT, legacy);
    expect(file.filename).toBe("trackyourtime-detailed-2026-08-01_2026-08-31.csv");
    expect(legacy).not.toHaveBeenCalled();
  });

  it("uses tRPC on a server whose level is known to be too low", async () => {
    state.supports = false;
    answer(csvResponse);
    const legacy = vi.fn(async () => legacyFile);
    await expect(exportReportFile("csv", INPUT, legacy)).resolves.toBe(legacyFile);
    expect(seen).toHaveLength(0);
  });

  it("falls back when an unknown-level server turns out not to have the route", async () => {
    answer(() => Response.json({ error: "Not found" }, { status: 404 }));
    const legacy = vi.fn(async () => legacyFile);
    await expect(exportReportFile("csv", INPUT, legacy)).resolves.toBe(legacyFile);
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("does not hide a real refusal behind the fallback", async () => {
    answer(() => Response.json(
      { error: { code: "UNAUTHORIZED", message: "UNAUTHORIZED", versionRefusal: null } },
      { status: 401 },
    ));
    const legacy = vi.fn(async () => legacyFile);
    await expect(exportReportFile("csv", INPUT, legacy)).rejects.toBeInstanceOf(ReportExportError);
    expect(legacy).not.toHaveBeenCalled();
  });
});
