// The route table. One array, and BOTH the Express wiring and the OpenAPI
// document are built from it.
//
// That is the whole point of the file: a route cannot exist undocumented,
// because `index.ts` mounts nothing that is not listed here, and it cannot be
// documented but unimplemented, because mounting throws when a listed route
// has no handler. The alternative — a hand-written spec beside hand-written
// wiring — drifts within one release and nobody notices until an integration
// is built against a route that never existed.
//
// Request schemas are the SAME objects the tRPC procedures validate with, imported
// from `@starter/shared`. Response schemas are declared here and pinned to the
// shared TYPES via `z.ZodType<T>`, so dropping a field from a wire type stops
// the build instead of quietly shrinking the documented response.
import { z } from "zod";
import {
  apiTokenScopeSchema,
  clientListSchema,
  createClientSchema,
  createEntrySchema,
  createProjectSchema,
  createTagSchema,
  createTaskSchema,
  detailedReportSchema,
  entryListSchema,
  entrySourceSchema,
  idleBehaviorSchema,
  projectListSchema,
  startTimerSchema,
  stopTimerSchema,
  summaryReportSchema,
  tagListSchema,
  taskListSchema,
  updateClientSchema,
  updateEntrySchema,
  updateProjectSchema,
  updateTagSchema,
  updateTaskSchema,
  weeklyReportSchema,
  type ApiTokenScope,
  type BudgetProgress,
  type CatalogRemoveResult,
  type Client,
  type DetailedEntry,
  type Project,
  type SummaryReportResult,
  type Tag,
  type TagRemoveResult,
  type Task,
  type TimeEntry,
  type WeeklyReportResult,
} from "@starter/shared";
import type { ProjectWithStats } from "../../services/catalog/projects.js";
import type { TaskWithStats } from "../../services/catalog/tasks.js";
import type { TagWithStats } from "../../services/catalog/tags.js";

/**
 * ISO-8601, UTC. Every timestamp this API emits is one of these.
 *
 * No `offset: true`, which is precisely the flag that would also admit
 * `2026-08-21T11:00:00+02:00`. Every value here is produced by `.toISOString()`
 * and therefore ends in `Z`, and the published contract says UTC — a schema
 * looser than the runtime is worse than one that is merely wrong, because the
 * client generated from it validates a shape the server never sends and its
 * author only finds out when they try to round-trip one.
 */
const isoDateTime = z.iso.datetime();

/**
 * Local calendar day, "YYYY-MM-DD".
 *
 * A pattern rather than a bare `z.string()`: this is the key a caller joins
 * `timeline[].date` and `weekly.days` on, and documenting it as an arbitrary
 * string leaves them to guess whether it is a day, a datetime, or a localised
 * label — a guess that appears to work for as long as their sample happens to
 * agree with it.
 */
const dayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ── request fragments the tRPC side has no equivalent of ─────────────

/**
 * `POST /:id/archive` — the id is in the path, so the body carries only the
 * flag. Omitting `archived` archives, which matches the tRPC sibling's default.
 */
export const archiveBodySchema = z.object({
  archived: z.boolean().optional(),
  originId: z.string().max(120).optional(),
});

/** `DELETE /:id` and the other path-only routes. */
export const idPathSchema = z.object({ id: z.string().min(1) });

/** `POST /entries/:id` style deletes answer with the id they removed. */
const deletedSchema: z.ZodType<{ success: true; id: string }> = z.object({
  success: z.literal(true),
  id: z.string(),
});

// ── response schemas, pinned to the shared wire types ────────────────

const runawayMarkSchema = z.object({
  detectedAt: isoDateTime,
  elapsedSec: z.number(),
  limitSec: z.number(),
  action: z.enum(["flagged", "capped", "stopped"]),
  resolvedAt: isoDateTime.nullable(),
});

