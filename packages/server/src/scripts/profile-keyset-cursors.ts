// Synthetic-only profiler for the keyset cursors outside `entries.list`: the
// report fold pages (`keysetPages`, behind summary, weekly and the detailed
// range totals), the detailed report's own cursor, `invoices.list` (its cursor
// and its overdue scan) and `webhooks.deliveries`. Requires an explicitly
// supplied loopback Mongo URI; creates a disposable database, never reads
// existing application records, and drops the database when it is done.
//
// Usage (from packages/server):
//   node --import tsx src/scripts/profile-keyset-cursors.ts mongodb://127.0.0.1:<port>/ [cases…]
//
// Each case reports the keys and documents its collection examined and the
// documents it sent back to the server (the database profiler, summed over
// every query the case sent, getMores included), the pages it returned and a
// digest of them. Ids are
// deterministic, so two builds' digests compare directly. PROFILE_OPS=1 also
// prints every profiled query with its plan summary, and PROFILE_DB keeps one
// seeded database across invocations (it is neither reseeded nor dropped).
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { Client } from "../models/Client.js";
import { Invoice } from "../models/Invoice.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";
import { TimeEntry } from "../models/TimeEntry.js";
import { WebhookDelivery } from "../models/WebhookDelivery.js";
import { WebhookSubscription } from "../models/WebhookSubscription.js";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { invoicesRouter } from "../trpc/routers/invoices.js";
import { reportsRouter } from "../trpc/routers/reports.js";
import { webhooksRouter } from "../trpc/routers/webhooks.js";

const ENTRY_COUNT = 100_000;
const INVOICE_COUNT = 3_000;
/** Per subscription; a second subscription holds as many again. */
const DELIVERY_COUNT = 20_000;
const WORKSPACE = "fixture";
const OWNER = "fixture-owner";
const RANGE = { from: "2000-01-01", to: "2030-12-31", timeZone: "Europe/Berlin" };
const WEEK = { from: "2026-09-28", to: "2026-10-04", timeZone: RANGE.timeZone };

const uri = process.argv[2] ?? "";
const url = new URL(uri);
assert.equal(url.protocol, "mongodb:");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "loopback MongoDB only");
assert.ok(!url.username && !url.password && !url.search && url.pathname === "/", "supply only a local host and port");

/** A deterministic ObjectId: one byte of collection tag, then the counter. */
const oid = (tag: number, n: number): mongoose.Types.ObjectId =>
  new mongoose.Types.ObjectId(tag.toString(16).padStart(2, "0") + n.toString(16).padStart(22, "0"));

const SUBSCRIPTION = String(oid(0xb1, 1));
const OTHER_SUBSCRIPTION = String(oid(0xb1, 2));
const CLIENT_IDS = Array.from({ length: 10 }, (_, n) => oid(0xc1, n));
const PROJECT_IDS = Array.from({ length: 50 }, (_, n) => oid(0xd1, n));
const FIVE_PROJECTS = PROJECT_IDS.slice(0, 5).map(String);

type Measured = { pages: number; rows: unknown[] };
type Case = { label: string; collection: string; run: () => Promise<Measured> };

const ctx = {
  req: undefined,
  res: undefined,
  session: { session: { activeOrganizationId: WORKSPACE }, user: { id: OWNER } },
  user: { id: OWNER, name: "Owner", email: "owner@example.test" },
  authMethod: "cookie",
  activeWorkspaceId: WORKSPACE,
};
const reports = reportsRouter.createCaller(ctx as unknown as Parameters<typeof reportsRouter.createCaller>[0]);
const invoices = invoicesRouter.createCaller(ctx as unknown as Parameters<typeof invoicesRouter.createCaller>[0]);
const webhooks = webhooksRouter.createCaller(ctx as unknown as Parameters<typeof webhooksRouter.createCaller>[0]);

const once = async (result: Promise<unknown>): Promise<Measured> => ({ pages: 1, rows: [await result] });

/** Follow a cursor from page one, at most `maxPages` pages. */
const walk = async <T extends { nextCursor?: string | null }>(
  fetchPage: (cursor: string | undefined) => Promise<T>,
  maxPages: number,
): Promise<Measured> => {
  const rows: unknown[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await fetchPage(cursor);
    pages += 1;
    rows.push(page);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && pages < maxPages);
  return { pages, rows };
};

