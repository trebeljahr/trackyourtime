// The streamed report export: the file a page at a time, the route around it,
// and the one promise both make — the same bytes as the export they replace.
//
// "The export they replace" is spelled out below as `legacyDetailed`: the
// paginate-then-concatenate loop `reports.exportCsv` / `exportPdf` ran before
// this, built from the functions it called, which still exist. The streamed
// writer must produce exactly its bytes, for every visibility in the shared
// workspace, across page boundaries, with a running entry, a clipped one and
// two currencies in the range.
import assert from "node:assert/strict";
import { after, beforeEach, describe, it, mock } from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import express from "express";
import { Types } from "mongoose";
import {
  currencyAmountsAccumulator,
  normalizeCurrency,
  reportMoneyVisible,
  resolveTimeZone,
  dayKeyInZone,
  type DetailedEntry,
  type ReportExportInput,
} from "@starter/shared";
import {
  buildDetailed,
  detailedCsvColumns,
  detailedCsvRows,
  planReportExport,
  reportsRouter,
  type ReportExportPlan,
  type ReportScope,
} from "../trpc/routers/reports.js";
import { toCsv } from "../services/csv.js";
import { renderDetailedPdf, reportPdfTitle } from "../services/pdf.js";
import {
  ExportAbortedError,
  bufferSink,
  writableSink,
} from "../services/report-export/sink.js";
import {
  MAX_EXPORTS_PER_USER,
  REPORT_EXPORT_PATH,
  reportExportHandler,
  type ReportExportDeps,
} from "../services/report-export/route.js";
import type { Context } from "../trpc/context.js";
import type { Row } from "./support/in-memory-models.js";
import {
  ADMIN,
  MEMBER,
  OWNER,
  PROJECT_ID,
  WORKSPACE,
  contextFor,
  freshStore,
  installStore,
  resetStore,
  type Person,
} from "./support/shared-workspace.js";

const store = freshStore();
const restore = installStore(store);
after(() => restore());

const FROZEN_NOW = Date.parse("2026-09-20T12:00:00.000Z");
const FILTERS = { from: "2026-09-01", to: "2026-09-19", timeZone: "Europe/Berlin" };

const VISIBILITY: Record<Person, ReportScope["visibility"]> = {
  [OWNER]: { userId: OWNER, canViewOthersTime: true, canViewOthersMoney: true },
  [ADMIN]: { userId: ADMIN, canViewOthersTime: true, canViewOthersMoney: false },
  [MEMBER]: { userId: MEMBER, canViewOthersTime: false, canViewOthersMoney: false },
};
const scopeOf = (person: Person): ReportScope => ({
  workspaceId: WORKSPACE,
  visibility: VISIBILITY[person],
});

const joinedProject = {
  _id: PROJECT_ID,
  workspaceId: WORKSPACE,
  name: "Rebrand",
  color: "#336699",
};

/**
 * Enough rows to cross the export's 500-entry pages twice, by all three
 * people, with the cases that make a total disagree when one path forgets
 * something: a running entry, an entry clipped by the range's start, one
 * entirely outside it, a second currency, an unbillable row, ties on `start`
 * (the keyset's `_id` tiebreak) and text the CSV has to quote and defuse.
 */
