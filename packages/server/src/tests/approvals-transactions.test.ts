import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, type TestContext } from "node:test";
import mongoose from "mongoose";
import { TRPCError } from "@trpc/server";
import { approvalWeekBounds } from "@starter/shared";
import { TimesheetApproval, TimesheetPolicy, WorkspaceWriteFence } from "../models/TimesheetApproval.js";
import { TimeEntry } from "../models/TimeEntry.js";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { WorkspaceSettingsModel, UserPreferencesModel } from "../models/Settings.js";
import { Project } from "../models/Project.js";
import { Client } from "../models/Client.js";
import { Task } from "../models/Task.js";
import { Tag } from "../models/Tag.js";
import { Favorite } from "../models/Favorite.js";
import { Invoice } from "../models/Invoice.js";
import { ImportBatch } from "../models/ImportBatch.js";
import { BusinessProfileModel } from "../models/BusinessProfile.js";
import { actOnTimesheet, approvalEntries, configureApprovals, invoiceApprovalEligibility, ownApprovalWeek, reviewQueue, submitTimesheet, type ApprovalActor } from "../services/approvals/service.js";
import { fenceWorkspace, supportsBusinessTransactions, withBusinessTransaction, deferAfterCommit } from "../services/business-transaction.js";
import { bulkEditEntries, executeBulkEdit, mongoBulkEntryStore } from "../services/entries/bulk.js";
import { createEntry, updateEntry } from "../services/entries/crud.js";
import { continueEntryDetailed, personReach, startTimerDetailed, stopTimer } from "../services/entries/timer.js";
import { finalizeStop } from "../services/entry-stop.js";
import { updateProjectWithEntries } from "../services/catalog/projects.js";
import { cascadeDeleteClient, cascadeDeleteProject, cascadeDeleteTask } from "../trpc/routers/catalog-cascade.js";
import { invoicesRouter } from "../trpc/routers/invoices.js";
import { dataRouter } from "../trpc/routers/data.js";
import type { Context } from "../trpc/context.js";
import { clearTestDatabase, connectTestDatabase, dropTestDatabase, skipWithoutDatabase } from "./support/test-database.js";

const WS = "approval-workspace";
const AUTHOR = "approval-author";
const REVIEWER = "approval-reviewer";
const WEEK = "2026-09-14";
const visibility = (userId: string, money = true) => ({ userId, canViewOthersTime: true, canViewOthersMoney: money });
const author: ApprovalActor = { workspaceId: WS, userId: AUTHOR, role: "member", visibility: visibility(AUTHOR) };
const reviewer: ApprovalActor = { workspaceId: WS, userId: REVIEWER, role: "admin", visibility: visibility(REVIEWER, false) };
const owner: ApprovalActor = { ...reviewer, role: "owner", visibility: visibility(REVIEWER) };
const submit = () => submitTimesheet(author, { weekStart: WEEK, confirmedOnline: true, pendingLocalEdits: false });
const span = { start: new Date("2026-09-15T09:00:00Z"), end: new Date("2026-09-15T10:00:00Z") };
const row = (extra: Record<string, unknown> = {}) => ({ workspaceId: WS, authorId: AUTHOR, description: "Work", billable: true, hourlyRate: 90, currency: "EUR", durationSec: 3600, ...span, ...extra });
const contextFor = (userId = AUTHOR): Context => ({ user: { id: userId, name: "Author", email: "author@example.test" }, session: { user: { id: userId } }, activeWorkspaceId: WS, req: undefined, res: undefined, authMethod: "cookie" }) as unknown as Context;
const inputFile = (start = span.start.toISOString()) => ({ workspaceId: WS, text: `Description,Start,End,Billable,Hourly Rate\nImported,${start},2026-09-15T10:00:00Z,true,0`, timeZone: "UTC", dateOrder: "dmy" as const });
function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
let transactions = false;
function requireTransactions(t: TestContext): boolean {
  if (transactions) return true;
  t.skip("This case requires a replica-set TEST_MONGODB_URI"); return false;
}
async function enabled(): Promise<void> {
  await configureApprovals(owner, { enabled: true, requireApprovedForInvoices: false, timeZone: "UTC" });
}

