"use client";

import * as React from "react";
import { deviceTimeZone } from "@starter/core";
import {
  timesheetRefusalMessage,
  type DetailedEntry,
  type EntryListInput,
  type TimesheetCellPlan,
} from "@starter/shared";

import { toast } from "@/components/ui/sonner";
import { ORIGIN_ID } from "@/hooks/use-sync";
import { getActiveWorkspaceId } from "@/lib/active-workspace";
import {
  buildOptimisticEntry,
  decorateEntry,
  type EntryShapeContext,
} from "@/lib/entry-shape";
import {
  cancelQueuedForTemp,
  createTempId,
  enqueueOffline,
  isNetworkError,
  isTempId,
  type OfflineCreateInput,
  type OfflineIdInput,
  type OfflineUpdateInput,
} from "@/lib/offline";
import { OFFLINE_QUEUED_MUTATION } from "@/lib/query-client";
import { trpc } from "@/lib/trpc";
import { entrySource } from "@/lib/entry-source";

/** What a plan needs to know beyond the numbers: which row it belongs to. */
export type CellEditContext = {
  projectId: string | null;
  taskId: string | null;
  /** Falls back to the project's `billableDefault` when omitted. */
  billable?: boolean;
};

export type TimesheetMutations = {
  /** Execute a plan from `planCellEdit`. Refusals surface as a toast. */
  applyPlan: (plan: TimesheetCellPlan, context: CellEditContext) => void;
  isBusy: boolean;
};

type ListSnapshot = { entries: DetailedEntry[]; nextCursor?: string } | undefined;

/**
 * The writes a timesheet cell performs.
 *
 * Three things this shares with the tracker rather than reinventing:
 *
 *  - the SERVER path. A cell creates entries through `entries.create`, so the
 *    hourly-rate and currency snapshot happens in exactly one place and grid
 *    entries carry the same history-proof rate as timed ones.
 *  - the OFFLINE contract. Failures that never reached the server keep their
 *    optimistic result and park on the same queue the tracker and the browser
 *    extension replay, under the same op names.
 *  - the ECHO guard. Every input carries `originId`, so the sync broadcast this
 *    tab caused is ignored instead of refetching over an update already made.
 *
 * What is local is the cache it patches: the timesheet reads one week of
 * entries under its own query key, so its optimistic writes go there.
 */
