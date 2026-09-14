"use client";

import * as React from "react";
import { createId } from "@starter/core";
import type { CreateTagInput, Tag, UpdateTagInput } from "@starter/shared";

import { toast } from "@/components/ui/sonner";
import {
  errorMessage,
  isConflict,
  sortByName,
} from "@/components/catalog/types";
import { ORIGIN_ID } from "@/hooks/use-sync";
import { translate } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";

/**
 * A tag plus how much time carries it — the shape `tags.list` returns.
 *
 * Mirrored structurally rather than imported: the router's `TagWithStats`
 * lives behind `@starter/server`, which the client does not depend on. Same
 * reasoning as `ProjectRow` in components/catalog/types.ts.
 */
export type TagRow = Tag & {
  /** Number of time entries carrying this tag. */
  entryCount: number;
  /** Sum of `durationSec` across those entries. */
  totalSec: number;
};

/**
 * One canonical `tags.list` input for the whole app.
 *
 * Everything — picker, filter, chips, manager — reads this single cache entry
 * and filters in the browser, so an optimistic `setData` never has to guess
 * which key the caller happens to be subscribed to.
 */
export const TAG_LIST_INPUT: { includeArchived: boolean } = {
  includeArchived: true,
};

export type UseTagsResult = {
  /** Name-sorted, archived tags excluded unless asked for. */
  tags: TagRow[];
  /** Every tag including archived ones — what chips resolve names against. */
  allTags: TagRow[];
  isLoading: boolean;
};

export type UseTagsOptions = {
  includeArchived?: boolean;
};

/** The owner's tag catalog. */
export function useTags(options?: UseTagsOptions): UseTagsResult {
  const query = trpc.tags.list.useQuery(TAG_LIST_INPUT);
  const includeArchived = options?.includeArchived ?? false;

  const allTags = React.useMemo<TagRow[]>(() => query.data ?? [], [query.data]);

  const tags = React.useMemo<TagRow[]>(
    () => (includeArchived ? allTags : allTags.filter((tag) => !tag.archived)),
    [allTags, includeArchived],
  );

  return { tags, allTags, isLoading: query.isLoading };
}

/** Look a tag up by id — the lookup every renderer needs. */
export function tagById(tags: TagRow[], id: string): TagRow | null {
  return tags.find((tag) => tag.id === id) ?? null;
}

/**
 * Resolve a list of ids to tags, dropping ids nothing answers to.
 *
 * An id with no tag behind it renders as a blank chip, which reads as a bug.
 * The server sweeps dangling ids off entries when a tag is deleted, but the
 * sweep and this render are not one transaction, so the guard stays.
 */
export function tagsForIds(tags: TagRow[], ids: readonly string[]): TagRow[] {
  const byId = new Map(tags.map((tag) => [tag.id, tag]));
  const resolved: TagRow[] = [];
  for (const id of ids) {
    const tag = byId.get(id);
    if (tag) resolved.push(tag);
  }
  return resolved;
}

// ── mutations ────────────────────────────────────────────────────────

/** Forms pass `onConflict` so a duplicate name lands on the field, not a toast. */
export type TagErrorHandlers = {
  onConflict?: (message: string) => void;
};

/** `originId` is stamped by the hook, never by a caller. */
export type CreateTagVars = Omit<CreateTagInput, "originId">;
export type UpdateTagVars = Omit<UpdateTagInput, "originId">;

/** What `tags.remove` resolves to — deletion is never guaranteed. */
export type TagRemoveResult = {
  deleted: boolean;
  archived: boolean;
  message: string | null;
};

const DEFAULT_COLOR = "#8b5cf6";

export type TagMutations = {
  /** Resolves to the created tag, or null when the server refused. */
  createTag: (vars: CreateTagVars) => Promise<Tag | null>;
  updateTag: (vars: UpdateTagVars) => Promise<Tag | null>;
  setTagArchived: (id: string, archived: boolean) => void;
  removeTag: (id: string) => void;
  isSaving: boolean;
};

/**
 * Every tag write, wrapped in the catalog's three guarantees: optimistic
 * `setData` with rollback, one canonical cache key, and an `originId` on every
 * input so this tab ignores the sync broadcast its own mutation caused.
 */
