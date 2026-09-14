// What the web app's own API may tell a colleague about time and money.
//
// REST has refused or projected money since `/api/v1` shipped. tRPC — the API
// the web app, the extension, Raycast and the phone actually use — served the
// same rows unprojected, which was harmless only while every workspace had one
// member. These tests drive the real routers against an in-memory copy of a
// shared workspace (owner: both flags, admin: time only, member: neither) and
// state each rule from the side of what must NOT be on the wire, next to the
// caller who may see it.
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { inflateSync } from "node:zlib";
import { TRPCError } from "@trpc/server";
import type { DetailedEntry } from "@starter/shared";
import { projectProjectForVisibility } from "@starter/shared";
import { canSeeBudgetProgress } from "../trpc/routers/project-budgets.js";
import { dataRouter } from "../trpc/routers/data.js";
import { entriesRouter } from "../trpc/routers/entries.js";
import { projectsRouter } from "../trpc/routers/projects.js";
import { reportsRouter } from "../trpc/routers/reports.js";
import {
  ADMIN,
  ENTRY_ID,
  MEMBER,
  OWNER,
  SECRET_RATE,
  contextFor,
  freshStore,
  installStore,
  resetStore,
} from "./support/shared-workspace.js";

const store = freshStore();
const restore = installStore(store);
after(restore);
beforeEach(() => resetStore(store));

const RANGE = { from: "2026-09-01", to: "2026-09-30" };

const byAuthor = (entries: DetailedEntry[]): Map<string, DetailedEntry> =>
  new Map(entries.map((entry) => [entry.authorId, entry]));

const rejectsWith = async (
  promise: Promise<unknown>,
  code: TRPCError["code"],
): Promise<void> => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof TRPCError, `expected a TRPCError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
};

// ── entries.list / entries.get ───────────────────────────────────────

describe("entries.list — colleagues' rows and their money", () => {
  it("owner: every row, every rate and amount", async () => {
    const { entries } = await entriesRouter
      .createCaller(contextFor(OWNER))
      .list(RANGE);
    const rows = byAuthor(entries);
    assert.equal(rows.size, 3);
    for (const entry of rows.values()) {
      assert.equal(entry.hourlyRate, SECRET_RATE);
      assert.equal(entry.amount, SECRET_RATE, "one hour at the rate");
    }
  });

  it("time-only admin: colleagues' rows arrive with hourlyRate AND amount null", async () => {
    const { entries } = await entriesRouter
      .createCaller(contextFor(ADMIN))
      .list(RANGE);
    const rows = byAuthor(entries);
    assert.equal(rows.size, 3, "time is visible, so every row is listed");
    for (const colleague of [OWNER, MEMBER]) {
      const entry = rows.get(colleague);
      assert.ok(entry);
      assert.equal(entry.hourlyRate, null, `${colleague}'s rate leaked`);
      // Null, never 0: zero is what unbillable time earns.
      assert.equal(entry.amount, null, `${colleague}'s amount leaked`);
      assert.equal(entry.durationSec, 3600);
    }
    const own = rows.get(ADMIN);
    assert.equal(own?.hourlyRate, SECRET_RATE, "own rows are always full");
    assert.equal(own?.amount, SECRET_RATE);
  });

  it("closed member: only their own rows, in full", async () => {
    const { entries } = await entriesRouter
      .createCaller(contextFor(MEMBER))
      .list(RANGE);
    assert.deepEqual(
      entries.map((entry) => entry.authorId),
      [MEMBER],
    );
    assert.equal(entries[0]?.hourlyRate, SECRET_RATE);
  });
});

describe("entries.get — one row by id", () => {
  it("time-only admin reads a colleague's entry with the rate withheld", async () => {
    const entry = await entriesRouter
      .createCaller(contextFor(ADMIN))
      .get({ id: String(ENTRY_ID[OWNER]) });
    assert.equal(entry.authorId, OWNER);
    assert.equal(entry.hourlyRate, null);
  });

  it("owner reads the same entry with its rate", async () => {
    const entry = await entriesRouter
      .createCaller(contextFor(OWNER))
      .get({ id: String(ENTRY_ID[ADMIN]) });
    assert.equal(entry.hourlyRate, SECRET_RATE);
  });

  it("closed member asking for a colleague's real id gets NOT_FOUND, never FORBIDDEN", async () => {
    await rejectsWith(
      entriesRouter
        .createCaller(contextFor(MEMBER))
        .get({ id: String(ENTRY_ID[OWNER]) }),
      "NOT_FOUND",
    );
  });

  it("closed member reads their own entry in full", async () => {
    const entry = await entriesRouter
      .createCaller(contextFor(MEMBER))
      .get({ id: String(ENTRY_ID[MEMBER]) });
    assert.equal(entry.hourlyRate, SECRET_RATE);
  });
});

