// The running timer: starting, stopping, discarding, continuing, and the
// runaway prompt.
//
// The invariant this file owns: at most ONE running entry (`end === null`) per
// PERSON, across every workspace they belong to. The running entry may live in
// a DIFFERENT workspace than the request, so the running-timer helpers here are
// author-scoped by default and carry no workspace filter of their own. Each
// event is published into the affected entry's own workspace, which may not be
// the one the request came in for — otherwise the colleagues watching that
// other workspace would never see the timer stop.
//
// `TimerReach` is what qualifies that for a principal who is NOT the person.
// Every helper a workspace-bound API token can reach takes one — `currentEntry`
// and `stopTimer` for the reads and the explicit stop, `startTimer` and the
// `stopRunningEntry` underneath it for the implicit stop a start performs —
// required and without a default. Author-scoped is right when the principal is
// the PERSON and wrong when it is a TOKEN. See the type for which is which.
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  resolvedEndMs,
  type ContinueEntryInput,
  type EntrySource,
  type ResolveRunawayInput,
  type RunawayMark,
  type StartTimerInput,
  type StopTimerInput,
  type TimeEntry as TimeEntryWire,
} from "@starter/shared";
import { TimeEntry, toClientTimeEntry } from "../../models/TimeEntry.js";
import { getOrCreateWorkspaceSettings } from "../../models/Settings.js";
import { authorScopeFilter } from "../../models/WorkspaceMember.js";
import { durationBetween, finalizeStop, snapshotRate } from "../entry-stop.js";
import { enforceMaxEntryDuration } from "../runaway.js";
import { emitWebhookEvent } from "../webhooks/emit.js";
import { publishSync } from "../../ws/sync.js";
import type { WorkspaceScope } from "../scope.js";
import {
  badRequest,
  isDuplicateKeyError,
  notFound,
  requireObjectId,
} from "./errors.js";
import { resolveRefs } from "./refs.js";
import { filterKnownTagIds, resolveTagIds } from "./tags.js";

/**
 * How far a running-timer lookup may reach.
 *
 * Two different principals ask "what is running?", and the honest answer is
 * not the same for both:
 *
 *  - `person` — a cookie or bearer SESSION. The principal IS the human, who
 *    belongs to every workspace their one running timer could be in, so "show
 *    me / stop whatever I have running" means exactly that, wherever it lives.
 *    That is what the extension badge and the Raycast menu bar render, and it
 *    is why everything else in this file is author-scoped.
 *  - `workspace` — an API TOKEN. The principal is the TOKEN, bound to one
 *    workspace and typically handed to somebody who is not the person: a
 *    contractor's integration, say. A workspace-A token that read the person's
 *    timer running in workspace B would hand out another client's description
 *    and hourly rate, and stopping it would end that client's billable time and
 *    fire `entry.stopped` webhooks into a workspace this token cannot even
 *    name — `requireApiToken` already answers 400 workspace-not-addressable to
 *    a request that tries to name one.
 *
 * The parameter is REQUIRED wherever it appears, and deliberately has no
 * default. A default could only be `person`, the permissive value, and the
 * failure this type exists to prevent is precisely a new call site crossing
 * workspaces by saying nothing at all. Forgetting it is a compile error.
 */
export type TimerReach =
  | { kind: "person" }
  | { kind: "workspace"; workspaceId: string };

/** A session principal: the person's timer, in whichever workspace it runs. */
export const personReach: TimerReach = { kind: "person" };

/** A token principal: only a timer running in the workspace it is bound to. */
export function workspaceReach(workspaceId: string): TimerReach {
  return { kind: "workspace", workspaceId };
}

/**
 * The extra `find` criteria a reach imposes — none for a person, the bound
 * workspace for a token.
 */
export function reachFilter(reach: TimerReach): { workspaceId?: string } {
  return reach.kind === "workspace" ? { workspaceId: reach.workspaceId } : {};
}

/**
 * The same confinement as a bare value, for `enforceMaxEntryDuration`.
 *
 * The runaway guard lives in services/runaway.ts, which this module imports —
 * it cannot import `TimerReach` back without a cycle, so it takes the
 * workspace id (or `null` for a person) and the translation happens here,
 * once, instead of at each call site.
 */
