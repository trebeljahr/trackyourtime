import { transactional, businessReads } from "../business-transaction.js";
// Tags: cross-cutting labels, deliberately OUTSIDE the Client → Project → Task
// tree. One entry lives at exactly one place in that tree but can carry any
// number of tags.
import { TRPCError } from "@trpc/server";
import mongoose from "mongoose";
import {
  pickCatalogColor,
  rollupVisibility,
  type CreateTagInput,
  type Tag as TagWire,
  type TagListInput,
  type TagRemoveResult,
  type UpdateTagInput,
  type Visibility,
} from "@starter/shared";
import { Tag, toClientTag } from "../../models/Tag.js";
import { TimeEntry } from "../../models/TimeEntry.js";
import { publishSync } from "../../ws/sync.js";
import type { WorkspaceScope } from "../scope.js";
import { assertObjectId } from "./guards.js";
import { assertUniqueCatalogName } from "./names.js";
import { scopeRollupMatch } from "./rollup.js";

/**
 * Where tags start in the shared catalog palette.
 *
 * Ten lands on violet — the same hue as `DEFAULT_TAG_COLOR` on the model — so
 * a tag created through the router and one written straight to the database
 * look alike, and a list of tags stays visually distinct from a list of
 * clients (offset 0) or projects (offset 6) created in lockstep.
 */
export const TAG_COLOR_OFFSET = 10;

/** A tag plus how much time carries it — what the tag manager lists. */
export type TagWithStats = TagWire & {
  /**
   * Number of time entries carrying this tag, counted under the CALLER's
   * roll-up scope — their own entries only unless they may see BOTH others'
   * time and others' money (`rollupVisibility`). Tags cut across every
   * project, so an unscoped count here is the widest of the three roll-ups:
   * it totals the whole workspace's work per label.
   */
  entryCount: number;
  /** Sum of `durationSec` across those same entries. */
  totalSec: number;
};

/** Rolled-up usage for one tag, keyed by the tag's id as a string. */
type TagUsage = { entryCount: number; totalSec: number };

const conflict = (name: string): TRPCError =>
  new TRPCError({
    code: "CONFLICT",
    message: `A tag named "${name.trim()}" already exists.`,
  });

const notFound = (): TRPCError =>
  new TRPCError({ code: "NOT_FOUND", message: "Tag not found" });

const isDuplicateKeyError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  return (error as { code?: unknown }).code === 11000;
};

const assertUniqueTagName = (
  workspaceId: string,
  name: string,
  excludeId?: string,
): Promise<void> =>
  assertUniqueCatalogName({
    model: Tag,
    filter: { workspaceId },
    name,
    ...(excludeId ? { excludeId } : {}),
    label: "tag",
  });

/**
 * Usage totals for every tag this workspace has used, in ONE aggregation.
 *
 * The alternative — asking "how much time carries this tag?" per tag — is an
 * N+1 that grows with the tag list. Unwinding `tagIds` once and grouping by
 * the id gives every tag's numbers in a single pass, and the empty-array
 * entries are filtered out before the unwind so untagged time never enters
 * the pipeline at all.
 */
const loadTagUsage = async (
  workspaceId: string,
  visibility: Visibility,
): Promise<Map<string, TagUsage>> => {
  const rows = await TimeEntry.aggregate<{
    _id: string;
    entryCount: number;
    totalSec: number;
  }>([
    // Author-scoped: see the note on `entryCount` above. Narrowed through
    // `rollupVisibility`, so the same conjunction guards all three roll-ups —
    // one of them staying on the time flag alone is how the rule quietly
    // acquires an exception nobody can check.
    {
      $match: scopeRollupMatch(
        { workspaceId, "tagIds.0": { $exists: true } },
        rollupVisibility(visibility),
      ),
    },
    { $unwind: "$tagIds" },
    {
      $group: {
        _id: "$tagIds",
        entryCount: { $sum: 1 },
        totalSec: { $sum: "$durationSec" },
      },
    },
  ]);

  return new Map(
    rows.map((row) => [
      String(row._id),
      { entryCount: row.entryCount, totalSec: row.totalSec },
    ]),
  );
};

/** Every tag in this workspace, name-sorted, with rolled-up totals. */
export async function listTags(
  scope: WorkspaceScope,
  input: TagListInput,
): Promise<TagWithStats[]> {
  const workspaceId = scope.workspaceId;

  const [docs, usage] = await businessReads([
    () => (
    Tag.find({
      workspaceId,
      ...(input.includeArchived ? {} : { archived: false }),
    })
      // Same collation as the unique index, so "design" and "Design"
      // sort next to each other rather than in two alphabets.
      .collation({ locale: "en", strength: 2 })
      .sort({ name: 1 })
      .lean()
    ),
    () => (
    loadTagUsage(workspaceId, scope.visibility)
    )
  ]);

  return docs.map((doc) => {
    const tag = toClientTag(doc);
    const stats = usage.get(tag.id);
    return {
      ...tag,
      entryCount: stats?.entryCount ?? 0,
      totalSec: stats?.totalSec ?? 0,
    };
  });
}

