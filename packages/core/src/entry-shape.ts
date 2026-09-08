/**
 * The shape an entry mutation writes locally before the server answers.
 *
 * Every optimistic write has to guess what the server is about to store, and
 * the money fields are the part that must not be guessed differently in two
 * places: `hourlyRate` and `currency` are SNAPSHOTS taken at create/stop time,
 * so a client that shapes them its own way shows one number for a second and a
 * different one after the round trip. These builders are pure and shared, so
 * the web tracker, the timesheet grid and Raycast cannot drift apart — which
 * matters far more now that a shape can sit in an offline queue for hours
 * before anything checks it against the server.
 *
 * Pure on purpose — they take the catalog and settings they need rather than
 * reading a query cache, which is what makes them testable and reusable from
 * any host.
 */

import {
  entryAmount,
  resolveHourlyRate,
  type DetailedEntry,
  type EntrySource,
  type ResolvedSettings,
  type TimeEntry,
} from "@starter/shared";
import { deviceTimeZone } from "./ids.js";

/** The catalog fields an optimistic entry needs. Matches `projects.list`. */
export type ShapeableProject = {
  id: string;
  name: string;
  color: string;
  clientName?: string | null;
  hourlyRate?: number | null;
};

/** Matches `tasks.list`; used only to label a row before the server replies. */
export type ShapeableTask = {
  id: string;
  name: string;
};

/**
 * Everything a shape needs that is not in the mutation itself.
 *
 * `source` is a field rather than something the builder decides, because it is
 * stamped once at write time and is not backfillable: only the host knows
 * whether it is a browser, a phone or a launcher.
 */
export type EntryShapeContext = {
  projects: readonly ShapeableProject[];
  /** Optional: without it a fresh entry's `taskName` is null until it syncs. */
  tasks?: readonly ShapeableTask[];
  /** Null while `settings.get` is still in flight. */
  settings: Pick<
    ResolvedSettings,
    "workspaceId" | "userId" | "currency" | "defaultHourlyRate"
  > | null;
  source: EntrySource;
};

export type ProjectFacts = {
  projectName: string | null;
  projectColor: string | null;
  clientName: string | null;
  /** The project's configured rate — an input to the snapshot, not a value. */
  projectRate: number | null;
};

const NO_PROJECT: ProjectFacts = {
  projectName: null,
  projectColor: null,
  clientName: null,
  projectRate: null,
};

export const projectFacts = (
  context: EntryShapeContext,
  projectId: string | null
): ProjectFacts => {
  if (projectId === null) return NO_PROJECT;
  const project = context.projects.find(
    (candidate) => candidate.id === projectId
  );
  return {
    projectName: project?.name ?? null,
    projectColor: project?.color ?? null,
    clientName: project?.clientName ?? null,
    projectRate: project?.hourlyRate ?? null,
  };
};

const taskName = (
  context: EntryShapeContext,
  taskId: string | null
): string | null => {
  if (taskId === null) return null;
  return context.tasks?.find((task) => task.id === taskId)?.name ?? null;
};

const durationBetween = (start: string, end: string): number =>
  Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000));

/** Decorate a server entry with the catalog labels a list renders. */
export const decorateEntry = (
  context: EntryShapeContext,
  entry: TimeEntry
): DetailedEntry => {
  const project = projectFacts(context, entry.projectId);
  return {
    ...entry,
    projectName: project.projectName,
    projectColor: project.projectColor,
    clientName: project.clientName,
    taskName: taskName(context, entry.taskId),
    amount: entryAmount(entry.durationSec, entry.hourlyRate),
  };
};

export type OptimisticEntryArgs = {
  id: string;
  description: string;
  projectId: string | null;
  taskId: string | null;
  billable: boolean;
  start: string;
  end: string | null;
  /** Tags the caller asked for. Omitted means untagged. */
  tagIds?: string[];
};

/** The entry the server is about to create, as far as this client can tell. */
export const buildOptimisticEntry = (
  context: EntryShapeContext,
  args: OptimisticEntryArgs
): DetailedEntry => {
  const { settings } = context;
  const project = projectFacts(context, args.projectId);
  const hourlyRate = resolveHourlyRate({
    billable: args.billable,
    projectRate: project.projectRate,
    defaultRate: settings?.defaultHourlyRate ?? null,
  });
  const durationSec =
    args.end === null ? 0 : durationBetween(args.start, args.end);
  const stamp = new Date().toISOString();

  return {
    id: args.id,
    workspaceId: settings?.workspaceId ?? "",
    authorId: settings?.userId ?? "",
    description: args.description,
    projectId: args.projectId,
    taskId: args.taskId,
    billable: args.billable,
    start: args.start,
    end: args.end,
    durationSec,
    hourlyRate,
    currency: settings?.currency ?? "EUR",
    source: context.source,
    timeZone: deviceTimeZone(),
    // Server-owned: only the runaway guard ever writes it.
    runaway: null,
    // Echo the tags the caller asked for, so the row is not briefly untagged
    // before the server answers — which reads as the tag failing to stick.
    tagIds: args.tagIds ?? [],
    // Freshly created time is never on an invoice yet.
    invoiceId: null,
    importId: null,
    createdAt: stamp,
    updatedAt: stamp,
    projectName: project.projectName,
    projectColor: project.projectColor,
    clientName: project.clientName,
    taskName: taskName(context, args.taskId),
    amount: entryAmount(durationSec, hourlyRate),
  };
};

/** The stopped shape the server would write for a running entry. */
export const stoppedEntryShape = (
  context: EntryShapeContext,
  running: TimeEntry,
  end: string
): DetailedEntry => {
  const { settings } = context;
  const project = projectFacts(context, running.projectId);
  const safeEnd =
    Date.parse(end) > Date.parse(running.start) ? end : running.start;
  const hourlyRate = resolveHourlyRate({
    billable: running.billable,
    projectRate: project.projectRate,
    defaultRate: settings?.defaultHourlyRate ?? null,
  });
  const durationSec = durationBetween(running.start, safeEnd);

  return {
    ...running,
    end: safeEnd,
    durationSec,
    hourlyRate,
    currency: settings?.currency ?? running.currency,
    updatedAt: safeEnd,
    projectName: project.projectName,
    projectColor: project.projectColor,
    clientName: project.clientName,
    taskName: taskName(context, running.taskId),
    amount: entryAmount(durationSec, hourlyRate),
  };
};