export function reachWorkspaceId(reach: TimerReach): string | null {
  return reach.kind === "workspace" ? reach.workspaceId : null;
}

/**
 * The entry back, or null when it turned out to live outside `reach`.
 *
 * The value-level half of `reachFilter`, for the one result that does not come
 * from a query this file wrote: the runaway guard hands back whatever entry it
 * acted on. The guard now takes the confinement too, so this is a belt beside
 * that brace — kept, because the day someone gives the guard a caller that
 * cannot confine it, the flagged entry still must not be handed to a caller
 * outside its workspace.
 */
export function withinReach<T extends { workspaceId: string }>(
  entry: T,
  reach: TimerReach,
): T | null {
  if (reach.kind === "person") return entry;
  return entry.workspaceId === reach.workspaceId ? entry : null;
}

/**
 * What a confined start answers instead of closing a foreign timer.
 *
 * CONFLICT, so the REST layer maps it to 409: the request is refused because of
 * state the caller can do something about, not because it was malformed and not
 * because a permission is missing. The wording names the situation and the
 * remedy without naming the other workspace, which this principal has no
 * standing to be told about.
 *
 * A plain `TRPCError` rather than a problem type of its own, because the
 * services deliberately have exactly one error taxonomy — see
 * `entries/errors.ts`. It surfaces as `problems/conflict` with this detail.
 */
const timerRunningElsewhere = (): TRPCError =>
  new TRPCError({
    code: "CONFLICT",
    message:
      "A timer is already running in another workspace. Stop it from a client signed in there before starting one here.",
  });

/** `discard` drops an entry without keeping it; defaults to the running one. */
export const discardTimerSchema = z.object({
  id: z.string().min(1).optional(),
  originId: z.string().max(64).optional(),
});

export type DiscardTimerInput = z.infer<typeof discardTimerSchema>;

/**
 * Stop whatever this principal has running, at `at` (never before its start).
 *
 * Under `personReach`, deliberately not workspace-scoped: the invariant is one
 * running timer per human across every workspace, so starting a timer in one
 * workspace stops the one running in another. The stop event is published into
 * the stopped entry's own workspace, which may not be the one the request came
 * in for — otherwise the colleagues watching that other workspace would never
 * see it stop.
 *
 * Under a workspace reach it stops only a timer running in THAT workspace and
 * leaves a foreign one untouched — no rate snapshot, no ended billable period,
 * no `entry.stopped` delivered into a workspace the token cannot address. It is
 * the second line of defence rather than the first: `startTimer` refuses a
 * confined start outright when the running timer is elsewhere, and this filter
 * is what keeps the window between that check and this write from crossing
 * anyway. The insert then loses to the running-entry unique index and the
 * caller gets a CONFLICT, which is the honest answer.
 */
export const stopRunningEntry = async (
  authorId: string,
  at: Date,
  reach: TimerReach,
  originId?: string,
): Promise<void> => {
  const running = await TimeEntry.findOne({
    authorId,
    end: null,
    ...reachFilter(reach),
  }).lean();
  if (!running) return;

  const endMs = Math.max(at.getTime(), running.start.getTime());
  const stopped = await finalizeStop(running, new Date(endMs));
  if (stopped) {
    void publishSync(
      running.workspaceId,
      { kind: "timer.stopped", entry: stopped },
      originId,
    );
    emitWebhookEvent(running.workspaceId, "entry.stopped", {
      kind: "entry",
      entry: stopped,
    });
  }
};

export type StartArgs = {
  workspaceId: string;
  authorId: string;
  description: string;
  projectId: string | null;
  taskId: string | null;
  /** `undefined` falls back to the project's `billableDefault`. */
  billable: boolean | undefined;
  start: Date;
  source: EntrySource;
  /** IANA zone the caller is in. See TimeEntry.timeZone in @starter/shared. */
  timeZone?: string | null;
  /** Tags to open the entry with; `undefined` means none. */
  tagIds?: readonly string[];
  /**
   * How far the stop that precedes this start may reach. Required, and part of
   * the args object rather than a defaulted parameter, so a new caller has to
   * name the principal instead of inheriting the permissive one by silence.
   */
  reach: TimerReach;
  originId?: string;
};

