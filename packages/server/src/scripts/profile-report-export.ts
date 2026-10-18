// Synthetic-only profiler for the reports and their exports. Requires an explicitly
// supplied loopback Mongo URI; creates a disposable database, never reads
// existing application records, and drops the database when it is done.
//
// Usage (from packages/server):
//   node --import tsx src/scripts/profile-report-export.ts mongodb://127.0.0.1:<port>/ [runs] [cases…]
//
// Options, as environment variables: PROFILE_DB keeps one seeded database
// across invocations (to compare two builds on identical rows),
// PROFILE_HEAP_MB caps each case's V8 heap, and PROFILE_OUT=<dir> with
// PROFILE_FIXED_NOW=<iso> writes each case's file for a byte comparison.
//
// Every case runs in a fresh child process, so one case's heap never inflates
// the next one's peak. A case reports wall time, the peak RSS of its process
// (getrusage, which sees inside synchronous loops that a sampler cannot), the
// peak sampled heap, and the size and SHA-256 of what it produced.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";

const ENTRY_COUNT = 100_000;
const WORKSPACE = "fixture";
const OWNER = "fixture-owner";
const RANGE = { from: "2000-01-01", to: "2030-12-31", timeZone: "Europe/Berlin" };

/**
 * Cases this build knows. `trpc-*` exist on every build since the exports;
 * `report-*` are the on-screen reports over the same 100k entries, measured
 * with the JSON body tRPC's HTTP adapter would send.
 */
const CASES = [
  "trpc-csv",
  "trpc-pdf",
  "stream-csv",
  "stream-pdf",
  "stream-pdf-slow",
  "report-summary",
  "report-summary-day",
  "report-detailed-page",
  "report-weekly",
  "stream-summary-pdf",
] as const;
type Case = (typeof CASES)[number];

const checkUri = (uri: string): URL => {
  const url = new URL(uri);
  assert.equal(url.protocol, "mongodb:");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "loopback MongoDB only");
  assert.ok(!url.username && !url.password && !url.search && url.pathname === "/", "supply only a local host and port");
  return url;
};

const mib = (bytes: number): number => Number((bytes / 1024 / 1024).toFixed(1));

async function seed(uri: string, dbName: string): Promise<void> {
  const { TimeEntry } = await import("../models/TimeEntry.js");
  const { Project } = await import("../models/Project.js");
  const { Task } = await import("../models/Task.js");
  const { Client } = await import("../models/Client.js");
  const { WorkspaceMember } = await import("../models/WorkspaceMember.js");
  await mongoose.connect(uri, { dbName, autoIndex: false });
  const db = mongoose.connection.db!;
  const clientIds = Array.from({ length: 10 }, () => new mongoose.Types.ObjectId());
  const projectIds = Array.from({ length: 50 }, () => new mongoose.Types.ObjectId());
  const taskIds = Array.from({ length: 20 }, () => new mongoose.Types.ObjectId());
  await db.collection(Client.collection.name).insertMany(clientIds.map((_id, n) => ({ _id, workspaceId: WORKSPACE, name: `Synthetic client ${n}`, archived: false })));
  await db.collection(Project.collection.name).insertMany(projectIds.map((_id, n) => ({ _id, workspaceId: WORKSPACE, name: `Synthetic project ${n}`, color: "#336699", clientId: String(clientIds[n % clientIds.length]), archived: false })));
  await db.collection(Task.collection.name).insertMany(taskIds.map((_id, n) => ({ _id, workspaceId: WORKSPACE, name: `Synthetic task ${n}` })));
  await db.collection(WorkspaceMember.collection.name).insertOne({ workspaceId: WORKSPACE, userId: OWNER, role: "owner", name: "Owner", canViewOthersTime: true, canViewOthersMoney: true, createdAt: new Date(), updatedAt: new Date() });
  const entries = db.collection(TimeEntry.collection.name);
  const newest = Date.parse("2026-10-01T18:00:00Z");
  for (let offset = 0; offset < ENTRY_COUNT; offset += 1000) {
    await entries.insertMany(Array.from({ length: Math.min(1000, ENTRY_COUNT - offset) }, (_, i) => {
      const n = offset + i;
      // Sixteen 25-minute entries per day, newest first, back to ~2009.
      const start = new Date(newest - Math.floor(n / 16) * 86_400_000 - (n % 16) * 1_800_000);
      const durationSec = 1500;
      return {
        workspaceId: WORKSPACE,
        authorId: OWNER,
        start,
        end: new Date(start.getTime() + durationSec * 1000),
        durationSec,
        description: `Synthetic work item ${n} — reviewing, writing, a meeting or two`,
        projectId: String(projectIds[n % projectIds.length]),
        taskId: n % 3 === 0 ? null : String(taskIds[n % taskIds.length]),
        billable: n % 4 !== 0,
        hourlyRate: n % 4 !== 0 ? 95 : null,
        currency: n % 50 === 0 ? "USD" : "EUR",
        source: "web",
        tagIds: [],
        createdAt: start,
        updatedAt: start,
      };
    }));
  }
  for (const [keys, options] of TimeEntry.schema.indexes()) {
    await entries.createIndex(keys as Record<string, 1 | -1>, options as Record<string, unknown>);
  }
  await mongoose.disconnect();
}

