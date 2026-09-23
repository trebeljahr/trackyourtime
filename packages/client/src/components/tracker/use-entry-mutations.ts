"use client";

import * as React from "react";
import { useQueryClient, type Mutation } from "@tanstack/react-query";
import { buildQuickStartInput, deviceTimeZone } from "@starter/core";
import {
  entryAmount,
  resolveHourlyRate,
  toQuickStart,
  type DetailedEntry,
  type QuickStart,
  type RunawayResolution,
  type TimeEntry,
} from "@starter/shared";

import { toast } from "@/components/ui/sonner";
import { getActiveWorkspaceId } from "@/lib/active-workspace";
import { ORIGIN_ID, timerStore } from "@/hooks/use-sync";
import { formatDurationShortFor } from "@/i18n/format";
import { getActiveLocale } from "@/i18n/locale-store";
import { translate } from "@/i18n/translate";
import {
  buildOptimisticEntry,
  decorateEntry,
  projectFacts,
  stoppedEntryShape,
  type EntryShapeContext,
  type OptimisticEntryArgs,
} from "@/lib/entry-shape";
import { idleWatcher } from "@/lib/idle-watcher";
import { OFFLINE_QUEUED_MUTATION } from "@/lib/query-client";
import { trpc } from "@/lib/trpc";
import {
  cancelQueuedForTemp,
  createTempId,
  enqueueOffline,
  isDocumentUnloading,
  isNetworkError,
  isOnline,
  isTempId,
  type OfflineCreateInput,
  type OfflineIdInput,
  type OfflineStartInput,
  type OfflineStopInput,
  type OfflineUpdateInput,
} from "@/lib/offline";
import { entrySource } from "@/lib/shell";
import { userErrorMessage } from "@/lib/error-message";

/**
 * The entry list covers all of history and is paged with the server cursor, so
 * the window is a constant. A constant keeps the react-query key stable, which
 * is what lets every mutation write into exactly one cache.
 */
export const TRACKER_LIST_INPUT: {
  from: string;
  to: string;
  limit: number;
} = { from: "2000-01-01", to: "2999-12-31", limit: 50 };

type Utils = ReturnType<typeof trpc.useUtils>;
type ListSnapshot = ReturnType<Utils["entries"]["list"]["getInfiniteData"]>;

type MutationContext = {
  previousCurrent?: TimeEntry | null;
  previousList?: ListSnapshot;
  /** Set when this mutation invented an entry the server has not seen yet. */
  tempId?: string;
  /** Flipped in `onError` when the mutation was parked in the offline queue. */
  queued?: boolean;
  /**
   * The entry a stop is ending, resolved from the query cache *or* the timer
   * store. Distinct from `previousCurrent`, which is only ever the cache and
   * is `undefined` on a cold offline launch — see `stopMutation.onMutate`.
   */
  runningAtStop?: TimeEntry | null;
  /**
   * The workspace on screen when the user acted. A queued row is stamped with
   * it, and the cache is only written while it is still the active one — a
   * switch resets the cache for the new workspace, and an answer for the old
   * one arriving afterwards must not be patched into it.
   */
  workspaceId?: string | null;
};

/**
 * Marks the writes that refetch the entry list when they settle. React Query
 * holds it on the mutation from the moment `mutate` is called, before
 * `onMutate` has produced a context, which is what lets a settling write see a
 * start that is still busy inserting its temp row.
 */
const TRACKER_WRITE_META = { trackerWrite: true } as const;

/*
 * Starts and stops reach the server one at a time, in the order they were
 * asked for — across every mounted copy of this hook, since a scope lives in
 * the mutation cache.
 *
 * Both writes act on "whatever is running": a stop carries no id, and a start
 * ends the running entry before inserting. Both are optimistic, so Stop can be
 * pressed while the start is still in flight, and under latency the two
 * requests arrive in either order. A stop that lands first finds nothing
 * running, and the start then opens the timer the user just stopped; a start
 * that lands after a later stop does the same in reverse.
 *
 * A scope queues the *request* only. `onMutate` still runs the moment the user
 * acts, so the screen answers at once; a queued mutation is `pending` (and
 * paused) until the one ahead of it settles, which `refetchWhenQuiet` already
 * counts as in flight. Offline nothing changes: the write ahead fails fast,
 * parks itself in the queue, and the next one follows it there in order.
 */
const TIMER_SCOPE = { id: "tracker-timer" } as const;

/**
 * A tracker write still in flight that will refetch when it settles itself.
 * A write parked in the offline queue does not (its replay does), so it is
 * nothing to wait for.
 */
const isRefetchingWrite = (
  mutation: Mutation<unknown, Error, unknown, unknown>
): boolean =>
  mutation.options.meta?.trackerWrite === true &&
  (mutation.state.context as MutationContext | undefined)?.queued !== true;

