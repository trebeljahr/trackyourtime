"use client";

import * as React from "react";
import { resolveHourlyRate, zonedWallClockToMs, type DetailedEntry, type TimeEntry, type EntryListInput, type TimesheetRow } from "@starter/shared";
import { decorateEntry } from "@/lib/entry-shape";
import { getActiveWorkspaceId } from "@/lib/active-workspace";
import { entryMutationScope, sameEntryMutationScope, type EntryMutationScope, type EntryMutationResult } from "@/lib/entry-mutation-result";
import { useT } from "@/i18n/use-t";
import { trpc } from "@/lib/trpc";
import type { EntryMutations } from "@/components/tracker/use-entry-mutations";
import type { ManualEntrySeed } from "@/components/tracker/manual-entry-dialog";
import { blockProtection } from "./block-protection";
import { blockBillableDefault } from "./block-billable-default";

type CellTarget = { row: TimesheetRow; day: string; testId: string };
type Draft = CellTarget & { userId: string; workspaceId: string; entry: DetailedEntry | null; scope: EntryMutationScope; range: { start: string; end: string } };

export type TimesheetBlockEditor = {
  entry: DetailedEntry | null;
  manual: { seed: ManualEntrySeed; range: { start: string; end: string } } | null;
  mutations: EntryMutations;
  edit: (entry: DetailedEntry, target: CellTarget) => void;
  add: (target: CellTarget) => void;
  close: () => void;
};

