// Pinned quick starts — the five things somebody tracks every day, kept where
// a weekly task cannot fall off the end of the recents list.
//
// Invariants this file owns:
//  - Every query/mutation is scoped by BOTH `workspaceId` and `userId`: a pin
//    is one person's shortcut, and it points at a project that exists in one
//    workspace. A pin outside that pair is indistinguishable from a missing
//    one (NOT_FOUND, never FORBIDDEN).
//  - `order` is dense from 0 within that pair. `create` appends, `remove`
//    closes the gap, `reorder` rewrites the whole list.
//  - Pins are unique by (description, projectId, taskId, billable) — pinning
//    the same job twice is always a mistake, never an intent. The project and
//    the task are independent references, so any combination of the two is a
//    legal pin.
//  - Every mutation calls `publishToUser(ctx.user.id, { kind:
//    "favorites.changed" }, input.originId)` — a pin change reaches that
//    person's own devices and nobody else's.
//
// There is no `start` procedure here on purpose. A favorite is started by
// handing its four fields to `entries.start`, exactly as the tracker's Start
// button does — see the note in @starter/shared's quick-start.ts.
import { TRPCError } from "@trpc/server";
import mongoose from "mongoose";
import {
  MAX_FAVORITES,
  createFavoriteSchema,
  idInputSchema,
  quickStartKey,
  reorderFavoritesSchema,
  type DetailedFavorite,
  workspaceScopeSchema,
} from "@starter/shared";
import { Favorite, toClientFavorite } from "../../models/Favorite.js";
import { Project } from "../../models/Project.js";
import { Task } from "../../models/Task.js";
import { publishToUser } from "../../ws/sync.js";
import { router, workspaceProcedure } from "../trpc.js";

/**
 * A pin is personal AND workspace-bound: it is one person's shortcut, and it
 * references a project that only exists in one workspace.
 */
const favoriteScope = (ctx: {
  workspaceId: string;
  user: { id: string };
}): FavoriteScope => ({ workspaceId: ctx.workspaceId, userId: ctx.user.id });
import { loadCatalogLookup } from "./catalog-lookup.js";
import { resolveQuickStartLabels } from "./quick-start.js";

const notFound = (): TRPCError =>
  new TRPCError({ code: "NOT_FOUND", message: "Favorite not found" });

/** An id that cannot address a document reads as missing, never as a 500. */
const requireObjectId = (id: string): string => {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  return id;
};

/**
 * Read the pins in their stored order, then attach catalog labels.
 *
 * Exported because the extension's snapshot and the Raycast command both want
 * exactly this, and because `entries.recent` needs the same labelling — the
 * two tiers must describe an archived project identically or the same pin
 * reads differently depending on which list it came from.
 */
export type FavoriteScope = { workspaceId: string; userId: string };

export async function listFavorites(
  scope: FavoriteScope,
): Promise<DetailedFavorite[]> {
  const docs = await Favorite.find(scope)
    .sort({ order: 1, createdAt: 1 })
    .lean();
  if (docs.length === 0) return [];

  const favorites = docs.map(toClientFavorite);
  const catalog = await loadCatalogLookup(scope.workspaceId, favorites);

  return favorites.map((favorite) => ({
    ...favorite,
    ...resolveQuickStartLabels(favorite, catalog),
  }));
}

/**
 * Rewrite `order` so it is dense from 0 in the given id order.
 *
 * Dense ordering is what makes "move one slot left" a client-side swap plus a
 * single `reorder`, instead of a fractional-index scheme nobody can debug.
 */
const writeOrder = async (
  scope: FavoriteScope,
  ids: readonly string[],
): Promise<void> => {
  if (ids.length === 0) return;
  await Favorite.bulkWrite(
    ids.map((id, index) => ({
      updateOne: {
        filter: { _id: id, ...scope },
        update: { $set: { order: index } },
      },
    })),
  );
};

