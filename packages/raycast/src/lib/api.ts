/**
 * Typed calls over the tRPC HTTP endpoints.
 *
 * Raycast cannot use the tRPC React bindings — no React Query provider, no
 * cookie jar — so it goes through `createApiClient` from `@starter/core`,
 * which speaks the same wire format with a bearer token instead.
 */
import {
  ApiError,
  buildOptimisticEntry,
  buildQuickStartInput,
  createApiClient,
  createTempId,
  decorateEntry,
  deviceTimeZone,
  isTempId,
  stoppedEntryShape,
  type ApiClient,
  type Client,
  type DescriptionSuggestion,
  type DetailedEntry,
  type DetailedFavorite,
  type OfflineCreateInput,
  type OfflineReplayMutators,
  type OfflineStartInput,
  type OfflineUpdateInput,
  type Project,
  type QuickStart,
  type Tag,
  type Task,
  type TimeEntry,
  type ResolvedSettings,
} from "@starter/core";
import { CLIENT_ID, getOriginId, getStoredSession } from "./auth.js";
import { NotSignedInError, StillSyncingError } from "./errors.js";
import {
  cachedBillableDefault,
  forgetEntry,
  loadCache,
  loadShapeContext,
  remember,
  rememberEntries,
} from "./local-cache.js";
import {
  cancelQueuedForTemp,
  enqueueOffline,
  flushOffline,
  getOfflineQueue,
  isTransportFailure,
} from "./offline.js";
import {
  applyOverlay,
  loadOverlay,
  noteOptimisticEntry,
  noteOptimisticPatch,
  noteOptimisticRemoval,
  overlayRunning,
  reconcileOverlay,
  resolveRunning,
  type OfflineOverlay,
} from "./overlay.js";
import { apiUrl } from "./preferences.js";
import { loadTimerEcho, noteTimerEcho } from "./storage.js";

export { NotSignedInError, StillSyncingError };

/** Entries written from here are tagged so reports can tell them apart. */
const SOURCE = "api" as const;

export type ProjectWithStats = Project & {
  clientName: string | null;
  clientColor: string | null;
  entryCount: number;
  totalSec: number;
};

export type TaskWithStats = Task & { totalSec: number };

export type TagWithStats = Tag & { entryCount: number; totalSec: number };

export type StartInput = {
  description?: string;
  projectId?: string | null;
  taskId?: string | null;
  tagIds?: string[];
  billable?: boolean;
};

/** A block of work that was never timed — both ends are known up front. */
export type CreateInput = StartInput & { start: string; end: string };

/**
 * What to offer as an autocomplete for the description field.
 *
 * `projectId` carries the same three-way meaning the server gives it: leave it
 * out for every project, pass `null` while composing an explicitly unfiled
 * entry, pass an id to see only what has been called that under that project.
 */
export type DescriptionsInput = {
  projectId?: string | null;
  taskId?: string | null;
  search?: string;
  limit?: number;
  days?: number;
};

export type UpdateInput = {
  id: string;
  description?: string;
  projectId?: string | null;
  taskId?: string | null;
  /** Absent leaves the tags alone; `[]` clears them. */
  tagIds?: string[];
  billable?: boolean;
  start?: string;
  end?: string | null;
};

/**
 * Catalog writes.
 *
 * Every field is optional on update and absent means "leave it alone", which
 * is the server's own contract — so a rename never has to resend a rate, and
 * archiving never has to resend a name.
 */
export type CreateClientInput = { name: string; color?: string };
export type UpdateClientInput = {
  id: string;
  name?: string;
  color?: string;
  archived?: boolean;
};

export type CreateProjectInput = {
  name: string;
  color?: string;
  clientId?: string | null;
  billableDefault?: boolean;
  /** Null clears the override and falls back to the workspace rate. */
  hourlyRate?: number | null;
  estimatedHours?: number | null;
  budgetAmount?: number | null;
};
export type UpdateProjectInput = CreateProjectInput & {
  id: string;
  name?: string;
  archived?: boolean;
};

export type CreateTaskInput = { name: string };
export type UpdateTaskInput = {
  id: string;
  name?: string;
  done?: boolean;
  archived?: boolean;
};

export type CreateTagInput = { name: string; color?: string };
export type UpdateTagInput = {
  id: string;
  name?: string;
  color?: string;
  archived?: boolean;
};