const timeEntryShape = {
  id: z.string(),
  workspaceId: z.string(),
  authorId: z.string(),
  description: z.string(),
  projectId: z.string().nullable(),
  taskId: z.string().nullable(),
  billable: z.boolean(),
  start: isoDateTime,
  end: isoDateTime.nullable(),
  durationSec: z.number(),
  /** Null when the caller may not see money for this entry's author. */
  hourlyRate: z.number().nullable(),
  currency: z.string(),
  // The shared enums, not a copy of their members: a re-spelled list is a
  // list that documents last release's values after somebody adds one.
  source: entrySourceSchema,
  timeZone: z.string().nullable(),
  runaway: runawayMarkSchema.nullable(),
  tagIds: z.array(z.string()),
  invoiceId: z.string().nullable(),
  importId: z.string().nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
};

export const timeEntrySchema: z.ZodType<TimeEntry> = z.object(timeEntryShape);

export const detailedEntrySchema: z.ZodType<DetailedEntry> = z.object({
  ...timeEntryShape,
  projectName: z.string().nullable(),
  projectColor: z.string().nullable(),
  clientName: z.string().nullable(),
  taskName: z.string().nullable(),
  /** `null` whenever `hourlyRate` was withheld — never `0`, which is unbilled time. */
  amount: z.number().nullable(),
});

/** What an invoice prints under "Billed to". Blank fields are `null`. */
const clientBillingResponseSchema = z.object({
  legalName: z.string().nullable(),
  addressLines: z.array(z.string()),
  postalCode: z.string().nullable(),
  city: z.string().nullable(),
  /** ISO 3166-1 alpha-2, upper case. */
  country: z.string().nullable(),
  taxId: z.string().nullable(),
  email: z.string().nullable(),
  reference: z.string().nullable(),
});

const clientShape = {
  id: z.string(),
  workspaceId: z.string(),
  createdBy: z.string(),
  name: z.string(),
  color: z.string(),
  archived: z.boolean(),
  /** `null` when the client has no billing details. */
  billing: clientBillingResponseSchema.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
};

export const clientSchema: z.ZodType<Client> = z.object(clientShape);

const currencySpendSchema = z.object({
  currency: z.string(),
  amount: z.number(),
  seconds: z.number(),
});

const budgetStatusSchema = z.enum(["none", "under", "near", "over"]);

const budgetProgressSchema: z.ZodType<BudgetProgress> = z.object({
  trackedSec: z.number(),
  billableSec: z.number(),
  estimatedHours: z.number().nullable(),
  budgetAmount: z.number().nullable(),
  currency: z.string().nullable(),
  spentAmount: z.number(),
  spentByCurrency: z.array(currencySpendSchema),
  hoursRatio: z.number().nullable(),
  amountRatio: z.number().nullable(),
  hoursStatus: budgetStatusSchema,
  amountStatus: budgetStatusSchema,
  remainingSec: z.number().nullable(),
  remainingAmount: z.number().nullable(),
  mixedCurrency: z.boolean(),
  foreignCurrencies: z.array(z.string()),
});

