// One shared workspace, three people, and every collection the visibility
// tests read — held in memory.
//
// The cast is the acceptance fixture of the teams work: an OWNER who may see
// everything, an ADMIN who may see colleagues' time but not their money, and a
// MEMBER who may see neither. Each of them has tracked billable time, so every
// "must not see" assertion has a real colleague's row to not see, and every
// "may see" assertion has one to find.
//
// The workspace id deliberately differs from every user id: a resolver that
// scopes by the caller's id instead of the workspace (a bug this codebase has
// had) must fail here rather than pass by coincidence.
import mongoose, { Types } from "mongoose";
import type { WorkspaceRole } from "@starter/shared/types";
import { Client } from "../../models/Client.js";
import { Favorite } from "../../models/Favorite.js";
import { Invoice } from "../../models/Invoice.js";
import { Project } from "../../models/Project.js";
import { WorkspaceSettingsModel } from "../../models/Settings.js";
import { Tag } from "../../models/Tag.js";
import { Task } from "../../models/Task.js";
import { TimeEntry } from "../../models/TimeEntry.js";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";
import type { Context } from "../../trpc/context.js";
import {
  memoryCollection,
  stubModel,
  type MemoryCollection,
  type Row,
} from "./in-memory-models.js";

// No database in the unit suite: a query nobody stubbed fails at once.
mongoose.set("bufferCommands", false);

export const WORKSPACE = "ws_shared_acme";

// Hex ObjectId strings, the shape better-auth's user ids take in this app —
// the member grouping resolves live names through them.
export const OWNER = "64b7f9c2e13a4d5f6a7b8e01";
export const ADMIN = "64b7f9c2e13a4d5f6a7b8e02";
export const MEMBER = "64b7f9c2e13a4d5f6a7b8e03";

export type Person = typeof OWNER | typeof ADMIN | typeof MEMBER;

