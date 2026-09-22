// Projects: the middle of the catalog, and the only catalog row that carries
// money (an hourly rate and a budget).
//
// `list` resolves the owning client (even an archived one) and aggregates
// entry counts / tracked seconds in a single pipeline — never N+1.
import { TRPCError } from "@trpc/server";
import mongoose from "mongoose";
import {
  PROJECT_COLOR_OFFSET,
  pickCatalogColor,
  type BudgetProgress,
  type CreateProjectInput,
  type Project as ProjectWire,
  projectRemoveResult,
  rollupVisibility,
  type OwnCollateralCounts,
  projectProjectForVisibility,
  type ProjectListInput,
  type ProjectUpdateResult,
  type UpdateProjectInput,
  type UpdateProjectWithEntriesInput,
  type WorkspaceSettings,
  projectBillableByDefault,
} from "@starter/shared";
import { Favorite } from "../../models/Favorite.js";
import {
  Project,
  toClientProject,
  type ProjectDocLike,
} from "../../models/Project.js";
import { TimeEntry } from "../../models/TimeEntry.js";
import { authorScopeFilter } from "../../models/WorkspaceMember.js";
import { getOrCreateWorkspaceSettings } from "../../models/Settings.js";
import { publishSync } from "../../ws/sync.js";
import type { CatalogRemoveResult } from "../../trpc/routers/catalog-cascade.js";
import { cascadeDeleteProject } from "../../trpc/routers/catalog-cascade.js";
import {
  budgetWrite,
  canSeeBudgetProgress,
  loadBudgetProgress,
  needsCurrency,
  touchesBudget,
} from "../../trpc/routers/project-budgets.js";
import type { WorkspaceScope } from "../scope.js";
import { assertClientOwned, assertObjectId } from "./guards.js";
import { applyBillingToEntries } from "./project-entry-billing.js";
import { assertUniqueCatalogName } from "./names.js";
import { catalogEntryRollup } from "./rollup.js";

/** A project plus its joined client and rolled-up time totals. */
export type ProjectWithStats = ProjectWire & {
  clientName: string | null;
  clientColor: string | null;
  /**
   * Number of time entries booked on this project, counted under the CALLER's
   * roll-up scope — their own entries only unless they may see BOTH others'
   * time and others' money (`rollupVisibility`). A whole-workspace count here
   * would hand a member the colleague hours the entry list refuses them, one
   * subtraction away; and beside `hourlyRate`, which every project row
   * carries, it also rebuilds the `progress.spentAmount` below by one
   * multiplication.
   */
  entryCount: number;
  /** Sum of `durationSec` across those same entries (running ones count 0). */
  totalSec: number;
  /**
   * Lifetime progress against the project's estimate/budget, or null when it
   * has neither. Null is the "no target set" signal — a project with a target
   * of zero still gets a progress object.
   *
   * Unlike the two counts above this is NOT author-scoped: a budget is the
   * project's, not one person's, so it deliberately spans every member. That
   * is exactly what makes it a disclosure, and why it is withheld as `null` —
   * for tRPC and REST alike, in `aggregateProjects` — from a caller who may
   * not see others' time or money (`projectProjectForVisibility` in
   * @starter/shared). `null` then reads as "no target", never as "0% spent".
   */
  progress: BudgetProgress | null;
};

/** Raw shape produced by the `list` aggregation. */
type ProjectAggregateRow = ProjectDocLike & {
  clientDoc: { name: string; color: string }[];
  stats: { entryCount: number; totalSec: number }[];
};

const notFound = (): TRPCError =>
  new TRPCError({ code: "NOT_FOUND", message: "Project not found" });

const assertUniqueProjectName = (
  workspaceId: string,
  name: string,
  excludeId?: string,
): Promise<void> =>
  assertUniqueCatalogName({
    model: Project,
    filter: { workspaceId },
    name,
    ...(excludeId ? { excludeId } : {}),
    label: "project",
  });

/**
 * The wire shape every read and write answers with: the stored row, with
 * `billableDefault` projected through the zero-rate rule
 * (`projectBillableByDefault`). Every client defaults new entries from the
 * wire flag, so a project billing at 0 reads as non-billable everywhere at
 * once, and reads as billable again the moment its rate (or the workspace
 * default it inherits) is raised — without any project being edited.
 */
function projectWire(
  doc: ProjectDocLike,
  settings: Pick<WorkspaceSettings, "defaultHourlyRate">,
): ProjectWire {
  const wire = toClientProject(doc);
  return {
    ...wire,
    billableDefault: projectBillableByDefault(wire, settings.defaultHourlyRate),
  };
}