const projectShape = {
  id: z.string(),
  workspaceId: z.string(),
  createdBy: z.string(),
  name: z.string(),
  color: z.string(),
  clientId: z.string().nullable(),
  billableDefault: z.boolean(),
  hourlyRate: z.number().nullable(),
  estimatedHours: z.number().nullable(),
  budgetAmount: z.number().nullable(),
  budgetCurrency: z.string().nullable(),
  idleBehavior: idleBehaviorSchema.nullable(),
  archived: z.boolean(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
};

export const projectSchema: z.ZodType<Project> = z.object(projectShape);

export const projectWithStatsSchema: z.ZodType<ProjectWithStats> = z.object({
  ...projectShape,
  clientName: z.string().nullable(),
  clientColor: z.string().nullable(),
  entryCount: z.number(),
  totalSec: z.number(),
  /**
   * Null both when the project has no target AND when the caller may not see
   * money: `progress.spentAmount` rolls up every member's earnings, so it is
   * aggregate colleague money and `canViewOthersMoney` gates it.
   */
  progress: budgetProgressSchema.nullable(),
});

const taskShape = {
  id: z.string(),
  workspaceId: z.string(),
  createdBy: z.string(),
  projectId: z.string(),
  name: z.string(),
  done: z.boolean(),
  archived: z.boolean(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
};

export const taskSchema: z.ZodType<Task> = z.object(taskShape);

export const taskWithStatsSchema: z.ZodType<TaskWithStats> = z.object({
  ...taskShape,
  projectName: z.string().nullable(),
  projectColor: z.string().nullable(),
  totalSec: z.number(),
});

const tagShape = {
  id: z.string(),
  workspaceId: z.string(),
  createdBy: z.string(),
  name: z.string(),
  color: z.string(),
  archived: z.boolean(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
};

export const tagSchema: z.ZodType<Tag> = z.object(tagShape);

export const tagWithStatsSchema: z.ZodType<TagWithStats> = z.object({
  ...tagShape,
  entryCount: z.number(),
  totalSec: z.number(),
});

export const catalogRemoveResultSchema: z.ZodType<CatalogRemoveResult> = z.object({
  entriesDetached: z.number(),
  tasksDeleted: z.number(),
  projectsDetached: z.number(),
  favoritesDetached: z.number(),
});

export const tagRemoveResultSchema: z.ZodType<TagRemoveResult> = z.object({
  deleted: z.boolean(),
  archived: z.boolean(),
  message: z.string().nullable(),
});

export const summaryReportSchemaOut: z.ZodType<SummaryReportResult> = z.object({
  totalSec: z.number(),
  billableSec: z.number(),
  // Nullable for the shape's sake: REST refuses (403) the one visibility that
  // withholds report money, so a served report always carries numbers here.
  totalAmount: z.number().nullable(),
  currency: z.string(),
  groups: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      color: z.string().nullable(),
      seconds: z.number(),
      billableSec: z.number(),
      amount: z.number().nullable(),
    }),
  ),
  timeline: z.array(
    z.object({
      date: dayKey,
      seconds: z.number(),
      billableSec: z.number(),
    }),
  ),
  /** False when every amount above is withheld as `null`. */
  moneyVisible: z.boolean(),
});

export const weeklyReportSchemaOut: z.ZodType<WeeklyReportResult> = z.object({
  days: z.array(dayKey),
  rows: z.array(
    z.object({
      projectId: z.string().nullable(),
      taskId: z.string().nullable(),
      label: z.string(),
      color: z.string().nullable(),
      daySeconds: z.array(z.number()),
      totalSec: z.number(),
    }),
  ),
  dayTotals: z.array(z.number()),
  totalSec: z.number(),
  moneyVisible: z.boolean(),
});

/** What `GET /me` answers: the token, its workspace, and what it may see. */
export type ApiIdentity = {
  tokenId: string;
  workspaceId: string;
  userId: string;
  scopes: ApiTokenScope[];
  visibility: { canViewOthersTime: boolean; canViewOthersMoney: boolean };
};

export const identitySchema: z.ZodType<ApiIdentity> = z.object({
  tokenId: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  scopes: z.array(apiTokenScopeSchema),
  /**
   * The EFFECTIVE flags: live membership ANDed with the token's mint-time
   * ceiling. A client reads these to decide whether to render a money column
   * at all, rather than discovering the answer from a 403 later.
   */
  visibility: z.object({
    canViewOthersTime: z.boolean(),
    canViewOthersMoney: z.boolean(),
  }),
});

// ── response envelopes ───────────────────────────────────────────────
//
// `output` on a route is the WHOLE response body, envelope included, not the
// resource inside it. That is what keeps the generated document honest: a
// generator that had to infer "this one is a list, so wrap it" is a generator
// that gets one route wrong the day somebody adds a list-shaped read.

/** `{ data }` — one resource. */
function dataOf<T extends z.ZodType>(schema: T): z.ZodType {
  return z.object({ data: schema });
}

