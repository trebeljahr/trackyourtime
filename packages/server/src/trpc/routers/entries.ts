// The tRPC surface over the entry services.
//
// Every resolver here is one line: resolve the scope, call the service. The
// logic lives in `services/entries/` because the public REST API calls the
// same functions without ever entering tRPC — no synthetic context, no token
// path through `workspaceProcedure`, so a token request can never reach
// `workspaceIdFromInput` and can never name a workspace of its own.
//
// The invariants those services own are documented on them; the two worth
// repeating at the boundary:
//  - At most ONE running entry (`end === null`) per PERSON, across every
//    workspace they belong to, so the running-timer paths are author-scoped
//    and carry no workspace filter.
//  - Every query/mutation is scoped by `ctx.workspaceId` — a document in
//    another workspace is indistinguishable from a missing one (NOT_FOUND,
//    never FORBIDDEN).
import {
  createEntrySchema,
  entryListSchema,
  continueEntrySchema,
  idInputSchema,
  entryDescriptionsSchema,
  recentEntriesSchema,
  resolveRunawaySchema,
  startTimerSchema,
  stopTimerSchema,
  updateEntrySchema,
  type DetailedEntry,
  type RecentEntry,
  type StartTimerReplaced,
  type TimeEntry as TimeEntryWire,
  type DescriptionSuggestion,
  workspaceScopeSchema,
} from "@starter/shared";
import { scopeFromContext } from "../../services/scope.js";
import {
  createEntry,
  deleteEntry,
  updateEntry,
} from "../../services/entries/crud.js";
import {
  getEntry,
  listEntries,
  entryDescriptions,
  recentEntries,
} from "../../services/entries/list.js";
import {
  continueEntryDetailed,
  currentEntry,
  discardTimer,
  discardTimerSchema,
  personReach,
  replacedByStart,
  resolveRunawayEntry,
  startTimerDetailed,
  stopTimer,
  type StartedEntry,
} from "../../services/entries/timer.js";
import { productionMembershipStore } from "../../services/membership/stores.js";
import { workspaceName } from "../../services/membership/workspaces.js";
import { router, workspaceProcedure } from "../trpc.js";

// Re-exported from their new homes so the existing unit tests and the sibling
// routers that import them keep working unchanged.
export { discardTimerSchema };
export { invoicedEntryEditRefusal } from "../../services/entries/invoice-guard.js";
export {
  MAX_ENTRY_TAGS,
  normalizeTagIds,
} from "../../services/entries/tags.js";

/** What `start` and `continue` answer: the new entry, and what it replaced. */
export type StartedTimerWire = TimeEntryWire & { replaced: StartTimerReplaced | null };

/**
 * Attach the cross-workspace timer a start closed, if any. See
 * `replacedByStart` — the client has to say "your timer in Acme stopped",
 * because nothing in the workspace being looked at shows it.
 */
async function withReplaced(
  started: StartedEntry,
  workspaceId: string,
): Promise<StartedTimerWire> {
  const replaced = await replacedByStart(
    started.stopped,
    workspaceId,
    async (id) => workspaceName(await productionMembershipStore(), id),
  );
  return { ...started.entry, replaced };
}

export const entriesRouter = router({
  list: workspaceProcedure
    .input(entryListSchema)
    .query(
      async ({
        ctx,
        input,
      }): Promise<{ entries: DetailedEntry[]; nextCursor?: string }> =>
        listEntries(scopeFromContext(ctx), input),
    ),

  recent: workspaceProcedure
    .input(recentEntriesSchema)
    .query(async ({ ctx, input }): Promise<RecentEntry[]> =>
      recentEntries(scopeFromContext(ctx), input),
    ),

  /**
   * Descriptions this person has used before — the autocomplete behind every
   * client's description field.
   *
   * Sibling of `recent` rather than a mode of it: recents are keyed on the
   * whole (description, project, task, billable) combination and answer
   * "resume this job", while these are keyed on the description alone and
   * answer "you have called work this before".
   */
  descriptions: workspaceProcedure
    .input(entryDescriptionsSchema)
    .query(async ({ ctx, input }): Promise<DescriptionSuggestion[]> =>
      entryDescriptions(scopeFromContext(ctx), input),
    ),

  get: workspaceProcedure
    .input(idInputSchema)
    .query(async ({ ctx, input }): Promise<TimeEntryWire> =>
      getEntry(scopeFromContext(ctx), input.id),
    ),

  current: workspaceProcedure.input(workspaceScopeSchema).query(
    async ({ ctx }): Promise<TimeEntryWire | null> =>
      // `personReach`: a tRPC caller is authenticated as the PERSON, so the
      // running timer is theirs to see wherever it runs. A workspace-bound API
      // token is a different principal and passes a confined reach instead —
      // see TimerReach in services/entries/timer.ts.
      currentEntry(scopeFromContext(ctx), personReach),
  ),

  start: workspaceProcedure
    .input(startTimerSchema)
    .mutation(async ({ ctx, input }): Promise<StartedTimerWire> =>
      // `personReach` — see `current` above. Starting here stops whatever the
      // person had running, in whichever workspace it ran: that is the intent
      // of a session principal pressing Start, and it is what keeps them from
      // ending up with two running timers. `replaced` names it when it ran in
      // another workspace.
      withReplaced(
        await startTimerDetailed(scopeFromContext(ctx), input, personReach),
        ctx.workspaceId,
      ),
    ),

  stop: workspaceProcedure
    .input(stopTimerSchema)
    .mutation(async ({ ctx, input }): Promise<TimeEntryWire> =>
      // `personReach` — see `current` above.
      stopTimer(scopeFromContext(ctx), input, personReach),
    ),

  resolveRunaway: workspaceProcedure
    .input(resolveRunawaySchema)
    .mutation(async ({ ctx, input }): Promise<TimeEntryWire> =>
      resolveRunawayEntry(scopeFromContext(ctx), input),
    ),

  discard: workspaceProcedure
    .input(discardTimerSchema)
    .mutation(
      async ({ ctx, input }): Promise<{ success: true; id: string }> =>
        discardTimer(scopeFromContext(ctx), input),
    ),

  continue: workspaceProcedure
    .input(continueEntrySchema)
    .mutation(async ({ ctx, input }): Promise<StartedTimerWire> =>
      withReplaced(
        await continueEntryDetailed(scopeFromContext(ctx), input),
        ctx.workspaceId,
      ),
    ),

  create: workspaceProcedure
    .input(createEntrySchema)
    .mutation(async ({ ctx, input }): Promise<TimeEntryWire> =>
      createEntry(scopeFromContext(ctx), input),
    ),

  update: workspaceProcedure
    .input(updateEntrySchema)
    .mutation(async ({ ctx, input }): Promise<TimeEntryWire> =>
      updateEntry(scopeFromContext(ctx), input),
    ),

  remove: workspaceProcedure
    .input(idInputSchema)
    .mutation(
      async ({ ctx, input }): Promise<{ success: true; id: string }> =>
        deleteEntry(scopeFromContext(ctx), input),
    ),
});