/**
 * The one pipeline. `list` and `get` differ only in their `$match`, so they
 * share this — a separate single-row query is how the two stop agreeing about
 * what `totalSec` and `progress` mean.
 */
async function aggregateProjects(
  scope: WorkspaceScope,
  match: Record<string, unknown>,
): Promise<ProjectWithStats[]> {
  const workspaceId = scope.workspaceId;
  const settings = await getOrCreateWorkspaceSettings(workspaceId);
  const rows = await Project.aggregate<ProjectAggregateRow>([
    { $match: { workspaceId, ...match } },
    {
      // Archived clients must still resolve, so this joins by id only.
      $lookup: {
        from: "clients",
        let: { cid: "$clientId" },
        pipeline: [
          {
            $match: {
              $expr: { $eq: [{ $toString: "$_id" }, "$$cid"] },
            },
          },
          { $project: { _id: 0, name: 1, color: 1 } },
        ],
        as: "clientDoc",
      },
    },
    // Author-scoped: see the note on `entryCount` above. Narrowed through
    // `rollupVisibility` and not passed straight, so the total is the caller's
    // own whenever the money it prices is withheld.
    catalogEntryRollup({
      workspaceId,
      visibility: rollupVisibility(scope.visibility),
      entryField: "projectId",
      as: "stats",
    }),
    { $addFields: { sortName: { $toLower: "$name" } } },
    { $sort: { sortName: 1 } },
  ]);

  const projects = rows.map((row) => {
    const client = row.clientDoc[0];
    const stats = row.stats[0];
    return {
      ...projectWire(row, settings),
      clientName: client?.name ?? null,
      clientColor: client?.color ?? null,
      entryCount: stats?.entryCount ?? 0,
      totalSec: stats?.totalSec ?? 0,
    };
  });

  // Costs nothing until a project actually carries a target, and archived
  // projects keep reporting: their history is still the answer to
  // "did that job come in under budget?".
  //
  // Withheld HERE, in the one pipeline every read of a project goes through,
  // rather than at each surface that serves one: `progress` spans every
  // member's entries, so a caller who may not see both others' time and
  // others' money gets `null` from tRPC exactly as from REST — and the
  // whole-workspace entry read behind it is never even made for them.
  // `projectProjectForVisibility` stays the rule; this only avoids computing
  // the value it would discard.
  const withheld = !canSeeBudgetProgress(scope.visibility);
  const progress = withheld
    ? new Map<string, BudgetProgress>()
    : await loadBudgetProgress(workspaceId, projects);

  return projects.map((project) =>
    projectProjectForVisibility(
      { ...project, progress: progress.get(project.id) ?? null },
      scope.visibility,
    ),
  );
}

export async function listProjects(
  scope: WorkspaceScope,
  input: ProjectListInput,
): Promise<ProjectWithStats[]> {
  if (typeof input.clientId === "string") assertObjectId(input.clientId);

  return aggregateProjects(scope, {
    ...(input.includeArchived ? {} : { archived: false }),
    ...(input.clientId !== undefined
      ? { clientId: input.clientId ?? null }
      : {}),
  });
}

/** One project by id, with the same joined shape `list` produces. */
export async function getProject(
  scope: WorkspaceScope,
  id: string,
): Promise<ProjectWithStats> {
  assertObjectId(id);
  const [found] = await aggregateProjects(scope, {
    // Ids are strings on the wire but ObjectIds in the collection, so the
    // match has to be on `_id` as Mongoose casts it — `assertObjectId` above
    // is what makes that cast safe.
    _id: new mongoose.Types.ObjectId(id),
  });
  if (!found) throw notFound();
  return found;
}

export async function createProject(
  scope: WorkspaceScope,
  input: CreateProjectInput,
): Promise<ProjectWire> {
  const name = input.name.trim();
  await assertUniqueProjectName(scope.workspaceId, name);
  if (input.clientId) await assertClientOwned(scope.workspaceId, input.clientId);

  const existing = await Project.countDocuments({
    workspaceId: scope.workspaceId,
  });
  // Read for the budget's currency and for the answer's billable flag, which
  // depends on the workspace default rate.
  const settings = await getOrCreateWorkspaceSettings(scope.workspaceId);
  const created = await Project.create({
    workspaceId: scope.workspaceId,
    createdBy: scope.userId,
    name,
    color: input.color ?? pickCatalogColor(existing, PROJECT_COLOR_OFFSET),
    clientId: input.clientId ?? null,
    billableDefault: input.billableDefault ?? true,
    hourlyRate: input.hourlyRate ?? null,
    estimatedHours: null,
    budgetAmount: null,
    budgetCurrency: null,
    ...budgetWrite(input, settings.currency),
    idleBehavior: input.idleBehavior ?? null,
    archived: false,
  });

  void publishSync(
    scope.workspaceId,
    { kind: "catalog.changed", scope: "project" },
    input.originId,
  );
  return projectWire(created, settings);
}