export const favoritesRouter = router({
  list: workspaceProcedure.input(workspaceScopeSchema).query(
    async ({ ctx }): Promise<DetailedFavorite[]> =>
      listFavorites(favoriteScope(ctx)),
  ),

  create: workspaceProcedure
    .input(createFavoriteSchema)
    .mutation(async ({ ctx, input }): Promise<DetailedFavorite> => {
      const scope = favoriteScope(ctx);
      const description = input.description.trim();
      const projectId = input.projectId ?? null;
      const taskId = input.taskId ?? null;

      // Same defaulting rule as `entries.start`, applied at pin time rather
      // than at start time: a pin is a decision about what to track, and it
      // must not silently change meaning later because the project's default
      // was edited in between.
      const project =
        projectId !== null && mongoose.isValidObjectId(projectId)
          ? await Project.findOne({ _id: projectId, workspaceId: ctx.workspaceId }).lean()
          : null;
      if (projectId !== null && project === null) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }
      const billable = input.billable ?? project?.billableDefault ?? false;

      // Validated at pin time for the same reason `entries.start` validates at
      // start time: a pin that cannot be started is worse than a rejected pin,
      // because it fails later, on the surface built to be one click.
      if (taskId !== null) {
        const task = mongoose.isValidObjectId(taskId)
          ? await Task.exists({ _id: taskId, workspaceId: ctx.workspaceId })
          : null;
        if (task === null) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
        }
      }

      const existing = await Favorite.find(scope)
        .sort({ order: 1 })
        .lean();

      // Pinning something already pinned is a no-op that returns the pin, not
      // a duplicate and not an error: every surface offers a pin action, and
      // two of them racing must not leave two identical chips behind.
      const key = quickStartKey({ description, projectId, taskId, billable });
      const clash = existing.find(
        (candidate) =>
          quickStartKey({
            description: candidate.description.trim(),
            projectId: candidate.projectId ?? null,
            taskId: candidate.taskId ?? null,
            billable: candidate.billable,
          }) === key,
      );
      if (clash) {
        const wire = toClientFavorite(clash);
        const catalog = await loadCatalogLookup(ctx.workspaceId, [wire]);
        return { ...wire, ...resolveQuickStartLabels(wire, catalog) };
      }

      if (existing.length >= MAX_FAVORITES) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `You can pin at most ${MAX_FAVORITES} favorites.`,
        });
      }

      const created = await Favorite.create({
        ...scope,
        description,
        projectId,
        taskId,
        billable,
        order: existing.length,
      });

      const wire = toClientFavorite(created);
      const catalog = await loadCatalogLookup(ctx.workspaceId, [wire]);

      publishToUser(
        ctx.user.id,
        { kind: "favorites.changed" },
        input.originId,
      );
      return { ...wire, ...resolveQuickStartLabels(wire, catalog) };
    }),

  remove: workspaceProcedure
    .input(idInputSchema)
    .mutation(
      async ({ ctx, input }): Promise<{ success: true; id: string }> => {
        const scope = favoriteScope(ctx);
        const result = await Favorite.deleteOne({
          _id: requireObjectId(input.id),
          ...scope,
        });
        if (result.deletedCount === 0) throw notFound();

        // Close the gap immediately. Leaving a hole works — the list is sorted,
        // not indexed by order — but it makes every later `reorder` diff look
        // like a reshuffle, and makes the stored data lie about position.
        const remaining = await Favorite.find(scope)
          .sort({ order: 1, createdAt: 1 })
          .select({ _id: 1 })
          .lean();
        await writeOrder(
          scope,
          remaining.map((favorite) => String(favorite._id)),
        );

        publishToUser(
        ctx.user.id,
        { kind: "favorites.changed" },
        input.originId,
      );
        return { success: true, id: input.id };
      },
    ),

  /**
   * Set the whole order at once. Ids this owner does not have are ignored, and
   * pins the caller left out keep their relative order after the ones it sent
   * — a client working from a stale list reorders what it can see instead of
   * hiding whatever it did not know about.
   */
  reorder: workspaceProcedure
    .input(reorderFavoritesSchema)
    .mutation(async ({ ctx, input }): Promise<DetailedFavorite[]> => {
      const scope = favoriteScope(ctx);
      const current = await Favorite.find(scope)
        .sort({ order: 1, createdAt: 1 })
        .select({ _id: 1 })
        .lean();

      const owned = new Set(current.map((favorite) => String(favorite._id)));
      // Deduplicated: a repeated id would otherwise consume two slots and
      // push everything after it one position out.
      const requested = [...new Set(input.ids.filter((id) => owned.has(id)))];
      const seen = new Set(requested);
      const rest = current
        .map((favorite) => String(favorite._id))
        .filter((id) => !seen.has(id));

      await writeOrder(scope, [...requested, ...rest]);

      publishToUser(
        ctx.user.id,
        { kind: "favorites.changed" },
        input.originId,
      );
      return listFavorites(scope);
    }),
});
