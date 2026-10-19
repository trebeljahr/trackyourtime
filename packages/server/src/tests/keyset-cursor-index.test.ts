import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import mongoose from "mongoose";
import { Invoice } from "../models/Invoice.js";
import { WebhookDelivery } from "../models/WebhookDelivery.js";
import { WebhookSubscription } from "../models/WebhookSubscription.js";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import type { Context } from "../trpc/context.js";
import { invoicesRouter } from "../trpc/routers/invoices.js";
import { webhooksRouter } from "../trpc/routers/webhooks.js";
import { connectTestDatabase, dropTestDatabase, skipWithoutDatabase } from "./support/test-database.js";

// `invoices.list` and the webhook delivery log page newest first by
// (`createdAt`, `_id`). Every page must seek to its cursor through an index
// that ends in `_id`: a blocking sort, or a scan from the top, reads every row
// below (or above) the cursor on every page. Built beside the indexes an older
// release declared, as an upgraded database has them.

const WORKSPACE = "keyset-fixture";
const OWNER = "keyset-owner";
const SUBSCRIPTION = new mongoose.Types.ObjectId();
const OTHER_SUBSCRIPTION = new mongoose.Types.ObjectId();
const ROWS = 90;
const newest = Date.parse("2026-10-01T12:00:00Z");
/** Every third row shares its predecessor's `createdAt`, so the tie-break runs. */
const createdAt = (n: number): Date => new Date(newest - (n - (n % 3 === 2 ? 1 : 0)) * 3_600_000);

const context = {
  req: undefined,
  res: undefined,
  session: { session: { activeOrganizationId: WORKSPACE }, user: { id: OWNER } },
  user: { id: OWNER, name: "Owner", email: "owner@example.test" },
  authMethod: "cookie",
  activeWorkspaceId: WORKSPACE,
} as unknown as Context;

type Profiled = { hasSortStage?: boolean; docsExamined?: number; planSummary?: string };

/** What one call cost the given collection, from the database profiler. */
async function profiled<T>(collection: string, run: () => Promise<T>): Promise<{ result: T; ops: Profiled[] }> {
  const db = mongoose.connection.db!;
  await db.command({ profile: 0 });
  await db.collection("system.profile").drop().catch(() => undefined);
  await db.command({ profile: 2 });
  try {
    const result = await run();
    const ops = await db.collection<Profiled>("system.profile").find({ ns: `${db.databaseName}.${collection}` }).toArray();
    return { result, ops };
  } finally {
    await db.command({ profile: 0 });
  }
}

/** Newest first by (`createdAt`, `_id`), the order the pages must follow. */
const newestFirst = (rows: { _id: mongoose.Types.ObjectId; createdAt: Date }[]): string[] =>
  [...rows]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (String(b._id) < String(a._id) ? -1 : 1))
    .map((row) => String(row._id));