export const useTimesheetMutations = (
  listInput: EntryListInput
): TimesheetMutations => {
  const utils = trpc.useUtils();

  const shapeContext = React.useCallback(
    (): EntryShapeContext => ({
      projects: utils.projects.list.getData({}) ?? [],
      tasks: utils.tasks.list.getData({}) ?? [],
      settings: utils.settings.get.getData() ?? null,
    }),
    [utils]
  );

  const billableFor = React.useCallback(
    (projectId: string | null, explicit: boolean | undefined): boolean => {
      if (explicit !== undefined) return explicit;
      const project = utils.projects.list
        .getData({})
        ?.find((candidate) => candidate.id === projectId);
      return project?.billableDefault ?? false;
    },
    [utils]
  );

  const patchList = React.useCallback(
    (fn: (entries: DetailedEntry[]) => DetailedEntry[]): void => {
      utils.entries.list.setData(listInput, (data) =>
        data === undefined ? data : { ...data, entries: fn(data.entries) }
      );
    },
    [listInput, utils]
  );

  const snapshot = React.useCallback(async (): Promise<ListSnapshot> => {
    await utils.entries.list.cancel(listInput);
    return utils.entries.list.getData(listInput);
  }, [listInput, utils]);

  const restore = React.useCallback(
    (previous: ListSnapshot): void => {
      utils.entries.list.setData(listInput, previous);
    },
    [listInput, utils]
  );

  const invalidate = React.useCallback((): void => {
    void utils.entries.invalidate();
    void utils.reports.invalidate();
  }, [utils]);

  const [pending, setPending] = React.useState(0);

  /**
   * Creates whose temp id the server has not answered for yet, mapped to the
   * real id it eventually gives them — or to null when the create never
   * landed and is parked on the offline queue instead.
   *
   * A cell is re-edited seconds after being filled in more often than not:
   * type "2", Enter, realise it was three and a half, type again. That second
   * edit resolves against the OPTIMISTIC entry, whose id only this tab has
   * ever seen, so without somewhere to wait it was refused outright and the
   * grid silently kept the first number. Holding the edit until the create
   * names the entry costs a few milliseconds and makes the two writes land in
   * the order they were made.
   *
   * Successful entries stay in the map rather than being deleted the instant
   * they settle: a keystroke handler can be holding the render from just
   * before the swap, and a temp id that has already been answered for must
   * still resolve. A create that failed or queued is dropped, so the next
   * edit is refused exactly as it was.
   */
  const createdIds = React.useRef(new Map<string, Promise<string | null>>());

  /**
   * Run `apply` against an id the server knows, waiting on an in-flight
   * create when the cell still carries a temp one.
   */
  const withServerId = React.useCallback(
    (id: string, apply: (serverId: string) => void): void => {
      if (!isTempId(id)) {
        apply(id);
        return;
      }
      const inFlight = createdIds.current.get(id);
      if (inFlight === undefined) {
        // Queued offline, or already failed: an update would be lost the
        // moment the create replays under a real id.
        toast.info("Still syncing — try again in a moment.");
        return;
      }
      void inFlight.then((serverId) => {
        if (serverId === null) {
          toast.info("Still syncing — try again in a moment.");
          return;
        }
        apply(serverId);
      });
    },
    []
  );

  /**
   * One write, optimistically applied.
   *
   * `queue` is what makes the edit survive a dead network: it is only reached
   * when the request never got an answer, and it leaves the optimistic cache
   * exactly as it is.
   */
  const run = React.useCallback(
    async (args: {
      optimistic: (entries: DetailedEntry[]) => DetailedEntry[];
      /** `stillHere` is false once the user has switched workspace. */
      perform: (stillHere: () => boolean) => Promise<void>;
      /** Stamps the queued row with the workspace the edit was made in. */
      queue: (workspaceId: string | null) => Promise<void>;
      failure: string;
    }): Promise<void> => {
      /*
       * The workspace the edit was made in, read before anything awaits.
       *
       * The list's query key does not carry the workspace (the tRPC link adds
       * it below React Query), and a switch resets that key for the new one.
       * So once the user has switched, this edit's snapshot and its answer are
       * the OLD workspace's data: restoring the snapshot would paint A's week
       * into B's grid, and nothing would refetch it away. The queued row is
       * stamped with it too, not with wherever the device points when the
       * network error finally arrives.
       */
      const workspaceId = getActiveWorkspaceId();
      const stillHere = (): boolean => getActiveWorkspaceId() === workspaceId;
      const previous = await snapshot();
      if (stillHere()) patchList(args.optimistic);
      setPending((count) => count + 1);

      try {
        await args.perform(stillHere);
        invalidate();
      } catch (error) {
        if (isNetworkError(error)) {
          await args.queue(workspaceId);
          return;
        }
        if (stillHere()) restore(previous);
        toast.error(
          error instanceof Error && error.message !== ""
            ? error.message
            : args.failure
        );
      } finally {
        setPending((count) => Math.max(0, count - 1));
      }
    },
    [invalidate, patchList, restore, snapshot]
  );

  // `networkMode: "always"` on each: `run()` above only reaches `queue()`
  // because the call rejected. React Query's default would pause the mutation
  // while offline instead, and a paused promise never rejects — the grid edit
  // would sit there un-queued for the rest of the launch.
  const createEntry = trpc.entries.create.useMutation(OFFLINE_QUEUED_MUTATION);
  const updateEntry = trpc.entries.update.useMutation(OFFLINE_QUEUED_MUTATION);
  const removeEntry = trpc.entries.remove.useMutation(OFFLINE_QUEUED_MUTATION);

  const create = React.useCallback(
    (start: string, end: string, context: CellEditContext): void => {
      const billable = billableFor(context.projectId, context.billable);
      const tempId = createTempId();
      const input: OfflineCreateInput = {
        description: "",
        projectId: context.projectId,
        taskId: context.taskId,
        billable,
        start,
        end,
        source: entrySource(),
        timeZone: deviceTimeZone(),
        originId: ORIGIN_ID,
      };
      const optimistic = buildOptimisticEntry(shapeContext(), {
        id: tempId,
        description: "",
        projectId: context.projectId,
        taskId: context.taskId,
        billable,
        start,
        end,
      });

      // `run` never rejects, so the id it settles on is enough to tell an
      // edit made in the meantime whether it has an entry to write to.
      let serverId: string | null = null;
      const named = run({
        optimistic: (entries) => [optimistic, ...entries],
        perform: async (stillHere) => {
          const created = await createEntry.mutateAsync(input);
          serverId = created.id;
          if (!stillHere()) return;
          patchList((entries) =>
            entries.map((entry) =>
              entry.id === tempId
                ? decorateEntry(shapeContext(), created)
                : entry
            )
          );
        },
        queue: (workspaceId) =>
          enqueueOffline("entries.create", input, tempId, workspaceId),
        failure: "Could not add the time",
      }).then((): string | null => serverId);

      createdIds.current.set(tempId, named);
      void named.then((id) => {
        if (id === null) createdIds.current.delete(tempId);
      });
    },
    [billableFor, createEntry, patchList, run, shapeContext]
  );

  const adjust = React.useCallback(
    (id: string, end: string): void => {
      withServerId(id, (serverId) => {
        const input: OfflineUpdateInput = {
          id: serverId,
          end,
          originId: ORIGIN_ID,
        };

        void run({
          optimistic: (entries) =>
            entries.map((entry) =>
              entry.id === serverId
                ? {
                    ...entry,
                    end,
                    durationSec: Math.max(
                      0,
                      Math.round(
                        (Date.parse(end) - Date.parse(entry.start)) / 1000
                      )
                    ),
                  }
                : entry
            ),
          perform: async () => {
            await updateEntry.mutateAsync(input);
          },
          queue: (workspaceId) =>
            enqueueOffline("entries.update", input, undefined, workspaceId),
          failure: "Could not save the change",
        });
      });
    },
    [run, updateEntry, withServerId]
  );

  const remove = React.useCallback(
    (id: string, context: CellEditContext): void => {
      if (isTempId(id) && !createdIds.current.has(id)) {
        // Never reached the server — drop it locally and cancel its replay,
        // so the create cannot resurrect an entry the user just cleared.
        // A temp id the map still knows belongs to a create that IS in flight,
        // and deleting it locally would only last until that create answers.
        patchList((entries) => entries.filter((entry) => entry.id !== id));
        void cancelQueuedForTemp(id);
        return;
      }

      withServerId(id, (serverId) => {
        // Read after the wait, so an entry the create has just renamed is
        // still found and the undo below can offer its real times back.
        const existing = utils.entries.list
          .getData(listInput)
          ?.entries.find((entry) => entry.id === serverId);
        const input: OfflineIdInput = { id: serverId, originId: ORIGIN_ID };

        void run({
          optimistic: (entries) =>
            entries.filter((entry) => entry.id !== serverId),
          perform: async () => {
            await removeEntry.mutateAsync(input);
            // Clearing a cell deletes tracked time, so the way back is offered
            // rather than assumed — the grid has no other undo.
            if (existing?.end) {
              toast.message("Entry removed", {
                action: {
                  label: "Undo",
                  onClick: () =>
                    create(
                      existing.start,
                      existing.end ?? existing.start,
                      context
                    ),
                },
              });
            }
          },
          queue: (workspaceId) =>
            enqueueOffline("entries.remove", input, undefined, workspaceId),
          failure: "Could not remove the time",
        });
      });
    },
    [create, listInput, patchList, removeEntry, run, utils, withServerId]
  );

  const applyPlan = React.useCallback(
    (plan: TimesheetCellPlan, context: CellEditContext): void => {
      switch (plan.kind) {
        case "noop":
          return;
        case "refuse":
          toast.error(timesheetRefusalMessage(plan.reason));
          return;
        case "create":
          create(plan.start, plan.end, context);
          return;
        case "adjust":
          adjust(plan.id, plan.end);
          return;
        case "delete":
          remove(plan.id, context);
          return;
      }
    },
    [adjust, create, remove]
  );

  return { applyPlan, isBusy: pending > 0 };
};