describe("entries.recent / entries.descriptions stay author-scoped", () => {
  it("time-only admin's quick starts name only their own work", async () => {
    const caller = entriesRouter.createCaller(contextFor(ADMIN));
    const entriesQueried = store.entries.queries;
    await caller.recent({ days: 365 });
    await caller.descriptions({ days: 365 });
    // Every read those two made was filtered to the caller as author.
    assert.ok(entriesQueried.length >= 2);
    for (const filter of entriesQueried) {
      assert.equal(filter.authorId, ADMIN, JSON.stringify(filter));
    }
  });
});

// ── projects.list progress ───────────────────────────────────────────

describe("projects.list — budget progress parity with REST", () => {
  it("owner receives progress, including spentAmount over every author", async () => {
    const [project] = await projectsRouter
      .createCaller(contextFor(OWNER))
      .list({});
    assert.ok(project?.progress, "owner should see budget progress");
    assert.equal(project.progress.trackedSec, 10_800);
    assert.equal(project.progress.spentAmount, 3 * SECRET_RATE);
  });

  for (const [label, userId] of [
    ["time-only admin", ADMIN],
    ["closed member", MEMBER],
  ] as const) {
    it(`${label}: progress is null, and the whole-workspace entry read never runs`, async () => {
      const [project] = await projectsRouter
        .createCaller(contextFor(userId))
        .list({});
      assert.ok(project);
      assert.equal(project.progress, null);
      assert.equal(
        store.entries.queries.length,
        0,
        "the budget roll-up read every member's entries for a caller who may see none of the result",
      );
    });
  }

  it("answers exactly what REST's projectProjectForVisibility would", async () => {
    const [ownerView] = await projectsRouter
      .createCaller(contextFor(OWNER))
      .list({});
    assert.ok(ownerView);
    for (const userId of [ADMIN, MEMBER]) {
      resetStore(store);
      const member = store.members.rows.find((row) => row.userId === userId);
      assert.ok(member);
      const [served] = await projectsRouter
        .createCaller(contextFor(userId))
        .list({});
      const rest = projectProjectForVisibility(ownerView, {
        userId,
        canViewOthersTime: member.canViewOthersTime === true,
        canViewOthersMoney: member.canViewOthersMoney === true,
      });
      assert.equal(served?.progress, rest.progress, userId);
    }
  });

  it("canSeeBudgetProgress is the conjunction of both flags", () => {
    const at = (time: boolean, money: boolean): boolean =>
      canSeeBudgetProgress({
        userId: "u",
        canViewOthersTime: time,
        canViewOthersMoney: money,
      });
    assert.equal(at(true, true), true);
    assert.equal(at(true, false), false);
    assert.equal(at(false, true), false);
    assert.equal(at(false, false), false);
  });
});

// ── data export ──────────────────────────────────────────────────────

