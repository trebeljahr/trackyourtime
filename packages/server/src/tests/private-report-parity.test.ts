import assert from "node:assert/strict";
import { after, beforeEach, it, mock } from "node:test";
import { Types } from "mongoose";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { bufferSink } from "../services/report-export/sink.js";
import { pageTexts } from "./support/pdf-text.js";
import * as portablePdf from "@starter/invoice-pdf/report-pdf";
import {
  createKeyPair, createSigningPair, encodeSecret, fingerprint, randomSecret,
  signPrivateChange, privateMemberKeyFingerprint, signPrivateWorkspaceDirectory,
  verifyPrivateWorkspaceDirectory, verifyPrivateWorkspacePolicy,
  privateReportQuery, privateReportExportData, csvFilename, toCsv, summaryCsvColumns, summaryCsvRows, detailedCsvColumns, detailedCsvRows, weeklyCsvColumns, weeklyCsvRows, readersForPrivateRecord, type PlainPrivateRecord,
  type PrivateReportQueryPath,
} from "@starter/core";
import { buildDetailed, buildSummary, buildWeekly, planReportExport, type ReportScope } from "../trpc/routers/reports.js";
import { ADMIN, MEMBER, OWNER, WORKSPACE, freshStore, installStore, resetStore } from "./support/shared-workspace.js";
import type { Row } from "./support/in-memory-models.js";

const store = freshStore(), restore = installStore(store);
after(restore);
beforeEach(() => resetStore(store));
const NOW = Date.parse("2026-09-20T12:00:00.000Z");
const range = { from: "2026-09-01", to: "2026-09-30", timeZone: "Europe/Berlin" };

async function fixture(userId = OWNER) {
  let open = true;
  const current = () => open;
  const scope = { server: "https://api.example.test", workspaceId: WORKSPACE, userId };
  const keys = await Promise.all(store.members.rows.map(async (row) => ({ row, encryption: await createKeyPair(), signing: await createSigningPair() })));
  const members = keys.map(({ row, encryption, signing }) => ({ userId: String(row.userId), role: row.role as "owner" | "admin" | "member", canViewOthersTime: Boolean(row.canViewOthersTime), canViewOthersMoney: Boolean(row.canViewOthersMoney), publicKey: encryption.publicKey, signingPublicKey: signing.publicKey }));
  const signed = await signPrivateWorkspaceDirectory({ v: 1, server: scope.server, workspaceId: WORKSPACE, ownerId: OWNER, revision: 1, previousDigest: null, members }, keys[0]!.signing.privateKey, null, new Map(await Promise.all(members.map(async (member) => [member.userId, await privateMemberKeyFingerprint(scope.server, member)] as const))));
  const directory = await verifyPrivateWorkspaceDirectory(signed, scope, { ownerId: OWNER, signingPublicKey: keys[0]!.signing.publicKey, revision: 0, digest: null });
  const actorKey = keys.find(({ row }) => row.userId === userId)!, actor = members.find((member) => member.userId === userId)!;
  const root = encodeSecret(randomSecret());
  const rawPolicy = { v: 1 as const, protocol: "trackyourtime-private-workspace-policy-v1" as const, mode: "encrypted" as const, ...scope, accountFingerprint: await fingerprint(actorKey.signing.publicKey), activationRoot: root, directoryDigest: directory.digest, ownerId: OWNER, ownerSigningPublicKey: keys[0]!.signing.publicKey, directoryRevision: 1, reportRangeTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, createdAt: new Date().toISOString() };
  const policy = await verifyPrivateWorkspacePolicy({ policy: rawPolicy, signature: await signPrivateChange(actorKey.signing.privateKey, rawPolicy) }, scope, actorKey.signing.publicKey, { activationRoot: root, directoryDigest: directory.digest }, current);
  const records: PlainPrivateRecord[] = [];
  const add = (kind: PlainPrivateRecord["kind"], row: Row, authorId: string | null = null) => {
    if (!readersForPrivateRecord(kind, authorId, [actor]).length) return;
    // Synthetic model fixtures use Date/ObjectId. JSON preserves their exact
    // wire values; the replica's BSON decoding is independently covered.
    const value = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
    records.push({ kind, id: String(row._id), authorId, value });
  };
  for (const row of store.entries.rows) {
    const { hourlyRate, project: _project, client: _client, task: _task, ...entry } = row;
    void _project; void _client; void _task;
    add("entries", entry, String(row.authorId)); add("entryMoney", { _id: row._id, hourlyRate }, String(row.authorId));
  }
  for (const row of store.projects.rows) add("projects", row);
  for (const row of store.clients.rows) add("clients", { color: "#336699", ...row });
  for (const row of store.tasks.rows) add("tasks", row);
  for (const row of store.tags.rows) add("tags", row);
  for (const row of store.members.rows) { const { hourlyRate: _rate, ...member } = row; void _rate; add("members", member, String(row.userId)); }
  for (const row of store.settings.rows) add("settings", { _id: "64b7f9c2e13a4d5f6a7b8f01", ...row });
  const visibility = { userId, canViewOthersTime: actor.role === "owner" || actor.canViewOthersTime, canViewOthersMoney: actor.role === "owner" || actor.canViewOthersMoney };
  const standardScope: ReportScope = { workspaceId: WORKSPACE, visibility };
  const read = (path: PrivateReportQueryPath, input: unknown) => privateReportQuery({ scope, directory, policy, records, current, path, input, now: NOW });
  return { records, read, scope, standardScope, directory, policy, current, lock: () => { open = false; } };
}

