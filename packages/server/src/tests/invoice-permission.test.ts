// Who may use invoices in a shared workspace, and how a refusal reads.
//
// An invoice merges whoever's billable hours fell in its range into one line:
// it discloses colleagues' time and money at once, and issuing one is a
// workspace decision. So the rule is `canUseInvoices` — owner or admin, with
// both visibility flags — and every procedure asks it BEFORE touching the
// database. How the refusal reads depends on what was asked:
//
//   list                                  → an empty page
//   get / exportPdf / update / updateStatus / remove → NOT_FOUND, exactly like an id
//                                           that does not exist (FORBIDDEN
//                                           would confirm the invoice is real)
//   preview / create                      → FORBIDDEN invoice-permission-required
//
// Every row of the matrix runs against a REAL invoice id in the caller's own
// workspace, so a NOT_FOUND here can only be the gate.
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { TRPCError } from "@trpc/server";
import { Types } from "mongoose";
import { canUseInvoices } from "@starter/shared";
import type { WorkspaceRole } from "@starter/shared";
import { UserPreferencesModel } from "../models/Settings.js";
import { WebhookSubscription } from "../models/WebhookSubscription.js";
import {
  INVOICE_PERMISSION_REQUIRED,
  invoicesRouter,
} from "../trpc/routers/invoices.js";
import { memoryCollection, stubModel } from "./support/in-memory-models.js";
import {
  CLIENT_ID,
  MEMBER,
  OWNER,
  SECRET_RATE,
  WORKSPACE,
  contextFor,
  freshStore,
  installStore,
  resetStore,
} from "./support/shared-workspace.js";

const store = freshStore();
const restoreStore = installStore(store);
const restoreWebhooks = stubModel(WebhookSubscription, memoryCollection());
// Read by preview and create for the issuer's language preference.
const restorePreferences = stubModel(UserPreferencesModel, memoryCollection());
after(() => {
  restoreStore();
  restoreWebhooks();
  restorePreferences();
});

const INVOICE_ID = new Types.ObjectId("64b7f9c2e13a4d5f6a7b8f01");

beforeEach(() => {
  resetStore(store);
  store.invoices.rows.push({
    _id: INVOICE_ID,
    workspaceId: WORKSPACE,
    createdBy: OWNER,
    number: "2026-001",
    clientId: String(CLIENT_ID),
    clientName: "Acme GmbH",
    status: "draft",
    issueDate: new Date("2026-08-31T00:00:00.000Z"),
    dueDate: new Date("2026-09-14T00:00:00.000Z"),
    from: new Date("2026-08-01T00:00:00.000Z"),
    to: new Date("2026-08-31T00:00:00.000Z"),
    groupBy: "project",
    lineItems: [
      {
        key: "p1",
        label: "Rebrand",
        projectId: null,
        taskId: null,
        seconds: 36_000,
        hours: 10,
        hourlyRate: SECRET_RATE,
        currency: "EUR",
        amount: 10 * SECRET_RATE,
      },
    ],
    subtotal: 10 * SECRET_RATE,
    taxRate: null,
    taxAmount: 0,
    total: 10 * SECRET_RATE,
    currency: "EUR",
    entryIds: [],
    notes: null,
    createdAt: new Date("2026-08-31T00:00:00.000Z"),
    updatedAt: new Date("2026-08-31T00:00:00.000Z"),
  });
});

/** The callers of the matrix, by role and flags — the caller is always MEMBER's id. */
const CALLERS: {
  name: string;
  role: WorkspaceRole;
  time: boolean;
  money: boolean;
}[] = [
  { name: "owner", role: "owner", time: true, money: true },
  { name: "admin with both flags", role: "admin", time: true, money: true },
  { name: "admin, time only", role: "admin", time: true, money: false },
  { name: "admin, money only", role: "admin", time: false, money: true },
  { name: "member, both flags", role: "member", time: true, money: true },
  { name: "member, closed", role: "member", time: false, money: false },
];

/** Make MEMBER's membership row hold `role` and the two flags. */
const becomeCaller = (caller: (typeof CALLERS)[number]): void => {
  const row = store.members.rows.find((member) => member.userId === MEMBER);
  assert.ok(row);
  row.role = caller.role;
  row.canViewOthersTime = caller.time;
  row.canViewOthersMoney = caller.money;
};