const addExportRows = (): void => {
  const authors = [OWNER, ADMIN, MEMBER] as const;
  const base = Date.parse("2026-09-18T16:00:00.000Z");
  for (let n = 0; n < 1_234; n += 1) {
    const author = authors[n % 3]!;
    // Pairs share a start, so the cursor's `_id` tiebreak is exercised.
    const start = new Date(base - Math.floor(n / 2) * 1_200_000);
    const durationSec = 900 + (n % 7) * 60;
    store.entries.rows.push({
      _id: new Types.ObjectId(),
      workspaceId: WORKSPACE,
      authorId: author,
      description: n % 97 === 0 ? `=SUM(A1), "quoted" ${n}` : `Row ${n}`,
      projectId: n % 5 === 0 ? null : String(PROJECT_ID),
      taskId: null,
      tagIds: [],
      billable: n % 4 !== 0,
      start,
      end: new Date(start.getTime() + durationSec * 1000),
      durationSec,
      hourlyRate: 80 + (n % 3) * 7.5,
      currency: n % 41 === 0 ? "usd" : "EUR",
      source: "web",
      timeZone: "UTC",
      runaway: null,
      invoiceId: null,
      importId: null,
      createdAt: start,
      updatedAt: start,
      project: n % 5 === 0 ? null : joinedProject,
      client: null,
      task: null,
    });
  }
  const extra = (row: Row): void => {
    store.entries.rows.push({
      workspaceId: WORKSPACE,
      projectId: null,
      taskId: null,
      tagIds: [],
      billable: true,
      hourlyRate: 120,
      currency: "EUR",
      source: "web",
      timeZone: "UTC",
      runaway: null,
      invoiceId: null,
      importId: null,
      project: null,
      client: null,
      task: null,
      ...row,
      createdAt: row.start,
      updatedAt: row.start,
    });
  };
  // Still running, inside the range: measured to `now`.
  extra({
    _id: new Types.ObjectId(),
    authorId: OWNER,
    description: "Running",
    start: new Date("2026-09-18T20:00:00.000Z"),
    end: null,
    durationSec: 0,
  });
  // Straddles the range's start: clipped for money, whole for duration.
  extra({
    _id: new Types.ObjectId(),
    authorId: ADMIN,
    description: "Over the boundary",
    start: new Date("2026-08-31T20:00:00.000Z"),
    end: new Date("2026-09-01T02:00:00.000Z"),
    durationSec: 21_600,
  });
  // Entirely before the range.
  extra({
    _id: new Types.ObjectId(),
    authorId: OWNER,
    description: "Last month",
    start: new Date("2026-08-10T09:00:00.000Z"),
    end: new Date("2026-08-10T10:00:00.000Z"),
    durationSec: 3600,
  });
};

beforeEach(() => {
  resetStore(store);
  addExportRows();
});

/** The export before this change: every page of `detailed`, concatenated. */
const legacyDetailed = async (
  scope: ReportScope,
): Promise<{ entries: DetailedEntry[]; currency: string }> => {
  const entries: DetailedEntry[] = [];
  let currency = "";
  let cursor: string | undefined;
  let guard = 0;
  do {
    const page = await buildDetailed(
      scope,
      FILTERS,
      { limit: 500, ...(cursor ? { cursor } : {}) },
      false,
    );
    entries.push(...page.entries);
    currency = page.currency;
    cursor = page.nextCursor;
    guard += 1;
  } while (cursor && guard < 200);
  return { entries, currency };
};

const legacyCsv = async (scope: ReportScope): Promise<Buffer> => {
  const moneyVisible = reportMoneyVisible(scope.visibility);
  const { entries, currency } = await legacyDetailed(scope);
  return Buffer.from(
    toCsv(
      detailedCsvRows(
        { entries, totalSec: 0, totalAmount: null, currency, moneyVisible },
        resolveTimeZone(FILTERS.timeZone),
      ),
      detailedCsvColumns(moneyVisible),
    ),
    "utf8",
  );
};

const legacyPdf = async (scope: ReportScope): Promise<Buffer> => {
  const moneyVisible = reportMoneyVisible(scope.visibility);
  const { entries, currency } = await legacyDetailed(scope);
  const zone = resolveTimeZone(FILTERS.timeZone);
  return renderDetailedPdf(
    { entries, totalSec: 0, totalAmount: null, currency, moneyVisible },
    {
      title: reportPdfTitle("en", { kind: "detailed" }),
      locale: "en",
      // parseRange's bounds, as the procedure computed them.
      from: dayKeyInZone(new Date(2026, 8, 1).getTime(), zone),
      to: dayKeyInZone(new Date(2026, 8, 20).getTime() - 1, zone),
      timeZone: zone,
      currency,
      generatedAt: new Date().toISOString(),
      moneyVisible,
    },
  );
};

/**
 * The file's name. `parseRange` reads a bare date as the HOST's local
 * midnight, so the day keys in the name depend on where the tests run.
 */
const expectedFilename = (ext: "csv" | "pdf"): string => {
  const zone = resolveTimeZone(FILTERS.timeZone);
  const from = dayKeyInZone(new Date(2026, 8, 1).getTime(), zone);
  const to = dayKeyInZone(new Date(2026, 8, 20).getTime() - 1, zone);
  return `trackyourtime-detailed-${from}_${to}.${ext}`;
};

