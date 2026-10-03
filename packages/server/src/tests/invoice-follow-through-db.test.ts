import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, describe, it } from "node:test";
import { supportsBusinessTransactions } from "../services/business-transaction.js";
import { Invoice } from "../models/Invoice.js";
import {
  changeFollowThrough,
  creditInvoice,
  ensureReplacement,
  loadFollowThrough,
} from "../services/invoice-follow-through.js";
import { pageTexts } from "./support/pdf-text.js";
import { TimeEntry } from "../models/TimeEntry.js";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { invoicesRouter } from "../trpc/routers/invoices.js";
import { runInvoiceReminders } from "../services/scheduler/invoice-reminders.js";
import {
  INTEGRATION_MODELS,
  OWNER,
  ADMIN_NO_MONEY,
  WORKSPACE,
  contextFor,
  seedWorkspace,
} from "./support/einvoice-db-fixture.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  dropTestDatabase,
  skipWithoutDatabase,
} from "./support/test-database.js";
const owner = () => invoicesRouter.createCaller(contextFor(OWNER));
const draft = async () => {
  const seed = await seedWorkspace();
  return owner().create({
    clientId: seed.clientId,
    from: "2026-09-01",
    to: "2026-09-30",
    issueDate: "2026-09-30",
    dueDate: "2026-10-01",
    timezone: "UTC",
  });
};
const sent = async () => {
  const invoice = await draft();
  return owner().updateStatus({ id: invoice.id, status: "sent" });
};
const payment = (id: string, amount: string) => ({
  id,
  requestId: randomUUID(),
  amount,
  kind: "payment" as const,
  at: "2026-09-30T00:00:00.000Z",
  note: "Test only",
});
const consent = (id: string, enabled = true) => ({
  id,
  enabled,
  recipient: "synthetic@example.test",
  timezone: "UTC",
});

