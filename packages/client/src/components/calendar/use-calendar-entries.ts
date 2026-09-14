"use client";

import * as React from "react";
import type { DetailedEntry } from "@starter/shared";

import { toast } from "@/components/ui/sonner";
import { ORIGIN_ID } from "@/hooks/use-sync";
import { useFormatSettings } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import {
  EMPTY_HISTORY,
  canRedo,
  canUndo,
  draftFromEntry,
  dropStep,
  inversePatch,
  isNoopPatch,
  patchLabel,
  peekRedo,
  peekUndo,
  pushStep,
  redo as redoStep,
  remapEntryId,
  replaceEntryId,
  restartsTimer,
  undo as undoStep,
  type HistoryState,
  type HistoryStep,
  type StepBody,
} from "./calendar-history";
import { entrySource } from "@/lib/entry-source";
import { ownEntries, useViewerId } from "@/components/tracker/own-entries";

/** The exact `entries.list` input the calendar screen is showing. */
export type CalendarQueryInput = {
  from: string;
  to: string;
  limit: number;
};

type ListData = { entries: DetailedEntry[]; nextCursor?: string };

/** Fields a calendar interaction can change on an existing entry. */
export type EntryPatch = {
  description?: string;
  projectId?: string | null;
  taskId?: string | null;
  billable?: boolean;
  /** Replaces the whole set, as `entries.update` does — omit to leave alone. */
  tagIds?: string[];
  start?: string;
  end?: string | null;
};

/** Everything needed to create an entry from a drag or the create dialog. */
export type EntryDraft = {
  description: string;
  projectId: string | null;
  taskId: string | null;
  billable?: boolean;
  start: string;
  end: string;
  /** Carried so undoing a delete restores the zone the entry was recorded in. */
  timeZone?: string;
  tagIds?: string[];
};

const durationOf = (start: string, end: string | null): number => {
  if (end === null) return 0;
  const seconds = Math.round((Date.parse(end) - Date.parse(start)) / 1000);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
};

const amountOf = (durationSec: number, hourlyRate: number | null): number =>
  hourlyRate === null ? 0 : (durationSec / 3600) * hourlyRate;

/** Newest first, matching the server's `start desc` ordering. */
const sortEntries = (entries: DetailedEntry[]): DetailedEntry[] =>
  [...entries].sort((a, b) => Date.parse(b.start) - Date.parse(a.start));

export type CalendarEntries = {
  entries: DetailedEntry[];
  isLoading: boolean;
};

/**
 * Every entry overlapping the visible window, running entries included.
 *
 * `enabled` is false for the year view, which would ask for a year of entries
 * and get a truncated page back — it reads aggregated report data instead.
 */
export const useCalendarEntries = (
  input: CalendarQueryInput,
  enabled = true
): CalendarEntries => {
  const query = trpc.entries.list.useQuery(input, {
    staleTime: 10_000,
    enabled,
  });
  // The calendar is the viewer's own time: every block on it can be dragged,
  // resized and deleted. See components/tracker/own-entries.ts.
  const viewerId = useViewerId();
  const entries = React.useMemo(
    () => ownEntries(query.data?.entries ?? [], viewerId),
    [query.data, viewerId]
  );
  return {
    entries,
    isLoading: enabled && query.isPending,
  };
};

/** The undo/redo surface the calendar toolbar and its shortcuts drive. */
export type CalendarHistory = {
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** What undo would reverse next, e.g. "move" — null when there is nothing. */
  undoLabel: string | null;
  redoLabel: string | null;
};

export type CalendarActions = {
  update: (id: string, patch: EntryPatch) => void;
  create: (draft: EntryDraft) => void;
  remove: (id: string) => void;
  isMutating: boolean;
  history: CalendarHistory;
};

/**
 * Optimistic create/update/delete against the calendar's `entries.list`
 * cache. Every mutation carries `originId` so the socket echo of our own
 * write is ignored instead of re-fetching what we already painted.
 */