/**
 * `{ data: [...], nextCursor }` — a page.
 *
 * `nextCursor` is `.nullable()` and NOT `.optional()`: it is always present,
 * and null only on the last page. Documenting it as optional would tell a
 * generated client that its absence is normal, and such a client stops paging
 * early whenever a serializer drops the field.
 */
function listOf<T extends z.ZodType>(
  schema: T,
  extra: z.ZodRawShape = {},
): z.ZodType {
  return z.object({
    data: z.array(schema),
    nextCursor: z.string().nullable(),
    ...extra,
  });
}

// ── the table ────────────────────────────────────────────────────────

export type ApiRoute = {
  method: "get" | "post" | "patch" | "delete";
  /** Express-style, relative to `/api/v1`. `:id` becomes `{id}` in OpenAPI. */
  path: string;
  /** The scope this route requires, or null when any valid token may call it. */
  scope: ApiTokenScope | null;
  summary: string;
  input: { source: "query" | "body" | "path"; schema: z.ZodType } | null;
  output: z.ZodType | null;
  /**
   * Callable with no token at all. Only the spec document is: everything else
   * is somebody's tracked time. Declared per-route so `index.ts` decides what
   * to mount from the table alone and never from a hard-coded exception.
   */
  isPublic?: true;
};

/**
 * Order matters for the Express wiring: `/entries/current` MUST precede
 * `/entries/:id`, or the parameterised route matches first and "current" is
 * looked up as an entry id — which answers 404 for a timer that is running.
 */