/**
 * Stop the running entry, then open a new one. Shared by `start` and
 * `continue` so both go through exactly one code path.
 *
 * The stop is `args.reach`-confined: under a workspace reach a timer running
 * elsewhere is left alone, and the insert below then fails on the running-entry
 * unique index rather than the foreign entry being closed.
 */
export const startNewEntry = async (args: StartArgs): Promise<TimeEntryWire> => {
  const refs = await resolveRefs(args.workspaceId, args.projectId, args.taskId);
  const tagIds = (await resolveTagIds(args.workspaceId, args.tagIds)) ?? [];
  const billable = args.billable ?? refs.project?.billableDefault ?? false;
  const settings = await getOrCreateWorkspaceSettings(args.workspaceId);
  const { hourlyRate, currency } = snapshotRate(
    billable,
    refs.project,
    settings,
  );

  const insert = async (): Promise<TimeEntryWire> => {
    const created = await TimeEntry.create({
      workspaceId: args.workspaceId,
      authorId: args.authorId,
      description: args.description,
      projectId: refs.projectId,
      taskId: refs.taskId,
      billable,
      start: args.start,
      end: null,
      durationSec: 0,
      hourlyRate,
      currency,
      source: args.source,
      timeZone: args.timeZone ?? null,
      tagIds,
    });
    return toClientTimeEntry(created);
  };

  await stopRunningEntry(args.authorId, args.start, args.reach, args.originId);

  try {
    return await insert();
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    // A concurrent start slipped in between our stop and our insert — or, for
    // a confined caller, the running entry is one this reach may not stop and
    // the retry will lose to the index again. Either way the second failure
    // below is a CONFLICT and nothing foreign was touched.
    await stopRunningEntry(args.authorId, args.start, args.reach, args.originId);
    try {
      return await insert();
    } catch (retryError) {
      if (!isDuplicateKeyError(retryError)) throw retryError;
      throw new TRPCError({
        code: "CONFLICT",
        message: "Another timer is already running",
      });
    }
  }
};

/**
 * The running entry (`end === null`), or null when the timer is stopped.
 *
 * Under `personReach` this is deliberately NOT workspace-scoped. The invariant
 * is one running timer per person across every workspace, so it must answer
 * "what am I doing right now" wherever that timer lives — which is exactly
 * what the extension badge and the Raycast menu bar render. The entry carries
 * its own `workspaceId` so a caller can say "running in Acme".
 *
 * Under a workspace reach it answers null instead of a timer running
 * elsewhere. See {@link TimerReach}.
 */
export async function currentEntry(
  scope: WorkspaceScope,
  reach: TimerReach,
): Promise<TimeEntryWire | null> {
  // A confined caller leaves early when the person's timer is running in
  // another workspace, rather than waking the guard for an entry it is then
  // going to withhold anyway. The guard is confined too (it is handed the same
  // reach below), so this is an early exit and not the confinement itself —
  // deleting it would cost a read, not correctness.
  if (reach.kind === "workspace") {
    const here = await TimeEntry.findOne({
      authorId: scope.userId,
      workspaceId: reach.workspaceId,
      end: null,
    }).lean();
    if (!here) return null;
  }

  // Where the runaway guard is evaluated on read. The runaway-reminder job
  // evaluates it on a schedule too; this is the fallback between polls and
  // with the scheduler off, and both are idempotent against each other.
  // Confined by the same reach as the query below it, and for the same
  // reason. See services/runaway.ts.
  const outcome = await enforceMaxEntryDuration(
    scope.userId,
    reachWorkspaceId(reach),
  );
  // The guard already holds the authoritative document; re-reading it
  // would only re-race the write that just landed.
  if (outcome.kind === "ended") return null;
  if (outcome.kind === "flagged") return withinReach(outcome.entry, reach);

  const running = await TimeEntry.findOne({
    authorId: scope.userId,
    end: null,
    ...reachFilter(reach),
  }).lean();
  return running ? toClientTimeEntry(running) : null;
}