const refusedWith = async (
  promise: Promise<unknown>,
  code: TRPCError["code"],
  message?: string,
): Promise<void> => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof TRPCError, `expected a TRPCError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
};

/** A refused caller must not have caused a single read of workspace data. */
const assertNothingRead = (): void => {
  assert.equal(store.invoices.queries.length, 0, "an invoice was read");
  assert.equal(store.entries.queries.length, 0, "entries were read");
  assert.equal(store.clients.queries.length, 0, "a client was read");
};

const RANGE = { clientId: String(CLIENT_ID), from: "2026-09-01", to: "2026-09-30" };

for (const callerSpec of CALLERS) {
  const allowed = canUseInvoices(callerSpec.role, {
    userId: MEMBER,
    canViewOthersTime: callerSpec.time,
    canViewOthersMoney: callerSpec.money,
  });

  describe(`invoices as ${callerSpec.name} (${allowed ? "allowed" : "refused"})`, () => {
    const caller = () => {
      becomeCaller(callerSpec);
      return invoicesRouter.createCaller(contextFor(MEMBER));
    };

    it("list", async () => {
      const result = await caller().list({});
      if (allowed) {
        assert.equal(result.invoices.length, 1);
      } else {
        assert.deepEqual(result, { invoices: [] });
        assertNothingRead();
      }
    });

    it("get", async () => {
      const call = caller().get({ id: String(INVOICE_ID) });
      if (allowed) {
        assert.equal((await call).total, 10 * SECRET_RATE);
      } else {
        await refusedWith(call, "NOT_FOUND");
        assertNothingRead();
      }
    });

    it("exportPdf", async () => {
      const call = caller().exportPdf({ id: String(INVOICE_ID) });
      if (allowed) {
        assert.equal((await call).mimeType, "application/pdf");
      } else {
        await refusedWith(call, "NOT_FOUND");
        assertNothingRead();
      }
    });

    it("updateStatus", async () => {
      const call = caller().updateStatus({ id: String(INVOICE_ID), status: "sent" });
      if (allowed) {
        assert.equal((await call).status, "sent");
      } else {
        await refusedWith(call, "NOT_FOUND");
        assertNothingRead();
        assert.equal(store.invoices.rows[0]?.status, "draft");
      }
    });

    it("update", async () => {
      const call = caller().update({
        id: String(INVOICE_ID),
        updatedAt: "2026-08-31T00:00:00.000Z",
        notes: "edited",
      });
      if (allowed) {
        assert.equal((await call).notes, "edited");
      } else {
        await refusedWith(call, "NOT_FOUND");
        assertNothingRead();
        assert.equal(store.invoices.rows[0]?.notes, null);
      }
    });

    it("remove", async () => {
      const call = caller().remove({ id: String(INVOICE_ID) });
      if (allowed) {
        assert.equal((await call).deleted, true);
        assert.equal(store.invoices.rows.length, 0);
      } else {
        await refusedWith(call, "NOT_FOUND");
        assertNothingRead();
        assert.equal(store.invoices.rows.length, 1);
      }
    });

    // The e-invoice procedures address the invoice by id too: NOT_FOUND for a
    // refused caller, before the invoice, the client or the profile is read.
    it("einvoiceCheck", async () => {
      const call = caller().einvoiceCheck({ id: String(INVOICE_ID), profile: "xrechnung" });
      if (allowed) {
        // A pre-e-invoicing fixture: no parties, no categories.
        assert.equal((await call).ready, false);
      } else {
        await refusedWith(call, "NOT_FOUND");
        assertNothingRead();
        assert.equal(store.businessProfiles.queries.length, 0, "the profile was read");
      }
    });

    it("attachEinvoiceData", async () => {
      const call = caller().attachEinvoiceData({ id: String(INVOICE_ID), confirm: true });
      if (allowed) {
        // No tax rate on the fixture: the 0 % category must be chosen first.
        await refusedWith(call, "BAD_REQUEST");
      } else {
        await refusedWith(call, "NOT_FOUND");
        assertNothingRead();
      }
      assert.equal("einvoice" in (store.invoices.rows[0] ?? {}), false);
    });

    for (const exporter of ["exportZugferd", "exportXrechnung"] as const) {
      it(exporter, async () => {
        const call = caller()[exporter]({ id: String(INVOICE_ID) });
        if (allowed) {
          await refusedWith(call, "PRECONDITION_FAILED");
        } else {
          await refusedWith(call, "NOT_FOUND");
          assertNothingRead();
        }
      });
    }

    it("preview", async () => {
      const call = caller().preview({ ...RANGE, groupBy: "project" });
      if (allowed) {
        const preview = await call;
        // All three authors' billable hours, merged into one line.
        assert.equal(preview.subtotal, 3 * SECRET_RATE);
        assert.equal(preview.entryIds.length, 3);
      } else {
        // Gathering first would have read every colleague's billable entries.
        await refusedWith(call, "FORBIDDEN", INVOICE_PERMISSION_REQUIRED);
        assertNothingRead();
      }
    });

    it("create", async () => {
      const call = caller().create({
        ...RANGE,
        groupBy: "project",
        issueDate: "2026-09-30",
        dueDate: "2026-10-14",
      });
      if (allowed) {
        const invoice = await call;
        assert.equal(invoice.total, 3 * SECRET_RATE);
        assert.equal(store.invoices.rows.length, 2);
      } else {
        await refusedWith(call, "FORBIDDEN", INVOICE_PERMISSION_REQUIRED);
        assertNothingRead();
        assert.equal(store.invoices.rows.length, 1);
        assert.ok(store.entries.rows.every((entry) => entry.invoiceId === null));
      }
    });
  });
}

describe("canUseInvoices", () => {
  it("is owner-or-admin AND both flags", () => {
    const allowedNames = CALLERS.filter((spec) =>
      canUseInvoices(spec.role, {
        userId: "u",
        canViewOthersTime: spec.time,
        canViewOthersMoney: spec.money,
      }),
    ).map((spec) => spec.name);
    assert.deepEqual(allowedNames, ["owner", "admin with both flags"]);
  });

  it("the matrix's owner is the acceptance fixture's owner", () => {
    // A personal workspace's owner has both flags forced on, so solo use is
    // unaffected by the gate.
    const owner = freshStore().members.rows.find((row) => row.userId === OWNER);
    assert.equal(owner?.canViewOthersTime, true);
    assert.equal(owner?.canViewOthersMoney, true);
  });
});