/**
 * Discards bytes, counting and hashing them. `bytesPerSecond` makes it a slow
 * reader, so the case shows what backpressure holds the producer to.
 */
const countingSink = (bytesPerSecond: number): Writable & { bytes: number; digest: () => string } => {
  const hash = createHash("sha256");
  let debtMs = 0;
  const sink = new Writable({
    highWaterMark: 64 * 1024,
    write(chunk: Buffer, _encoding, callback) {
      sink.bytes += chunk.length;
      hash.update(chunk);
      if (bytesPerSecond <= 0) return callback();
      debtMs += (chunk.length / bytesPerSecond) * 1000;
      if (debtMs < 10) return callback();
      const wait = debtMs;
      debtMs = 0;
      setTimeout(callback, wait);
    },
  }) as Writable & { bytes: number; digest: () => string };
  sink.bytes = 0;
  sink.digest = () => hash.digest("hex").slice(0, 16);
  return sink;
};

async function measure(which: Case, uri: string, dbName: string): Promise<void> {
  const { reportsRouter } = await import("../trpc/routers/reports.js");
  await mongoose.connect(uri, { dbName, autoIndex: false });
  // Warm the module graph, the connection and pdfkit's font metrics on a
  // tiny range, so the measured run pays only for the export itself.
  const ctx = {
    req: undefined,
    res: undefined,
    session: { session: { activeOrganizationId: WORKSPACE }, user: { id: OWNER } },
    user: { id: OWNER, name: "Owner", email: "owner@example.test" },
    authMethod: "cookie",
    activeWorkspaceId: WORKSPACE,
  } as unknown as Parameters<typeof reportsRouter.createCaller>[0];
  const caller = reportsRouter.createCaller(ctx);
  const warm = { from: "2026-09-30", to: "2026-09-30", timeZone: RANGE.timeZone, report: "detailed" as const };
  await caller.exportCsv(warm);
  await caller.exportPdf({ ...warm, locale: "en" });

  // After the models exist: mongoose rejects a schema typed with a subclass.
  if (process.env.PROFILE_FIXED_NOW) freezeClock(process.env.PROFILE_FIXED_NOW);
  global.gc?.();
  const baseline = process.memoryUsage();
  let heapPeak = baseline.heapUsed;
  const sampler = setInterval(() => {
    heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
  }, 2);

  const began = performance.now();
  let bytes = 0;
  let digest = "";
  const input = { ...RANGE, report: "detailed" as const };
  if (which.startsWith("report-")) {
    const result =
      which === "report-summary"
        ? await caller.summary({ ...RANGE, groupBy: "project" })
        : which === "report-summary-day"
          ? await caller.summary({ ...RANGE, groupBy: "day" })
          : which === "report-detailed-page"
            ? await caller.detailed({ ...RANGE, limit: 50 })
            : await caller.weekly({ ...RANGE, weekStart: "2026-09-28" });
    const body = Buffer.from(JSON.stringify({ result: { data: result } }), "utf8");
    bytes = body.length;
    digest = createHash("sha256").update(body).digest("hex").slice(0, 16);
    if (process.env.PROFILE_OUT) writeFileSync(`${process.env.PROFILE_OUT}/${which}.json`, body);
  } else if (which === "trpc-csv" || which === "trpc-pdf") {
    const result = which === "trpc-csv"
      ? await caller.exportCsv(input)
      : await caller.exportPdf({ ...input, locale: "en" });
    // What tRPC's HTTP adapter does with the result before it can send it.
    const body = JSON.stringify({ result: { data: result } });
    bytes = Buffer.byteLength(body);
    const payload = "csv" in result ? Buffer.from(result.csv, "utf8") : Buffer.from(result.base64, "base64");
    digest = createHash("sha256").update(payload).digest("hex").slice(0, 16);
    if (process.env.PROFILE_OUT) {
      writeFileSync(`${process.env.PROFILE_OUT}/${which}.${"csv" in result ? "csv" : "pdf"}`, payload);
    }
  } else {
    const { planReportExport } = (await import("../trpc/routers/reports.js")) as unknown as {
      planReportExport?: (...args: unknown[]) => Promise<{ write: (sink: unknown) => Promise<void> }>;
    };
    assert.ok(planReportExport, "this build has no streaming export");
    const { writableSink } = await import("../services/report-export/sink.js");
    // 150 KB/s: slower than the PDF is drawn, so the reader sets the pace.
    const sink = countingSink(which === "stream-pdf-slow" ? 150_000 : 0);
    const scope = { workspaceId: WORKSPACE, visibility: { userId: OWNER, canViewOthersTime: true, canViewOthersMoney: true } };
    const plan = await planReportExport(
      scope,
      which === "stream-summary-pdf"
        ? { ...RANGE, report: "summary", groupBy: "project", format: "pdf", locale: "en" }
        : { ...input, format: which === "stream-csv" ? "csv" : "pdf", locale: "en" },
      OWNER,
    );
    const kept: Buffer[] = [];
    const tee = process.env.PROFILE_OUT
      ? { ...writableSink(sink), write: (chunk: string | Buffer) => { kept.push(Buffer.from(chunk)); sink.write(chunk); } }
      : writableSink(sink);
    await plan.write(tee);
    if (process.env.PROFILE_OUT) {
      writeFileSync(`${process.env.PROFILE_OUT}/${which}.${which === "stream-csv" ? "csv" : "pdf"}`, Buffer.concat(kept));
    }
    await new Promise<void>((resolve, reject) => sink.end((error?: Error | null) => (error ? reject(error) : resolve())));
    bytes = sink.bytes;
    digest = sink.digest();
  }
  const wallMs = performance.now() - began;
  clearInterval(sampler);
  const rusage = process.resourceUsage();
  console.log(JSON.stringify({
    case: which,
    wallMs: Math.round(wallMs),
    baselineRssMiB: mib(baseline.rss),
    peakRssMiB: mib(rusage.maxRSS * 1024),
    peakHeapMiB: mib(heapPeak),
    baselineHeapMiB: mib(baseline.heapUsed),
    outputMiB: mib(bytes),
    digest,
  }));
  await mongoose.disconnect();
}