describe("timesheet transaction safety", { skip: skipWithoutDatabase }, () => {
  before(async () => {
    await connectTestDatabase("approvals", [TimeEntry, TimesheetApproval, TimesheetPolicy, WorkspaceWriteFence, WorkspaceMember, WorkspaceSettingsModel, UserPreferencesModel, Project, Client, Task, Tag, Favorite, Invoice, ImportBatch, BusinessProfileModel] as never);
    transactions = await supportsBusinessTransactions();
  });
  beforeEach(async () => {
    await clearTestDatabase();
    await WorkspaceSettingsModel.create({ workspaceId: WS, defaultHourlyRate: 60, currency: "EUR", weekStartsOn: 1 });
    await WorkspaceMember.create([
      { workspaceId: WS, userId: AUTHOR, name: "Author", role: "member", hourlyRate: 90, canViewOthersTime: true, canViewOthersMoney: true },
      { workspaceId: WS, userId: REVIEWER, name: "Reviewer", role: "owner", hourlyRate: 999, canViewOthersTime: true, canViewOthersMoney: true },
    ]);
  });
  after(dropTestDatabase);

  it("ordinary tracking works on standalone; activation is explicitly gated", async () => {
    const entry = await createEntry(author, { description: "Ordinary", billable: true, start: span.start.toISOString(), end: span.end.toISOString() });
    assert.equal(entry.hourlyRate, 90);
    if (!transactions) await assert.rejects(enabled(), { message: "TIMESHEET_TRANSACTIONS_UNAVAILABLE" });
  });

  it("closing a removed member's timer preserves their own rate snapshot", async () => {
    const running = await TimeEntry.create(row({ end: null }));
    await WorkspaceMember.deleteOne({ workspaceId: WS, userId: AUTHOR });
    const stopped = await finalizeStop(running, span.end);
    assert.equal(stopped?.hourlyRate, 90);
    assert.equal(stopped?.currency, "EUR");
  });

  it("new snapshots follow the author and historical snapshots stay fixed", async () => {
    const project = await Project.create({ workspaceId: WS, name: "Rate project", billableDefault: true, hourlyRate: null });
    const entry = await createEntry(author, { description: "Author time", projectId: String(project._id), start: span.start.toISOString(), end: span.end.toISOString() });
    assert.equal(entry.hourlyRate, 90); assert.equal(entry.billable, true);
    await WorkspaceMember.updateOne({ workspaceId: WS, userId: AUTHOR }, { $set: { hourlyRate: 120 } });
    const edited = await updateEntry(author, { id: entry.id, description: "Same history" });
    assert.equal(edited.hourlyRate, 90);
    const running = await TimeEntry.create(row({ start: new Date("2026-09-16T09:00:00Z"), end: null, projectId: String(project._id) }));
    const stopped = await finalizeStop(running, new Date("2026-09-16T10:00:00Z"));
    assert.equal(stopped?.hourlyRate, 120);
    const continued = await continueEntryDetailed(owner, { id: entry.id });
    assert.equal(continued.entry.authorId, REVIEWER); assert.equal(continued.entry.hourlyRate, 999);
    assert.equal((await TimeEntry.findById(entry.id).lean())?.hourlyRate, 90);
    await stopTimer(owner, { id: continued.entry.id, end: new Date(Date.parse(continued.entry.start) + 1000).toISOString() }, personReach);
    await updateProjectWithEntries(author, { id: String(project._id), hourlyRate: null, applyToEntries: true });
    assert.equal((await TimeEntry.findById(entry.id).lean())?.hourlyRate, 120);
    assert.equal((await TimeEntry.findById(continued.entry.id).lean())?.hourlyRate, 999);
  });

  it("locks empty cells, existing entries and proposed moved intervals", async (t) => {
    if (!requireTransactions(t)) return;
    await enabled();
    const entry = await TimeEntry.create(row());
    const outside = await TimeEntry.create(row({ start: new Date("2026-09-22T09:00:00Z"), end: new Date("2026-09-22T10:00:00Z") }));
    await submit();
    const operations = [
      () => TimeEntry.create(row({ start: new Date("2026-09-18T09:00:00Z"), end: new Date("2026-09-18T10:00:00Z") })),
      () => TimeEntry.updateOne({ _id: entry._id }, { $set: { description: "Changed" } }),
      () => TimeEntry.updateMany({ workspaceId: WS }, { $pull: { tagIds: "tag" } }),
      () => TimeEntry.deleteOne({ _id: entry._id }),
      () => TimeEntry.deleteMany({ workspaceId: WS }),
      () => TimeEntry.updateOne({ _id: outside._id }, { $set: span }),
      () => TimeEntry.updateOne({ _id: entry._id }, { $set: { start: outside.start, end: outside.end } }),
      () => TimeEntry.insertMany([row({ description: "Import" })]),
      () => startTimerDetailed(author, { start: "2026-09-17T12:00:00Z" }, personReach),
    ];
    for (const operation of operations) await assert.rejects(async () => { await operation(); }, { message: "TIMESHEET_LOCKED" });
    await TimeEntry.create(row({ authorId: REVIEWER }));
    await TimeEntry.create(row({ workspaceId: "other-workspace" }));
    assert.equal((await TimeEntry.findById(entry._id).lean())?.description, "Work");
  });

  it("refuses future empty submissions without blocking today's timer", async (t) => {
    if (!requireTransactions(t)) return;
    await enabled();
    await assert.rejects(submitTimesheet(author, { weekStart: "2099-01-05", confirmedOnline: true, pendingLocalEdits: false }), { message: "TIMESHEET_FUTURE_WEEK" });
    const started = await startTimerDetailed(author, {}, personReach);
    assert.equal(started.entry.end, null);
    assert.equal(await TimesheetApproval.countDocuments({}), 0);
  });

  it("preserves milliseconds at both sides of a locked boundary", async (t) => {
    if (!requireTransactions(t)) return;
    await enabled(); await submit();
    const boundary = new Date("2026-09-14T00:00:00.000Z");
    const outside = await TimeEntry.create(row({ start: new Date(boundary.getTime() - 1000), end: boundary }));
    await assert.rejects(TimeEntry.updateOne({ _id: outside._id }, { $set: { end: new Date(boundary.getTime() + 1) } }), { message: "TIMESHEET_LOCKED" });
    await assert.rejects(TimeEntry.create(row({ start: new Date(boundary.getTime() - 1), end: new Date(boundary.getTime() + 1) })), { message: "TIMESHEET_LOCKED" });
    await assert.rejects(TimeEntry.insertMany([row({ start: new Date(boundary.getTime() - 1), end: new Date(boundary.getTime() + 1) })]), { message: "TIMESHEET_LOCKED" });
    await assert.rejects(TimeEntry.updateOne({ _id: outside._id }, { $set: { start: 1, end: 2 } }), { message: "TIMESHEET_INVALID_INTERVAL" });
    await assert.rejects(TimeEntry.insertMany([row({ start: 1, end: 2 })]), { message: "TIMESHEET_INVALID_INTERVAL" });
    const ending = new Date("2026-09-21T00:00:00.000Z");
    const after = await TimeEntry.create(row({ start: ending, end: new Date(ending.getTime() + 1000) }));
    await assert.rejects(TimeEntry.updateOne({ _id: after._id }, { $set: { start: new Date(ending.getTime() - 1) } }), { message: "TIMESHEET_LOCKED" });
  });

  it("requires stop/split before submission and snapshots DST bounds", async (t) => {
    if (!requireTransactions(t)) return;
    await enabled();
    const running = await TimeEntry.create(row({ start: new Date("2026-09-13T23:00:00Z"), end: null }));
    await assert.rejects(submit(), { message: "TIMESHEET_RUNNING_ENTRY" });
    await finalizeStop(running, new Date("2026-09-14T01:00:00Z"));
    await assert.rejects(submit(), { message: "TIMESHEET_CROSS_WEEK_ENTRY" });
    await TimeEntry.deleteMany({ workspaceId: WS });
    const approved = await submit();
    await configureApprovals(owner, { enabled: true, requireApprovedForInvoices: false, timeZone: "Pacific/Auckland" });
    await WorkspaceSettingsModel.updateOne({ workspaceId: WS }, { $set: { weekStartsOn: 0 } });
    const movedView = await ownApprovalWeek(author, "2026-09-13");
    assert.ok(movedView.records.some((record) => record.id === approved.id));
    await assert.rejects(TimeEntry.create(row()), { message: "TIMESHEET_LOCKED" });
    const bounds = approvalWeekBounds("2026-03-23", "Europe/Berlin");
    assert.equal((bounds.end.getTime() - bounds.start.getTime()) / 3600000, 167);
  });

  it("withdraw, reject with reason, resubmit, approve and reopen enforce role and revision", async (t) => {
    if (!requireTransactions(t)) return;
    await enabled(); await TimeEntry.create(row());
    let record = await submit();
    await assert.rejects(actOnTimesheet(author, { id: record.id, revision: record.revision, action: "approve" }), { message: "TIMESHEET_REVIEW_PERMISSION" });
    await assert.rejects(actOnTimesheet({ ...owner, workspaceId: "foreign" }, { id: record.id, revision: record.revision, action: "approve" }), { code: "NOT_FOUND" });
    await assert.rejects(actOnTimesheet(reviewer, { id: record.id, revision: record.revision, action: "reject" }), { message: "TIMESHEET_REASON_REQUIRED" });
    record = await actOnTimesheet(author, { id: record.id, revision: record.revision, action: "withdraw" });
    assert.equal(record.status, "draft");
    record = await submit();
    record = await actOnTimesheet(reviewer, { id: record.id, revision: record.revision, action: "reject", reason: "Correct the description" });
    await TimeEntry.updateMany({ workspaceId: WS, authorId: AUTHOR }, { $set: { description: "Corrected" } });
    record = await submit();
    const revision = record.revision;
    record = await actOnTimesheet(reviewer, { id: record.id, revision, action: "approve" });
    await assert.rejects(actOnTimesheet(reviewer, { id: record.id, revision, action: "approve" }), { message: "TIMESHEET_STALE" });
    const detail = await approvalEntries(reviewer, record.id);
    assert.equal(detail.entries.length, 1);
    for (const field of ["hourlyRate", "amount", "invoiceId", "currency"]) assert.equal(field in detail.entries[0]!, false);
    const reopened = await actOnTimesheet(reviewer, { id: record.id, revision: record.revision, action: "reopen", reason: "Correction requested" });
    assert.equal(reopened.status, "draft"); assert.equal(reopened.history.at(-1)?.reason, "Correction requested");
  });

  it("catalog cascades roll back as a whole when locked time would change", async (t) => {
    if (!requireTransactions(t)) return;
    await enabled();
    const client = await Client.create({ workspaceId: WS, name: "Client" });
    const project = await Project.create({ workspaceId: WS, name: "Project", clientId: String(client._id) });
    const task = await Task.create({ workspaceId: WS, name: "Task" });
    await TimeEntry.create(row({ clientId: String(client._id), projectId: String(project._id), taskId: String(task._id) }));
    await submit();
    await assert.rejects(cascadeDeleteClient(WS, String(client._id)), { message: "TIMESHEET_LOCKED" });
    assert.equal((await Project.findById(project._id).lean())?.clientId, String(client._id));
    await assert.rejects(cascadeDeleteProject(WS, String(project._id)), { message: "TIMESHEET_LOCKED" });
    await assert.rejects(cascadeDeleteTask(WS, String(task._id)), { message: "TIMESHEET_LOCKED" });
    assert.ok(await Client.exists({ _id: client._id })); assert.ok(await Project.exists({ _id: project._id })); assert.ok(await Task.exists({ _id: task._id }));
  });

  it("a writer paused before acquiring the fence cannot commit across submission", async (t) => {
    if (!requireTransactions(t)) return;
    await enabled(); const entry = await TimeEntry.create(row());
    const read = gate(); const resume = gate(); let attempts = 0;
    const writer = withBusinessTransaction(async () => {
      const old = await TimeEntry.findById(entry._id).lean(); assert.ok(old);
      if (++attempts === 1) { read.resolve(); await resume.promise; }
      await TimeEntry.updateOne({ _id: entry._id }, { $set: { description: "Stale writer" } });
    });
    const refused = assert.rejects(writer, { message: "TIMESHEET_LOCKED" });
    await read.promise;
    try { await submit(); } finally { resume.resolve(); }
    await refused;
    assert.ok(attempts >= 2); assert.equal((await TimeEntry.findById(entry._id).lean())?.description, "Work");
  });

  it("concurrent submissions produce one durable period", async (t) => {
    if (!requireTransactions(t)) return;
    await enabled();
    const outcomes = await Promise.allSettled([submit(), submit()]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(await TimesheetApproval.countDocuments({ workspaceId: WS, status: "submitted" }), 1);
  });

  it("invoice claiming and reopening cannot both win", async (t) => {
    if (!requireTransactions(t)) return;
    await enabled(); await configureApprovals(owner, { enabled: true, requireApprovedForInvoices: true, timeZone: "UTC" });
    const entry = await TimeEntry.create(row());
    assert.equal((await invoiceApprovalEligibility(WS, [entry])).size, 0);
    let record = await submit();
    record = await actOnTimesheet(reviewer, { id: record.id, revision: record.revision, action: "approve" });
    assert.equal((await invoiceApprovalEligibility(WS, [entry])).size, 1);
    const outcomes = await Promise.allSettled([
      withBusinessTransaction(() => TimeEntry.updateOne({ _id: entry._id }, { $set: { invoiceId: "invoice" } }).exec()),
      actOnTimesheet(reviewer, { id: record.id, revision: record.revision, action: "reopen", reason: "Correct time" }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    const stored = await TimeEntry.findById(entry._id).lean();
    const period = await TimesheetApproval.findById(record.id).lean();
    assert.ok(stored?.invoiceId ? period?.status === "approved" : period?.status === "draft");
  });

  it("retries document creates without duplicate records or pre-commit effects", async (t) => {
    if (!requireTransactions(t)) return;
    await enabled(); let attempts = 0; const published: number[] = [];
    const document = new TimeEntry(row());
    await withBusinessTransaction(async () => {
      await fenceWorkspace(WS); const attempt = ++attempts;
      await document.save();
      deferAfterCommit(() => { published.push(attempt); });
      if (attempt === 1) {
        const conflict = new mongoose.mongo.MongoServerError({ message: "test transaction retry", code: 112 });
        conflict.addErrorLabel("TransientTransactionError"); throw conflict;
      }
    });
    assert.equal(await TimeEntry.countDocuments({ workspaceId: WS }), 1);
    assert.deepEqual(published, [2]);
  });

  it("bulk edits resolve author rates and report a raced approval as locked", async (t) => {
    if (!requireTransactions(t)) return;
    await enabled();
    const entry = await TimeEntry.create(row({ billable: false, hourlyRate: null }));
    const input = { workspaceId: WS, entries: [{ id: String(entry._id), expectedUpdatedAt: entry.updatedAt.toISOString() }], operation: { kind: "update" as const, billable: true } };
    assert.equal((await bulkEditEntries(author, input)).results[0]?.success, true);
    const priced = await TimeEntry.findById(entry._id).lean(); assert.ok(priced);
    assert.equal(priced.hourlyRate, 90);
    const next = { ...input, entries: [{ id: String(entry._id), expectedUpdatedAt: priced.updatedAt.toISOString() }], operation: { kind: "update" as const, billable: false } };
    const raced = await executeBulkEdit(author, next, {
      ...mongoBulkEntryStore,
      write: async (...args) => { await submit(); return mongoBulkEntryStore.write(...args); },
    });
    assert.deepEqual(raced.results, [{ id: String(entry._id), success: false, reason: "locked" }]);
    assert.equal((await TimeEntry.findById(entry._id).lean())?.billable, true);
    const blocked = await bulkEditEntries(author, next);
    assert.equal(blocked.phase, "validation");
    const refusal = blocked.results[0]; assert.ok(refusal && !refusal.success);
    assert.equal(refusal.reason, "locked");
  });

  it("retries tRPC-wrapped transient transaction errors", async (t) => {
    if (!requireTransactions(t)) return;
    let attempts = 0;
    await withBusinessTransaction(async () => {
      attempts++;
      if (attempts === 1) {
        const cause = new mongoose.mongo.MongoServerError({ message: "Synthetic conflict", code: 112 });
        cause.addErrorLabel("TransientTransactionError");
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", cause });
      }
      await TimeEntry.create(row());
    });
    assert.equal(attempts, 2); assert.equal(await TimeEntry.countDocuments({ workspaceId: WS }), 1);
  });

  it("invoice routes honor approval eligibility and keep issued claims immutable", async (t) => {
    if (!requireTransactions(t)) return;
    await configureApprovals(owner, { enabled: true, requireApprovedForInvoices: true, timeZone: "UTC" });
    const client = await Client.create({ workspaceId: WS, name: "Synthetic client", color: "#112233" });
    const entry = await TimeEntry.create(row({ clientId: String(client._id) }));
    const caller = invoicesRouter.createCaller(contextFor(REVIEWER));
    const input = { workspaceId: WS, clientId: String(client._id), from: WEEK, to: "2026-09-20", timezone: "UTC", issueDate: "2026-09-21", dueDate: "2026-09-28" };
    assert.equal((await caller.preview(input)).skippedApproval, 1);
    const submitted = await submit();
    assert.equal((await caller.preview(input)).skippedApproval, 1);
    let approved = await actOnTimesheet(reviewer, { id: submitted.id, revision: submitted.revision, action: "approve" });
    assert.deepEqual((await caller.preview(input)).entryIds, [String(entry._id)]);
    const draft = await caller.create(input);
    await assert.rejects(actOnTimesheet(reviewer, { id: approved.id, revision: approved.revision, action: "reopen", reason: "Correct time" }), { message: "TIMESHEET_INVOICED" });
    await caller.remove({ id: draft.id });
    await actOnTimesheet(reviewer, { id: approved.id, revision: approved.revision, action: "reopen", reason: "Correct time" });
    const resubmitted = await submit();
    approved = await actOnTimesheet(reviewer, { id: resubmitted.id, revision: resubmitted.revision, action: "approve" });
    const issued = await caller.create(input);
    await caller.updateStatus({ id: issued.id, status: "sent" });
    await assert.rejects(caller.remove({ id: issued.id }));
    await assert.rejects(caller.updateStatus({ id: issued.id, status: "draft" }));
    await assert.rejects(actOnTimesheet(reviewer, { id: approved.id, revision: approved.revision, action: "reopen", reason: "Correct time" }), { message: "TIMESHEET_INVOICED" });
    assert.equal((await TimeEntry.findById(entry._id).lean())?.invoiceId, issued.id);
  });

  it("ordinary imports preserve explicit zero", async () => {
    const caller = dataRouter.createCaller(contextFor());
    const imported = await caller.commit(inputFile());
    assert.ok(imported);
    const entry = await TimeEntry.findOne({ workspaceId: WS }).lean();
    assert.equal(entry?.hourlyRate, 0);
    assert.equal(await TimesheetApproval.countDocuments({}), 0);
  });

  it("JSON imports cannot restore approval authority or override member rates", async () => {
    const caller = dataRouter.createCaller(contextFor());
    const document = {
      version: 2, exportedAt: new Date().toISOString(), workspaceId: WS, currency: "EUR",
      clients: [], projects: [], tasks: [], tags: [],
      entries: [{ description: "Forged authority", clientName: null, projectName: null, taskName: null,
        tagNames: [], billable: true, start: span.start.toISOString(), end: span.end.toISOString(),
        durationSec: 3600, hourlyRate: 0, currency: "EUR", timeZone: "UTC" }],
      approvals: [{ workspaceId: WS, authorId: AUTHOR, status: "approved", ...span,
        weekStart: WEEK, weekStartsOn: 1, timeZone: "UTC", revision: 99, history: [] }],
      approvalPolicy: { enabled: true, requireApprovedForInvoices: true, timeZone: "UTC" },
      memberRates: [{ userId: AUTHOR, hourlyRate: 999 }],
    };
    await caller.commit({ ...inputFile(), text: JSON.stringify(document) });
    assert.equal((await TimeEntry.findOne({ workspaceId: WS }).lean())?.hourlyRate, 0);
    assert.equal(await TimesheetApproval.countDocuments({}), 0);
    assert.equal(await TimesheetPolicy.countDocuments({}), 0);
    assert.equal((await WorkspaceMember.findOne({ workspaceId: WS, userId: AUTHOR }).lean())?.hourlyRate, 90);
  });

  it("import and undo refuse locked periods without leaving partial catalog/batches", async (t) => {
    if (!requireTransactions(t)) return;
    await enabled(); const caller = dataRouter.createCaller(contextFor());
    const imported = await caller.commit(inputFile());
    const batch = await ImportBatch.findOne({ workspaceId: WS }).lean(); assert.ok(batch); assert.ok(imported);
    await submit();
    await assert.rejects(caller.undo({ batchId: String(batch._id) }), { message: "TIMESHEET_LOCKED" });
    assert.equal(await TimeEntry.countDocuments({ workspaceId: WS }), 1);
    await assert.rejects(caller.commit({ ...inputFile(), skipDuplicates: false }), { message: "TIMESHEET_LOCKED" });
    assert.equal(await ImportBatch.countDocuments({ workspaceId: WS }), 1);
  });

  it("review queue pages pending submissions before approved history", async (t) => {
    if (!requireTransactions(t)) return;
    await enabled();
    for (let i = 0; i < 26; i++) await TimesheetApproval.create({ workspaceId: WS, authorId: `history-${i}`, weekStart: WEEK, weekStartsOn: 1, timeZone: "UTC", ...approvalWeekBounds(WEEK, "UTC"), status: "approved", revision: 1, history: [] });
    const pending = await submit();
    const page = await reviewQueue(reviewer);
    assert.equal(page.records[0]?.id, pending.id); assert.equal(page.records.length, 25); assert.equal(page.hasMore, true);
    assert.equal((await reviewQueue(reviewer, 1)).records.length, 2);
  });
});
