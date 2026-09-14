// A workspace in a REAL database for the invoice integration tests: an owner
// who may use invoices, an admin who may not see colleagues' money, one
// client with billing details, one project and billable time on two tasks.
// Synthetic data throughout.
import { Types } from "mongoose";
import {
  normalizeClientBilling,
  type BusinessProfileFields,
  type ClientBillingFields,
  type Locale,
} from "@starter/shared";
import { BusinessProfileModel, saveBusinessProfile } from "../../models/BusinessProfile.js";
import { Client } from "../../models/Client.js";
import { Invoice, type InvoiceDocLike } from "../../models/Invoice.js";
import { Project } from "../../models/Project.js";
import { UserPreferencesModel, WorkspaceSettingsModel } from "../../models/Settings.js";
import { Task } from "../../models/Task.js";
import { TimeEntry } from "../../models/TimeEntry.js";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";
import { WebhookSubscription } from "../../models/WebhookSubscription.js";
import type { Context } from "../../trpc/context.js";
import { CLIENT_BILLING_FIELDS, PROFILE_FIELDS } from "./einvoice-invoice.js";

export const WORKSPACE = "ws_einvoice_example";
export const OWNER = "64b7f9c2e13a4d5f6a7b9e01";
/** An admin who sees colleagues' time but not their money: the invoice gate refuses. */
export const ADMIN_NO_MONEY = "64b7f9c2e13a4d5f6a7b9e02";

export const INTEGRATION_MODELS = [
  BusinessProfileModel,
  Client,
  Invoice,
  Project,
  Task,
  TimeEntry,
  WorkspaceMember,
  WorkspaceSettingsModel,
  UserPreferencesModel,
  WebhookSubscription,
] as const;

export type Seeded = {
  clientId: string;
  projectId: string;
  /** Line keys of a task-grouped invoice over the seeded time. */
  taskKeys: { design: string; review: string };
};

const member = (userId: string, role: "owner" | "admin", money: boolean) => ({
  workspaceId: WORKSPACE,
  userId,
  role,
  name: role === "owner" ? "Erika Owner" : "Arno Admin",
  canViewOthersTime: true,
  canViewOthersMoney: money,
});

/**
 * Seed the workspace. 10 h "Design" and 2.5 h "Review" at 95 EUR, in
 * September 2026, all billable and un-invoiced.
 */
export async function seedWorkspace(
  options: {
    profile?: BusinessProfileFields | null;
    billing?: ClientBillingFields | null;
    invoiceLocale?: Locale | null;
  } = {},
): Promise<Seeded> {
  await WorkspaceMember.create([member(OWNER, "owner", true), member(ADMIN_NO_MONEY, "admin", false)]);
  await WorkspaceSettingsModel.create({ workspaceId: WORKSPACE, currency: "EUR", defaultHourlyRate: 95, weekStartsOn: 1 });
  if (options.profile !== null) {
    await saveBusinessProfile(WORKSPACE, options.profile ?? PROFILE_FIELDS);
  }
  const client = await Client.create({
    workspaceId: WORKSPACE,
    createdBy: OWNER,
    name: "Example Kunde",
    ...(options.billing === null
      ? {}
      : { billing: normalizeClientBilling(options.billing ?? CLIENT_BILLING_FIELDS) }),
    ...(options.invoiceLocale ? { invoiceLocale: options.invoiceLocale } : {}),
  });
  const project = await Project.create({
    workspaceId: WORKSPACE,
    createdBy: OWNER,
    name: "Relaunch",
    clientId: String(client._id),
    hourlyRate: 95,
  });
  const design = await Task.create({ workspaceId: WORKSPACE, createdBy: OWNER, name: "Design" });
  const review = await Task.create({ workspaceId: WORKSPACE, createdBy: OWNER, name: "Review" });
  const entry = (taskId: string, day: number, seconds: number) => {
    const start = new Date(Date.UTC(2026, 8, day, 9));
    return {
      workspaceId: WORKSPACE,
      authorId: OWNER,
      projectId: String(project._id),
      taskId,
      billable: true,
      start,
      end: new Date(start.getTime() + seconds * 1000),
      durationSec: seconds,
      hourlyRate: 95,
      currency: "EUR",
    };
  };
  await TimeEntry.create([
    entry(String(design._id), 2, 36_000),
    entry(String(review._id), 3, 9_000),
  ]);
  return {
    clientId: String(client._id),
    projectId: String(project._id),
    taskKeys: { design: String(design._id), review: String(review._id) },
  };
}

/** A signed-in person whose active workspace is the seeded one. */
export const contextFor = (userId: string): Context =>
  ({
    req: undefined,
    res: undefined,
    session: { session: { activeOrganizationId: WORKSPACE }, user: { id: userId } },
    user: { id: userId, name: userId, email: `${userId}@example.test` },
    authMethod: "cookie",
    activeWorkspaceId: WORKSPACE,
  }) as unknown as Context;

/**
 * An invoice exactly as main stored it before e-invoicing: no parties, no
 * categories, no breakdown, no payment terms, no locale. 10 h at 95 plus
 * 2.5 h at 95; tax as float-rounded by main.
 */
export async function insertLegacyInvoice(
  seeded: Seeded,
  overrides: Partial<Omit<InvoiceDocLike, "_id">> = {},
): Promise<string> {
  const subtotal = 1187.5;
  const taxRate = overrides.taxRate === undefined ? 19 : overrides.taxRate;
  const taxAmount = taxRate === null ? 0 : Math.round(subtotal * taxRate) / 100;
  const doc = await Invoice.create({
    workspaceId: WORKSPACE,
    createdBy: OWNER,
    number: "2025-0007",
    clientId: seeded.clientId,
    clientName: "Example Kunde",
    status: "sent",
    issueDate: new Date("2025-11-03T00:00:00.000Z"),
    dueDate: new Date("2025-11-17T00:00:00.000Z"),
    from: new Date("2025-10-01T00:00:00.000Z"),
    to: new Date("2025-11-01T00:00:00.000Z"),
    groupBy: "task",
    lineItems: [
      { key: "t-design", label: "Relaunch — Design", projectId: seeded.projectId, taskId: null, seconds: 36_000, hours: 10, hourlyRate: 95, currency: "EUR", amount: 950 },
      { key: "t-review", label: "Relaunch — Review", projectId: seeded.projectId, taskId: null, seconds: 9_000, hours: 2.5, hourlyRate: 95, currency: "EUR", amount: 237.5 },
    ],
    subtotal,
    taxRate,
    taxAmount,
    total: Math.round((subtotal + taxAmount) * 100) / 100,
    currency: "EUR",
    entryIds: [],
    notes: null,
    ...overrides,
  });
  return String(doc._id);
}

/** A stable id no document has. */
export const MISSING_ID = String(new Types.ObjectId("64b7f9c2e13a4d5f6a7b9fff"));