export async function updateProject(
  scope: WorkspaceScope,
  input: UpdateProjectInput,
): Promise<ProjectWire> {
  assertObjectId(input.id);
  if (input.name !== undefined) {
    await assertUniqueProjectName(scope.workspaceId, input.name, input.id);
  }
  if (input.clientId) await assertClientOwned(scope.workspaceId, input.clientId);

  // Read on every update: the answer's billable flag depends on the
  // workspace default rate.
  const settings = await getOrCreateWorkspaceSettings(scope.workspaceId);

  // Changing a budget's amount must keep the currency it was agreed in,
  // so the existing snapshot is read before it is overwritten. An
  // estimate-only edit needs no lookup.
  let budgetSet: Record<string, unknown> = {};
  if (touchesBudget(input)) {
    if (needsCurrency(input)) {
      const existing = await Project.findOne({
        _id: input.id,
        workspaceId: scope.workspaceId,
      })
        .select("budgetAmount budgetCurrency")
        .lean();
      budgetSet = budgetWrite(input, settings.currency, {
        budgetAmount: existing?.budgetAmount ?? null,
        budgetCurrency: existing?.budgetCurrency ?? null,
      });
    } else {
      budgetSet = budgetWrite(input, "");
    }
  }

  const updated = await Project.findOneAndUpdate(
    { _id: input.id, workspaceId: scope.workspaceId },
    {
      $set: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.clientId !== undefined
          ? { clientId: input.clientId ?? null }
          : {}),
        ...(input.billableDefault !== undefined
          ? { billableDefault: input.billableDefault }
          : {}),
        ...(input.hourlyRate !== undefined
          ? { hourlyRate: input.hourlyRate ?? null }
          : {}),
        ...(input.idleBehavior !== undefined
          ? { idleBehavior: input.idleBehavior ?? null }
          : {}),
        ...(input.archived !== undefined ? { archived: input.archived } : {}),
        ...budgetSet,
      },
    },
    { returnDocument: "after" },
  ).lean();

  if (!updated) throw notFound();

  void publishSync(
    scope.workspaceId,
    { kind: "catalog.changed", scope: "project" },
    input.originId,
  );
  return projectWire(updated, settings);
}

/**
 * `updateProject`, optionally carrying the billing change onto the time
 * already booked on the project (`project-entry-billing.ts` for what that
 * may and may not touch).
 *
 * The flag is a no-op for an update that changes neither the billable
 * default nor the rate: nothing about the entries' billing would move.
 */
export async function updateProjectWithEntries(
  scope: WorkspaceScope,
  input: UpdateProjectWithEntriesInput,
): Promise<ProjectUpdateResult> {
  const { applyToEntries, ...update } = input;
  const touchesBilling =
    update.billableDefault !== undefined || update.hourlyRate !== undefined;

  if (!applyToEntries || !touchesBilling) {
    return { ...(await updateProject(scope, update)), entriesRewritten: null };
  }

  assertObjectId(update.id);
  // Read before the write: whether the default changed decides whether each
  // entry's own flag is overwritten or left alone. Compared as the clients
  // saw it — through the zero-rate rule — so giving a rate to a project that
  // was billable at 0 counts as switching it on, and its entries follow.
  const [before, settings] = await Promise.all([
    Project.findOne({ _id: update.id, workspaceId: scope.workspaceId })
      .select("billableDefault hourlyRate")
      .lean(),
    getOrCreateWorkspaceSettings(scope.workspaceId),
  ]);
  if (!before) throw notFound();
  const wasBillable = projectBillableByDefault(
    before,
    settings.defaultHourlyRate,
  );

  const project = await updateProject(scope, update);
  const entriesRewritten = await applyBillingToEntries(
    scope,
    project.id,
    {
      billableDefault: project.billableDefault,
      billableChanged: project.billableDefault !== wasBillable,
      projectRate: project.hourlyRate,
    },
    settings,
  );

  if (entriesRewritten.entries > 0) {
    // Entry lists, reports and invoice previews all read the snapshot this
    // just rewrote. `updateProject` already announced the catalog change; this
    // one tells every other screen that entries moved with it.
    void publishSync(
      scope.workspaceId,
      { kind: "catalog.changed", scope: "project", entriesTouched: true },
      input.originId,
    );
  }
  return { ...project, entriesRewritten };
}

