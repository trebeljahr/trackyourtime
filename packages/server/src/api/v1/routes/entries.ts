import { withEntryOperation } from "../../../services/entries/operation.js";
// Time-entry routes.
//
// Every handler is a thin shell: parse with the SAME zod schema the tRPC
// procedure uses, build a `WorkspaceScope` from the token, call the SAME
// extracted service function, project the result for what this token may see.
// No business rule is re-implemented here — that is the point of the layer.
// The services already publish the ws/sync events and enqueue the webhook
// deliveries, so a REST mutation moves the web app exactly as a tRPC one does.
import {
  projectDetailedEntry,
  projectEntryForVisibility,
  createEntrySchema,
  entryListSchema,
  startTimerSchema,
  stopTimerSchema,
  updateEntrySchema,
} from "@starter/shared";
import { scopeFromApiToken } from "../../../services/scope.js";
import {
  createEntry,
  deleteEntry,
  updateEntry,
} from "../../../services/entries/crud.js";
import { getEntry, listEntries } from "../../../services/entries/list.js";
import {
  currentEntry,
  startTimer,
  stopTimer,
  workspaceReach,
} from "../../../services/entries/timer.js";
import type { ApiHandlers } from "../auth.js";
import { sendData, sendList } from "../envelope.js";
import { asObject, coerceQuery, parseWith } from "../query.js";
import { idPathSchema } from "../routes-table.js";
import { notFoundProblem } from "../problem.js";
import { requireMoneyVisibility } from "./reports.js";

export const entryHandlers: ApiHandlers = {
  "get /entries": async (req, res) => {
    const scope = scopeFromApiToken(req.apiToken);
    // The same refusal the report layer raises, for the same reason: every row
    // here carries an `amount`, and a colleague's row with the rate stripped
    // comes back as `amount: 0` — indistinguishable from genuinely unbillable
    // time. An integration summing `data[].amount` would under-report by
    // whatever share is colleagues', with no error to notice. A page of
    // honest-looking zeros is worse than a 403, so this list refuses exactly
    // where `/reports/*` refuses rather than serving the shape reports decline.
    requireMoneyVisibility(scope.visibility);
    const input = parseWith(entryListSchema, coerceQuery(req.apiQuery, entryListSchema));
    const page = await listEntries(scope, input);

    // The query already dropped rows this caller may not see (the service
    // applies `authorScopeFilter` to the same `$match` it aggregates on). The
    // pass below is the value-level half of the same rule: it strips the rate
    // off a colleague's row when `canViewOthersMoney` is off, and would drop a
    // row entirely if the query filter were ever weakened.
    const rows = page.entries
      .map((entry) => projectDetailedEntry(entry, scope.visibility))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    // The cursor is whatever the service handed back, passed through
    // unchanged. It is deliberately NOT re-encoded through services/cursor.ts:
    // the entry list kept its own legacy encoding so that re-deploying does
    // not jump every open page mid-scroll. To this layer it is opaque.
    sendList(res, rows, page.nextCursor ?? null);
  },

  "get /entries/current": async (req, res) => {
    const scope = scopeFromApiToken(req.apiToken);
    // Confined to the token's own workspace. The service is author-scoped by
    // default because a SESSION's principal is the person, who may look at
    // their one running timer wherever it happens to be. A TOKEN's principal
    // is the token: bound to one workspace, and often held by somebody who is
    // not the person at all. Unconfined, a workspace-A token would read back
    // `{ workspaceId: "<B>", description: "...", hourlyRate: ... }` — another
    // client's work, from a workspace this token is refused for by name (400
    // workspace-not-addressable) the moment it asks for it explicitly.
    const entry = await currentEntry(scope, workspaceReach(scope.workspaceId));
    sendData(res, entry);
  },

  "get /entries/:id": async (req, res) => {
    const scope = scopeFromApiToken(req.apiToken);
    const { id } = parseWith(idPathSchema, req.params);
    const entry = await getEntry(scope, id);
    const visible = projectEntryForVisibility(entry, scope.visibility);
    // A row the caller may not see reads as missing, never as forbidden — a
    // 403 would confirm that an entry with that id exists in this workspace.
    if (!visible) throw notFoundProblem("Entry not found");
    sendData(res, visible);
  },

  "post /entries": async (req, res) => {
    const scope = scopeFromApiToken(req.apiToken);
    const input = parseWith(createEntrySchema, asObject(req.body));
    // Not projected: writes are author-only, so the entry that comes back is
    // the caller's own and its rate is their own money.
    sendData(res, await withEntryOperation(scope, "api:entries.create", input, () => createEntry(scope, input)));
  },

  "patch /entries/:id": async (req, res) => {
    const scope = scopeFromApiToken(req.apiToken);
    // The path is authoritative for the id. `updateEntrySchema` carries
    // refinements (`end` after `start`), which zod will not let us `.omit()`
    // a field out of — so the shared schema is used whole and the path id is
    // merged in over anything the body claimed.
    const input = parseWith(updateEntrySchema, {
      ...asObject(req.body),
      id: req.params.id,
    });
    sendData(res, await withEntryOperation(scope, "api:entries.update", input, () => updateEntry(scope, input)));
  },

  "delete /entries/:id": async (req, res) => {
    const scope = scopeFromApiToken(req.apiToken);
    const { id } = parseWith(idPathSchema, req.params);
    sendData(res, await deleteEntry(scope, { id }));
  },

  "post /entries/start": async (req, res) => {
    const scope = scopeFromApiToken(req.apiToken);
    const input = parseWith(startTimerSchema, asObject(req.body));
    // `source` defaults to "web" in the service; a token client that does not
    // say otherwise is an API caller, so name it as one. An explicit `source`
    // in the body still wins — the browser extension and Raycast set their own.
    //
    // Confined, and here the confinement is about a WRITE this route performs
    // implicitly: a start closes whatever was running, and unconfined that is
    // an entry in a workspace this token cannot even name — its billable
    // period ended, its rate snapshotted, `entry.stopped` fired to that
    // workspace's subscribers. Confined, such a timer is refused with 409
    // instead, because the alternative would leave the person with two running
    // timers. See `startTimer`.
    sendData(
      res,
      await withEntryOperation(scope, "api:entries.start", input, () => startTimer(
        scope,
        { source: "api", ...input },
        workspaceReach(scope.workspaceId),
      )),
    );
  },

  "post /entries/stop": async (req, res) => {
    const scope = scopeFromApiToken(req.apiToken);
    const input = parseWith(stopTimerSchema, asObject(req.body));
    // Confined for the same reason as `/entries/current`, with a mutation's
    // stakes: unconfined, this ends billable time for a client the token was
    // never issued for and fires `entry.stopped` webhooks into that other
    // workspace. A timer running outside this workspace reads as no timer at
    // all — 404, never 403.
    sendData(res, await withEntryOperation(scope, "api:entries.stop", input, () => stopTimer(scope, input, workspaceReach(scope.workspaceId))));
  },
};