it("private summaries match standard groups, timelines, filters and money visibility", async () => {
  const clock = mock.method(Date, "now", () => NOW);
  try {
    for (const person of [OWNER, ADMIN, MEMBER]) {
      const f = await fixture(person);
      for (const groupBy of ["project", "client", "task", "day", "week", "month", "tag", "member"] as const) {
        for (const filters of [range, { ...range, memberIds: [MEMBER] }, { ...range, projectIds: [] }, { ...range, search: ".*" }, { ...range, tagIds: [] }]) {
          assert.deepEqual(f.read("reports.summary", { ...filters, groupBy }), await buildSummary(f.standardScope, filters, groupBy), `${person} ${groupBy} ${JSON.stringify(filters)}`);
        }
      }
    }
  } finally { clock.mock.restore(); }
});

it("preserves page cursors, original detailed facts and full-range mixed currency totals", async () => {
  store.entries.rows[0]!.currency = "USD";
  store.entries.rows[1]!.durationSec = 3599.6;
  // A raw matching row can measure to zero. It must still advance the cursor.
  store.entries.rows.push({ ...store.entries.rows[0]!, _id: new Types.ObjectId("74b7f9c2e13a4d5f6a7b8d01"), start: new Date(NOW + 3600000), end: null, durationSec: 0 });
  const clock = mock.method(Date, "now", () => NOW);
  try {
    for (const person of [OWNER, ADMIN, MEMBER]) {
      const f = await fixture(person);
      let cursor: string | undefined;
      do {
        const page = { limit: 1, ...(cursor ? { cursor } : {}) }, standard = await buildDetailed(f.standardScope, range, page);
        assert.deepEqual(f.read("reports.detailed", { ...range, ...page }), standard);
        assert.deepEqual(f.read("reports.rows", { ...range, ...page }), { entries: standard.entries, ...(standard.nextCursor ? { nextCursor: standard.nextCursor } : {}) });
        const { entries: _entries, nextCursor: _cursor, ...totals } = standard; void _entries; void _cursor;
        assert.deepEqual(f.read("reports.totals", range), totals);
        cursor = standard.nextCursor;
      } while (cursor);
    }
  } finally { clock.mock.restore(); }
});

it("matches clipped/running work, explicit no-client snapshots and literal filters", async () => {
  const row = store.entries.rows[0]!;
  row.start = new Date("2026-08-31T23:00:00.000Z"); row.end = new Date("2026-09-01T01:00:00.000Z"); row.description = "Design [draft]";
  store.entries.rows[1]!.clientId = null; store.entries.rows[1]!.client = null;
  store.entries.rows[2]!.end = null;
  const clock = mock.method(Date, "now", () => NOW);
  try {
    const f = await fixture();
    for (const filters of [range, { ...range, clientIds: [String(store.clients.rows[0]!._id)] }, { ...range, search: " [draft] " }, { ...range, from: "2026-09-01T00:30:00.000Z", to: "2026-09-01T00:45:00.000Z" }]) {
      assert.deepEqual(f.read("reports.detailed", filters), await buildDetailed(f.standardScope, filters, {}));
      assert.deepEqual(f.read("reports.summary", { ...filters, groupBy: "day" }), await buildSummary(f.standardScope, filters, "day"));
    }
  } finally { clock.mock.restore(); }
});