const membership = (
  userId: string,
  name: string,
  role: WorkspaceRole,
  canViewOthersTime: boolean,
  canViewOthersMoney: boolean,
): Row => ({
  _id: new Types.ObjectId(),
  workspaceId: WORKSPACE,
  userId,
  name,
  role,
  hourlyRate: null,
  canViewOthersTime,
  canViewOthersMoney,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

export const PROJECT_ID = new Types.ObjectId("64b7f9c2e13a4d5f6a7b8c01");
export const CLIENT_ID = new Types.ObjectId("64b7f9c2e13a4d5f6a7b8c02");

/** The hourly rate every fixture entry carries — the number that must not leak. */
export const SECRET_RATE = 13_700;

/** An entry id per author, stable so tests can address colleagues' rows. */
export const ENTRY_ID: Record<Person, Types.ObjectId> = {
  [OWNER]: new Types.ObjectId("64b7f9c2e13a4d5f6a7b8d01"),
  [ADMIN]: new Types.ObjectId("64b7f9c2e13a4d5f6a7b8d02"),
  [MEMBER]: new Types.ObjectId("64b7f9c2e13a4d5f6a7b8d03"),
};

const HOUR_OF: Record<Person, number> = { [OWNER]: 9, [ADMIN]: 11, [MEMBER]: 14 };

const entryRow = (authorId: Person): Row => {
  const start = new Date(`2026-09-07T${String(HOUR_OF[authorId]).padStart(2, "0")}:00:00.000Z`);
  const end = new Date(start.getTime() + 3_600_000);
  return {
    _id: ENTRY_ID[authorId],
    workspaceId: WORKSPACE,
    authorId,
    description: `Work by ${authorId}`,
    projectId: String(PROJECT_ID),
    taskId: null,
    tagIds: [],
    billable: true,
    start,
    end,
    durationSec: 3600,
    hourlyRate: SECRET_RATE,
    currency: "EUR",
    source: "web",
    timeZone: "UTC",
    runaway: null,
    invoiceId: null,
    importId: null,
    createdAt: start,
    updatedAt: end,
    // What the aggregation's lookups would have joined on.
    project: {
      _id: PROJECT_ID,
      workspaceId: WORKSPACE,
      name: "Rebrand",
      color: "#336699",
      clientId: String(CLIENT_ID),
    },
    client: { _id: CLIENT_ID, workspaceId: WORKSPACE, name: "Acme GmbH" },
    task: null,
  };
};

export type Store = {
  members: MemoryCollection;
  entries: MemoryCollection;
  projects: MemoryCollection;
  clients: MemoryCollection;
  tasks: MemoryCollection;
  tags: MemoryCollection;
  favorites: MemoryCollection;
  invoices: MemoryCollection;
  settings: MemoryCollection;
};

/** A fresh copy of the whole workspace. */
export const freshStore = (): Store => ({
  members: memoryCollection([
    membership(OWNER, "Olga Owner", "owner", true, true),
    membership(ADMIN, "Arno Admin", "admin", true, false),
    membership(MEMBER, "Mia Member", "member", false, false),
  ]),
  entries: memoryCollection([entryRow(OWNER), entryRow(ADMIN), entryRow(MEMBER)]),
  projects: memoryCollection([
    {
      _id: PROJECT_ID,
      workspaceId: WORKSPACE,
      name: "Rebrand",
      color: "#336699",
      clientId: String(CLIENT_ID),
      hourlyRate: SECRET_RATE,
      billableDefault: true,
      archived: false,
      estimatedHours: 100,
      budgetAmount: 1_000_000,
      budgetCurrency: "EUR",
      createdBy: OWNER,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      // Joined by the aggregation's lookups.
      clientDoc: [{ name: "Acme GmbH", color: null }],
      stats: [{ entryCount: 3, totalSec: 10_800 }],
    },
  ]),
  clients: memoryCollection([
    {
      _id: CLIENT_ID,
      workspaceId: WORKSPACE,
      name: "Acme GmbH",
      color: null,
      archived: false,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  ]),
  tasks: memoryCollection(),
  tags: memoryCollection(),
  favorites: memoryCollection(),
  invoices: memoryCollection(),
  settings: memoryCollection([
    {
      workspaceId: WORKSPACE,
      defaultHourlyRate: 9_900,
      currency: "EUR",
      weekStartsOn: 1,
    },
  ]),
});

/**
 * Point every model at `store`. The store object stays the same for the life
 * of a test file; `reset` swaps its rows so each test starts from the fixture.
 */
export const installStore = (store: Store): (() => void) => {
  const restores = [
    stubModel(WorkspaceMember, store.members),
    stubModel(TimeEntry, store.entries),
    stubModel(Project, store.projects),
    stubModel(Client, store.clients),
    stubModel(Task, store.tasks),
    stubModel(Tag, store.tags),
    stubModel(Favorite, store.favorites),
    stubModel(Invoice, store.invoices),
    stubModel(WorkspaceSettingsModel, store.settings),
  ];
  return () => {
    for (const restore of restores) restore();
  };
};

/** Copy a fresh fixture into an installed store, in place. */
export const resetStore = (store: Store): void => {
  const fresh = freshStore();
  for (const key of Object.keys(store) as (keyof Store)[]) {
    store[key].rows.splice(0, store[key].rows.length, ...fresh[key].rows);
    store[key].queries.length = 0;
  }
};

/**
 * A signed-in person whose active workspace is the shared one. `req`/`res`
 * are express handles none of the procedures under test read.
 */
export const contextFor = (userId: string): Context =>
  ({
    req: undefined,
    res: undefined,
    session: {
      session: { activeOrganizationId: WORKSPACE },
      user: { id: userId },
    },
    user: { id: userId, name: userId, email: `${userId}@example.test` },
    authMethod: "cookie",
    activeWorkspaceId: WORKSPACE,
  }) as unknown as Context;