const exportInput = (format: "csv" | "pdf"): ReportExportInput => ({
  ...FILTERS,
  report: "detailed",
  format,
  locale: "en",
});

const written = async (plan: ReportExportPlan): Promise<Buffer> => {
  const sink = bufferSink();
  await plan.write(sink);
  return sink.buffer();
};

/** Run `body` with `Date` frozen, so both paths draw the same timestamps. */
const frozen = async <T>(body: () => Promise<T>): Promise<T> => {
  mock.timers.enable({ apis: ["Date"], now: FROZEN_NOW });
  try {
    return await body();
  } finally {
    mock.timers.reset();
  }
};

// ── the currency fold ────────────────────────────────────────────────

describe("currencyAmountsAccumulator", () => {
  /** `sumCurrencyAmounts` as it was written before the accumulator existed. */
  const reference = (
    entries: readonly { currency: string; amount: number | null }[],
  ): { currency: string; amount: number }[] | null => {
    const buckets = new Map<string, number[]>();
    for (const entry of entries) {
      if (entry.amount === null) return null;
      if (entry.amount === 0) continue;
      const currency = normalizeCurrency(entry.currency);
      const bucket = buckets.get(currency) ?? [];
      bucket.push(entry.amount);
      buckets.set(currency, bucket);
    }
    return [...buckets]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, amounts]) => ({
        currency,
        amount: Math.round(amounts.reduce((total, amount) => total + amount * 100, 0)) / 100,
      }))
      .filter((bucket) => bucket.amount !== 0);
  };

  it("folds to exactly what the array version returns", () => {
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let round = 0; round < 200; round += 1) {
      const entries = Array.from({ length: Math.floor(random() * 400) }, () => ({
        currency: ["EUR", "eur", "USD", "CHF"][Math.floor(random() * 4)]!,
        amount:
          random() < 0.01
            ? null
            : random() < 0.1
              ? 0
              : Math.round((random() * 2_000 - 300) * 100) / 100,
      }));
      const fold = currencyAmountsAccumulator();
      for (const entry of entries) fold.add(entry);
      assert.deepEqual(fold.result(), reference(entries));
    }
  });
});

// ── the sink ─────────────────────────────────────────────────────────