export const useCalendarActions = (
  input: CalendarQueryInput
): CalendarActions => {
  const utils = trpc.useUtils();
  const { currency } = useFormatSettings();
  // Stamped on the optimistic block so the own-entries filter keeps it on
  // screen until the server's answer replaces it.
  const viewerId = useViewerId();
  const projects = trpc.projects.list.useQuery({});
  const projectsData = projects.data;

  const projectMeta = React.useCallback(
    (
      projectId: string | null
    ): {
      projectName: string | null;
      projectColor: string | null;
      clientName: string | null;
    } => {
      const project = projectId
        ? projectsData?.find((candidate) => candidate.id === projectId)
        : undefined;
      return {
        projectName: project?.name ?? null,
        projectColor: project?.color ?? null,
        clientName: project?.clientName ?? null,
      };
    },
    [projectsData]
  );

  const snapshot = React.useCallback(async (): Promise<ListData | undefined> => {
    await utils.entries.list.cancel(input);
    return utils.entries.list.getData(input);
  }, [input, utils]);

  const rollback = React.useCallback(
    (previous: ListData | undefined): void => {
      if (previous) utils.entries.list.setData(input, previous);
    },
    [input, utils]
  );

  const settle = React.useCallback((): void => {
    void utils.entries.invalidate();
    void utils.reports.invalidate();
  }, [utils]);

  const updateMutation = trpc.entries.update.useMutation({
    onMutate: async (variables) => {
      const previous = await snapshot();
      utils.entries.list.setData(input, (current) => {
        if (!current) return current;
        return {
          ...current,
          entries: sortEntries(
            current.entries.map((entry) => {
              if (entry.id !== variables.id) return entry;
              const start = variables.start ?? entry.start;
              const end =
                variables.end === undefined ? entry.end : variables.end;
              const durationSec = durationOf(start, end);
              const projectId =
                variables.projectId === undefined
                  ? entry.projectId
                  : variables.projectId ?? null;
              const meta =
                variables.projectId === undefined
                  ? {
                      projectName: entry.projectName,
                      projectColor: entry.projectColor,
                      clientName: entry.clientName,
                    }
                  : projectMeta(projectId);
              return {
                ...entry,
                ...meta,
                description: variables.description ?? entry.description,
                projectId,
                taskId:
                  variables.taskId === undefined
                    ? entry.taskId
                    : variables.taskId ?? null,
                billable: variables.billable ?? entry.billable,
                tagIds: variables.tagIds ?? entry.tagIds,
                start,
                end,
                durationSec,
                // timeZone is deliberately absent: an edit must not restamp the
                // zone the entry was recorded in. The spread above preserves it.
                amount: amountOf(durationSec, entry.hourlyRate),
                updatedAt: new Date().toISOString(),
              };
            })
          ),
        };
      });
      return { previous };
    },
    onError: (error, _variables, context) => {
      rollback(context?.previous);
      toast.error(error.message);
    },
    onSettled: settle,
  });

  const createMutation = trpc.entries.create.useMutation({
    onMutate: async (variables) => {
      const previous = await snapshot();
      const now = new Date().toISOString();
      const projectId = variables.projectId ?? null;
      const durationSec = durationOf(variables.start, variables.end);
      const optimistic: DetailedEntry = {
        id: `optimistic-${now}`,
        workspaceId: "",
        authorId: viewerId ?? "",
        description: variables.description ?? "",
        projectId,
        taskId: variables.taskId ?? null,
        billable: variables.billable ?? false,
        start: variables.start,
        end: variables.end,
        durationSec,
        hourlyRate: null,
        currency,
        source: entrySource(),
        timeZone: variables.timeZone ?? null,
        // Server-owned: only the runaway guard ever writes it.
        runaway: null,
        // Echo the tags the caller asked for, so the optimistic row is not
        // briefly untagged before the server answers. Freshly created time is
        // never on an invoice yet.
        tagIds: variables.tagIds ?? [],
        invoiceId: null,
        importId: null,
        createdAt: now,
        updatedAt: now,
        ...projectMeta(projectId),
        taskName: null,
        amount: 0,
      };
      utils.entries.list.setData(input, (current) =>
        current
          ? { ...current, entries: sortEntries([optimistic, ...current.entries]) }
          : current
      );
      return { previous };
    },
    onError: (error, _variables, context) => {
      rollback(context?.previous);
      toast.error(error.message);
    },
    onSettled: settle,
  });

  const removeMutation = trpc.entries.remove.useMutation({
    onMutate: async (variables) => {
      const previous = await snapshot();
      utils.entries.list.setData(input, (current) =>
        current
          ? {
              ...current,
              entries: current.entries.filter(
                (entry) => entry.id !== variables.id
              ),
            }
          : current
      );
      return { previous };
    },
    onError: (error, _variables, context) => {
      rollback(context?.previous);
      toast.error(error.message);
    },
    onSettled: settle,
  });

  // ── raw mutations, no history ──────────────────────────────────────

  // Each resolves to whether the write landed. A mutation that failed left
  // nothing behind to reverse, so its history step has to go with it —
  // otherwise undoing a refused delete would create a duplicate entry.

  const applyUpdate = React.useCallback(
    (id: string, patch: EntryPatch): Promise<boolean> =>
      updateMutation
        .mutateAsync({ id, ...patch, originId: ORIGIN_ID })
        .then(() => true)
        .catch(() => false),
    [updateMutation]
  );

  const applyCreate = React.useCallback(
    (draft: EntryDraft): Promise<string | null> =>
      createMutation
        .mutateAsync({ ...draft, originId: ORIGIN_ID })
        .then((created) => created.id)
        .catch(() => null),
    [createMutation]
  );

  const applyRemove = React.useCallback(
    (id: string): Promise<boolean> =>
      removeMutation
        .mutateAsync({ id, originId: ORIGIN_ID })
        .then(() => true)
        .catch(() => false),
    [removeMutation]
  );

  // ── history ────────────────────────────────────────────────────────

  // The ref is the stack; the state is only how it reaches the render. Undo
  // has to read the current stack AND act on the step it pops, which a
  // functional setState cannot do — and reading through the ref is what keeps
  // two keystrokes inside one frame from undoing the same change twice.
  const historyRef = React.useRef<HistoryState>(EMPTY_HISTORY);
  const [history, setHistory] = React.useState<HistoryState>(EMPTY_HISTORY);

  const writeHistory = React.useCallback(
    (map: (current: HistoryState) => HistoryState): void => {
      historyRef.current = map(historyRef.current);
      setHistory(historyRef.current);
    },
    []
  );

  const nextStepIdRef = React.useRef(1);

  const record = React.useCallback(
    (body: StepBody, label: string): HistoryStep => {
      const step: HistoryStep = { ...body, id: nextStepIdRef.current, label };
      nextStepIdRef.current += 1;
      writeHistory((current) => pushStep(current, step));
      return step;
    },
    [writeHistory]
  );

  const entryById = React.useCallback(
    (id: string): DetailedEntry | undefined =>
      utils.entries.list
        .getData(input)
        ?.entries.find((entry) => entry.id === id),
    [input, utils]
  );

  /**
   * Run a create, and re-aim the history at the id the server hands back.
   *
   * `replacing` is the id this create is resurrecting, when the create is the
   * undo of a delete: every older step about that entry has to follow it to
   * its new id, or they would each undo into a "not found".
   */
  const createTracked = React.useCallback(
    (draft: EntryDraft, stepId: number, replacing: string | null): void => {
      void applyCreate(draft).then((id) => {
        writeHistory((current) => {
          if (id === null) return dropStep(current, stepId);
          const rebased =
            replacing === null
              ? current
              : replaceEntryId(current, replacing, id);
          return remapEntryId(rebased, stepId, id);
        });
      });
    },
    [applyCreate, writeHistory]
  );

  /** Run a write, and forget `stepId` if the server refused it. */
  const trackFailure = React.useCallback(
    (result: Promise<boolean>, stepId: number | null): void => {
      void result.then((ok) => {
        if (!ok && stepId !== null) {
          writeHistory((current) => dropStep(current, stepId));
        }
      });
    },
    [writeHistory]
  );

  const update = React.useCallback(
    (id: string, patch: EntryPatch): void => {
      const entry = entryById(id);
      const step =
        entry && !isNoopPatch(entry, patch)
          ? record(
              restartsTimer(entry, patch)
                ? {
                    kind: "barrier",
                    reason:
                      "Stopping a running timer cannot be undone — only one " +
                      "entry can run at a time",
                  }
                : {
                    kind: "update",
                    entryId: id,
                    undo: inversePatch(entry, patch),
                    redo: patch,
                  },
              patchLabel(patch)
            )
          : null;
      trackFailure(applyUpdate(id, patch), step?.id ?? null);
    },
    [applyUpdate, entryById, record, trackFailure]
  );

  const create = React.useCallback(
    (draft: EntryDraft): void => {
      const step = record({ kind: "create", entryId: null, draft }, "create");
      createTracked(draft, step.id, null);
    },
    [createTracked, record]
  );

  const remove = React.useCallback(
    (id: string): void => {
      const entry = entryById(id);
      const step = entry
        ? record(
            entry.end === null
              ? {
                  kind: "barrier",
                  reason:
                    "Deleting a running timer cannot be undone — only one " +
                    "entry can run at a time",
                }
              : {
                  kind: "remove",
                  entryId: id,
                  draft: draftFromEntry(entry, entry.end),
                },
            "delete"
          )
        : null;
      trackFailure(applyRemove(id), step?.id ?? null);
    },
    [applyRemove, entryById, record, trackFailure]
  );

  const travel = React.useCallback(
    (direction: "undo" | "redo"): void => {
      const current = historyRef.current;
      const move =
        direction === "undo" ? undoStep(current) : redoStep(current);

      if (move.outcome === "empty") return;
      if (move.outcome === "blocked") {
        toast.error(move.reason);
        return;
      }

      writeHistory(() => move.state);
      const target = move.step;
      const undoing = direction === "undo";

      switch (target.kind) {
        case "update":
          void applyUpdate(
            target.entryId,
            undoing ? target.undo : target.redo
          );
          break;
        case "create":
          // Undoing a create deletes; redoing it writes a NEW entry, whose id
          // the step then adopts so a further undo deletes the right one.
          if (!undoing) createTracked(target.draft, target.id, target.entryId);
          else if (target.entryId) void applyRemove(target.entryId);
          break;
        case "remove":
          if (undoing) createTracked(target.draft, target.id, target.entryId);
          else if (target.entryId) void applyRemove(target.entryId);
          break;
        case "barrier":
          return;
      }

      toast.success(`${undoing ? "Undid" : "Redid"} ${target.label}`);
    },
    [applyRemove, applyUpdate, createTracked, writeHistory]
  );

  const undo = React.useCallback((): void => {
    travel("undo");
  }, [travel]);

  const redo = React.useCallback((): void => {
    travel("redo");
  }, [travel]);

  return {
    update,
    create,
    remove,
    isMutating:
      updateMutation.isPending ||
      createMutation.isPending ||
      removeMutation.isPending,
    history: {
      undo,
      redo,
      canUndo: canUndo(history),
      canRedo: canRedo(history),
      undoLabel: peekUndo(history)?.label ?? null,
      redoLabel: peekRedo(history)?.label ?? null,
    },
  };
};