export type ListInput = {
  from: string;
  to: string;
  search?: string;
  limit?: number;
  cursor?: string;
};

export type TrackYourTime = {
  /** The running entry, or null when the timer is stopped. */
  current(): Promise<TimeEntry | null>;
  start(input: StartInput): Promise<TimeEntry>;
  /** Log past work: an entry that is finished the moment it is written. */
  create(input: CreateInput): Promise<TimeEntry>;
  stop(id?: string): Promise<TimeEntry>;
  /** Throw the running entry away instead of keeping it. */
  discard(id?: string): Promise<{ success: true; id: string }>;
  /**
   * Start a fresh timer with the same description/project/task/billable.
   *
   * `quick` is the offline path: the server resolves a continue from the entry
   * it names, and with no network there is nobody to ask. Every caller already
   * has the row on screen, so it hands the fields over rather than leaving the
   * hotkey dead on a train.
   */
  continue(id: string, quick?: QuickStart): Promise<TimeEntry>;
  /**
   * Start a favorite or a recent.
   *
   * Goes through `entries.start` like everything else — `buildQuickStartInput`
   * is the same builder the web tracker and the extension use, so the entry a
   * favorite opens is identical whichever client opened it.
   */
  startQuick(quick: QuickStart): Promise<TimeEntry>;
  favorites(): Promise<DetailedFavorite[]>;
  addFavorite(quick: QuickStart): Promise<DetailedFavorite>;
  removeFavorite(id: string): Promise<{ success: true; id: string }>;
  list(input: ListInput): Promise<{
    entries: DetailedEntry[];
    nextCursor?: string;
  }>;
  /** Descriptions this person has used before, newest first. */
  descriptions(input?: DescriptionsInput): Promise<DescriptionSuggestion[]>;
  update(input: UpdateInput): Promise<TimeEntry>;
  remove(id: string): Promise<{ success: true; id: string }>;
  projects(options?: {
    includeArchived?: boolean;
    clientId?: string | null;
  }): Promise<ProjectWithStats[]>;
  /** Tasks are workspace-wide, so this takes no project. */
  tasks(options?: { includeArchived?: boolean }): Promise<TaskWithStats[]>;
  /** Tags are not scoped to a project, so this takes no project either. */
  tags(options?: { includeArchived?: boolean }): Promise<TagWithStats[]>;
  clients(options?: { includeArchived?: boolean }): Promise<Client[]>;

  /**
   * Catalog rows are created and renamed from the pickers that need them, and
   * nothing else. Archiving, deleting and reordering are web app work — see
   * the extension's README — so the wrappers for them are deliberately absent
   * rather than dead.
   */
  createClient(input: CreateClientInput): Promise<Client>;
  updateClient(input: UpdateClientInput): Promise<Client>;

  createProject(input: CreateProjectInput): Promise<Project>;
  updateProject(input: UpdateProjectInput): Promise<Project>;

  createTask(input: CreateTaskInput): Promise<Task>;
  updateTask(input: UpdateTaskInput): Promise<Task>;

  createTag(input: CreateTagInput): Promise<Tag>;
  updateTag(input: UpdateTagInput): Promise<Tag>;

  settings(): Promise<ResolvedSettings>;

  /**
   * Replay anything queued offline, and report how much of this account's work
   * is still waiting.
   *
   * Every mutation does this first anyway — order has to be preserved — so
   * this is for the surfaces that want to drain on launch without writing
   * anything: the menu bar, the hotkey, the timer view.
   */
  sync(): Promise<number>;
};

/**
 * Record a timer transition locally the instant the server confirms it.
 *
 * Every Raycast command is its own process, so a stop performed in the Timer
 * command is invisible to the menu bar item until something crosses between
 * them. `refreshMenuBar()` is that something, and it is best effort: Raycast
 * may decline the launch, and a menu bar command that is still loaded — which
 * is exactly the state a running timer puts it in — is not remounted by one.
 * The echo does not depend on any of that. It is written here rather than in
 * each caller so a new command cannot ship without it.
 */
const echoing = async <T>(
  result: Promise<T>,
  next: (value: T) => string | null,
  /**
   * Only clear the echo when this id is the one we last saw running. Editing
   * or deleting some entry from last Tuesday says nothing about the timer
   * running right now, and "no echo yet" is not knowledge either — both skip.
   */
  clearsOnlyIf?: string,
): Promise<T> => {
  const value = await result;
  const runningId = next(value);
  if (runningId === null && clearsOnlyIf !== undefined) {
    const echo = await loadTimerEcho();
    if (echo?.runningId !== clearsOnlyIf) return value;
  }
  await noteTimerEcho(runningId);
  return value;
};