/**
 * Open a new timer, closing whatever this principal already had running.
 *
 * A start is the one running-timer WRITE that reaches past the workspace it is
 * addressed to, because the entry it closes may be in another one. For the
 * PERSON that is the whole point. For a workspace-bound TOKEN it would be a
 * mutation of a workspace it is answered 400 workspace-not-addressable for the
 * moment it names one — the foreign entry stopped, its rate snapshotted, that
 * client's billable period ended, and `timer.stopped` / `entry.stopped`
 * delivered to watchers and webhook subscribers who are not this token's
 * business. Hence the required `reach`. See {@link TimerReach}.
 */
export async function startTimer(
  scope: WorkspaceScope,
  input: StartTimerInput,
  reach: TimerReach,
): Promise<TimeEntryWire> {
  const start = input.start ? new Date(input.start) : new Date();
  if (Number.isNaN(start.getTime())) throw badRequest("Invalid start");

  // The confined behaviour, chosen rather than inherited: REFUSE. The two
  // honest options were to refuse, or to start here and leave the foreign
  // timer running — and the second breaks the one invariant this file exists
  // to hold, one running entry per person. Silently starting nothing is not on
  // the list at all; a caller whose timer did not start must not be told it
  // did.
  //
  // The refusal does disclose that SOMETHING is running somewhere, which
  // `currentEntry` and `stopTimer` deliberately withhold. It is the smallest
  // possible disclosure and an unavoidable one: the partial-unique index on the
  // running entry refuses the insert regardless, so this token learns the same
  // one bit from a duplicate-key CONFLICT it cannot be denied. Nothing ABOUT
  // the entry — its workspace, description, project or rate — crosses.
  if (reach.kind === "workspace") {
    const running = await TimeEntry.findOne({
      authorId: scope.userId,
      end: null,
    }).lean();
    if (running && running.workspaceId !== reach.workspaceId) {
      throw timerRunningElsewhere();
    }
  }

  // Before `startNewEntry` closes whatever is running at `now` and hides
  // the evidence. A runaway that is merely superseded by the next start
  // keeps all 63 hours and is never mentioned again; run it through the
  // guard first so it is capped, or at least marked, either way.
  //
  // The guard is handed the reach as well, not just trusted to be safe
  // because of the check above. The check narrows a race it cannot close on
  // its own: a timer opened in another workspace between the two reads would
  // otherwise be capped or flagged by THIS request, and `timer.stopped`
  // published into a workspace this token cannot address — the same crossing,
  // arriving through the back door.
  await enforceMaxEntryDuration(scope.userId, reachWorkspaceId(reach), start);

  const entry = await startNewEntry({
    workspaceId: scope.workspaceId,
    authorId: scope.userId,
    reach,
    description: input.description ?? "",
    projectId: input.projectId ?? null,
    taskId: input.taskId ?? null,
    billable: input.billable,
    start,
    source: input.source ?? "web",
    timeZone: input.timeZone ?? null,
    ...(input.tagIds ? { tagIds: input.tagIds } : {}),
    originId: input.originId,
  });

  void publishSync(
    scope.workspaceId,
    { kind: "timer.started", entry },
    input.originId,
  );
  emitWebhookEvent(scope.workspaceId, "entry.started", {
    kind: "entry",
    entry,
  });
  return entry;
}

export async function stopTimer(
  scope: WorkspaceScope,
  input: StopTimerInput,
  reach: TimerReach,
): Promise<TimeEntryWire> {
  // Author-scoped, not workspace-scoped: you may always stop your own
  // timer, including from a client currently pointed at a different
  // workspace. Stopping somebody else's is not a thing that exists.
  //
  // `reach` is what qualifies that for a TOKEN principal, which is not the
  // person: confined, a timer running in another workspace is simply not
  // found, so the token can neither end that client's billable time nor
  // deliver `entry.stopped` webhooks into a workspace it cannot address. The
  // answer is NOT_FOUND rather than FORBIDDEN, so the endpoint also cannot be
  // used to learn that a timer is running somewhere out of view.
  const authorId = scope.userId;
  const confinement = reachFilter(reach);
  const running = input.id
    ? await TimeEntry.findOne({
        _id: requireObjectId(input.id, "Entry not found"),
        authorId,
        ...confinement,
      }).lean()
    : await TimeEntry.findOne({
        authorId,
        end: null,
        ...confinement,
      }).lean();

  if (!running) throw notFound("No running timer");
  if (running.end !== null) throw badRequest("Entry is not running");

  const end = input.end ? new Date(input.end) : new Date();
  if (Number.isNaN(end.getTime())) throw badRequest("Invalid end");
  if (end.getTime() <= running.start.getTime()) {
    throw badRequest("End must be after start");
  }

  const stopped = await finalizeStop(running, end);
  if (!stopped) throw badRequest("Entry is not running");

  void publishSync(
    running.workspaceId,
    { kind: "timer.stopped", entry: stopped },
    input.originId,
  );
  emitWebhookEvent(running.workspaceId, "entry.stopped", {
    kind: "entry",
    entry: stopped,
  });
  return stopped;
}