export function useTagMutations(
  handlers: TagErrorHandlers = {},
): TagMutations {
  const utils = trpc.useUtils();

  const report = React.useCallback(
    (error: unknown, fallback: string, name?: string): void => {
      // The server's CONFLICT message is English; rebuild it from the name.
      const message =
        isConflict(error) && name !== undefined
          ? translate("catalog")("errors.nameTaken", {
              kind: "tag",
              name: name.trim(),
            })
          : errorMessage(error, fallback);
      if (isConflict(error) && handlers.onConflict) {
        handlers.onConflict(message);
        return;
      }
      toast.error(message);
    },
    [handlers],
  );

  const write = (update: (rows: TagRow[]) => TagRow[]): void => {
    utils.tags.list.setData(TAG_LIST_INPUT, (old) =>
      old === undefined ? old : update(old),
    );
  };

  const begin = async (): Promise<{ previous: TagRow[] | undefined }> => {
    await utils.tags.list.cancel(TAG_LIST_INPUT);
    return { previous: utils.tags.list.getData(TAG_LIST_INPUT) };
  };

  const rollback = (previous: TagRow[] | undefined): void => {
    if (previous !== undefined) utils.tags.list.setData(TAG_LIST_INPUT, previous);
  };

  // Tag-grouped reports and the tag filter both read from the report caches,
  // so a renamed or recoloured tag has to refresh those too.
  const settle = (): void => {
    void utils.tags.list.invalidate();
    void utils.reports.invalidate();
  };

  const create = trpc.tags.create.useMutation({
    onMutate: async (vars) => {
      const context = await begin();
      const now = new Date().toISOString();
      const optimistic: TagRow = {
        id: `optimistic-${createId()}`,
        workspaceId: "",
        createdBy: "",
        name: vars.name.trim(),
        color: vars.color ?? DEFAULT_COLOR,
        archived: false,
        createdAt: now,
        updatedAt: now,
        entryCount: 0,
        totalSec: 0,
      };
      write((rows) => sortByName([...rows, optimistic]));
      return context;
    },
    onError: (error, _vars, context) => {
      rollback(context?.previous);
      report(error, translate("catalog")("errors.createTag"), _vars.name);
    },
    onSettled: settle,
  });

  const update = trpc.tags.update.useMutation({
    onMutate: async (vars) => {
      const context = await begin();
      write((rows) =>
        sortByName(
          rows.map((row) =>
            row.id === vars.id
              ? {
                  ...row,
                  ...(vars.name !== undefined ? { name: vars.name.trim() } : {}),
                  ...(vars.color !== undefined ? { color: vars.color } : {}),
                  ...(vars.archived !== undefined
                    ? { archived: vars.archived }
                    : {}),
                }
              : row,
          ),
        ),
      );
      return context;
    },
    onError: (error, _vars, context) => {
      rollback(context?.previous);
      report(error, translate("catalog")("errors.saveTag"), _vars.name);
    },
    onSettled: settle,
  });

  const remove = trpc.tags.remove.useMutation({
    onMutate: async (vars) => {
      const context = await begin();
      write((rows) => rows.filter((row) => row.id !== vars.id));
      return context;
    },
    onSuccess: (result: TagRemoveResult) => {
      // The server decides between the two — an archive announced as a delete
      // is a lie the user finds out about the next time they open the picker.
      // `result.message` is the server's English sentence for the same fact,
      // so the localised one is used in its place.
      const t = translate("catalog");
      if (result.deleted) {
        toast.success(t("tags.deleted"));
        return;
      }
      toast.warning(t("tags.archivedInstead"));
    },
    onError: (error, _vars, context) => {
      rollback(context?.previous);
      report(error, translate("catalog")("errors.deleteTag"));
    },
    onSettled: () => {
      settle();
      // A deleted tag is pulled off every entry that carried it.
      void utils.entries.invalidate();
    },
  });

  return {
    createTag: (vars) =>
      create.mutateAsync({ ...vars, originId: ORIGIN_ID }).catch(() => null),
    updateTag: (vars) =>
      update.mutateAsync({ ...vars, originId: ORIGIN_ID }).catch(() => null),
    setTagArchived: (id, archived) => {
      update.mutate({ id, archived, originId: ORIGIN_ID });
    },
    removeTag: (id) => {
      remove.mutate({ id, originId: ORIGIN_ID });
    },
    isSaving: create.isPending || update.isPending,
  };
}