// ── the offline path ─────────────────────────────────────────────────

/**
 * The entry a queued mutation stands in for, from whatever this Mac still
 * knows: the overlay first, because a second edit before the first has been
 * sent must build on the first, then the cached window the last successful
 * read left behind.
 */
const knownEntry = async (
  id: string,
  overlay: OfflineOverlay,
): Promise<DetailedEntry | null> => {
  const local = overlay.entries.find((entry) => entry.id === id);
  if (local) return local;
  const cached = (await loadCache()).entries.find((entry) => entry.id === id);
  if (!cached) return null;
  const patch = overlay.patches[id];
  return patch ? { ...cached, ...patch } : cached;
};

/** Descriptions this person has used before, read out of the cached window. */
const cachedDescriptions = (
  entries: readonly DetailedEntry[],
  input: DescriptionsInput | undefined,
): DescriptionSuggestion[] => {
  const search = input?.search?.trim().toLowerCase() ?? "";
  const out = new Map<string, DescriptionSuggestion>();

  for (const entry of entries) {
    const description = entry.description.trim();
    if (description === "") continue;
    if (search && !description.toLowerCase().includes(search)) continue;
    if (
      input?.projectId !== undefined &&
      entry.projectId !== input.projectId
    ) {
      continue;
    }

    const key = description.toLowerCase();
    const seen = out.get(key);
    if (seen) {
      seen.count += 1;
      continue;
    }
    out.set(key, {
      description,
      projectId: entry.projectId,
      taskId: entry.taskId,
      billable: entry.billable,
      tagIds: entry.tagIds,
      projectName: entry.projectName,
      projectColor: entry.projectColor,
      clientName: entry.clientName,
      taskName: entry.taskName,
      // Nothing local can tell a missing project from an archived one, and
      // both would only ever soften a label. Claiming neither is the honest
      // reading of "we have not asked the server".
      projectMissing: false,
      projectArchived: false,
      taskMissing: false,
      lastStart: entry.start,
      lastEntryId: entry.id,
      count: 1,
    });
  }

  // The cache is already newest-first, so insertion order is the answer.
  return [...out.values()].slice(0, input?.limit ?? 20);
};