/**
 * PROFILE_FIXED_NOW freezes `Date.now()` and `new Date()` in a case, so two
 * builds render the same "Generated" line, CreationDate and file ID, and
 * their PDFs can be compared byte for byte. Equivalence runs only — it is no
 * timing measurement.
 */
const freezeClock = (iso: string): void => {
  const fixed = Date.parse(iso);
  assert.ok(Number.isFinite(fixed), "PROFILE_FIXED_NOW must be an ISO date");
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fixed);
      else super(...(args as [string]));
    }
    static override now(): number {
      return fixed;
    }
  }
  globalThis.Date = FrozenDate as DateConstructor;
};

const [mode, ...rest] = process.argv.slice(2);
if (mode === "--case") {
  const [which, uri, dbName] = rest as [Case, string, string];
  assert.ok(CASES.includes(which), `unknown case ${which}`);
  checkUri(uri);
  await measure(which, uri, dbName);
} else {
  const uri = mode ?? "";
  checkUri(uri);
  const runs = Number(rest[0] ?? 3);
  const only = rest.slice(1) as Case[];
  // PROFILE_DB keeps one seeded database across invocations, so two builds
  // can be measured against the same rows (and the same ObjectIds).
  const kept = process.env.PROFILE_DB;
  assert.ok(!kept || kept.startsWith("trackyourtime-profile-"), "PROFILE_DB must be a profiler database");
  const dbName = kept || `trackyourtime-profile-${randomUUID()}`;
  await mongoose.connect(uri, { dbName });
  const seeded = (await mongoose.connection.db!.collection("timeentries").estimatedDocumentCount()) > 0;
  await mongoose.disconnect();
  if (!seeded) await seed(uri, dbName);
  try {
    for (const which of only.length > 0 ? only : CASES) {
      for (let run = 0; run < runs; run += 1) {
        const child = spawnSync(
          process.execPath,
          [
            "--expose-gc",
            // PROFILE_HEAP_MB caps the V8 heap, to show whether a case fits a
            // small box at all rather than how much it happens to grow.
            ...(process.env.PROFILE_HEAP_MB ? [`--max-old-space-size=${process.env.PROFILE_HEAP_MB}`] : []),
            "--import",
            "tsx",
            fileURLToPath(import.meta.url),
            "--case",
            which,
            uri,
            dbName,
          ],
          { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
        );
        const line = child.stdout.trim().split("\n").pop() ?? "";
        if (child.status !== 0 || !line.startsWith("{")) {
          console.log(JSON.stringify({ case: which, skipped: (child.stderr.trim().split("\n").pop() ?? "").slice(0, 160) }));
          break;
        }
        console.log(line);
      }
    }
  } finally {
    if (kept) process.exit(0);
    await mongoose.connect(uri, { dbName });
    assert.ok(mongoose.connection.db!.databaseName.startsWith("trackyourtime-profile-"));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
}