export async function archiveProject(
  scope: WorkspaceScope,
  input: { id: string; archived?: boolean; originId?: string },
): Promise<ProjectWire> {
  assertObjectId(input.id);

  const updated = await Project.findOneAndUpdate(
    { _id: input.id, workspaceId: scope.workspaceId },
    { $set: { archived: input.archived ?? true } },
    { returnDocument: "after" },
  ).lean();

  if (!updated) throw notFound();

  void publishSync(
    scope.workspaceId,
    { kind: "catalog.changed", scope: "project" },
    input.originId,
  );
  return projectWire(
    updated,
    await getOrCreateWorkspaceSettings(scope.workspaceId),
  );
}

/**
 * The caller's own share of what a cascading delete is about to detach, or
 * `null` when they may be told the workspace's numbers as they are.
 *
 * Counted BEFORE the cascade runs, which is the whole reason this is a
 * separate query rather than a projection of the result: afterwards nothing
 * points at the deleted row any more and the same count comes back zero.
 *
 * Shared with `removeTask` rather than copied, because two copies is how one
 * of them goes on reporting the whole workspace's collateral six months after
 * the other was fixed. What it may report is decided by
 * `projectRemoveResult` in @starter/shared, which is where the rule is
 * written down.
 *
 * Matching on the catalog id alone mirrors what the cascade detaches: an entry
 * or a pin that carries a task always carries that task's project too (the
 * cascade matches both only to stay correct if that ever drifts). Should it
 * drift, this count can only come out LOW — never disclosing a row the caller
 * may not see, which is the direction that matters here.
 */
export async function ownCascadeCollateral(
  scope: WorkspaceScope,
  match: { projectId: string } | { taskId: string },
): Promise<OwnCollateralCounts | null> {
  const authorScope = authorScopeFilter(scope.visibility);
  // Nothing to withhold, and no extra round trip for the common case.
  if (authorScope === null) return null;

  const [entriesDetached, favoritesDetached] = await Promise.all([
    TimeEntry.countDocuments({
      workspaceId: scope.workspaceId,
      ...match,
      ...authorScope,
    }),
    // A pin is filed under `userId`, not `authorId` — it is one person's
    // shortcut, so the caller's own pins are the ones they may be told about.
    Favorite.countDocuments({
      workspaceId: scope.workspaceId,
      ...match,
      userId: scope.visibility.userId,
    }),
  ]);

  return { entriesDetached, favoritesDetached };
}

/**
 * Always deletes. Tasks go with the project; entries booked on either keep
 * their tracked time and become project-less. Use `archive` to keep the
 * project around instead.
 *
 * The collateral it reports is the CALLER's when they may not see others'
 * work — `ownCascadeCollateral` above, and `projectRemoveResult` for why.
 */
export async function removeProject(
  scope: WorkspaceScope,
  input: { id: string; originId?: string },
): Promise<CatalogRemoveResult> {
  assertObjectId(input.id);

  const project = await Project.findOne({
    _id: input.id,
    workspaceId: scope.workspaceId,
  }).lean();
  if (!project) throw notFound();

  const own = await ownCascadeCollateral(scope, { projectId: input.id });
  const result = await cascadeDeleteProject(scope.workspaceId, input.id);

  // The SYNC events below deliberately read the cascade's whole-workspace
  // counts, never the projected ones: they decide whose cached lists must be
  // refetched, and a member who may not see an entry still has a stale screen
  // when it moves. Only the RESPONSE is narrowed, at the end.
  void publishSync(
    scope.workspaceId,
    {
      kind: "catalog.changed",
      scope: "project",
      entriesTouched: result.entriesDetached > 0,
    },
    input.originId,
  );
  // A detached pin still points somewhere it did not a moment ago, and
  // `catalog.changed` does not cover the favorites cache.
  if (result.favoritesDetached > 0) {
    void publishSync(
      scope.workspaceId,
      { kind: "favorites.changed" },
      input.originId,
    );
  }
  return projectRemoveResult(result, own);
}