export async function getTag(
  scope: WorkspaceScope,
  id: string,
): Promise<TagWire> {
  assertObjectId(id);
  const doc = await Tag.findOne({
    _id: new mongoose.Types.ObjectId(id),
    workspaceId: scope.workspaceId,
  }).lean();
  if (!doc) throw notFound();
  return toClientTag(doc);
}

export async function createTag(
  scope: WorkspaceScope,
  input: CreateTagInput,
): Promise<TagWire> {
  const workspaceId = scope.workspaceId;
  const name = input.name.trim();
  if (name === "") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Name is required" });
  }
  await assertUniqueTagName(workspaceId, name);

  const existing = await Tag.countDocuments({ workspaceId });

  let created;
  try {
    created = await Tag.create({
      workspaceId,
      createdBy: scope.userId,
      name,
      color: input.color ?? pickCatalogColor(existing, TAG_COLOR_OFFSET),
      archived: false,
    });
  } catch (error) {
    // The check above lost a race with a concurrent create; the index
    // caught it. Same answer either way.
    if (isDuplicateKeyError(error)) throw conflict(name);
    throw error;
  }

  void publishSync(
    workspaceId,
    { kind: "catalog.changed", scope: "tag" },
    input.originId,
  );
  return toClientTag(created);
}

export async function updateTag(
  scope: WorkspaceScope,
  input: UpdateTagInput,
): Promise<TagWire> {
  const workspaceId = scope.workspaceId;
  assertObjectId(input.id);

  const name = input.name?.trim();
  if (name !== undefined) {
    if (name === "") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Name is required" });
    }
    await assertUniqueTagName(workspaceId, name, input.id);
  }

  let updated;
  try {
    updated = await Tag.findOneAndUpdate(
      { _id: input.id, workspaceId },
      {
        $set: {
          ...(name !== undefined ? { name } : {}),
          ...(input.color !== undefined ? { color: input.color } : {}),
          ...(input.archived !== undefined ? { archived: input.archived } : {}),
        },
      },
      { returnDocument: "after" },
    ).lean();
  } catch (error) {
    if (isDuplicateKeyError(error) && name !== undefined) {
      throw conflict(name);
    }
    throw error;
  }

  if (!updated) throw notFound();

  void publishSync(
    workspaceId,
    { kind: "catalog.changed", scope: "tag" },
    input.originId,
  );
  return toClientTag(updated);
}

/** Hard-deletes only when nothing references the tag; archives otherwise. */
async function removeTagImpl(
  scope: WorkspaceScope,
  input: { id: string; originId?: string },
): Promise<TagRemoveResult> {
  const workspaceId = scope.workspaceId;
  assertObjectId(input.id);

  const tag = await Tag.findOne({ _id: input.id, workspaceId }).lean();
  if (!tag) throw notFound();

  // A tag that still labels tracked time is ARCHIVED, not deleted — the
  // same rule clients and projects follow. Deleting it would silently
  // rewrite history: reports grouped by tag would lose a bucket and the
  // entries would have nothing to show in its place.
  //
  // Deliberately NOT author-scoped, unlike the roll-up above. This decides
  // whether other people's history survives, so scoping it would let a member
  // who cannot see colleague entries hard-delete a tag those entries carry.
  // It does tell that member "somebody uses this tag" — one bit, and the
  // price of not destroying data on their behalf. `TagRemoveResult` carries
  // no counts, so that bit is all of it.
  const referenced =
    (await TimeEntry.exists({ workspaceId, tagIds: input.id })) !== null;

  if (referenced) {
    await Tag.updateOne(
      { _id: input.id, workspaceId },
      { $set: { archived: true } },
    );
    void publishSync(
      workspaceId,
      { kind: "catalog.changed", scope: "tag" },
      input.originId,
    );
    return {
      deleted: false,
      archived: true,
      message:
        "This tag is still on tracked time, so it was archived instead of deleted.",
    };
  }

  await Tag.deleteOne({ _id: input.id, workspaceId });

  // Belt and braces, and ordered on purpose: the `exists` check above and
  // this delete are not one transaction, so an entry written in between
  // would keep an id pointing at a tag that is gone — which renders as a
  // blank chip on the entry and as a phantom filter value. One updateMany
  // sweeps any such straggler, and running it AFTER the delete is what
  // makes it catch writes that landed during the check.
  //
  // `$pull` and never `$set: []` / `$unset`: either of those would take the
  // entry's OTHER tags with it.
  await TimeEntry.updateMany(
    { workspaceId, tagIds: input.id },
    { $pull: { tagIds: input.id } },
  );

  void publishSync(
    workspaceId,
    { kind: "catalog.changed", scope: "tag" },
    input.originId,
  );
  return { deleted: true, archived: false, message: null };
}

export const removeTag = transactional(removeTagImpl);