/** False once the user has switched away from the workspace this write began in. */
const stillInWorkspace = (context: MutationContext | undefined): boolean =>
  context === undefined ||
  context.workspaceId === undefined ||
  context.workspaceId === getActiveWorkspaceId();

/**
 * The toast for a start that ended a timer in another workspace. One running
 * timer per person is the rule, so the stop is right — but it happened
 * somewhere the person is not looking, and a timer that silently disappears
 * from another workspace reads as lost time.
 */
export const announceReplacedTimer = (result: unknown): void => {
  if (typeof result !== "object" || result === null) return;
  const replaced = (result as { replaced?: unknown }).replaced;
  if (typeof replaced !== "object" || replaced === null) return;
  const name = (replaced as { workspaceName?: unknown }).workspaceName;
  if (typeof name !== "string" || name === "") return;
  toast.message(translate("tracker")("workspace.replaced", { name }));
};

// The offline payload types in `@starter/core` now carry `tagIds` themselves,
// so these are the plain payloads — the local intersection that widened them
// here is gone, and the extension replays tagged rows through the same
// contract rather than only this client understanding them.
type StartInput = OfflineStartInput;
type CreateInput = OfflineCreateInput;
type UpdateInput = OfflineUpdateInput;

const byStartDesc = (a: DetailedEntry, b: DetailedEntry): number => {
  const delta = Date.parse(b.start) - Date.parse(a.start);
  return delta !== 0 ? delta : b.id.localeCompare(a.id);
};

const durationBetween = (start: string, end: string): number =>
  Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000));

const nowIso = (): string => new Date().toISOString();

/**
 * Below this, a stopped entry is probably a misfire — a stray click on Start,
 * or continuing the wrong row — rather than real tracked time.
 *
 * It is never discarded automatically: silently deleting time someone tracked
 * is far worse than leaving a short row in the list. The offer is made once, in
 * the toast, and ignoring it keeps the entry.
 */
const SHORT_ENTRY_SEC = 60;

export type StartTimerArgs = {
  description: string;
  projectId: string | null;
  taskId?: string | null;
  billable: boolean;
  /** ISO instant to open the entry at. Defaults to now. */
  start?: string;
  /** Tags to stamp on the new entry. Omitted means untagged. */
  tagIds?: string[];
};

export type ManualEntryArgs = StartTimerArgs & {
  start: string;
  end: string;
};

export type UpdateEntryArgs = {
  id: string;
  description?: string;
  projectId?: string | null;
  taskId?: string | null;
  billable?: boolean;
  start?: string;
  end?: string | null;
  /** Replaces the whole set — omit to leave the entry's tags untouched. */
  tagIds?: string[];
};

/** One idle decision, applied as "close this, then maybe open that". */
export type SplitAtIdleArgs = {
  /** ISO instant to end the running entry at — where input stopped. */
  end: string;
  /** The entry to reopen afterwards, or null to leave the timer stopped. */
  resume: StartTimerArgs | null;
};

/** Answering the runaway prompt. See components/tracker/runaway-prompt.tsx. */
export type ResolveRunawayArgs = {
  id: string;
  resolution: RunawayResolution;
  /** ISO datetime, only for the `end-at` resolution. */
  end?: string;
};

export type EntryMutations = {
  startTimer: (args: StartTimerArgs) => void;
  /**
   * Start a favorite or a recent. Deliberately the same call as `startTimer`
   * underneath — a quick start is a start whose fields were chosen earlier.
   */
  startQuickStart: (quick: QuickStart) => void;
  /** `end` defaults to now; idle detection passes the instant input stopped. */
  stopTimer: (end?: string) => void;
  continueEntry: (entry: DetailedEntry) => void;
  createManualEntry: (args: ManualEntryArgs) => void;
  updateEntry: (args: UpdateEntryArgs) => void;
  duplicateEntry: (entry: DetailedEntry) => void;
  removeEntry: (entry: DetailedEntry) => void;
  /** Truncate the running entry, then optionally reopen it. See idle guard. */
  splitAtIdle: (args: SplitAtIdleArgs) => void;
  /**
   * Answer the runaway prompt. Not optimistic on purpose: the server owns the
   * boundary for every resolution but `end-at`, and guessing it here would
   * mean the client and the server disagree about how much time was put back.
   */
  resolveRunaway: (args: ResolveRunawayArgs) => void;
  isBusy: boolean;
};

/**
 * Every write the tracker performs, wrapped in the same three guarantees:
 *
 *  1. optimistic — cancel, snapshot, `setData`, roll back on a server error;
 *  2. offline-tolerant — a mutation that never reached the server keeps its
 *     optimistic result and is queued for replay instead of rolling back;
 *  3. echo-safe — every input carries `originId` so this tab ignores the sync
 *     broadcast its own mutation caused.
 */
