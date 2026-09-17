"use client";

import * as React from "react";
import {
  mergeQuickStarts,
  quickStartKey,
  type DetailedFavorite,
  type QuickStart,
  type QuickStartItem,
} from "@starter/core";

import { toast } from "@/components/ui/sonner";
import { translate } from "@/i18n/translate";
import { ORIGIN_ID } from "@/hooks/use-sync";
import { trpc } from "@/lib/trpc";
import { userErrorMessage } from "@/lib/error-message";

/** How many chips the tracker's quick-start row shows across both tiers. */
export const QUICK_START_LIMIT = 6;

/** How far back the recents query looks, and how many it may return. */
export const RECENT_INPUT = { limit: QUICK_START_LIMIT, days: 30 };

export type QuickStarts = {
  items: QuickStartItem[];
  favorites: DetailedFavorite[];
  /** True only before the first load — a reorder must not blank the row. */
  isLoading: boolean;
  /** Whether this exact combination is already pinned. */
  isPinned: (quick: QuickStart) => boolean;
  pin: (quick: QuickStart) => void;
  unpin: (id: string) => void;
  /** Swap a pin with its neighbour. `delta` is -1 for left, +1 for right. */
  move: (id: string, delta: number) => void;
};

/**
 * The tracker's quick-start row: pinned favorites, then recents to fill.
 *
 * Recents are derived server-side from the entry log, so they need no
 * invalidation of their own beyond the entry mutations that already run one —
 * starting a timer changes what "recent" means, and the tracker invalidates
 * `entries` on every start anyway. Favorites are invalidated here and by the
 * `favorites.changed` sync event, so another device's pin shows up without a
 * refresh.
 */
export const useQuickStarts = (): QuickStarts => {
  const utils = trpc.useUtils();
  const favorites = trpc.favorites.list.useQuery(undefined, {
    staleTime: 60_000,
  });
  const recents = trpc.entries.recent.useQuery(RECENT_INPUT, {
    staleTime: 30_000,
  });

  const invalidate = React.useCallback((): void => {
    void utils.favorites.invalidate();
  }, [utils]);

  const onError = React.useCallback(
    (error: unknown, fallback: string): void => {
      invalidate();
      toast.error(
        userErrorMessage(error, fallback)
      );
    },
    [invalidate]
  );

  const createMutation = trpc.favorites.create.useMutation({
    onSuccess: () => {
      toast.success(translate("tracker")("favorites.pinned"));
      invalidate();
    },
    onError: (error) => onError(error, translate("tracker")("favorites.pinFailed")),
  });

  const removeMutation = trpc.favorites.remove.useMutation({
    onMutate: async (input) => {
      await utils.favorites.list.cancel();
      const previous = utils.favorites.list.getData();
      utils.favorites.list.setData(undefined, (current) =>
        current?.filter((favorite) => favorite.id !== input.id)
      );
      return { previous };
    },
    onError: (error, _input, context) => {
      if (context?.previous) {
        utils.favorites.list.setData(undefined, context.previous);
      }
      onError(error, translate("tracker")("favorites.unpinFailed"));
    },
    onSettled: invalidate,
  });

  const reorderMutation = trpc.favorites.reorder.useMutation({
    onMutate: async (input) => {
      await utils.favorites.list.cancel();
      const previous = utils.favorites.list.getData();
      // Reorder the cache to the requested order so the chip moves under the
      // cursor rather than a round trip later. The server answers with the
      // whole list, which then replaces this.
      utils.favorites.list.setData(undefined, (current) => {
        if (current === undefined) return current;
        const byId = new Map(current.map((f) => [f.id, f]));
        const ordered = input.ids
          .map((id) => byId.get(id))
          .filter((f): f is DetailedFavorite => f !== undefined);
        const seen = new Set(ordered.map((f) => f.id));
        return [...ordered, ...current.filter((f) => !seen.has(f.id))];
      });
      return { previous };
    },
    onSuccess: (list) => {
      utils.favorites.list.setData(undefined, list);
    },
    onError: (error, _input, context) => {
      if (context?.previous) {
        utils.favorites.list.setData(undefined, context.previous);
      }
      onError(error, translate("tracker")("favorites.reorderFailed"));
    },
  });

  const favoriteList = React.useMemo(
    () => favorites.data ?? [],
    [favorites.data]
  );

  const items = React.useMemo(
    () =>
      mergeQuickStarts({
        favorites: favoriteList,
        recents: recents.data ?? [],
        limit: QUICK_START_LIMIT,
      }),
    [favoriteList, recents.data]
  );

  const pinnedKeys = React.useMemo(
    () => new Set(favoriteList.map((favorite) => quickStartKey(favorite))),
    [favoriteList]
  );

  const isPinned = React.useCallback(
    (quick: QuickStart): boolean => pinnedKeys.has(quickStartKey(quick)),
    [pinnedKeys]
  );

  const pin = React.useCallback(
    (quick: QuickStart): void => {
      createMutation.mutate({ ...quick, originId: ORIGIN_ID });
    },
    [createMutation]
  );

  const unpin = React.useCallback(
    (id: string): void => {
      removeMutation.mutate({ id, originId: ORIGIN_ID });
    },
    [removeMutation]
  );

  const move = React.useCallback(
    (id: string, delta: number): void => {
      const ids = favoriteList.map((favorite) => favorite.id);
      const from = ids.indexOf(id);
      const to = from + delta;
      // Silently ignored at the ends: the buttons are disabled there, and a
      // reorder that changes nothing is not worth a round trip.
      if (from === -1 || to < 0 || to >= ids.length) return;
      [ids[from], ids[to]] = [ids[to] as string, ids[from] as string];
      reorderMutation.mutate({ ids, originId: ORIGIN_ID });
    },
    [favoriteList, reorderMutation]
  );

  // `isPending` rather than `isLoading` on both, so a background refetch — or
  // a reorder — never collapses the list the user is aiming at.
  const isLoading = favorites.isPending || recents.isPending;

  // Memoised: the entry list threads this into every row, and a fresh object
  // each render would defeat the rows' `React.memo`.
  return React.useMemo(
    () => ({
      items,
      favorites: favoriteList,
      isLoading,
      isPinned,
      pin,
      unpin,
      move,
    }),
    [items, favoriteList, isLoading, isPinned, pin, unpin, move]
  );
};