it("keeps seven-day grids across DST and joins missing catalog records identically", async () => {
  store.entries.rows[0]!.start = new Date("2026-03-28T22:00:00.000Z");
  store.entries.rows[0]!.end = new Date("2026-03-30T01:00:00.000Z"); store.entries.rows[0]!.durationSec = 27 * 3600;
  store.entries.rows[1]!.projectId = "missing"; store.entries.rows[1]!.project = null; store.entries.rows[1]!.client = null;
  const clock = mock.method(Date, "now", () => NOW);
  try {
    const f = await fixture();
    for (const weekStart of ["2026-03-23", "2026-09-07", "2026-10-19"]) {
      assert.deepEqual(f.read("reports.weekly", { ...range, weekStart }), await buildWeekly(f.standardScope, range, weekStart));
    }
  } finally { clock.mock.restore(); }
});

it("refuses forged scopes, cursor/policy changes and stale reads while preserving source records", async () => {
  const f = await fixture(), original = structuredClone(f.records);
  assert.throws(() => f.read("reports.rows", { ...range, workspaceId: "other" }), /another workspace/);
  assert.throws(() => f.read("reports.rows", { ...range, cursor: "invalid" }), /cursor/);
  assert.throws(() => privateReportQuery({ ...f, policy: { ...f.policy }, path: "reports.totals", input: range, current: () => true }), /current verified/);
  assert.deepEqual(f.records, original); f.lock();
  assert.throws(() => f.read("reports.totals", range), /changed/);
});

it("does not open financial snapshots outside the filter or when report money is withheld", async () => {
  const f = await fixture(ADMIN);
  for (const row of f.records) if (row.kind === "entryMoney") row.value.hourlyRate = "invalid private data";
  assert.equal((f.read("reports.totals", range) as { totalAmount: unknown }).totalAmount, null);
  const own = await fixture(); own.records.find((row) => row.kind === "entryMoney")!.value.hourlyRate = "invalid";
  assert.throws(() => own.read("reports.totals", range));
  assert.equal((own.read("reports.totals", { ...range, memberIds: [MEMBER] }) as { totalSec: number }).totalSec, 3600);
});

it("keeps large-page and multi-tag parity without double-counting range totals", async () => {
  const tag = "64b7f9c2e13a4d5f6a7b8a01", hidden = "64b7f9c2e13a4d5f6a7b8a02", second = "64b7f9c2e13a4d5f6a7b8a03";
  for (const [id, name, hiddenFlag] of [[tag, "Archived", false], [hidden, "Hidden", true], [second, "Second", false]] as const) store.tags.rows.push({ _id: new Types.ObjectId(id), workspaceId: WORKSPACE, name, color: "#112233", hidden: hiddenFlag, archived: true });
  const template = store.entries.rows[0]!;
  for (let i = 0; i < 503; i++) store.entries.rows.push({ ...template, _id: new Types.ObjectId((i + 1).toString(16).padStart(24, "0")), tagIds: [tag, tag, hidden, second, "deleted"] });
  const clock = mock.method(Date, "now", () => NOW);
  try {
    const f = await fixture();
    assert.deepEqual(f.read("reports.summary", { ...range, groupBy: "tag" }), await buildSummary(f.standardScope, range, "tag"));
    const first = await buildDetailed(f.standardScope, range, { limit: 500 });
    assert.deepEqual(f.read("reports.detailed", { ...range, limit: 500 }), first);
    assert.ok(first.nextCursor);
    assert.deepEqual(f.read("reports.detailed", { ...range, limit: 500, cursor: first.nextCursor }), await buildDetailed(f.standardScope, range, { limit: 500, cursor: first.nextCursor }));
  } finally { clock.mock.restore(); }
});