export const API_ROUTES: readonly ApiRoute[] = [
  // ── time entries ───────────────────────────────────────────────────
  {
    method: "get",
    path: "/entries",
    scope: "entries:read",
    summary: "List time entries overlapping a date range.",
    input: { source: "query", schema: entryListSchema },
    output: listOf(detailedEntrySchema),
  },
  // Both timer routes say "in this workspace" on purpose. A token addresses one
  // workspace, and the service is called with a workspace reach, so a timer the
  // same person has running elsewhere is invisible here and `stop` answers 404
  // for it. A summary reading "the caller's running timer" would have an
  // integration treat a null as "nothing is being tracked" and start a second
  // one on top of a timer that is still counting somewhere else.
  {
    method: "get",
    path: "/entries/current",
    scope: "entries:read",
    summary: "The caller's running timer in this workspace, or null when none is running here.",
    input: null,
    output: dataOf(timeEntrySchema.nullable()),
  },
  {
    method: "get",
    path: "/entries/:id",
    scope: "entries:read",
    summary: "One time entry.",
    input: { source: "path", schema: idPathSchema },
    output: dataOf(timeEntrySchema),
  },
  {
    method: "post",
    path: "/entries",
    scope: "entries:write",
    summary: "Create a completed entry with an explicit start and end.",
    input: { source: "body", schema: createEntrySchema },
    output: dataOf(timeEntrySchema),
  },
  {
    method: "patch",
    path: "/entries/:id",
    scope: "entries:write",
    summary: "Edit an entry. Author-only, and refused once it is invoiced.",
    input: { source: "body", schema: updateEntrySchema },
    output: dataOf(timeEntrySchema),
  },
  {
    method: "delete",
    path: "/entries/:id",
    scope: "entries:write",
    summary: "Delete an entry. Author-only, and refused once it is invoiced.",
    input: { source: "path", schema: idPathSchema },
    output: dataOf(deletedSchema),
  },
  {
    method: "post",
    path: "/entries/start",
    scope: "entries:write",
    summary:
      "Start a timer, stopping this workspace's running one first. Answers 409 when the timer is running in another workspace, which this token may not stop.",
    input: { source: "body", schema: startTimerSchema },
    output: dataOf(timeEntrySchema),
  },
  {
    method: "post",
    path: "/entries/stop",
    scope: "entries:write",
    summary: "Stop the timer running in this workspace.",
    input: { source: "body", schema: stopTimerSchema },
    output: dataOf(timeEntrySchema),
  },
  // ── clients ────────────────────────────────────────────────────────
  {
    method: "get",
    path: "/clients",
    scope: "catalog:read",
    summary: "List clients.",
    input: { source: "query", schema: clientListSchema },
    output: listOf(clientSchema),
  },
  {
    method: "get",
    path: "/clients/:id",
    scope: "catalog:read",
    summary: "One client.",
    input: { source: "path", schema: idPathSchema },
    output: dataOf(clientSchema),
  },
  {
    method: "post",
    path: "/clients",
    scope: "catalog:write",
    summary: "Create a client.",
    input: { source: "body", schema: createClientSchema },
    output: dataOf(clientSchema),
  },
  {
    method: "patch",
    path: "/clients/:id",
    scope: "catalog:write",
    summary: "Edit a client.",
    input: { source: "body", schema: updateClientSchema },
    output: dataOf(clientSchema),
  },
  {
    method: "post",
    path: "/clients/:id/archive",
    scope: "catalog:write",
    summary: "Archive or unarchive a client.",
    input: { source: "body", schema: archiveBodySchema },
    output: dataOf(clientSchema),
  },
  {
    method: "delete",
    path: "/clients/:id",
    scope: "catalog:write",
    summary: "Delete a client. Its projects keep their time and lose the link.",
    input: { source: "path", schema: idPathSchema },
    output: dataOf(catalogRemoveResultSchema),
  },
  // ── projects ───────────────────────────────────────────────────────
  {
    method: "get",
    path: "/projects",
    scope: "catalog:read",
    summary: "List projects with rolled-up totals and budget progress.",
    input: { source: "query", schema: projectListSchema },
    output: listOf(projectWithStatsSchema),
  },
  {
    method: "get",
    path: "/projects/:id",
    scope: "catalog:read",
    summary: "One project with its totals and budget progress.",
    input: { source: "path", schema: idPathSchema },
    output: dataOf(projectWithStatsSchema),
  },
  {
    method: "post",
    path: "/projects",
    scope: "catalog:write",
    summary: "Create a project.",
    input: { source: "body", schema: createProjectSchema },
    output: dataOf(projectSchema),
  },
  {
    method: "patch",
    path: "/projects/:id",
    scope: "catalog:write",
    summary: "Edit a project.",
    input: { source: "body", schema: updateProjectSchema },
    output: dataOf(projectSchema),
  },
  {
    method: "post",
    path: "/projects/:id/archive",
    scope: "catalog:write",
    summary: "Archive or unarchive a project.",
    input: { source: "body", schema: archiveBodySchema },
    output: dataOf(projectSchema),
  },
  {
    method: "delete",
    path: "/projects/:id",
    scope: "catalog:write",
    summary: "Delete a project and its tasks. Entries keep their time.",
    input: { source: "path", schema: idPathSchema },
    output: dataOf(catalogRemoveResultSchema),
  },
  // ── tasks ──────────────────────────────────────────────────────────
  {
    method: "get",
    path: "/tasks",
    scope: "catalog:read",
    summary: "List tasks, optionally narrowed to one project.",
    input: { source: "query", schema: taskListSchema },
    output: listOf(taskWithStatsSchema),
  },
  {
    method: "get",
    path: "/tasks/:id",
    scope: "catalog:read",
    summary: "One task.",
    input: { source: "path", schema: idPathSchema },
    output: dataOf(taskWithStatsSchema),
  },
  {
    method: "post",
    path: "/tasks",
    scope: "catalog:write",
    summary: "Create a task inside a project.",
    input: { source: "body", schema: createTaskSchema },
    output: dataOf(taskSchema),
  },
  {
    method: "patch",
    path: "/tasks/:id",
    scope: "catalog:write",
    summary: "Edit a task.",
    input: { source: "body", schema: updateTaskSchema },
    output: dataOf(taskSchema),
  },
  {
    method: "post",
    path: "/tasks/:id/archive",
    scope: "catalog:write",
    summary: "Archive or unarchive a task.",
    input: { source: "body", schema: archiveBodySchema },
    output: dataOf(taskSchema),
  },
  {
    method: "delete",
    path: "/tasks/:id",
    scope: "catalog:write",
    summary: "Delete a task. Entries keep their time and lose the link.",
    input: { source: "path", schema: idPathSchema },
    output: dataOf(catalogRemoveResultSchema),
  },
  // ── tags ───────────────────────────────────────────────────────────
  // No `/tags/:id/archive`: `DELETE /tags/:id` archives instead of deleting
  // when the tag is still on tracked time, and reports which of the two it
  // did. A separate archive route would offer a second way to reach the same
  // state and a second place for that rule to be re-implemented.
  {
    method: "get",
    path: "/tags",
    scope: "catalog:read",
    summary: "List tags with usage counts.",
    input: { source: "query", schema: tagListSchema },
    output: listOf(tagWithStatsSchema),
  },
  {
    method: "get",
    path: "/tags/:id",
    scope: "catalog:read",
    summary: "One tag.",
    input: { source: "path", schema: idPathSchema },
    output: dataOf(tagSchema),
  },
  {
    method: "post",
    path: "/tags",
    scope: "catalog:write",
    summary: "Create a tag.",
    input: { source: "body", schema: createTagSchema },
    output: dataOf(tagSchema),
  },
  {
    method: "patch",
    path: "/tags/:id",
    scope: "catalog:write",
    summary: "Edit a tag.",
    input: { source: "body", schema: updateTagSchema },
    output: dataOf(tagSchema),
  },
  {
    method: "delete",
    path: "/tags/:id",
    scope: "catalog:write",
    summary: "Delete a tag, or archive it when tracked time still carries it.",
    input: { source: "path", schema: idPathSchema },
    output: dataOf(tagRemoveResultSchema),
  },
  // ── reports ────────────────────────────────────────────────────────
  {
    method: "get",
    path: "/reports/summary",
    scope: "reports:read",
    summary: "Totals, a grouped breakdown, and a zero-filled daily series.",
    input: { source: "query", schema: summaryReportSchema },
    output: dataOf(summaryReportSchemaOut),
  },
  {
    method: "get",
    path: "/reports/detailed",
    scope: "reports:read",
    summary: "A paginated entry log; totals span the whole filtered range.",
    input: { source: "query", schema: detailedReportSchema },
    output: listOf(detailedEntrySchema, {
      totalSec: z.number(),
      totalAmount: z.number().nullable(),
      currency: z.string(),
    }),
  },
  {
    method: "get",
    path: "/reports/weekly",
    scope: "reports:read",
    summary: "A seven-day timesheet grid, one row per project and task.",
    input: { source: "query", schema: weeklyReportSchema },
    output: dataOf(weeklyReportSchemaOut),
  },
  // ── meta ───────────────────────────────────────────────────────────
  {
    method: "get",
    path: "/me",
    scope: null,
    summary: "The calling token, its workspace, its scopes and what it may see.",
    input: null,
    output: dataOf(identitySchema),
  },
  {
    method: "get",
    path: "/openapi.json",
    scope: null,
    summary: "This API's OpenAPI 3.1 document.",
    input: null,
    output: null,
    isPublic: true,
  },
];

/**
 * Routes whose response is a page of rows rather than a single resource.
 *
 * Not used to BUILD anything — `output` already carries the envelope. It is
 * the inventory the tests check that envelope against, so a new list route
 * cannot be added with a single-resource shape by accident.
 */
export const LIST_ROUTES: ReadonlySet<string> = new Set([
  // `get /reports/detailed` is deliberately not here: it is a page of rows
  // with the RANGE totals beside it, so its envelope carries three required
  // fields a plain list does not. It is asserted on its own terms instead.
  "get /entries",
  "get /clients",
  "get /projects",
  "get /tasks",
  "get /tags",
]);