describe("data.exportJson / exportCsv / exportInfo — author scope and money", () => {
  it("closed member: only their own entries leave, with every rate redacted", async () => {
    const caller = dataRouter.createCaller(contextFor(MEMBER));
    const document = await caller.exportJson({});

    assert.equal(document.entries.length, 1);
    assert.equal(document.entries[0]?.description, `Work by ${MEMBER}`);
    for (const entry of document.entries) {
      assert.equal(entry.hourlyRate, null);
    }
    assert.equal(document.moneyRedacted, true);
    assert.equal(document.settings?.defaultHourlyRate ?? null, null);
    for (const project of document.projects) {
      assert.equal(project.hourlyRate ?? null, null);
    }
    const serialized = JSON.stringify(document);
    assert.ok(!serialized.includes(`Work by ${OWNER}`), "a colleague's entry left in the file");
    assert.ok(!serialized.includes(String(SECRET_RATE)), "a rate survived redaction");
  });

  it("closed member: the CSV carries the same single row and no rate values", async () => {
    const { csv } = await dataRouter
      .createCaller(contextFor(MEMBER))
      .exportCsv({});
    const lines = csv.trim().split(/\r?\n/);
    assert.equal(lines.length, 2, csv);
    assert.ok(!csv.includes(`Work by ${OWNER}`));
    assert.ok(!csv.includes(String(SECRET_RATE)));
  });

  it("closed member: exportInfo counts only their own entries", async () => {
    const info = await dataRouter
      .createCaller(contextFor(MEMBER))
      .exportInfo({});
    assert.equal(info.entries, 1);
    assert.equal(info.moneyRedacted, true);
  });

  it("closed member and time-only admin never receive invoices in the file", async () => {
    store.invoices.rows.push({
      workspaceId: "ws_shared_acme",
      createdBy: MEMBER,
      number: "2026-001",
      clientId: "64b7f9c2e13a4d5f6a7b8c02",
      clientName: "Acme GmbH",
      status: "draft",
      issueDate: new Date("2026-09-10T00:00:00.000Z"),
      dueDate: new Date("2026-09-24T00:00:00.000Z"),
      from: new Date("2026-09-01T00:00:00.000Z"),
      to: new Date("2026-09-30T00:00:00.000Z"),
      groupBy: "project",
      lineItems: [],
      subtotal: 411,
      taxRate: null,
      taxAmount: 0,
      total: 411,
      currency: "EUR",
      entryIds: [],
      notes: null,
      createdAt: new Date("2026-09-10T00:00:00.000Z"),
      updatedAt: new Date("2026-09-10T00:00:00.000Z"),
    });
    for (const userId of [MEMBER, ADMIN]) {
      const document = await dataRouter
        .createCaller(contextFor(userId))
        .exportJson({});
      assert.deepEqual(document.invoices ?? [], [], userId);
    }
  });

  it("time-only admin: every author's time, no money", async () => {
    const document = await dataRouter
      .createCaller(contextFor(ADMIN))
      .exportJson({});
    assert.equal(document.entries.length, 3);
    for (const entry of document.entries) assert.equal(entry.hourlyRate, null);
  });

  it("owner: the whole workspace with its money", async () => {
    const document = await dataRouter
      .createCaller(contextFor(OWNER))
      .exportJson({});
    assert.equal(document.entries.length, 3);
    for (const entry of document.entries) {
      assert.equal(entry.hourlyRate, SECRET_RATE);
    }
    assert.notEqual(document.moneyRedacted, true);
  });
});

// ── reports ──────────────────────────────────────────────────────────

/**
 * The visible text of a pdfkit document, page by page — the same
 * reconstruction pdf.test.ts documents: every content stream is deflated and
 * draws its text as hex runs inside `TJ` arrays.
 */
const pdfText = (base64: string): string => {
  const bytes = Buffer.from(base64, "base64");
  const open = Buffer.from("stream\n", "latin1");
  const close = Buffer.from("endstream", "latin1");
  const pages: string[] = [];
  let cursor = 0;
  for (;;) {
    const at = bytes.indexOf(open, cursor);
    if (at === -1) break;
    const start = at + open.byteLength;
    const end = bytes.indexOf(close, start);
    if (end === -1) break;
    try {
      const inflated = inflateSync(bytes.subarray(start, end)).toString("latin1");
      const runs = inflated.match(/<([0-9a-fA-F]+)>/g) ?? [];
      pages.push(
        Buffer.from(runs.map((run) => run.slice(1, -1)).join(""), "hex").toString(
          "latin1",
        ),
      );
      cursor = end + close.byteLength;
    } catch {
      cursor = start;
    }
  }
  return pages.join("\n");
};

/** Set one member's two flags in the installed store. */
const setFlags = (userId: string, time: boolean, money: boolean): void => {
  const row = store.members.rows.find((member) => member.userId === userId);
  assert.ok(row);
  row.canViewOthersTime = time;
  row.canViewOthersMoney = money;
};