/**
 * Answer the runaway prompt.
 *
 * The one thing this exists to guarantee is that a cap is never final:
 * `restore` puts back exactly the span the guard measured, because the mark
 * kept `elapsedSec` alongside the entry's own `start`. Nothing the guard does
 * is ever a one-way door.
 *
 * `cap` and `restore` recompute their instant here from the mark rather than
 * trusting one off the wire; only `end-at` takes a client-supplied time, and
 * it is validated like any other manual edit.
 *
 * Author-scoped, like `stop` and `discard`: the entry may be in a workspace
 * the caller is not currently pointed at, and answering a question about
 * your own timer must work from wherever you happen to be. The event goes
 * into the entry's own workspace.
 */
export async function resolveRunawayEntry(
  scope: WorkspaceScope,
  input: ResolveRunawayInput,
): Promise<TimeEntryWire> {
  const authorId = scope.userId;
  const existing = await TimeEntry.findOne({
    _id: requireObjectId(input.id, "Entry not found"),
    authorId,
  }).lean();
  if (!existing) throw notFound();
  if (!existing.runaway) {
    throw badRequest("Entry has no runaway timer to resolve");
  }

  const mark: RunawayMark = {
    detectedAt: existing.runaway.detectedAt.toISOString(),
    elapsedSec: existing.runaway.elapsedSec,
    limitSec: existing.runaway.limitSec,
    action: existing.runaway.action,
    resolvedAt: null,
  };

  const suppliedEndMs = input.end === undefined ? null : Date.parse(input.end);
  if (suppliedEndMs !== null && Number.isNaN(suppliedEndMs)) {
    throw badRequest("Invalid end");
  }
  if (input.resolution === "end-at" && suppliedEndMs === null) {
    throw badRequest("An end is required to set the real end time");
  }

  const startMs = existing.start.getTime();
  const endMs = resolvedEndMs(input.resolution, startMs, mark, suppliedEndMs);
  const resolvedAt = new Date();

  // "keep" — dismiss and change nothing. It means the same thing whether
  // the entry is still running (keep running, this really is a long
  // session) or already capped (the cap was right).
  if (endMs === null) {
    const kept = await TimeEntry.findOneAndUpdate(
      { _id: String(existing._id), authorId },
      { $set: { "runaway.resolvedAt": resolvedAt } },
      { returnDocument: "after" },
    ).lean();
    if (!kept) throw notFound();

    const entry = toClientTimeEntry(kept);
    void publishSync(
      existing.workspaceId,
      { kind: "entry.upserted", entry },
      input.originId,
    );
    emitWebhookEvent(existing.workspaceId, "entry.updated", {
      kind: "entry",
      entry,
    });
    return entry;
  }

  if (endMs <= startMs) throw badRequest("End must be after start");

  // A running entry goes through the same stop path as any other stop, so
  // the rate snapshot is taken exactly once and in exactly one place — and
  // from the entry's workspace, not the caller's. An already-ended entry
  // keeps the snapshot it was stopped with: only the boundary moves, and
  // the money inputs did not change.
  if (existing.end === null) {
    const stopped = await finalizeStop(existing, new Date(endMs));
    if (!stopped) throw badRequest("Entry is not running");

    const resolved = await TimeEntry.findOneAndUpdate(
      { _id: String(existing._id), authorId },
      { $set: { "runaway.resolvedAt": resolvedAt } },
      { returnDocument: "after" },
    ).lean();
    const entry = resolved ? toClientTimeEntry(resolved) : stopped;

    void publishSync(
      existing.workspaceId,
      { kind: "timer.stopped", entry },
      input.originId,
    );
    emitWebhookEvent(existing.workspaceId, "entry.stopped", {
      kind: "entry",
      entry,
    });
    return entry;
  }

  const updated = await TimeEntry.findOneAndUpdate(
    { _id: String(existing._id), authorId },
    {
      $set: {
        end: new Date(endMs),
        durationSec: durationBetween(existing.start, new Date(endMs)),
        "runaway.resolvedAt": resolvedAt,
      },
    },
    { returnDocument: "after" },
  ).lean();
  if (!updated) throw notFound();

  const entry = toClientTimeEntry(updated);
  void publishSync(
    existing.workspaceId,
    { kind: "entry.upserted", entry },
    input.originId,
  );
  emitWebhookEvent(existing.workspaceId, "entry.updated", {
    kind: "entry",
    entry,
  });
  return entry;
}