describe(
  "invoice accounting on Mongo",
  { skip: skipWithoutDatabase },
  () => {
    before(async () =>
      connectTestDatabase(
        "invoice-follow-through",
        INTEGRATION_MODELS as never,
      ),
    );
    afterEach(clearTestDatabase);
    after(dropTestDatabase);
    it("concurrent full payments cannot overpay; identical retry appends once", async () => {
      const invoice = await sent();
      const input = payment(invoice.id, String(invoice.total));
      const results = await Promise.allSettled([
        owner().recordPayment(input),
        owner().recordPayment({ ...input, requestId: randomUUID() }),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const saved = await owner().get({ id: invoice.id });
      assert.equal(saved.followThrough?.payments?.length, 1);
      const winner = saved.followThrough!.payments![0]!;
      await owner().recordPayment({ ...input, requestId: winner.requestId });
      assert.equal(
        (await owner().get({ id: invoice.id })).followThrough?.payments?.length,
        1,
      );
      assert.equal(saved.balance?.outstandingMinor, 0);
    });
    it("an unsafe stored total remains visible as unavailable and cannot be settled or reminded", async () => {
      const invoice = await sent();
      await Invoice.updateOne({ _id: invoice.id }, { $set: { total: 1e20 } });
      const row = (await owner().list({})).invoices.find(
        (value) => value.id === invoice.id,
      );
      assert.equal(row?.balance?.available, false);
      assert.equal(row?.balance?.outstandingMinor, null);
      await assert.rejects(
        owner().recordPayment(payment(invoice.id, "1")),
        /invoice-balance-unavailable/,
      );
      await assert.rejects(
        owner().updateStatus({ id: invoice.id, status: "paid" }),
        /invoice-balance-unavailable/,
      );
      await assert.rejects(
        owner().setReminders(consent(invoice.id)),
        /invoice-balance-unavailable/,
      );
      await assert.rejects(
        owner().reminderPreview(consent(invoice.id)),
        /invoice-balance-unavailable/,
      );
      assert.equal((await owner().get({ id: invoice.id })).status, "sent");
    });
    it("sent cannot return to draft, issued XML drafts cannot be edited/deleted", async () => {
      const invoice = await sent();
      await assert.rejects(
        owner().updateStatus({ id: invoice.id, status: "draft" }),
      );
      await Invoice.updateOne(
        { _id: invoice.id },
        {
          $set: {
            status: "draft",
            "einvoice.issuedXml.en16931": {
              xml: "synthetic",
              generatedAt: new Date(),
              generator: "test",
            },
          },
        },
      );
      const locked = await owner().get({ id: invoice.id });
      assert.equal(locked.issued, true);
      await assert.rejects(owner().remove({ id: invoice.id }));
      await assert.rejects(
        owner().update({
          id: invoice.id,
          updatedAt: locked.updatedAt,
          notes: "Changed",
        }),
      );
      assert.equal(
        await TimeEntry.countDocuments({ invoiceId: invoice.id }),
        invoice.entryIds.length,
      );
    });
    it("interrupted deletion rolls back with transactions or stays visibly pending on standalone", async (t) => {
      const invoice = await draft();
      const fail = t.mock.method(TimeEntry, "updateMany", () => {
        throw new Error("Synthetic release failure");
      });
      await assert.rejects(
        owner().remove({ id: invoice.id }),
        /Synthetic release failure/,
      );
      fail.mock.restore();
      const visible = await owner().list({});
      const transactions = await supportsBusinessTransactions();
      assert.equal(
        Boolean(visible.invoices.find((row) => row.id === invoice.id)?.deletionPending),
        !transactions,
      );
      assert.equal(await TimeEntry.countDocuments({ invoiceId: invoice.id }), invoice.entryIds.length);
      if (!transactions) {
        const pending = await owner().get({ id: invoice.id });
        await assert.rejects(
          owner().update({
            id: invoice.id,
            updatedAt: pending.updatedAt,
            notes: "Cannot edit",
          }),
        );
        await assert.rejects(
          owner().updateStatus({ id: invoice.id, status: "sent" }),
        );
        await assert.rejects(owner().exportPdf({ id: invoice.id }));
        await assert.rejects(owner().exportXrechnung({ id: invoice.id }));
        await assert.rejects(
          owner().attachEinvoiceData({ id: invoice.id, confirm: true }),
        );
      }
      await owner().remove({ id: invoice.id });
      assert.equal(await Invoice.countDocuments({ _id: invoice.id }), 0);
      assert.equal(
        await TimeEntry.countDocuments({ invoiceId: invoice.id }),
        0,
      );
    });
    it("concurrent correction retries create one full credit and one normally numbered replacement, with locked original entries", async () => {
      const invoice = await sent();
      const input = {
        id: invoice.id,
        requestId: randomUUID(),
        reason: "Correct the scope",
        replacement: true,
      };
      await Promise.all([owner().credit(input), owner().credit(input)]);
      const original = await owner().get({ id: invoice.id });
      const credit = original.followThrough!.credit!;
      assert.equal(credit.number, `CN-${invoice.number}`);
      assert.deepEqual(credit.snapshot.lineItems, invoice.lineItems);
      const replacement = await owner().get({ id: credit.replacementId! });
      assert.match(replacement.number, /^\d{4}-\d{3,}$/);
      assert.equal(replacement.status, "draft");
      assert.equal(replacement.replacementFor, invoice.id);
      assert.deepEqual(replacement.entryIds, []);
      assert.equal(replacement.lineItems[0]?.kind, "manual");
      assert.equal(
        await Invoice.countDocuments({ replacementFor: invoice.id }),
        1,
      );
      assert.equal(
        await TimeEntry.countDocuments({ invoiceId: invoice.id }),
        invoice.entryIds.length,
      );
      await assert.rejects(owner().remove({ id: replacement.id }));
      await owner().credit(input);
      assert.equal(
        await Invoice.countDocuments({ replacementFor: invoice.id }),
        1,
      );
      await assert.rejects(
        owner().exportCreditXml({ id: invoice.id }),
        /credit-xml-unsupported/,
      );
      const pdf = await owner().exportCreditPdf({ id: invoice.id });
      assert.match(
        Buffer.from(pdf.base64, "base64").subarray(0, 4).toString(),
        /%PDF/,
      );
    });
    it("keeps a Sydney Jan 1 credit PDF and replacement in the new year when retried in another timezone", async () => {
      const invoice = await sent();
      await Invoice.updateOne(
        { _id: invoice.id },
        { $set: { timezone: "Australia/Sydney", locale: "en" } },
      );
      const input = {
        id: invoice.id,
        requestId: randomUUID(),
        reason: "Year boundary",
        replacement: true,
      };
      const instant = new Date("2026-12-31T13:05:00.000Z");
      const credited = await changeFollowThrough(
        invoice.id,
        WORKSPACE,
        (wire) => creditInvoice(wire, input, OWNER, instant),
      );
      assert.equal(credited.followThrough!.credit!.at, instant.toISOString());
      assert.equal(credited.followThrough!.credit!.issueDate, "2027-01-01");
      const firstPdf = await owner().exportCreditPdf({ id: invoice.id });
      assert.match(
        pageTexts(Buffer.from(firstPdf.base64, "base64")).join(" "),
        /Issue date2027-01-01/,
      );

      // Simulate later settings and a retry after credit persisted but before draft creation.
      await Invoice.updateOne(
        { _id: invoice.id },
        { $set: { timezone: "America/Los_Angeles" } },
      );
      await ensureReplacement(await loadFollowThrough(invoice.id, WORKSPACE));
      const replacement = await owner().get({
        id: credited.followThrough!.credit!.replacementId!,
      });
      assert.match(replacement.number, /^2027-/);
      assert.equal(replacement.issueDate.slice(0, 10), "2027-01-01");
      assert.equal(replacement.dueDate.slice(0, 10), "2027-01-01");
      const retried = await owner().credit(input);
      assert.equal(retried.followThrough!.credit!.issueDate, "2027-01-01");
      assert.equal(retried.followThrough!.credit!.at, instant.toISOString());
      const secondPdf = await owner().exportCreditPdf({ id: invoice.id });
      assert.deepEqual(
        pageTexts(Buffer.from(secondPdf.base64, "base64")),
        pageTexts(Buffer.from(firstPdf.base64, "base64")),
      );
      assert.equal(
        await Invoice.countDocuments({ replacementFor: invoice.id }),
        1,
      );
    });
    it("mixed VAT replacement preserves the credit snapshot and recomputes an edited draft coherently", async () => {
      const seed = await seedWorkspace();
      const original = await owner().create({
        clientId: seed.clientId,
        issueDate: "2026-09-30",
        dueDate: "2026-10-14",
        lines: [
          {
            label: "Standard",
            quantity: 2,
            unit: "piece",
            unitPrice: 50,
            tax: { category: "S", rate: 19 },
          },
          {
            label: "Reduced",
            quantity: 3,
            unit: "piece",
            unitPrice: 20,
            tax: { category: "S", rate: 7 },
          },
        ],
      });
      await owner().updateStatus({ id: original.id, status: "sent" });
      const credited = await owner().credit({
        id: original.id,
        requestId: randomUUID(),
        reason: "Quantity correction",
        replacement: true,
      });
      const replacement = await owner().get({
        id: credited.followThrough!.credit!.replacementId!,
      });
      assert.deepEqual(replacement.taxBreakdown, original.taxBreakdown);
      assert.equal(replacement.total, original.total);
      const edited = await owner().update({
        id: replacement.id,
        updatedAt: replacement.updatedAt,
        lines: replacement.lineItems.map((line, index) => ({
          kind: "manual" as const,
          key: line.key,
          label: line.label,
          quantity: 1,
          unit: "piece" as const,
          unitPrice: index === 0 ? 80 : 60,
        })),
      });
      assert.equal(edited.subtotal, 140);
      assert.equal(edited.taxAmount, 19.4);
      assert.equal(edited.total, 159.4);
      assert.deepEqual(
        edited.taxBreakdown
          ?.map((row) => [row.rate, row.basisAmount, row.taxAmount])
          .sort((a, b) => a[0]! - b[0]!),
        [
          [7, 60, 4.2],
          [19, 80, 15.2],
        ],
      );
      assert.deepEqual(
        (await owner().get({ id: original.id })).followThrough?.credit?.snapshot
          .taxBreakdown,
        original.taxBreakdown,
      );
    });
    it("credit snapshots and append-only records survive database serialization", async () => {
      const invoice = await sent();
      await owner().recordPayment(payment(invoice.id, "0.29"));
      await owner().credit({
        id: invoice.id,
        requestId: randomUUID(),
        reason: "Archive",
        replacement: false,
      });
      const before = await owner().get({ id: invoice.id });
      const raw = await Invoice.findById(invoice.id).lean();
      assert.ok(raw);
      const copy = new Invoice(raw);
      await copy.validate();
      assert.deepEqual(
        JSON.parse(JSON.stringify(copy.followThrough)),
        before.followThrough,
      );
    });
    it("partial payments, full credit and refunds reconcile without deleting history", async () => {
      const invoice = await sent();
      await owner().recordPayment(payment(invoice.id, "25.29"));
      await owner().credit({
        id: invoice.id,
        requestId: randomUUID(),
        reason: "Cancelled",
        replacement: false,
      });
      assert.equal(
        (await owner().get({ id: invoice.id })).balance?.refundDueMinor,
        2529,
      );
      const result = await owner().recordPayment({
        ...payment(invoice.id, "25.29"),
        kind: "refund",
      });
      assert.equal(result.balance?.refundDueMinor, 0);
      assert.equal(result.followThrough?.payments?.length, 2);
      await assert.rejects(
        owner().recordPayment({
          ...payment(invoice.id, "0.01"),
          kind: "refund",
        }),
      );
    });
    it("all new operations hide ids from restricted admins and other workspaces", async () => {
      const invoice = await sent();
      const restricted = invoicesRouter.createCaller(
        contextFor(ADMIN_NO_MONEY),
      );
      await WorkspaceMember.create({
        workspaceId: "other",
        userId: OWNER,
        role: "owner",
        name: "Synthetic owner",
        canViewOthersTime: true,
        canViewOthersMoney: true,
      });
      for (const caller of [
        restricted,
        invoicesRouter.createCaller({
          ...contextFor(OWNER),
          activeWorkspaceId: "other",
        }),
      ]) {
        for (const operation of [
          () => caller.recordPayment(payment(invoice.id, "1")),
          () =>
            caller.credit({
              id: invoice.id,
              requestId: randomUUID(),
              reason: "Test",
              replacement: false,
            }),
          () => caller.setReminders(consent(invoice.id)),
          () => caller.reminderPreview(consent(invoice.id)),
          () => caller.exportCreditPdf({ id: invoice.id }),
          () => caller.exportCreditXml({ id: invoice.id }),
        ]) {
          await assert.rejects(
            operation(),
            (error: unknown) =>
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "NOT_FOUND",
          );
        }
      }
      assert.deepEqual(await restricted.list({ overdue: true }), {
        invoices: [],
      });
    });
    it("fake delivery: opt-in only, finite schedule, failed outcome retry, no claim leak", async () => {
      const invoice = await sent();
      let now = new Date("2026-10-02T12:00:00Z");
      const mails: string[] = [];
      let fail = false;
      const deps = {
        now: () => now,
        configured: () => true,
        send: async (mail: { to: string }) => {
          if (fail) throw new Error("Fake failure");
          mails.push(mail.to);
        },
      };
      await runInvoiceReminders(deps);
      assert.deepEqual(mails, []);
      await owner().setReminders(consent(invoice.id));
      fail = true;
      await runInvoiceReminders(deps);
      assert.equal(
        (await owner().get({ id: invoice.id })).followThrough?.reminders
          ?.lastOutcome,
        "failed",
      );
      assert.equal(
        (await owner().get({ id: invoice.id })).followThrough?.reminders?.claim,
        undefined,
      );
      fail = false;
      now = new Date("2026-10-02T13:01:00Z");
      await Promise.all([runInvoiceReminders(deps), runInvoiceReminders(deps)]);
      assert.deepEqual(mails, ["synthetic@example.test"]);
      for (const date of ["2026-10-08", "2026-10-15", "2026-11-01"]) {
        now = new Date(date);
        await runInvoiceReminders(deps);
      }
      assert.equal(mails.length, 3);
    });
    it("rechecks cancellation after claiming and before the fake mailer", async () => {
      const invoice = await sent();
      await owner().setReminders(consent(invoice.id));
      await runInvoiceReminders({
        now: () => new Date("2026-10-20T12:00:00Z"),
        configured: () => true,
        beforeRecheck: async () => {
          await owner().setReminders(consent(invoice.id, false));
        },
        send: async () => {
          assert.fail("cancelled consent must not send");
        },
      });
    });
    it("late opt-in sends one reminder and records skipped stages", async () => {
      const invoice = await sent();
      await owner().setReminders(consent(invoice.id));
      let now = new Date("2026-11-01T12:00:00Z");
      let count = 0;
      const deps = {
        now: () => now,
        configured: () => true,
        send: async () => {
          count++;
        },
      };
      await runInvoiceReminders(deps);
      now = new Date("2026-11-02T12:00:00Z");
      await runInvoiceReminders(deps);
      const reminder = (await owner().get({ id: invoice.id })).followThrough
        ?.reminders;
      assert.equal(count, 1);
      assert.deepEqual(reminder?.sentDays, [14]);
      assert.deepEqual(reminder?.skippedDays, [1, 7]);
    });
    it("overdue filtering derives outstanding balance and paginates without dropping matching rows", async () => {
      const original = await sent();
      const raw = await Invoice.findById(original.id).lean();
      assert.ok(raw);
      const {
        _id: _ignoredId,
        createdAt: _ignoredCreated,
        updatedAt: _ignoredUpdated,
        ...copy
      } = raw;
      await Invoice.insertMany(
        Array.from({ length: 5 }, (_, index) => ({
          ...copy,
          number: `FILTER-${index}`,
          entryIds: [],
          status: index === 2 ? "paid" : "sent",
          dueDate: new Date("2000-01-01"),
          createdAt: new Date(2020, 0, index + 1),
        })),
      );
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await owner().list({
          overdue: true,
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        for (const row of page.invoices) {
          assert.ok((row.balance?.outstandingMinor ?? 0) > 0);
          assert.ok((row.balance?.overdueDays ?? 0) > 0);
          ids.push(row.id);
        }
        cursor = page.nextCursor;
      } while (cursor);
      assert.equal(new Set(ids).size, ids.length);
      assert.equal(ids.filter((id) => id !== original.id).length, 4);
    });
    it("settlement, credit, consent cancellation and revoked rights suppress fake delivery", async () => {
      const invoice = await sent();
      const deps = {
        now: () => new Date("2026-10-20T12:00:00Z"),
        configured: () => true,
        send: async () => {
          assert.fail("must not send");
        },
      };
      await owner().setReminders(consent(invoice.id));
      await owner().setReminders(consent(invoice.id, false));
      await runInvoiceReminders(deps);
      await owner().setReminders(consent(invoice.id));
      await WorkspaceMember.updateOne(
        { workspaceId: WORKSPACE, userId: OWNER },
        { $set: { canViewOthersMoney: false } },
      );
      await runInvoiceReminders(deps);
      await WorkspaceMember.updateOne(
        { workspaceId: WORKSPACE, userId: OWNER },
        { $set: { canViewOthersMoney: true } },
      );
      await owner().setReminders(consent(invoice.id));
      await owner().recordPayment(payment(invoice.id, String(invoice.total)));
      await runInvoiceReminders(deps);
      await owner().credit({
        id: invoice.id,
        requestId: randomUUID(),
        reason: "Correct paid invoice",
        replacement: false,
      });
      await runInvoiceReminders(deps);
      assert.equal(
        (await owner().get({ id: invoice.id })).balance?.refundDueMinor,
        Math.round(invoice.total * 100),
      );
    });
  },
);