const csvHeader = (csv: string): string[] =>
  (csv.split(/\r?\n/)[0] ?? "").split(",").map((cell) => cell.replace(/"/g, ""));

/**
 * The four combinations, with what each must be served. `ADMIN` is the caller
 * throughout; only the flags change.
 */
const COMBOS = [
  { name: "both flags", time: true, money: true, totalSec: 10_800, money$: true },
  { name: "time only", time: true, money: false, totalSec: 10_800, money$: false },
  // Author-scoped, so every amount is the caller's own — nothing to withhold.
  { name: "money only", time: false, money: true, totalSec: 3_600, money$: true },
  { name: "neither", time: false, money: false, totalSec: 3_600, money$: true },
] as const;

describe("reports — money follows reportMoneyVisible, time follows the author scope", () => {
  for (const combo of COMBOS) {
    it(`summary (${combo.name})`, async () => {
      setFlags(ADMIN, combo.time, combo.money);
      const result = await reportsRouter
        .createCaller(contextFor(ADMIN))
        .summary({ ...RANGE, groupBy: "project" });

      assert.equal(result.totalSec, combo.totalSec);
      assert.equal(result.moneyVisible, combo.money$);
      if (combo.money$) {
        assert.equal(result.totalAmount, (combo.totalSec / 3600) * SECRET_RATE);
        for (const group of result.groups) assert.equal(typeof group.amount, "number");
      } else {
        // Null — not the caller's own 13,700 presented under a total that
        // covers everybody's hours, and not 0.
        assert.equal(result.totalAmount, null);
        assert.ok(result.groups.length > 0);
        for (const group of result.groups) assert.equal(group.amount, null);
      }
    });

    it(`detailed (${combo.name})`, async () => {
      setFlags(ADMIN, combo.time, combo.money);
      const result = await reportsRouter
        .createCaller(contextFor(ADMIN))
        .detailed(RANGE);

      assert.equal(result.totalSec, combo.totalSec);
      assert.equal(result.moneyVisible, combo.money$);
      assert.equal(
        result.totalAmount,
        combo.money$ ? (combo.totalSec / 3600) * SECRET_RATE : null,
      );
      assert.equal(result.entries.length, combo.totalSec / 3600);
      for (const entry of result.entries) {
        if (combo.money$) {
          assert.equal(entry.hourlyRate, SECRET_RATE);
          assert.equal(entry.amount, SECRET_RATE);
        } else {
          // Every row, the caller's own included: one report, one answer.
          assert.equal(entry.hourlyRate, null, `${entry.authorId}: rate leaked`);
          assert.equal(entry.amount, null, `${entry.authorId}: amount leaked`);
        }
      }
    });

    it(`weekly (${combo.name})`, async () => {
      setFlags(ADMIN, combo.time, combo.money);
      const result = await reportsRouter
        .createCaller(contextFor(ADMIN))
        .weekly({ ...RANGE, weekStart: "2026-09-07" });
      assert.equal(result.totalSec, combo.totalSec);
      assert.equal(result.moneyVisible, combo.money$);
    });

    it(`exportCsv column set (${combo.name})`, async () => {
      setFlags(ADMIN, combo.time, combo.money);
      const caller = reportsRouter.createCaller(contextFor(ADMIN));
      const summary = await caller.exportCsv({
        ...RANGE,
        report: "summary",
        groupBy: "project",
      });
      const detailed = await caller.exportCsv({ ...RANGE, report: "detailed" });

      const summaryHeader = csvHeader(summary.csv);
      const detailedHeader = csvHeader(detailed.csv);
      for (const header of ["Amount", "Currency"]) {
        assert.equal(summaryHeader.includes(header), combo.money$, `summary ${header}`);
      }
      for (const header of ["Rate", "Amount", "Currency"]) {
        assert.equal(detailedHeader.includes(header), combo.money$, `detailed ${header}`);
      }
      if (!combo.money$) {
        for (const csv of [summary.csv, detailed.csv]) {
          assert.ok(!csv.includes(String(SECRET_RATE)), "a money value survived");
        }
      }
    });

    it(`exportPdf money (${combo.name})`, async () => {
      setFlags(ADMIN, combo.time, combo.money);
      const caller = reportsRouter.createCaller(contextFor(ADMIN));
      for (const report of ["summary", "detailed"] as const) {
        const pdf = await caller.exportPdf({
          ...RANGE,
          report,
          ...(report === "summary" ? { groupBy: "project" as const } : {}),
        });
        const text = pdfText(pdf.base64);
        assert.ok(text.includes("Rebrand"), `${report}: the PDF text was not readable`);
        assert.equal(text.includes("Amount"), combo.money$, `${report}: Amount column`);
        if (!combo.money$) {
          assert.ok(!text.includes("13,700"), `${report}: an amount was drawn`);
          assert.ok(!text.includes("41,100"), `${report}: a total was drawn`);
        }
      }
    });
  }
});