describe("keyset cursors seek through an index ending in _id", { skip: skipWithoutDatabase }, () => {
  const invoices: { _id: mongoose.Types.ObjectId; createdAt: Date; status: string }[] = [];
  const deliveries: { _id: mongoose.Types.ObjectId; createdAt: Date }[] = [];

  before(async () => {
    await connectTestDatabase("keyset-cursor-index", [Invoice, WebhookDelivery, WebhookSubscription, WorkspaceMember] as never);
    await Invoice.collection.createIndex({ workspaceId: 1, createdAt: -1 });
    await Invoice.collection.createIndex({ workspaceId: 1, status: 1, createdAt: -1 });
    await WebhookDelivery.collection.createIndex({ subscriptionId: 1, createdAt: -1 });
    await WorkspaceMember.create({ workspaceId: WORKSPACE, userId: OWNER, role: "owner", name: "Owner", canViewOthersTime: true, canViewOthersMoney: true });
    await WebhookSubscription.create([SUBSCRIPTION, OTHER_SUBSCRIPTION].map((_id, n) => ({
      _id, workspaceId: WORKSPACE, createdBy: OWNER, url: `https://example.test/${n}`, secret: "synthetic",
    })));

    const invoiceDocs = Array.from({ length: ROWS + 30 }, (_, n) => {
      const at = createdAt(n);
      const doc = {
        _id: new mongoose.Types.ObjectId(),
        // A second workspace interleaved, which no page may read.
        workspaceId: n % 4 === 3 ? "keyset-other" : WORKSPACE,
        createdBy: OWNER, number: `K-${n}`, clientId: "client", clientName: "Client",
        // One in five still sent and long overdue.
        status: n % 5 === 0 ? "sent" : "paid",
        issueDate: at, dueDate: new Date(at.getTime() + 86_400_000), from: at, to: at, groupBy: "project",
        lineItems: [], subtotal: 100, taxRate: null, taxAmount: 0, total: 100, currency: "EUR", entryIds: [],
        notes: null, createdAt: at, updatedAt: at,
      };
      if (doc.workspaceId === WORKSPACE) invoices.push(doc);
      return doc;
    });
    await Invoice.collection.insertMany(invoiceDocs);

    const deliveryDocs = Array.from({ length: ROWS * 2 }, (_, n) => {
      const at = createdAt(Math.floor(n / 2));
      const doc = {
        _id: new mongoose.Types.ObjectId(),
        workspaceId: WORKSPACE,
        subscriptionId: String(n % 2 === 0 ? SUBSCRIPTION : OTHER_SUBSCRIPTION),
        event: "entry.created",
        envelope: { data: { kind: "entry", entry: { authorId: OWNER } } },
        status: "delivered", attempt: 1, responseStatus: 200, error: null, nextAttemptAt: null,
        createdAt: at, updatedAt: at,
      };
      if (doc.subscriptionId === String(SUBSCRIPTION)) deliveries.push(doc);
      return doc;
    });
    await WebhookDelivery.collection.insertMany(deliveryDocs);
  });
  after(dropTestDatabase);

  it("invoices.list reads one page per page, with and without a status filter", async () => {
    const caller = invoicesRouter.createCaller(context);
    for (const status of [undefined, "paid"] as const) {
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const { result, ops } = await profiled(Invoice.collection.name, () =>
          caller.list({ limit: 10, ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) }));
        assert.ok(ops.length > 0);
        for (const op of ops) assert.equal(op.hasSortStage ?? false, false, op.planSummary);
        // One page and its look-ahead row, plus the cursor's own ties.
        assert.ok(ops.reduce((sum, op) => sum + (op.docsExamined ?? 0), 0) <= 13);
        ids.push(...result.invoices.map((invoice) => invoice.id));
        cursor = result.nextCursor;
      } while (cursor);
      assert.deepEqual(ids, newestFirst(invoices.filter((row) => !status || row.status === status)));
    }
  });

  it("the overdue scan seeks too, and drops no overdue invoice", async () => {
    const caller = invoicesRouter.createCaller(context);
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const { result, ops } = await profiled(Invoice.collection.name, () =>
        caller.list({ overdue: true, limit: 4, ...(cursor ? { cursor } : {}) }));
      for (const op of ops) assert.equal(op.hasSortStage ?? false, false, op.planSummary);
      ids.push(...result.invoices.map((invoice) => invoice.id));
      cursor = result.nextCursor;
    } while (cursor);
    assert.deepEqual(ids, newestFirst(invoices.filter((row) => row.status === "sent")));
  });

  it("webhooks.deliveries reads one page per page", async () => {
    const caller = webhooksRouter.createCaller(context);
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const { result, ops } = await profiled(WebhookDelivery.collection.name, () =>
        caller.deliveries({ subscriptionId: String(SUBSCRIPTION), limit: 10, ...(cursor ? { cursor } : {}) }));
      assert.equal(ops.length, 1);
      assert.equal(ops[0]!.hasSortStage ?? false, false, ops[0]!.planSummary);
      assert.ok((ops[0]!.docsExamined ?? 0) <= 13);
      ids.push(...result.deliveries.map((delivery) => delivery.id));
      cursor = result.nextCursor;
    } while (cursor);
    assert.deepEqual(ids, newestFirst(deliveries));
  });
});