const CASES: Case[] = [
  { label: "report summary, all time", collection: "timeentries", run: () => once(reports.summary({ ...RANGE, groupBy: "project" })) },
  { label: "report summary, all time, 5 projects", collection: "timeentries", run: () => once(reports.summary({ ...RANGE, projectIds: FIVE_PROJECTS, groupBy: "project" })) },
  { label: "report summary, all time, 2 clients", collection: "timeentries", run: () => once(reports.summary({ ...RANGE, clientIds: CLIENT_IDS.slice(0, 2).map(String), groupBy: "project" })) },
  { label: "report summary, all time, one member", collection: "timeentries", run: () => once(reports.summary({ ...RANGE, memberIds: [OWNER], groupBy: "project" })) },
  { label: "report summary, all time, billable", collection: "timeentries", run: () => once(reports.summary({ ...RANGE, billable: true, groupBy: "project" })) },
  { label: "report summary, newest week", collection: "timeentries", run: () => once(reports.summary({ ...WEEK, groupBy: "project" })) },
  { label: "report weekly", collection: "timeentries", run: () => once(reports.weekly({ ...RANGE, weekStart: "2026-09-28" })) },
  { label: "report detailed, all time, page 1", collection: "timeentries", run: () => once(reports.detailed({ ...RANGE, limit: 50 })) },
  {
    label: "report detailed, all time, 5 pages",
    collection: "timeentries",
    run: () => walk((cursor) => reports.detailed({ ...RANGE, limit: 50, ...(cursor ? { cursor } : {}) }), 5),
  },
  {
    label: "report detailed, 5 projects, 5 pages",
    collection: "timeentries",
    run: () => walk((cursor) => reports.detailed({ ...RANGE, projectIds: FIVE_PROJECTS, limit: 50, ...(cursor ? { cursor } : {}) }), 5),
  },
  {
    label: "invoices.list, every page",
    collection: "invoices",
    run: () => walk((cursor) => invoices.list({ limit: 50, ...(cursor ? { cursor } : {}) }), Infinity),
  },
  {
    label: "invoices.list, status sent, every page",
    collection: "invoices",
    run: () => walk((cursor) => invoices.list({ status: "sent", limit: 50, ...(cursor ? { cursor } : {}) }), Infinity),
  },
  {
    label: "invoices.list, one client, every page",
    collection: "invoices",
    run: () => walk((cursor) => invoices.list({ clientId: String(CLIENT_IDS[3]), limit: 50, ...(cursor ? { cursor } : {}) }), Infinity),
  },
  {
    label: "invoices.list, overdue, every page",
    collection: "invoices",
    run: () => walk((cursor) => invoices.list({ overdue: true, limit: 10, ...(cursor ? { cursor } : {}) }), Infinity),
  },
  {
    label: "webhooks.deliveries, 20 pages",
    collection: "webhookdeliveries",
    run: () => walk((cursor) => webhooks.deliveries({ subscriptionId: SUBSCRIPTION, limit: 25, ...(cursor ? { cursor } : {}) }), 20),
  },
];