describe("writableSink", () => {
  /** A destination that takes one chunk and then holds the next until told. */
  const slowDestination = (): Writable & { release: () => void } => {
    let pending: (() => void) | null = null;
    const destination = new Writable({
      highWaterMark: 4,
      write(_chunk, _encoding, callback) {
        pending = callback;
      },
    }) as Writable & { release: () => void };
    destination.release = () => {
      const callback = pending;
      pending = null;
      callback?.();
    };
    return destination;
  };

  it("is ready at once while the destination keeps up", async () => {
    const destination = new Writable({ write: (_c, _e, callback) => callback() });
    const sink = writableSink(destination);
    sink.write("abc");
    await sink.ready();
  });

  it("waits for drain when the destination is full", async () => {
    const destination = slowDestination();
    const sink = writableSink(destination);
    sink.write("more than four bytes");
    let ready = false;
    const waiting = sink.ready().then(() => {
      ready = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ready, false, "ready() must wait for the reader");
    destination.release();
    await waiting;
    assert.equal(ready, true);
  });

  it("rejects when the destination closes while it waits", async () => {
    const destination = slowDestination();
    const sink = writableSink(destination);
    sink.write("more than four bytes");
    const waiting = sink.ready();
    destination.destroy();
    await assert.rejects(waiting, ExportAbortedError);
    // Writes after that are dropped, never thrown — pdfkit calls write from
    // its own events, where a throw would be uncaught.
    sink.write("late");
    await assert.rejects(sink.ready(), ExportAbortedError);
  });

  it("gives up on a reader that stops reading", async () => {
    const destination = slowDestination();
    const sink = writableSink(destination, { stallMs: 20 });
    sink.write("more than four bytes");
    await assert.rejects(sink.ready(), /stalled/);
  });
});

// ── the files ────────────────────────────────────────────────────────

describe("planReportExport — the same bytes as the paginated export", () => {
  for (const person of [OWNER, ADMIN, MEMBER] as const) {
    const who = { [OWNER]: "owner", [ADMIN]: "time-only admin", [MEMBER]: "member" }[person];

    it(`detailed CSV, ${who}`, async () => {
      await frozen(async () => {
        const plan = await planReportExport(scopeOf(person), exportInput("csv"), person, Date.now());
        const streamed = await written(plan);
        const legacy = await legacyCsv(scopeOf(person));
        assert.ok(legacy.length > 1_000, "the fixture produced a real file");
        assert.ok(streamed.equals(legacy), "streamed CSV differs from the paginated one");
        assert.equal(plan.contentType, "text/csv; charset=utf-8");
        assert.equal(plan.filename, expectedFilename("csv"));
      });
    });

    it(`detailed PDF, ${who}`, async () => {
      await frozen(async () => {
        const plan = await planReportExport(scopeOf(person), exportInput("pdf"), person, Date.now());
        const streamed = await written(plan);
        const legacy = await legacyPdf(scopeOf(person));
        assert.ok(streamed.equals(legacy), "streamed PDF differs from the paginated one");
        assert.equal(plan.contentType, "application/pdf");
      });
    });
  }

  it("writes the CSV a page at a time, waiting for the reader in between", async () => {
    const plan = await planReportExport(scopeOf(OWNER), exportInput("csv"), OWNER);
    let writes = 0;
    let readies = 0;
    await plan.write({
      write: () => {
        writes += 1;
      },
      ready: async () => {
        readies += 1;
      },
    });
    // The header, then one chunk per 500-entry page: the fixture's three, the
    // 1,234 added, the running entry and the clipped one.
    assert.equal(writes, 1 + Math.ceil(1_239 / 500));
    assert.equal(readies, writes - 1);
  });

  it("refuses a bad range before anything is written", async () => {
    await assert.rejects(
      planReportExport(scopeOf(OWNER), { ...exportInput("csv"), from: "2026-09-19", to: "2026-09-01" }, OWNER),
      /must be after/,
    );
  });

  it("is what the tRPC procedures return, for every report and format", async () => {
    await frozen(async () => {
      const caller = reportsRouter.createCaller(contextFor(OWNER));
      for (const report of ["detailed", "summary", "weekly"] as const) {
        const input = { ...FILTERS, report, weekStart: "2026-09-14" };
        const csv = await caller.exportCsv(input);
        const csvPlan = await planReportExport(scopeOf(OWNER), { ...input, format: "csv" }, OWNER);
        assert.equal(csv.filename, csvPlan.filename);
        assert.ok(Buffer.from(csv.csv, "utf8").equals(await written(csvPlan)), `${report} CSV`);

        const pdf = await caller.exportPdf({ ...input, locale: "en" });
        const pdfPlan = await planReportExport(scopeOf(OWNER), { ...input, format: "pdf", locale: "en" }, OWNER);
        assert.equal(pdf.filename, pdfPlan.filename);
        assert.ok(Buffer.from(pdf.base64, "base64").equals(await written(pdfPlan)), `${report} PDF`);
      }
    });
  });
});

// ── the route ────────────────────────────────────────────────────────

type Served = { url: string; close: () => Promise<void> };

const serve = async (deps: Partial<ReportExportDeps> = {}): Promise<Served> => {
  const app = express();
  app.use(express.json());
  const handle = reportExportHandler({
    context: async (req) => ({ ...contextFor(OWNER), req }) as unknown as Context,
    plan: planReportExport,
    ...deps,
  });
  app.post(REPORT_EXPORT_PATH, (req, res) => {
    void handle(req, res);
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${REPORT_EXPORT_PATH}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

const post = (url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("POST /api/reports/export", () => {
  it("streams the file with its name, type and no caching", async () => {
    const served = await serve();
    try {
      const response = await post(served.url, exportInput("csv"));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
      assert.equal(
        response.headers.get("content-disposition"),
        `attachment; filename="${expectedFilename("csv")}"`,
      );
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = Buffer.from(await response.arrayBuffer());
      assert.deepEqual([...body.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      // Every row the owner may see, plus the header.
      assert.equal(body.toString("utf8").trimEnd().split("\r\n").length, 1 + 1_239);
    } finally {
      await served.close();
    }
  });

  it("answers no session with 401 and tRPC's code", async () => {
    const served = await serve({
      context: async (req) =>
        ({ req, res: undefined, session: null, user: null, authMethod: null, activeWorkspaceId: null, sessionId: null }) as unknown as Context,
    });
    try {
      const response = await post(served.url, exportInput("csv"));
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), {
        error: { code: "UNAUTHORIZED", message: "UNAUTHORIZED", versionRefusal: null },
      });
    } finally {
      await served.close();
    }
  });

  it("answers a workspace the caller is not in with the route's own NOT_FOUND", async () => {
    const served = await serve();
    try {
      const response = await post(served.url, { ...exportInput("csv"), workspaceId: "ws_somebody_else" });
      assert.equal(response.status, 404);
      const body = (await response.json()) as { error: { code: string } };
      // A `code` is what tells this apart from an older server without the route.
      assert.equal(body.error.code, "NOT_FOUND");
    } finally {
      await served.close();
    }
  });

  it("validates the body with the procedure's schema", async () => {
    const served = await serve();
    try {
      const response = await post(served.url, { ...exportInput("csv"), format: "xlsx" });
      assert.equal(response.status, 400);
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, "BAD_REQUEST");
    } finally {
      await served.close();
    }
  });

  it("refuses a client below the API-level floor, as tRPC does", async () => {
    const served = await serve();
    try {
      const response = await post(served.url, exportInput("csv"), {
        "x-trackyourtime-api-level": "0",
      });
      assert.equal(response.status, 412);
      const body = (await response.json()) as { error: { versionRefusal: string } };
      assert.equal(body.error.versionRefusal, "CLIENT_TOO_OLD");
    } finally {
      await served.close();
    }
  });

  it(`lets one person run ${MAX_EXPORTS_PER_USER} exports at once, and frees the slot after`, async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    let bothIn!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      bothIn = resolve;
    });
    const served = await serve({
      plan: async (scope, input, userId) => {
        const plan = await planReportExport(scope, input, userId);
        return {
          ...plan,
          write: async (sink) => {
            entered += 1;
            if (entered === MAX_EXPORTS_PER_USER) bothIn();
            await gate;
            await plan.write(sink);
          },
        };
      },
    });
    try {
      const first = post(served.url, exportInput("csv"));
      const second = post(served.url, exportInput("csv"));
      await bothEntered;
      const third = await post(served.url, exportInput("csv"));
      assert.equal(third.status, 429);
      assert.equal(third.headers.get("retry-after"), "5");
      release();
      for (const response of await Promise.all([first, second])) {
        assert.equal(response.status, 200);
        await response.arrayBuffer();
      }
      const fourth = await post(served.url, exportInput("csv"));
      assert.equal(fourth.status, 200);
      await fourth.arrayBuffer();
    } finally {
      release();
      await served.close();
    }
  });

  it("cuts the connection when the file fails half-way, never ending it cleanly", async () => {
    const errors = mock.method(console, "error", () => undefined);
    const served = await serve({
      plan: async (scope, input, userId) => ({
        ...(await planReportExport(scope, input, userId)),
        write: async (sink) => {
          sink.write("Date,Start\r\n");
          await sink.ready();
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new Error("database went away");
        },
      }),
    });
    try {
      const response = await post(served.url, exportInput("csv"));
      assert.equal(response.status, 200);
      await assert.rejects(response.arrayBuffer());
      assert.equal(errors.mock.callCount(), 1, "a mid-file failure is reported");
    } finally {
      errors.mock.restore();
      await served.close();
    }
  });

  it("stops producing when the reader goes away", async () => {
    let finished!: (outcome: unknown) => void;
    const outcome = new Promise<unknown>((resolve) => {
      finished = resolve;
    });
    const served = await serve({
      plan: async (scope, input, userId) => ({
        ...(await planReportExport(scope, input, userId)),
        write: async (sink) => {
          try {
            // Far more than any socket buffers: only a reader keeps this going.
            for (let page = 0; page < 10_000; page += 1) {
              sink.write(Buffer.alloc(256 * 1024, 0x41));
              await sink.ready();
            }
            finished("finished");
          } catch (error) {
            finished(error);
            throw error;
          }
        },
      }),
    });
    try {
      const controller = new AbortController();
      const response = await fetch(served.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(exportInput("csv")),
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      await reader.read();
      controller.abort();
      assert.ok((await outcome) instanceof ExportAbortedError);
    } finally {
      await served.close();
    }
  });
});