/** Delete the running entry instead of keeping it. */
export async function discardTimer(
  scope: WorkspaceScope,
  input: DiscardTimerInput,
): Promise<{ success: true; id: string }> {
  // Author-scoped for the same reason as `stop`.
  const authorId = scope.userId;
  const running = input.id
    ? await TimeEntry.findOne({
        _id: requireObjectId(input.id, "Entry not found"),
        authorId,
        end: null,
      }).lean()
    : await TimeEntry.findOne({ authorId, end: null }).lean();

  if (!running) throw notFound("No running timer");

  const id = String(running._id);
  await TimeEntry.deleteOne({ _id: id, authorId });
  void publishSync(
    running.workspaceId,
    { kind: "entry.deleted", id },
    input.originId,
    // Without an author the fan-out fails closed, and a restricted member's
    // own other devices would keep showing the discarded timer.
    { authorId },
  );
  emitWebhookEvent(running.workspaceId, "entry.deleted", {
    kind: "entry-deleted",
    id,
    // Carried explicitly: the row is gone by send time, so there is nothing
    // left to look the author up on, and without an author the delivery's
    // visibility check could only fail closed.
    authorId,
  });
  return { success: true, id };
}

/** Start a new timer with the same description/project/task/billable. */
export async function continueEntry(
  scope: WorkspaceScope,
  input: ContinueEntryInput,
): Promise<TimeEntryWire> {
  const workspaceId = scope.workspaceId;
  const source = await TimeEntry.findOne({
    _id: requireObjectId(input.id, "Entry not found"),
    workspaceId,
    ...(authorScopeFilter(scope.visibility) ?? {}),
  }).lean();
  if (!source) throw notFound();

  const entry = await startNewEntry({
    workspaceId,
    authorId: scope.userId,
    // `continue` has no REST route — it is reachable only through tRPC, whose
    // principal is the person, so the stop it performs is the person-wide one
    // every session client expects. Named here rather than defaulted so that
    // exposing this over the token API is a decision somebody has to make on
    // this line, the way `startTimer` made it: pass a reach in, do not leave a
    // token stopping timers in workspaces it cannot address.
    reach: personReach,
    description: source.description,
    projectId: source.projectId,
    taskId: source.taskId,
    billable: source.billable,
    start: new Date(),
    source: source.source,
    // A continued entry is being recorded NOW, wherever the person now is,
    // so it takes the caller's zone rather than inheriting the original's.
    timeZone: input.timeZone ?? null,
    // Tags go the OTHER way: continuing is "more of this same work", so
    // the labels that described it still describe it. A tag deleted since
    // then is dropped rather than copied forward dead — see
    // `filterKnownTagIds` for why this path is lenient.
    tagIds: await filterKnownTagIds(workspaceId, source.tagIds),
    originId: input.originId,
  });

  void publishSync(
    workspaceId,
    { kind: "timer.started", entry },
    input.originId,
  );
  emitWebhookEvent(workspaceId, "entry.started", { kind: "entry", entry });
  return entry;
}