async function seed(db: mongoose.mongo.Db): Promise<void> {
  const projectIds = PROJECT_IDS;
  const taskIds = Array.from({ length: 20 }, (_, n) => oid(0xe1, n));
  await db.collection(Client.collection.name).insertMany(CLIENT_IDS.map((_id, n) => ({ _id, workspaceId: WORKSPACE, name: `Synthetic client ${n}`, archived: false })));
  await db.collection(Project.collection.name).insertMany(projectIds.map((_id, n) => ({ _id, workspaceId: WORKSPACE, name: `Synthetic project ${n}`, color: "#336699", clientId: String(CLIENT_IDS[n % CLIENT_IDS.length]), archived: false })));
  await db.collection(Task.collection.name).insertMany(taskIds.map((_id, n) => ({ _id, workspaceId: WORKSPACE, name: `Synthetic task ${n}` })));
  await db.collection(WorkspaceMember.collection.name).insertOne({ workspaceId: WORKSPACE, userId: OWNER, role: "owner", name: "Owner", canViewOthersTime: true, canViewOthersMoney: true, createdAt: new Date(0), updatedAt: new Date(0) });

  // Time entries: the shape of profile-report-export.ts, with fixed ids.
  const entries = db.collection(TimeEntry.collection.name);
  const newest = Date.parse("2026-10-01T18:00:00Z");
  for (let offset = 0; offset < ENTRY_COUNT; offset += 1000) {
    await entries.insertMany(Array.from({ length: Math.min(1000, ENTRY_COUNT - offset) }, (_, i) => {
      const n = offset + i;
      // Sixteen 25-minute entries per day, newest first, back to ~2009.
      const start = new Date(newest - Math.floor(n / 16) * 86_400_000 - (n % 16) * 1_800_000);
      const durationSec = 1500;
      return {
        _id: oid(0xa1, n),
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

  // Invoices: one a day, newest first, every third one sharing the previous
  // one's `createdAt` so the tie-break is exercised. Mostly paid; one in
  // fifty still sent and long overdue, so the overdue list scans.
  await db.collection(Invoice.collection.name).insertMany(Array.from({ length: INVOICE_COUNT }, (_, n) => {
    const createdAt = new Date(newest - (n - (n % 3 === 2 ? 1 : 0)) * 86_400_000);
    const dueDate = new Date(createdAt.getTime() + 14 * 86_400_000);
    const status = n % 50 === 7 ? "sent" : n % 20 === 0 ? "draft" : "paid";
    return {
      _id: oid(0xf1, n),
      workspaceId: WORKSPACE,
      createdBy: OWNER,
      number: `INV-${String(INVOICE_COUNT - n).padStart(5, "0")}`,
      clientId: String(CLIENT_IDS[n % CLIENT_IDS.length]),
      clientName: `Synthetic client ${n % CLIENT_IDS.length}`,
      status,
      issueDate: createdAt,
      dueDate,
      from: new Date(createdAt.getTime() - 30 * 86_400_000),
      to: createdAt,
      groupBy: "project",
      lineItems: [],
      subtotal: 950,
      taxRate: 19,
      taxAmount: 180.5,
      total: 1130.5,
      currency: "EUR",
      entryIds: [],
      notes: null,
      createdAt,
      updatedAt: createdAt,
    };
  }));

  // Webhook deliveries: two subscriptions, one every two minutes each, every
  // fourth one sharing its predecessor's `createdAt`.
  await db.collection(WebhookSubscription.collection.name).insertMany([SUBSCRIPTION, OTHER_SUBSCRIPTION].map((id, n) => ({
    _id: new mongoose.Types.ObjectId(id),
    workspaceId: WORKSPACE,
    createdBy: OWNER,
    url: `https://example.test/hook-${n}`,
    secret: "synthetic",
    events: ["entry.created", "invoice.created"],
    enabled: true,
    consecutiveFailures: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  })));
  const deliveries = db.collection(WebhookDelivery.collection.name);
  for (const [s, subscriptionId] of [SUBSCRIPTION, OTHER_SUBSCRIPTION].entries()) {
    for (let offset = 0; offset < DELIVERY_COUNT; offset += 1000) {
      await deliveries.insertMany(Array.from({ length: Math.min(1000, DELIVERY_COUNT - offset) }, (_, i) => {
        const n = offset + i;
        const createdAt = new Date(newest - (n - (n % 4 === 3 ? 1 : 0)) * 120_000);
        const invoiceEvent = n % 10 === 0;
        return {
          _id: oid(0x91 + s, n),
          workspaceId: WORKSPACE,
          subscriptionId,
          event: invoiceEvent ? "invoice.created" : "entry.created",
          envelope: {
            id: `delivery-${s}-${n}`,
            event: invoiceEvent ? "invoice.created" : "entry.created",
            data: invoiceEvent ? { kind: "invoice", invoice: {} } : { kind: "entry", entry: { authorId: OWNER } },
          },
          status: n % 7 === 0 ? "failed" : "delivered",
          attempt: 1,
          responseStatus: n % 7 === 0 ? 500 : 200,
          error: null,
          nextAttemptAt: null,
          createdAt,
          updatedAt: createdAt,
        };
      }));
    }
  }

  for (const model of [TimeEntry, Invoice, WebhookDelivery, WebhookSubscription, WorkspaceMember] as mongoose.Model<unknown>[]) {
    for (const [keys, options] of model.schema.indexes()) {
      await db.collection(model.collection.name).createIndex(keys as Record<string, 1 | -1>, options as Record<string, unknown>);
    }
  }
}

const only = process.argv.slice(3);
const kept = process.env.PROFILE_DB;
assert.ok(!kept || kept.startsWith("trackyourtime-profile-"), "PROFILE_DB must be a profiler database");
const dbName = kept || `trackyourtime-profile-${randomUUID()}`;
await mongoose.connect(uri, { dbName, autoIndex: false });
try {
  const db = mongoose.connection.db!;
  if ((await db.collection(TimeEntry.collection.name).estimatedDocumentCount()) === 0) await seed(db);
  for (const which of CASES.filter((c) => only.length === 0 || only.some((o) => c.label.startsWith(o)))) {
    // Two warm-up runs, so the measured one reads cached plans rather than
    // paying for the planner's trial of every candidate index.
    await which.run();
    await which.run();

    await db.command({ profile: 0 });
    await db.collection("system.profile").drop().catch(() => undefined);
    await db.command({ profile: 2 });
    const { pages, rows } = await which.run();
    await db.command({ profile: 0 });
    const ops = await db.collection("system.profile").find({ ns: `${dbName}.${which.collection}` }).toArray();
    if (process.env.PROFILE_OPS) {
      for (const op of ops) {
        console.log(JSON.stringify({ op: op.op, keys: op.keysExamined, docs: op.docsExamined, plan: op.planSummary, sort: op.hasSortStage ?? false }));
      }
    }
    const keysExamined = ops.reduce((sum, op) => sum + Number(op.keysExamined ?? 0), 0);
    const docsExamined = ops.reduce((sum, op) => sum + Number(op.docsExamined ?? 0), 0);
    const returned = ops.reduce((sum, op) => sum + Number(op.nreturned ?? 0), 0);
    const sorted = ops.filter((op) => op.hasSortStage === true).length;
    const digest = createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
    console.log(JSON.stringify({ case: which.label, pages, queries: ops.length, sorted, keysExamined, docsExamined, returned, digest }));
  }
} finally {
  assert.ok(mongoose.connection.db!.databaseName.startsWith("trackyourtime-profile-"));
  if (!kept) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}