export const useEntryMutations = (): EntryMutations => {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();

  // `removeEntry` is declared below the mutations that need to call it, so the
  // toast action reaches it through a ref rather than reordering the file.
  const removeEntryRef = React.useRef<((entry: DetailedEntry) => void) | null>(
    null
  );

  // ── cache helpers ──────────────────────────────────────────────────

  const patchList = React.useCallback(
    (fn: (entries: DetailedEntry[]) => DetailedEntry[]): void => {
      utils.entries.list.setInfiniteData(TRACKER_LIST_INPUT, (data) =>
        data === undefined
          ? data
          : {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                entries: fn(page.entries),
              })),
            }
      );
    },
    [utils]
  );

  const insertEntry = React.useCallback(
    (entry: DetailedEntry): void => {
      utils.entries.list.setInfiniteData(TRACKER_LIST_INPUT, (data) => {
        if (data === undefined) return data;
        const [first, ...rest] = data.pages;
        if (first === undefined) return data;
        return {
          ...data,
          pages: [
            { ...first, entries: [entry, ...first.entries].sort(byStartDesc) },
            ...rest,
          ],
        };
      });
    },
    [utils]
  );

  const replaceEntry = React.useCallback(
    (id: string, next: DetailedEntry): void => {
      patchList((entries) =>
        entries.map((entry) => (entry.id === id ? next : entry))
      );
    },
    [patchList]
  );

  const dropEntry = React.useCallback(
    (id: string): void => {
      patchList((entries) => entries.filter((entry) => entry.id !== id));
    },
    [patchList]
  );

  const snapshot = React.useCallback(async (): Promise<MutationContext> => {
    // Read before the awaits below: this is the workspace the user acted in.
    const workspaceId = getActiveWorkspaceId();
    await utils.entries.current.cancel();
    await utils.entries.list.cancel();
    return {
      workspaceId,
      previousCurrent: utils.entries.current.getData(),
      previousList: utils.entries.list.getInfiniteData(TRACKER_LIST_INPUT),
    };
  }, [utils]);

  const rollback = React.useCallback(
    (context: MutationContext | undefined): void => {
      if (context === undefined) return;
      // The snapshot is of the workspace the write began in; restoring it
      // into another one would put that workspace's entries on screen.
      if (!stillInWorkspace(context)) return;
      if (context.previousCurrent !== undefined) {
        utils.entries.current.setData(undefined, context.previousCurrent);
      }
      if (context.previousList !== undefined) {
        utils.entries.list.setInfiniteData(
          TRACKER_LIST_INPUT,
          context.previousList
        );
      }
    },
    [utils]
  );

  const invalidate = React.useCallback(async (): Promise<void> => {
    await utils.entries.invalidate();
    await utils.reports.invalidate();
  }, [utils]);

  /*
   * Refetch after a write — but only once no other tracker write is in flight.
   *
   * A stop is optimistic, so Start can be clicked before the stop has an
   * answer. If the stop's refetch then goes out, it can reach the server
   * before the start is committed, and its answer replaces the cache: the
   * start's temp row is gone, `replaceEntry` in the start's `onSuccess` finds
   * nothing to replace, and the list shows no running timer until the start's
   * own refetch lands — seconds, on a loaded machine. Any write racing any
   * other write takes the same path.
   *
   * So the last write to settle is the one that refetches; everything before
   * it has already patched its answer into the cache. The check runs on a
   * macrotask because React Query marks this mutation settled only after
   * `onSettled` returns — checking inside it would count the write itself, and
   * two writes settling together would each wait for the other and neither
   * would refetch.
   */
  const refetchWhenQuiet = React.useCallback((): void => {
    setTimeout(() => {
      const busy = queryClient
        .getMutationCache()
        .findAll({ status: "pending", predicate: isRefetchingWrite });
      if (busy.length > 0) return;
      void invalidate();
    }, 0);
  }, [invalidate, queryClient]);

  // ── optimistic entry construction ──────────────────────────────────
  //
  // The shapes themselves live in `lib/entry-shape.ts` so the timesheet grid
  // writes exactly the same optimistic entry — in particular the same rate
  // snapshot — as the tracker does.

  const shapeContext = React.useCallback(
    (): EntryShapeContext => ({
      projects: utils.projects.list.getData({}) ?? [],
      settings: utils.settings.get.getData() ?? null,
    }),
    [utils]
  );

  /** Decorate a server entry with the catalog labels the list renders. */
  const toDetailed = React.useCallback(
    (entry: TimeEntry): DetailedEntry => decorateEntry(shapeContext(), entry),
    [shapeContext]
  );

  const buildEntry = React.useCallback(
    (args: OptimisticEntryArgs): DetailedEntry =>
      buildOptimisticEntry(shapeContext(), args),
    [shapeContext]
  );

  /** The stopped shape the server would write for a running entry. */
  const stopShape = React.useCallback(
    (running: TimeEntry, end: string): DetailedEntry =>
      stoppedEntryShape(shapeContext(), running, end),
    [shapeContext]
  );

  /**
   * Shared error path. A transport failure keeps the optimistic result and
   * parks the mutation for replay; anything the server actually answered
   * rolls the cache back and surfaces the message.
   */
  const handleError = React.useCallback(
    async (
      error: unknown,
      context: MutationContext | undefined,
      enqueue: (tempId: string | undefined, workspaceId: string | null) => Promise<void>,
      fallbackMessage: string
    ): Promise<void> => {
      if (isNetworkError(error)) {
        /*
         * The document is being torn down *and the device was online*, so this
         * "failure" is an aborted request whose bytes the server almost
         * certainly already has. See `isDocumentUnloading` — queueing it would
         * duplicate the entry rather than recover it, and the reload about to
         * happen asks the server what is really there.
         *
         * `isOnline()` is half of the condition, not decoration. Offline,
         * `isNetworkError()` returns true unconditionally, so an airplane-mode
         * start or stop that happens to coincide with a reload or a tab close
         * used to hit this guard and be dropped on the floor — silently, in
         * the exact case the queue exists for. There are no bytes for the
         * server to have received when there is no radio, so nothing can be
         * duplicated by queueing it.
         */
        if (isDocumentUnloading() && isOnline()) return;
        if (context) context.queued = true;
        await enqueue(context?.tempId, context?.workspaceId ?? null);
        return;
      }
      rollback(context);
      const message =
        userErrorMessage(error, fallbackMessage);
      toast.error(message);
    },
    [rollback]
  );

  // ── mutations ──────────────────────────────────────────────────────

  /**
   * True while a start or stop the user asked for after this one is waiting
   * for it. `self` is counted: a mutation stays `pending` until its own
   * callbacks have returned.
   */
  const timerWriteQueuedBehind = React.useCallback(
    (): boolean =>
      queryClient.getMutationCache().findAll({
        status: "pending",
        predicate: (mutation) => mutation.options.scope?.id === TIMER_SCOPE.id,
      }).length > 1,
    [queryClient]
  );

  const retargetQueuedStops = React.useCallback(
    (tempId: string, entry: TimeEntry): void => {
      for (const mutation of queryClient.getMutationCache().findAll({
        status: "pending",
        predicate: (m) => m.options.scope?.id === TIMER_SCOPE.id,
      })) {
        const context = mutation.state.context as MutationContext | undefined;
        if (context?.runningAtStop?.id !== tempId) continue;
        context.runningAtStop = entry;
        context.tempId = undefined;
      }
    },
    [queryClient]
  );

  const startMutation = trpc.entries.start.useMutation({
    ...OFFLINE_QUEUED_MUTATION,
    meta: TRACKER_WRITE_META,
    scope: TIMER_SCOPE,
    onMutate: async (raw): Promise<MutationContext> => {
      const input = raw as StartInput;
      const context = await snapshot();
      context.tempId = createTempId();

      const running = context.previousCurrent ?? null;
      if (running) replaceEntry(running.id, stopShape(running, input.start));

      const optimistic = buildEntry({
        id: context.tempId,
        description: input.description,
        projectId: input.projectId,
        taskId: input.taskId,
        billable: input.billable,
        start: input.start,
        end: null,
        tagIds: input.tagIds ?? [],
      });
      utils.entries.current.setData(undefined, optimistic);
      insertEntry(optimistic);
      // This tab opened the entry, so it is the one allowed to act on its own
      // idle signal for it. Claimed against the temp id first: a timer started
      // offline still belongs to this device before the server names it.
      idleWatcher.noteLocalStart(context.tempId, Date.parse(input.start));
      return context;
    },
    onSuccess: (entry, _raw, context) => {
      announceReplacedTimer(entry);
      if (!stillInWorkspace(context)) return;
      const tempId = context?.tempId;
      if (timerWriteQueuedBehind()) {
        /*
         * A stop or another start was pressed while this one was in flight.
         * Its `onMutate` has already ended the temp row on screen and moved
         * `current` on, and its request goes out as soon as this callback
         * returns. Adopting the server's running entry here would put the
         * stopped timer back on screen until that request answers — so the row
         * only learns its real id, and keeps the end it was given.
         */
        const row =
          tempId === undefined
            ? undefined
            : utils.entries.list
                .getInfiniteData(TRACKER_LIST_INPUT)
                ?.pages.flatMap((page) => page.entries)
                .find((candidate) => candidate.id === tempId);
        if (tempId !== undefined && row !== undefined) {
          replaceEntry(
            tempId,
            row.end === null ? toDetailed(entry) : stopShape(entry, row.end)
          );
        }
        // The stop waiting behind resolved its target to the temp id. Name the
        // real entry instead, so that if it fails offline it is queued with an
        // `id` rather than as "stop whatever is running" with a temp id no
        // queued start will ever resolve.
        if (tempId !== undefined) retargetQueuedStops(tempId, entry);
      } else {
        if (tempId) replaceEntry(tempId, toDetailed(entry));
        utils.entries.current.setData(undefined, entry);
      }
      // A rename of the claim, never a fresh one: the detector can fire while
      // the start is still in flight, and re-claiming here would discard what
      // it decided — which is how a pause-and-resume lost the resume it was
      // holding the moment the server answered.
      if (context?.tempId) idleWatcher.noteServerId(context.tempId, entry.id);
    },
    onError: (error, raw, context) =>
      handleError(
        error,
        context,
        (tempId, workspaceId) =>
          enqueueOffline(
            "entries.start",
            raw as OfflineStartInput,
            tempId,
            workspaceId
          ),
        translate("tracker")("mutations.startFailed")
      ),
    onSettled: (_data, _error, _raw, context) => {
      if (context?.queued) return;
      refetchWhenQuiet();
    },
  });

  const stopMutation = trpc.entries.stop.useMutation({
    ...OFFLINE_QUEUED_MUTATION,
    meta: TRACKER_WRITE_META,
    scope: TIMER_SCOPE,
    onMutate: async (raw): Promise<MutationContext> => {
      const input = raw as OfflineStopInput;
      const context = await snapshot();
      /*
       * What is running — from the query cache when it has an answer, and from
       * the timer store when it does not.
       *
       * The fallback is the whole point on a phone. Cold-launch offline and
       * `trpc.entries.current` never resolves, so `previousCurrent` is
       * `undefined` while the timer on screen is perfectly real: the mirror
       * seeded it into the store before the query ever fired
       * (`lib/running-mirror.ts`). Reading only the cache meant the stop the
       * user then pressed was queued with neither an `id` nor a `tempId` —
       * degrading on replay to "stop whatever is running", which days later is
       * a different entry, possibly on another device. The store knows which
       * entry it is; use it.
       *
       * `!== undefined` rather than `??`: an answered `null` means the server
       * says nothing is running, and that answer beats the store (which
       * `useRunningEntry` has already cleared to match). Only a query that has
       * not spoken at all falls through.
       */
      const running =
        context.previousCurrent !== undefined
          ? context.previousCurrent
          : timerStore.getState().running;
      context.runningAtStop = running;
      if (running) {
        replaceEntry(running.id, stopShape(running, input.end));
        // A timer started offline still carries its temp id; keep the link so
        // a later delete can cancel the whole queued pair — and so the replay
        // can name the entry once the start ahead of it in the queue lands.
        if (isTempId(running.id)) context.tempId = running.id;
      }
      utils.entries.current.setData(undefined, null);
      return context;
    },
    onSuccess: (entry, _raw, context) => {
      if (!stillInWorkspace(context)) return;
      if (context?.tempId) dropEntry(context.tempId);
      const detailed = toDetailed(entry);
      replaceEntry(entry.id, detailed);
      utils.entries.current.setData(undefined, null);

      // Includes a zero-second entry: an immediate start-then-stop is the
      // most obvious misfire there is, and used to get no offer at all.
      if (entry.durationSec < SHORT_ENTRY_SEC) {
        const t = translate("tracker");
        toast.message(
          t("mutations.stoppedAfter", {
            duration: formatDurationShortFor(
              entry.durationSec,
              getActiveLocale()
            ),
          }),
          {
            description: t("mutations.shortEntryKept"),
            action: {
              label: translate("common")("actions.discard"),
              onClick: () => removeEntryRef.current?.(detailed),
            },
          }
        );
      }
    },
    onError: (error, raw, context) =>
      handleError(
        error,
        context,
        (tempId, workspaceId) => {
          /*
           * Name the entry whenever we can.
           *
           * The `id` is omitted only for a timer that was itself started
           * offline: the id it carries right now is a temp one the server has
           * never seen, and the replayed start is what mints the real one —
           * `hooks/replay-offline-mutation.ts` threads that id in here at
           * replay time, keyed on the `tempId` carried alongside.
           *
           * For every other timer the real id is already known, and using it
           * matters now that the queue survives an OS kill: an id-less stop
           * means "end whatever is running", which days later is a different
           * entry, possibly on a different device.
           */
          const runningId = context?.runningAtStop?.id ?? null;
          const targeted = runningId !== null && !isTempId(runningId);
          return enqueueOffline(
            "entries.stop",
            {
              ...(targeted ? { id: runningId } : {}),
              end: (raw as OfflineStopInput).end,
              originId: ORIGIN_ID,
            },
            tempId,
            workspaceId
          );
        },
        translate("tracker")("mutations.stopFailed")
      ),
    onSettled: (_data, _error, _raw, context) => {
      if (context?.queued) return;
      refetchWhenQuiet();
    },
  });

  const createMutation = trpc.entries.create.useMutation({
    ...OFFLINE_QUEUED_MUTATION,
    meta: TRACKER_WRITE_META,
    onMutate: async (raw): Promise<MutationContext> => {
      const input = raw as CreateInput;
      const context = await snapshot();
      context.tempId = createTempId();
      insertEntry(
        buildEntry({
          id: context.tempId,
          description: input.description,
          projectId: input.projectId,
          taskId: input.taskId,
          billable: input.billable,
          start: input.start,
          end: input.end,
          tagIds: input.tagIds ?? [],
        })
      );
      return context;
    },
    onSuccess: (entry, _raw, context) => {
      if (!stillInWorkspace(context)) return;
      if (context?.tempId) replaceEntry(context.tempId, toDetailed(entry));
    },
    onError: (error, raw, context) =>
      handleError(
        error,
        context,
        (tempId, workspaceId) =>
          enqueueOffline(
            "entries.create",
            raw as OfflineCreateInput,
            tempId,
            workspaceId
          ),
        translate("tracker")("mutations.addFailed")
      ),
    onSettled: (_data, _error, _raw, context) => {
      if (context?.queued) return;
      refetchWhenQuiet();
    },
  });

  const updateMutation = trpc.entries.update.useMutation({
    ...OFFLINE_QUEUED_MUTATION,
    meta: TRACKER_WRITE_META,
    onMutate: async (raw): Promise<MutationContext> => {
      const input = raw as UpdateInput;
      const context = await snapshot();
      const settings = utils.settings.get.getData();

      patchList((entries) =>
        entries.map((entry) => {
          if (entry.id !== input.id) return entry;

          const projectId =
            input.projectId === undefined
              ? entry.projectId
              : input.projectId ?? null;
          const billable = input.billable ?? entry.billable;
          const start = input.start ?? entry.start;
          const end = input.end === undefined ? entry.end : input.end;
          const project = projectFacts(shapeContext(), projectId);
          const hourlyRate = resolveHourlyRate({
            billable,
            projectRate: project.projectRate,
            defaultRate: settings?.defaultHourlyRate ?? null,
          });
          const durationSec = end === null ? 0 : durationBetween(start, end);

          return {
            ...entry,
            description: input.description ?? entry.description,
            projectId,
            taskId:
              input.taskId === undefined ? entry.taskId : input.taskId ?? null,
            billable,
            start,
            end,
            // Omitted leaves the entry's tags alone; a supplied list replaces
            // the whole set, which is what the server does with it too.
            tagIds: input.tagIds ?? entry.tagIds,
            durationSec,
            hourlyRate,
            updatedAt: nowIso(),
            projectName: project.projectName,
            projectColor: project.projectColor,
            clientName: project.clientName,
            amount: entryAmount(durationSec, hourlyRate),
          };
        })
      );

      const running = context.previousCurrent ?? null;
      if (running && running.id === input.id) {
        if (input.end !== undefined && input.end !== null) {
          utils.entries.current.setData(undefined, null);
        } else {
          utils.entries.current.setData(undefined, {
            ...running,
            description: input.description ?? running.description,
            projectId:
              input.projectId === undefined
                ? running.projectId
                : input.projectId ?? null,
            taskId:
              input.taskId === undefined
                ? running.taskId
                : input.taskId ?? null,
            billable: input.billable ?? running.billable,
            start: input.start ?? running.start,
            // The tracker bar seeds its tag picker from the running entry, so
            // leaving this stale would bounce a just-added tag back off.
            tagIds: input.tagIds ?? running.tagIds,
          });
        }
      }

      return context;
    },
    onSuccess: (entry, _raw, context) => {
      if (!stillInWorkspace(context)) return;
      replaceEntry(entry.id, toDetailed(entry));
      if (entry.end === null) utils.entries.current.setData(undefined, entry);
    },
    onError: (error, raw, context) =>
      handleError(
        error,
        context,
        (_tempId, workspaceId) =>
          enqueueOffline(
            "entries.update",
            raw as OfflineUpdateInput,
            undefined,
            workspaceId
          ),
        translate("tracker")("mutations.saveFailed")
      ),
    onSettled: (_data, _error, _raw, context) => {
      if (context?.queued) return;
      refetchWhenQuiet();
    },
  });

  const removeMutation = trpc.entries.remove.useMutation({
    ...OFFLINE_QUEUED_MUTATION,
    meta: TRACKER_WRITE_META,
    onMutate: async (raw): Promise<MutationContext> => {
      const input = raw as OfflineIdInput;
      const context = await snapshot();
      dropEntry(input.id);
      if (context.previousCurrent?.id === input.id) {
        utils.entries.current.setData(undefined, null);
      }
      return context;
    },
    onError: (error, raw, context) =>
      handleError(
        error,
        context,
        (_tempId, workspaceId) =>
          enqueueOffline(
            "entries.remove",
            raw as OfflineIdInput,
            undefined,
            workspaceId
          ),
        translate("tracker")("mutations.deleteFailed")
      ),
    onSettled: (_data, _error, _raw, context) => {
      if (context?.queued) return;
      refetchWhenQuiet();
    },
  });

  // ── public API ─────────────────────────────────────────────────────

  /**
   * One builder for every start this app makes, shared with the extension and
   * Raycast through core — so a favorite, a continued entry and the Start
   * button produce byte-identical inputs, live or queued.
   *
   * `now` exists for the idle resume, which reopens the work at the instant
   * input came back rather than whenever the mutation happens to fire.
   */
  const startWith = React.useCallback(
    (quick: QuickStart, now?: Date, tagIds?: string[]): void => {
      const input: OfflineStartInput = buildQuickStartInput(quick, {
        source: entrySource(),
        timeZone: deviceTimeZone(),
        originId: ORIGIN_ID,
        now,
      });
      // Tags ride alongside the QuickStart rather than inside it:
      // `quickStartKey` dedupes favorites and recents on that shape, so
      // folding tags in would split one recurring combination into a separate
      // recent per set of labels.
      const withTags: StartInput = { ...input, tagIds: tagIds ?? [] };
      startMutation.mutate(withTags);
    },
    [startMutation]
  );

  const startQuickStart = React.useCallback(
    (quick: QuickStart): void => {
      startWith(quick);
    },
    [startWith]
  );

  const startTimer = React.useCallback(
    (args: StartTimerArgs): void => {
      startWith(
        {
          description: args.description,
          projectId: args.projectId,
          taskId: args.taskId ?? null,
          billable: args.billable,
        },
        args.start === undefined ? undefined : new Date(args.start),
        args.tagIds
      );
    },
    [startWith]
  );

  const stopTimer = React.useCallback(
    (end?: string): void => {
      // No `id`, even when idle detection knows one: the server stops whatever
      // is running, which is what a replayed offline stop has to do too, and
      // an entry started offline has no server id to name yet. That is only
      // safe because `TIMER_SCOPE` holds this request until any start ahead of
      // it has answered.
      const input: OfflineStopInput = { end: end ?? nowIso(), originId: ORIGIN_ID };
      // Deliberately not inside `stopMutation.onMutate`: `splitAtIdle` stops
      // through the same mutation while the watcher is holding a resume, and
      // releasing there would drop it. A stop the user asked for is the only
      // one that should clear the watcher.
      idleWatcher.noteLocalStop(Date.now());
      stopMutation.mutate(input);
    },
    [stopMutation]
  );

  /**
   * The pause half of pause-and-resume.
   *
   * The two writes are sequenced rather than fired together, and that is
   * load-bearing: `entries.start` stops whatever is running *at the new
   * entry's start* before inserting, so a start racing an in-flight stop would
   * re-close the entry at "now" and put the idle minutes straight back on it.
   * Awaiting the stop means the resume opens against nothing.
   */
  const splitAtIdle = React.useCallback(
    ({ end, resume }: SplitAtIdleArgs): void => {
      const stopInput: OfflineStopInput = { end, originId: ORIGIN_ID };
      const openResumed = (): void => {
        if (resume !== null) startTimer(resume);
      };

      void stopMutation.mutateAsync(stopInput).then(openResumed, (error) => {
        // A transport failure was already parked in the offline queue by the
        // shared error path, and its optimistic result stands — so the resume
        // still belongs after it, and will replay in that order. A refusal
        // from the server is different: the stop did not happen, and opening a
        // second entry on top of a still-running one would only make it worse.
        if (isNetworkError(error)) openResumed();
      });
    },
    [startTimer, stopMutation]
  );

  const continueEntry = React.useCallback(
    (entry: DetailedEntry): void => {
      // Continuing the entry that is already running would stop it and start an
      // identical copy, shredding one stretch of work into fragments. The row
      // renders Stop instead of Continue for exactly this reason; this guard
      // covers every other caller.
      if (entry.end === null) return;

      // Deliberately `start`, not `continue`: every field is already in hand,
      // so this works offline where a server-side copy could not.
      // Continuing carries the labels over — the server's own `continue`
      // copies them, and a client-side copy that dropped them would disagree
      // with it.
      startTimer({ ...toQuickStart(entry), tagIds: entry.tagIds });
    },
    [startTimer]
  );

  const createManualEntry = React.useCallback(
    (args: ManualEntryArgs): void => {
      const input: CreateInput = {
        description: args.description,
        projectId: args.projectId,
        taskId: args.taskId ?? null,
        billable: args.billable,
        start: args.start,
        end: args.end,
        source: entrySource(),
        timeZone: deviceTimeZone(),
        tagIds: args.tagIds ?? [],
        originId: ORIGIN_ID,
      };
      createMutation.mutate(input);
    },
    [createMutation]
  );

  const updateEntry = React.useCallback(
    (args: UpdateEntryArgs): void => {
      if (isTempId(args.id)) {
        // The server has never seen this entry, so an edit would be lost the
        // moment the queued create replays. Rows disable their editors while
        // this is true; this guard is the backstop.
        toast.info(translate("tracker")("mutations.stillSyncing"));
        return;
      }
      const input: UpdateInput = { ...args, originId: ORIGIN_ID };
      updateMutation.mutate(input);
    },
    [updateMutation]
  );

  const duplicateEntry = React.useCallback(
    (entry: DetailedEntry): void => {
      createManualEntry({
        description: entry.description,
        projectId: entry.projectId,
        taskId: entry.taskId,
        billable: entry.billable,
        start: entry.start,
        end: entry.end ?? nowIso(),
        tagIds: entry.tagIds,
      });
    },
    [createManualEntry]
  );

  const removeEntry = React.useCallback(
    (entry: DetailedEntry): void => {
      if (isTempId(entry.id)) {
        // Never reached the server — drop it locally and cancel its replay.
        dropEntry(entry.id);
        if (utils.entries.current.getData()?.id === entry.id) {
          utils.entries.current.setData(undefined, null);
        }
        void cancelQueuedForTemp(entry.id);
        return;
      }
      removeMutation.mutate({ id: entry.id, originId: ORIGIN_ID });
    },
    [dropEntry, removeMutation, utils]
  );

  /*
   * The one mutation here that does NOT carry `OFFLINE_QUEUED_MUTATION`, and
   * the omission is the point: resolving a runaway timer queues nothing (see
   * `onError` — it toasts), so React Query's default pause-and-resume is
   * exactly right for it. Offline it waits and replays on reconnect instead of
   * failing at the user.
   */
  const resolveRunawayMutation = trpc.entries.resolveRunaway.useMutation({
    meta: TRACKER_WRITE_META,
    onSuccess: (entry) => {
      replaceEntry(entry.id, toDetailed(entry));
      utils.entries.current.setData(undefined, entry.end === null ? entry : null);
    },
    onError: (error) => {
      toast.error(
        userErrorMessage(error, translate("tracker")("mutations.updateFailed"))
      );
    },
    onSettled: () => {
      refetchWhenQuiet();
    },
  });

  const resolveRunaway = React.useCallback(
    (args: ResolveRunawayArgs): void => {
      resolveRunawayMutation.mutate({ ...args, originId: ORIGIN_ID });
    },
    [resolveRunawayMutation]
  );

  // Written from an effect, never during render. The only reader is a row's
  // own click handler, which cannot fire before this commit has painted.
  React.useEffect(() => {
    removeEntryRef.current = removeEntry;
  }, [removeEntry]);

  const isBusy =
    startMutation.isPending ||
    stopMutation.isPending ||
    createMutation.isPending ||
    updateMutation.isPending ||
    removeMutation.isPending ||
    resolveRunawayMutation.isPending;

  // Memoised because the entry list threads this object into every row, and a
  // fresh object each render would defeat the rows' `React.memo` — a running
  // timer re-renders this hook once a second, which would otherwise re-render
  // the whole history with it.
  return React.useMemo(
    () => ({
      startTimer,
      startQuickStart,
      stopTimer,
      continueEntry,
      createManualEntry,
      updateEntry,
      duplicateEntry,
      removeEntry,
      splitAtIdle,
      resolveRunaway,
      isBusy,
    }),
    [
      startTimer,
      startQuickStart,
      stopTimer,
      continueEntry,
      createManualEntry,
      updateEntry,
      duplicateEntry,
      removeEntry,
      splitAtIdle,
      resolveRunaway,
      isBusy,
    ]
  );
};