const wrap = (client: ApiClient, originId: string): TrackYourTime => {
  /**
   * One call per queued op, bound to this client.
   *
   * The op string *is* the tRPC path, by design — so there is no dispatch
   * table here to drift out of step with the queue contract in
   * `@starter/core/offline-ops`.
   */
  const mutators: OfflineReplayMutators = {
    "entries.start": (input) => client.mutate("entries.start", input),
    "entries.stop": (input) => client.mutate("entries.stop", input),
    "entries.create": (input) => client.mutate("entries.create", input),
    "entries.update": (input) => client.mutate("entries.update", input),
    "entries.remove": (input) => client.mutate("entries.remove", input),
    "entries.discard": (input) => client.mutate("entries.discard", input),
  };

  /**
   * Replay whatever is queued, and report how much of *this account's* work is
   * still stuck.
   *
   * Rows belonging to another account are excluded from the count as well as
   * from the replay: they can never drain under this session, so counting them
   * would send every future mutation straight to the queue and this Mac would
   * never talk to the server again.
   */
  const drain = async (): Promise<number> => {
    const size = await getOfflineQueue().size();
    if (size === 0) return 0;

    const report = await flushOffline(mutators);
    await reconcileOverlay({
      resolved: report.resolved,
      drained: report.remaining - report.skipped === 0,
    });

    // A start that replayed has a real id now. The echo still names the temp
    // one, and an echo naming an id no snapshot will ever contain reads as
    // "a timer is running that I cannot describe" — the surfaces blank the
    // clock and refetch forever.
    if (report.resolved.size > 0) {
      const echo = await loadTimerEcho();
      const renamed = echo?.runningId ? report.resolved.get(echo.runningId) : undefined;
      if (renamed) await noteTimerEcho(renamed);
    }

    return report.remaining - report.skipped;
  };

  /**
   * Send a mutation, or queue it.
   *
   * Two reasons to queue, and the first is the one that is easy to miss: work
   * already waiting has to go out ahead of anything new, or a stop lands
   * before the start it ends. So a non-empty queue routes even a perfectly
   * online mutation into the queue, where the order is kept.
   */
  const writing = async <T>(
    live: () => Promise<T>,
    queued: () => Promise<T>,
  ): Promise<T> => {
    // A drain that throws is a storage failure, not a refused mutation — the
    // queue itself swallows every server and transport error into its result.
    // Whatever went wrong, we no longer know the queue is empty, so the safe
    // reading is "something may be waiting" and the new mutation goes behind
    // it. Sending it live on a guess is what breaks ordering.
    const stuck = await drain().catch(() => 1);
    if (stuck > 0) return queued();
    try {
      return await live();
    } catch (error) {
      if (!isTransportFailure(error)) throw error;
      return queued();
    }
  };

  /**
   * Read from the server, or from the last good answer.
   *
   * A failed read is not an error the user has to act on — every one of these
   * has a local fallback, and a surface that renders yesterday's project list
   * is strictly better than one that renders a red toast. Only a transport
   * failure falls back: a 401 is a real answer and must reach the sign-in
   * handling.
   */
  const reading = async <T>(
    live: () => Promise<T>,
    fallback: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await live();
    } catch (error) {
      if (!isTransportFailure(error)) throw error;
      return fallback();
    }
  };

  /** Start an entry with no network: a temp id now, a real one on replay. */
  const queueStart = async (input: StartInput): Promise<DetailedEntry> => {
    const tempId = createTempId();
    const payload: OfflineStartInput = {
      description: input.description ?? "",
      projectId: input.projectId ?? null,
      taskId: input.taskId ?? null,
      tagIds: input.tagIds,
      billable:
        input.billable ?? (await cachedBillableDefault(input.projectId ?? null)),
      start: new Date().toISOString(),
      source: SOURCE,
      timeZone: deviceTimeZone(),
      originId,
    };
    await enqueueOffline("entries.start", payload, tempId);

    const entry = buildOptimisticEntry(await loadShapeContext(), {
      id: tempId,
      description: payload.description,
      projectId: payload.projectId,
      taskId: payload.taskId,
      billable: payload.billable,
      tagIds: payload.tagIds,
      start: payload.start,
      end: null,
    });
    await noteOptimisticEntry(entry);
    // The same record every live mutation writes, so the menu bar shows the
    // offline timer within a second rather than after a fetch that cannot
    // happen.
    await noteTimerEcho(tempId);
    return entry;
  };

  const queueStop = async (id: string | undefined): Promise<DetailedEntry> => {
    const overlay = await loadOverlay();
    const local = overlayRunning(overlay);
    const end = new Date().toISOString();
    const context = await loadShapeContext();

    // Stopping a timer this Mac started offline. The queued stop carries NO
    // id — the server has never seen the temp one — and rides on the same
    // `tempId` as its start, which is what lets the replay target the entry
    // that start produces.
    if (local && (id === undefined || id === local.id)) {
      await enqueueOffline("entries.stop", { end, originId }, local.id);
      const stopped = stoppedEntryShape(context, local, end);
      await noteOptimisticEntry(stopped);
      await noteTimerEcho(null);
      return stopped;
    }

    const target = id ?? (await runningFromCache())?.id;
    if (target === undefined) {
      // Same shape the server answers with, so `isAlreadyStopped` reads it
      // identically whether the refusal came from here or from the API.
      throw new ApiError("No running timer", "NOT_FOUND", 404);
    }

    await enqueueOffline("entries.stop", { id: target, end, originId });
    const base = await knownEntry(target, overlay);
    const stopped = base
      ? stoppedEntryShape(context, base, end)
      : // Nothing local describes this entry, so the stop is queued and the
        // caller gets the little that is knowable. The replay writes the real
        // numbers; only the toast is poorer for it.
        null;
    if (stopped) {
      await noteOptimisticPatch(target, {
        end: stopped.end,
        durationSec: stopped.durationSec,
        hourlyRate: stopped.hourlyRate,
        amount: stopped.amount,
      });
    } else {
      await noteOptimisticPatch(target, { end });
    }
    await noteTimerEcho(null);
    return stopped ?? placeholderStopped(target, end);
  };

  /** The running entry as far as the last successful read knew. */
  const runningFromCache = async (): Promise<DetailedEntry | null> =>
    (await loadCache()).entries.find((entry) => entry.end === null) ?? null;

  /**
   * A stopped entry we can describe by id and end time and nothing else.
   *
   * Only reachable when a stop is queued for an entry no local read has ever
   * seen — a timer started on another device, on a Mac that has been offline
   * since. The queue holds the truth; this is what the toast is drawn from.
   */
  const placeholderStopped = (id: string, end: string): DetailedEntry => ({
    id,
    workspaceId: "",
    authorId: "",
    description: "",
    projectId: null,
    taskId: null,
    billable: false,
    start: end,
    end,
    durationSec: 0,
    hourlyRate: null,
    currency: "",
    source: SOURCE,
    timeZone: deviceTimeZone(),
    runaway: null,
    tagIds: [],
    invoiceId: null,
    importId: null,
    createdAt: end,
    updatedAt: end,
    projectName: null,
    projectColor: null,
    clientName: null,
    taskName: null,
    amount: 0,
  });

  const queueCreate = async (input: CreateInput): Promise<DetailedEntry> => {
    const tempId = createTempId();
    const payload: OfflineCreateInput = {
      description: input.description ?? "",
      projectId: input.projectId ?? null,
      taskId: input.taskId ?? null,
      tagIds: input.tagIds,
      billable:
        input.billable ?? (await cachedBillableDefault(input.projectId ?? null)),
      start: input.start,
      end: input.end,
      source: SOURCE,
      timeZone: deviceTimeZone(),
      originId,
    };
    await enqueueOffline("entries.create", payload, tempId);

    const entry = buildOptimisticEntry(await loadShapeContext(), {
      id: tempId,
      description: payload.description,
      projectId: payload.projectId,
      taskId: payload.taskId,
      billable: payload.billable,
      tagIds: payload.tagIds,
      start: payload.start,
      end: payload.end,
    });
    await noteOptimisticEntry(entry);
    return entry;
  };

  const queueUpdate = async (input: UpdateInput): Promise<DetailedEntry> => {
    const payload: OfflineUpdateInput = { ...input, originId };
    await enqueueOffline("entries.update", payload);

    const overlay = await loadOverlay();
    const base = await knownEntry(input.id, overlay);
    const context = await loadShapeContext();
    // Nothing local describes the entry, so there is nothing to patch: the
    // list keeps showing the server's version until the edit replays. Queuing
    // it is what matters; the overlay is a courtesy.
    if (base === null) return placeholderStopped(input.id, new Date().toISOString());

    const merged: DetailedEntry = decorateEntry(context, {
      ...base,
      description: input.description ?? base.description,
      projectId: input.projectId === undefined ? base.projectId : input.projectId,
      taskId: input.taskId === undefined ? base.taskId : input.taskId,
      tagIds: input.tagIds ?? base.tagIds,
      billable: input.billable ?? base.billable,
      start: input.start ?? base.start,
      end: input.end === undefined ? base.end : input.end,
    });
    await noteOptimisticPatch(input.id, merged);
    // An edit can end the running entry, and it can also un-end it.
    const echo = await loadTimerEcho();
    if (merged.end === null) await noteTimerEcho(merged.id);
    else if (echo?.runningId === merged.id) await noteTimerEcho(null);
    return merged;
  };

  return {
    current: () =>
      reading(
        async () => {
          const server = await client.query<TimeEntry | null>("entries.current");
          return resolveRunning(server, await loadOverlay());
        },
        async () => resolveRunning(await runningFromCache(), await loadOverlay()),
      ),

    start: (input) =>
      writing(
        () =>
          echoing(
            client.mutate<TimeEntry>("entries.start", {
              ...input,
              source: SOURCE,
              originId,
            }),
            (entry) => entry.id,
          ),
        () => queueStart(input),
      ),

    stop: (id) =>
      writing(
        () =>
          echoing(
            client.mutate<TimeEntry>("entries.stop", { id, originId }),
            () => null,
          ),
        () => queueStop(id),
      ),

    discard: (id) =>
      writing(
        () =>
          echoing(
            client.mutate<{ success: true; id: string }>("entries.discard", {
              id,
              originId,
            }),
            () => null,
          ),
        async () => {
          const overlay = await loadOverlay();
          const local = overlayRunning(overlay);
          const target = id ?? local?.id ?? (await runningFromCache())?.id;
          if (target === undefined) {
            throw new ApiError("No running timer", "NOT_FOUND", 404);
          }
          // A timer that only exists as a queued start is discarded by
          // dropping that start. Sending `entries.discard` for it would name
          // an id the server has never seen, and leaving the start queued
          // would resurrect the timer the moment the network returned.
          if (isTempId(target)) await cancelQueuedForTemp(target);
          else await enqueueOffline("entries.discard", { id: target, originId });
          await noteOptimisticRemoval(target);
          await noteTimerEcho(null);
          return { success: true as const, id: target };
        },
      ),

    // `quick` is what makes this work with no network: the server resolves a
    // continue from the entry it names, and offline there is nobody to ask.
    // Every caller has the row on screen already, so it hands over the fields
    // rather than making this guess at them.
    continue: (id, quick) =>
      writing(
        () =>
          echoing(
            client.mutate<TimeEntry>("entries.continue", { id, originId }),
            (entry) => entry.id,
          ),
        () => {
          if (!quick) {
            throw new ApiError(
              "Cannot continue this entry while offline",
              "PRECONDITION_FAILED",
              412,
            );
          }
          return queueStart({
            description: quick.description,
            projectId: quick.projectId,
            taskId: quick.taskId,
            billable: quick.billable,
          });
        },
      ),

    startQuick: (quick) =>
      writing(
        () =>
          echoing(
            client.mutate<TimeEntry>(
              "entries.start",
              buildQuickStartInput(quick, {
                source: SOURCE,
                timeZone: deviceTimeZone(),
                originId,
              }),
            ),
            (entry) => entry.id,
          ),
        () =>
          queueStart({
            description: quick.description,
            projectId: quick.projectId,
            taskId: quick.taskId,
            billable: quick.billable,
          }),
      ),

    // No echo: a manual entry is already finished, so it says nothing about
    // what is running — and the server does not touch the running timer to
    // write one. Clearing the echo here would blank a menu bar that is right.
    create: (input) =>
      writing(
        async () => {
          const created = await client.mutate<TimeEntry>("entries.create", {
            ...input,
            source: SOURCE,
            timeZone: deviceTimeZone(),
            originId,
          });
          return created;
        },
        () => queueCreate(input),
      ),

    favorites: () =>
      reading(
        async () => {
          const favorites =
            await client.query<DetailedFavorite[]>("favorites.list");
          await remember({ favorites });
          return favorites;
        },
        async () => (await loadCache()).favorites,
      ),

    // Pinning mints an id the server owns and changes nothing about tracked
    // time, so it is deliberately not queueable: a favorite that failed to
    // pin is a button to press again, not lost work.
    addFavorite: (quick) =>
      client.mutate<DetailedFavorite>("favorites.create", { ...quick, originId }),

    removeFavorite: (id) =>
      client.mutate<{ success: true; id: string }>("favorites.remove", {
        id,
        originId,
      }),

    list: (input) =>
      reading(
        async () => {
          const page = await client.query<{
            entries: DetailedEntry[];
            nextCursor?: string;
          }>("entries.list", input);
          await rememberEntries(page.entries);
          return {
            ...page,
            entries: applyOverlay(page.entries, await loadOverlay(), input),
          };
        },
        async () => {
          const cached = (await loadCache()).entries.filter((entry) => {
            const startMs = Date.parse(entry.start);
            return (
              startMs >= Date.parse(input.from) && startMs <= Date.parse(input.to)
            );
          });
          const search = input.search?.trim().toLowerCase();
          const matched = search
            ? cached.filter((entry) =>
                entry.description.toLowerCase().includes(search),
              )
            : cached;
          return {
            // No cursor: what is cached is all there is, and offering one
            // would page into a request that cannot be made.
            entries: applyOverlay(matched, await loadOverlay(), input).slice(
              0,
              input.limit ?? 100,
            ),
          };
        },
      ),

    descriptions: (input) =>
      reading(
        () =>
          client.query<DescriptionSuggestion[]>(
            "entries.descriptions",
            input ?? {},
          ),
        async () => cachedDescriptions((await loadCache()).entries, input),
      ),

    update: (input) =>
      writing(
        () =>
          echoing(
            client.mutate<TimeEntry>("entries.update", { ...input, originId }),
            (entry) => (entry.end === null ? entry.id : null),
            input.id,
          ),
        async () => {
          // An entry that exists only as a queued start or create would be
          // refused on replay under a temp id the server has never seen, and
          // the queue drops a permanent refusal — so the edit would vanish
          // with no error anywhere. The queued row still carries every field
          // it was written with; the edit just has to wait for it to land.
          if (isTempId(input.id)) throw new StillSyncingError();
          return queueUpdate(input);
        },
      ),

    remove: (id) =>
      writing(
        () =>
          echoing(
            client.mutate<{ success: true; id: string }>("entries.remove", {
              id,
              originId,
            }),
            () => null,
            id,
          ),
        async () => {
          // Deleting a row that only exists as a queued create is done by
          // dropping that create — see `discard` for the same argument.
          if (isTempId(id)) await cancelQueuedForTemp(id);
          else await enqueueOffline("entries.remove", { id, originId });
          await noteOptimisticRemoval(id);
          await forgetEntry(id);
          const echo = await loadTimerEcho();
          if (echo?.runningId === id) await noteTimerEcho(null);
          return { success: true as const, id };
        },
      ),

    projects: (options) =>
      reading(
        async () => {
          const projects = await client.query<ProjectWithStats[]>(
            "projects.list",
            {
              includeArchived: options?.includeArchived ?? false,
              ...(options?.clientId === undefined
                ? {}
                : { clientId: options.clientId }),
            },
          );
          // Only the unfiltered list is worth remembering: a filtered one
          // would shrink the catalog an offline picker can offer.
          if (!options?.includeArchived && options?.clientId === undefined) {
            await remember({ projects });
          }
          return projects;
        },
        async () => (await loadCache()).projects,
      ),

    tasks: (options) =>
      reading(
        async () => {
          const tasks = await client.query<TaskWithStats[]>("tasks.list", {
            includeArchived: options?.includeArchived ?? false,
          });
          if (!options?.includeArchived) await remember({ tasks });
          return tasks;
        },
        async () => (await loadCache()).tasks,
      ),

    tags: (options) =>
      reading(
        async () => {
          const tags = await client.query<TagWithStats[]>("tags.list", {
            includeArchived: options?.includeArchived ?? false,
          });
          if (!options?.includeArchived) await remember({ tags });
          return tags;
        },
        async () => (await loadCache()).tags,
      ),

    clients: (options) =>
      reading(
        async () => {
          const clients = await client.query<Client[]>("clients.list", {
            includeArchived: options?.includeArchived ?? false,
          });
          if (!options?.includeArchived) await remember({ clients });
          return clients;
        },
        async () => (await loadCache()).clients,
      ),

    // Catalog writes mint ids the server owns, and an entry cannot reference
    // an id that does not exist yet — so none of them are queueable. Offline
    // they fail loudly, which is the honest answer: the project the user is
    // trying to create is not available to file anything under.
    createClient: (input) =>
      client.mutate<Client>("clients.create", { ...input, originId }),
    updateClient: (input) =>
      client.mutate<Client>("clients.update", { ...input, originId }),

    createProject: (input) =>
      client.mutate<Project>("projects.create", { ...input, originId }),
    updateProject: (input) =>
      client.mutate<Project>("projects.update", { ...input, originId }),

    createTask: (input) =>
      client.mutate<Task>("tasks.create", { ...input, originId }),
    updateTask: (input) =>
      client.mutate<Task>("tasks.update", { ...input, originId }),

    createTag: (input) =>
      client.mutate<Tag>("tags.create", { ...input, originId }),
    updateTag: (input) =>
      client.mutate<Tag>("tags.update", { ...input, originId }),

    settings: () =>
      reading(
        async () => {
          const settings = await client.query<ResolvedSettings>("settings.get");
          await remember({ settings });
          return settings;
        },
        async () => {
          const settings = (await loadCache()).settings;
          if (settings === null) {
            throw new ApiError(
              "Settings have never been loaded on this Mac",
              "NOT_FOUND",
              404,
            );
          }
          return settings;
        },
      ),

    /** Replay what is queued, and report what is left. */
    sync: () => drain(),
  };
};

/**
 * Build a caller bound to the stored session.
 *
 * Throws {@link NotSignedInError} when there is no token, which every command
 * turns into "run Sign in to Track Your Time" rather than a raw failure toast.
 */
export async function getTrackYourTime(): Promise<TrackYourTime> {
  const session = await getStoredSession();
  if (!session) throw new NotSignedInError();

  const client = createApiClient({
    baseUrl: apiUrl(),
    token: session.token,
    clientId: CLIENT_ID,
  });

  return wrap(client, await getOriginId());
}