/** Dialogs live above the grid so a cache update cannot unmount a pending draft. */
export const useTimesheetBlockEditor = (args: {
  entries: readonly DetailedEntry[];
  userId: string | null;
  listInput: EntryListInput;
  timeZone: string;
  mutations: EntryMutations;
  disabled: boolean;
  memberRate?: number | null;
  /** Localized lock reason; callers can wire approval periods here. */
  cellDisabledReason?: (row: TimesheetRow, day: string) => string | undefined;
}): TimesheetBlockEditor => {
  const t = useT("calendar");
  const utils = trpc.useUtils();
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const currentUser = React.useRef(args.userId);
  React.useLayoutEffect(() => { currentUser.current = args.userId; }, [args.userId]);

  const close = (): void => {
    const testId = draft?.testId;
    setDraft(null);
    if (testId !== undefined) requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ??
        document.querySelector<HTMLElement>('[data-testid="timesheet-page"]');
      target?.focus();
    });
  };

  const open = (target: CellTarget, entry: DetailedEntry | null): void => {
    const workspaceId = getActiveWorkspaceId();
    if (args.disabled || args.cellDisabledReason?.(target.row, target.day) !== undefined || args.userId === null || workspaceId === null) return;
    if (entry !== null && blockProtection(entry, args.userId, workspaceId) !== null) return;
    const start = new Date(zonedWallClockToMs({
      year: Number(target.day.slice(0, 4)), month: Number(target.day.slice(5, 7)),
      day: Number(target.day.slice(8, 10)), hour: 9,
    }, args.timeZone)).toISOString();
    setDraft({ ...target, userId: args.userId, workspaceId, entry, scope: entryMutationScope(),
      range: { start, end: new Date(Date.parse(start) + 3600_000).toISOString() } });
  };

  const refusal = (): string | null => {
    if (draft === null || draft.userId !== args.userId || draft.workspaceId !== getActiveWorkspaceId() || !sameEntryMutationScope(draft.scope)) return t("timesheet.blocks.scopeChanged");
    const locked = args.cellDisabledReason?.(draft.row, draft.day);
    if (locked !== undefined) return locked;
    if (args.disabled) return t("timesheet.blocks.unavailable");
    return null;
  };
  const stillHere = (): boolean => draft !== null && draft.userId === currentUser.current && draft.workspaceId === getActiveWorkspaceId() && sameEntryMutationScope(draft.scope);

  const detailed = (entry: TimeEntry): DetailedEntry => decorateEntry({
    projects: utils.projects.list.getData({}) ?? [],
    tasks: utils.tasks.list.getData({}) ?? [],
    settings: utils.settings.get.getData() ?? null,
  }, entry);

  // Keep the shared Promise<EntryMutationResult> contract. Only a confirmed
  // server save or durable queue write permits closing the shared dialogs.
  const mutations: EntryMutations = {
    ...args.mutations,
    createManualEntry: async (input): Promise<EntryMutationResult> => {
      const message = refusal();
      if (message !== null) return { ok: false, message };
      const result = await args.mutations.createManualEntry(input);
      if (result.ok && stillHere()) {
        if (result.entry === undefined || result.entry.authorId !== draft?.userId || result.entry.workspaceId !== draft?.workspaceId) {
          return { ok: false, message: t("timesheet.blocks.refreshBeforeRetry") };
        }
        const created = detailed(result.entry);
        utils.entries.list.setData(args.listInput, (data) => data === undefined
          ? { entries: [created] }
          : data.entries.some((entry) => entry.id === created.id)
            ? data : { ...data, entries: [...data.entries, created] });
      }
      return result;
    },
    updateEntry: async (input): Promise<EntryMutationResult> => {
      const message = refusal();
      if (message !== null) return { ok: false, message };
      const entry = args.entries.find((candidate) => candidate.id === input.id);
      const protection = blockProtection(entry, args.userId, getActiveWorkspaceId());
      if (draft?.entry?.id !== input.id || protection !== null || entry === undefined) {
        return { ok: false, message: t(`timesheet.blocks.protection.${protection ?? "missing"}`) };
      }
      const result = await args.mutations.updateEntry(input);
      if (result.ok && stillHere()) {
        // An older block can be outside the tracker cache while offline. Its
        // ID is already known, so a durable update can project those exact
        // submitted fields onto the original record without guessing identity.
        const start = input.start ?? entry.start;
        const end = input.end === undefined ? entry.end : input.end;
        const settings = utils.settings.get.getData();
        const projectId = input.projectId === undefined ? entry.projectId : input.projectId;
        const billable = input.billable ?? entry.billable;
        const resnapshot = (projectId !== entry.projectId || billable !== entry.billable) &&
          settings?.workspaceId === entry.workspaceId && settings?.userId === entry.authorId;
        const hourlyRate = resnapshot ? resolveHourlyRate({
          billable, projectRate: utils.projects.list.getData({})?.find((project) => project.id === projectId)?.hourlyRate,
          memberRate: settings?.memberHourlyRate, defaultRate: settings?.defaultHourlyRate,
        }) : entry.hourlyRate;
        const saved = result.entry ?? (result.saved === "offline" ? {
          ...entry,
          description: input.description ?? entry.description,
          clientId: input.clientId === undefined ? entry.clientId : input.clientId,
          projectId: input.projectId === undefined ? entry.projectId : input.projectId,
          taskId: input.taskId === undefined ? entry.taskId : input.taskId,
          billable, hourlyRate, currency: resnapshot ? settings!.currency : entry.currency,
          tagIds: input.tagIds ?? entry.tagIds,
          start, end,
          durationSec: end === null ? 0 : Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000)),
        } : undefined);
        if (saved === undefined || saved.id !== input.id || saved.authorId !== draft?.userId || saved.workspaceId !== draft?.workspaceId) {
          return { ok: false, message: t("timesheet.blocks.refreshBeforeRetry") };
        }
        const updated = detailed(saved);
        utils.entries.list.setData(args.listInput, (data) => data === undefined ? data : {
          ...data, entries: data.entries.map((candidate) => candidate.id === input.id ? updated : candidate),
        });
      }
      return result;
    },
  };

  return {
    entry: draft?.entry ?? null,
    manual: draft === null || draft.entry !== null ? null : {
      seed: { description: "", projectId: draft.row.projectId, taskId: draft.row.taskId,
        billable: blockBillableDefault(
          utils.projects.list.getData({})?.find((project) => project.id === draft.row.projectId),
          utils.settings.get.getData()?.defaultHourlyRate, args.memberRate,
        ), tagIds: [] },
      range: draft.range,
    },
    mutations,
    edit: (entry, target) => open(target, entry),
    add: (target) => open(target, null),
    close,
  };
};