it("uses the pinned source calendar when the device timezone changes", async () => {
  const previous = process.env.TZ, clock = mock.method(Date, "now", () => NOW);
  try {
    process.env.TZ = "UTC";
    const f = await fixture(), filters = { ...range, from: "2026-09-07", to: "2026-09-07" };
    const standard = await buildDetailed(f.standardScope, filters, {});
    process.env.TZ = "Australia/Sydney";
    assert.deepEqual(f.read("reports.detailed", filters), standard);
  } finally { clock.mock.restore(); if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

it("local CSV bytes and browser PDF text match actual standard export plans", async () => {
  const standalonePath = join(dirname(createRequire(import.meta.url).resolve("pdfkit")), "pdfkit.standalone.js");
  const standalone = await import(pathToFileURL(standalonePath).href);
  const PDFDocument = standalone.default as portablePdf.ReportPdfRenderOptions["PDFDocument"];
  store.entries.rows[0]!.description = '=SUM(1,2) "quoted", ä';
  store.entries.rows[1]!.currency = "USD";
  store.entries.rows[2]!.end = null;
  const clock = mock.method(Date, "now", () => NOW);
  try {
    for (const userId of [OWNER, ADMIN, MEMBER]) {
      const f = await fixture(userId);
      for (const locale of ["en", "de"] as const) for (const report of ["summary", "detailed", "weekly"] as const) {
        const input = { ...range, report, locale, groupBy: "project" as const, weekStart: "2026-09-07" };
        const data = privateReportExportData({ ...f, input: { ...input, format: "csv" }, now: NOW });
        const csv = data.report === "summary" ? toCsv(summaryCsvRows(data.result), summaryCsvColumns(data.result.moneyVisible)) : data.report === "weekly" ? toCsv(weeklyCsvRows(data.result), weeklyCsvColumns(data.result)) : toCsv(detailedCsvRows(data.result, range.timeZone, NOW), detailedCsvColumns(data.result.moneyVisible));
        const plan = await planReportExport(f.standardScope, { ...input, format: "csv" }, userId, NOW), sink = bufferSink(); await plan.write(sink);
        assert.equal(csv, sink.buffer().toString("utf8"), `${userId} ${report} CSV`);
        assert.equal(csvFilename(report, data.filenameRange.from, data.filenameRange.to), plan.filename);
        const pdfPlan = await planReportExport(f.standardScope, { ...input, format: "pdf" }, userId, NOW), pdfSink = bufferSink(); await pdfPlan.write(pdfSink);
        const kind = report === "summary" ? { kind: report, groupBy: input.groupBy } : { kind: report };
        const meta = { ...range, from: data.filenameRange.from, to: data.filenameRange.to, locale, currency: data.report === "weekly" ? data.currency : data.result.currency, title: portablePdf.reportPdfTitle(locale, kind), generatedAt: new Date(NOW).toISOString(), moneyVisible: data.result.moneyVisible, renderOptions: { PDFDocument, nowMs: NOW } };
        const bytes = data.report === "summary" ? await portablePdf.renderSummaryPdf(data.result, meta, input.groupBy) : data.report === "weekly" ? await portablePdf.renderWeeklyPdf(data.result, meta) : await portablePdf.renderDetailedPdf(data.result, meta);
        if (userId === OWNER && locale === "en" && report === "detailed") { const text = pageTexts(Buffer.from(bytes)).join(" "); assert.ok(text.includes("4,247,000.00 EUR")); assert.ok((text.match(/312:00:00/g) ?? []).length >= 2, "headline and table total both retain the full duration"); }
        assert.deepEqual(pageTexts(Buffer.from(bytes)), pageTexts(pdfSink.buffer()), `${userId} ${locale} ${report} PDF`);
        const qaDir = process.env.TYT_REPORT_QA_DIR;
        if (qaDir && ((userId === OWNER && locale === "en") || (userId === ADMIN && locale === "de"))) {
          mkdirSync(qaDir, { recursive: true });
          writeFileSync(join(qaDir, `private-${userId === OWNER ? "owner" : "time-only"}-${locale}-${report}.pdf`), bytes);
        }
      }
    }
  } finally { clock.mock.restore(); }
});
