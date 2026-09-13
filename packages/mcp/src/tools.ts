// The tools, one per thing a person asks an assistant to do with their time.
//
// Every input schema starts from the zod schema `/api/v1` itself validates
// with, imported from `@starter/shared`. Fields the transport owns are removed
// (`originId` names a browser tab, `source` is stamped "api" by the server),
// and nothing is re-declared: a limit or a format changed in shared reaches
// the tool description on the next build instead of disagreeing with it.
//
// No invoice tools. v1 has no invoice routes, on purpose — see the REST
// overview — and an MCP tool that reached around it would be the first place
// money leaked past the visibility rules.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ApiTokenScope } from "@starter/shared/api-tokens";
import {
  clientListSchema,
  createClientSchema,
  createEntrySchema,
  createProjectSchema,
  createTagSchema,
  createTaskSchema,
  entryListSchema,
  projectListSchema,
  startTimerSchema,
  stopTimerSchema,
  summaryReportSchema,
  tagListSchema,
  taskListSchema,
} from "@starter/shared/schemas";
import type { QueryValue, RestClient } from "./api-client.js";
import {
  duration,
  errorResult,
  resolveRange,
  resolveZone,
  textResult,
} from "./format.js";

type Json = Record<string, unknown>;
type QueryParams = Record<string, QueryValue>;

export type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  /** Null when any valid token may call it. Mirrors `API_ROUTES[].scope`. */
  scope: ApiTokenScope | null;
  inputSchema: z.ZodObject;
  readOnly: boolean;
  run: (client: RestClient, args: Json, context: ToolContext) => Promise<CallToolResult>;
};

export type ToolContext = {
  /** The token's scopes when known, so a tool can skip an optional lookup it may not make. */
  scopes: ReadonlySet<ApiTokenScope> | null;
};

const timeZoneField = z
  .string()
  .max(64)
  .optional()
  .describe(
    "IANA time zone for interpreting bare dates, e.g. Europe/Berlin. Defaults to the time zone of the machine running this MCP server.",
  );

const rangeDescription =
  "YYYY-MM-DD or a full ISO-8601 timestamp. A bare `from` date starts at 00:00 and a bare `to` date includes that whole day, in `timeZone`.";

// ── entries ──────────────────────────────────────────────────────────

type EntryLike = {
  id: string;
  description: string;
  start: string;
  end: string | null;
  durationSec: number;
  projectId: string | null;
  taskId: string | null;
  tagIds: string[];
  billable: boolean;
  [field: string]: unknown;
};

/**
 * Names for an entry's project and task, when the token may read the catalog.
 *
 * The timer routes answer with ids only, and "you are tracking 664a…" answers
 * nothing a person asked. A failed lookup is dropped, never reported: the
 * timer call itself succeeded, and that is what the result is about.
 */
async function withNames(client: RestClient, entry: EntryLike, context: ToolContext): Promise<Json> {
  const canRead = context.scopes === null || context.scopes.has("catalog:read");
  if (!canRead) return entry;
  const lookup = async (path: string): Promise<Json | null> => {
    try {
      return (await client.request("GET", path)).data as Json;
    } catch {
      return null;
    }
  };
  const [project, task] = await Promise.all([
    entry.projectId ? lookup(`/projects/${encodeURIComponent(entry.projectId)}`) : null,
    entry.taskId ? lookup(`/tasks/${encodeURIComponent(entry.taskId)}`) : null,
  ]);
  return {
    ...entry,
    projectName: (project?.name as string | undefined) ?? null,
    clientName: (project?.clientName as string | undefined) ?? null,
    taskName: (task?.name as string | undefined) ?? null,
  };
}

function describeEntry(entry: Json): string {
  const what = (entry.description as string) || "(no description)";
  const where = [entry.clientName, entry.projectName, entry.taskName].filter(Boolean).join(" / ");
  return where ? `"${what}" on ${where}` : `"${what}"`;
}

/** The fields a person reads, without the ids-and-bookkeeping half of the row. */
function compactEntry(entry: Json): Json {
  return {
    id: entry.id,
    description: entry.description,
    start: entry.start,
    end: entry.end,
    duration: duration(entry.durationSec as number),
    durationSec: entry.durationSec,
    running: entry.end === null,
    clientName: entry.clientName ?? null,
    projectName: entry.projectName ?? null,
    projectId: entry.projectId,
    taskName: entry.taskName ?? null,
    taskId: entry.taskId,
    tagIds: entry.tagIds,
    billable: entry.billable,
    hourlyRate: entry.hourlyRate ?? null,
    amount: entry.amount ?? null,
    currency: entry.currency ?? null,
    invoiced: entry.invoiceId != null,
    authorId: entry.authorId,
  };
}

const startInput = startTimerSchema.omit({ originId: true, source: true }).extend({
  timeZone: timeZoneField,
});

const stopInput = stopTimerSchema.omit({ originId: true });

// `createEntrySchema` carries an end-after-start refinement, and zod refuses
// `.omit` on a refined object. Rebuilding from `.shape` keeps every field's
// own rules; the refinement is enforced by the server, whose message names it.
const { originId: _entryOrigin, source: _entrySource, ...createEntryShape } = createEntrySchema.shape;
const logEntryInput = z.object(createEntryShape).extend({ timeZone: timeZoneField });

const listEntriesInput = entryListSchema.extend({
  from: z.string().describe(`Start of the range. ${rangeDescription}`),
  to: z.string().describe(`End of the range. ${rangeDescription}`),
  timeZone: timeZoneField,
});

const summaryInput = summaryReportSchema.extend({
  from: z.string().describe(`Start of the range. ${rangeDescription}`),
  to: z.string().describe(`End of the range. ${rangeDescription}`),
  timeZone: timeZoneField,
});

const DEFAULT_ENTRY_LIMIT = 100;

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "get_token_info",
    title: "Check the connection",
    description:
      "Confirm the MCP server can reach Track Your Time, and show the token's workspace, scopes and whether it may see other members' time and money. Call this first when another tool fails with an authentication error.",
    scope: null,
    inputSchema: z.object({}),
    readOnly: true,
    async run(client) {
      const { data } = await client.request("GET", "/me");
      const me = data as { scopes: string[]; workspaceId: string };
      return textResult(
        `Connected to ${client.baseUrl}. Workspace ${me.workspaceId}. Scopes: ${me.scopes.join(", ") || "(none)"}.`,
        data,
      );
    },
  },
  {
    name: "get_running_timer",
    title: "Get the running timer",
    description:
      "Return the timer currently running in this token's workspace, with how long it has run, or say that none is running.",
    scope: "entries:read",
    inputSchema: z.object({}),
    readOnly: true,
    async run(client, _args, context) {
      const { data } = await client.request("GET", "/entries/current");
      if (!data) return textResult("No timer is running.", null);
      const entry = await withNames(client, data as EntryLike, context);
      const elapsedSec = Math.max(0, Math.round((Date.now() - Date.parse(entry.start as string)) / 1000));
      return textResult(
        `Running: ${describeEntry(entry)}, started ${entry.start as string}, ${duration(elapsedSec)} so far.`,
        { ...entry, elapsedSec, elapsed: duration(elapsedSec) },
      );
    },
  },
  {
    name: "start_timer",
    title: "Start a timer",
    description:
      "Start a timer now (or at `start`). A timer already running in this workspace is stopped first. Use list_projects, list_tasks and list_tags to find ids; pass none of them to track unfiled time. Answers 409 when a timer runs in another workspace this token cannot stop.",
    scope: "entries:write",
    inputSchema: startInput,
    readOnly: false,
    async run(client, args, context) {
      const { timeZone, ...body } = args as z.infer<typeof startInput>;
      const { data } = await client.request("POST", "/entries/start", {
        body: { ...body, timeZone: resolveZone(timeZone) },
      });
      const entry = await withNames(client, data as EntryLike, context);
      return textResult(`Started ${describeEntry(entry)} at ${entry.start as string}.`, entry);
    },
  },
  {
    name: "stop_timer",
    title: "Stop the timer",
    description:
      "Stop the timer running in this workspace, now or at `end`. Pass `id` to stop a specific entry; stopping an entry that is already stopped returns it unchanged.",
    scope: "entries:write",
    inputSchema: stopInput,
    readOnly: false,
    async run(client, args, context) {
      const { data } = await client.request("POST", "/entries/stop", { body: args });
      const entry = await withNames(client, data as EntryLike, context);
      return textResult(
        `Stopped ${describeEntry(entry)} after ${duration(entry.durationSec as number)}.`,
        entry,
      );
    },
  },
  {
    name: "log_time_entry",
    title: "Log past time",
    description:
      "Create a finished time entry with an explicit start and end, for work that was not timed. `start` and `end` are ISO-8601 timestamps with an offset or Z, and end must be after start.",
    scope: "entries:write",
    inputSchema: logEntryInput,
    readOnly: false,
    async run(client, args, context) {
      const { timeZone, ...body } = args as z.infer<typeof logEntryInput>;
      const { data } = await client.request("POST", "/entries", {
        body: { ...body, timeZone: resolveZone(timeZone) },
      });
      const entry = await withNames(client, data as EntryLike, context);
      return textResult(
        `Logged ${duration(entry.durationSec as number)} for ${describeEntry(entry)}.`,
        entry,
      );
    },
  },
  {
    name: "list_entries",
    title: "List time entries",
    description:
      "List time entries that overlap a date range, newest first, with project, client and task names. Filter by project, client, task, tag, billable flag, or a text `search` over descriptions. Returns up to `limit` entries (default 100, max 500); pass `nextCursor` back as `cursor` for the next page.",
    scope: "entries:read",
    inputSchema: listEntriesInput,
    readOnly: true,
    async run(client, args) {
      const { timeZone, from, to, ...filters } = args as z.infer<typeof listEntriesInput>;
      const range = resolveRange(from, to, resolveZone(timeZone));
      const response = await client.request("GET", "/entries", {
        query: { ...filters, ...range, limit: filters.limit ?? DEFAULT_ENTRY_LIMIT },
      });
      const entries = (response.data as Json[]).map(compactEntry);
      const totalSec = entries.reduce((sum, entry) => sum + (entry.durationSec as number), 0);
      const more = response.nextCursor ? " More entries exist: pass nextCursor as cursor." : "";
      return textResult(
        `${entries.length} entries between ${range.from} and ${range.to}, ${duration(totalSec)} on this page.${more}`,
        { entries, nextCursor: response.nextCursor ?? null },
      );
    },
  },
  // ── catalog ────────────────────────────────────────────────────────
  {
    name: "list_clients",
    title: "List clients",
    description: "List the workspace's clients. Archived clients are left out unless includeArchived is true.",
    scope: "catalog:read",
    inputSchema: clientListSchema,
    readOnly: true,
    async run(client, args) {
      const { data } = await client.request("GET", "/clients", { query: args as QueryParams });
      return textResult(`${(data as unknown[]).length} clients.`, data);
    },
  },
  {
    name: "list_projects",
    title: "List projects",
    description:
      "List projects with their client, hourly rate, total tracked time and budget progress. Narrow to one client with clientId. Archived projects are left out unless includeArchived is true.",
    scope: "catalog:read",
    inputSchema: projectListSchema,
    readOnly: true,
    async run(client, args) {
      const { data } = await client.request("GET", "/projects", { query: args as QueryParams });
      return textResult(`${(data as unknown[]).length} projects.`, data);
    },
  },
  {
    name: "list_tasks",
    title: "List tasks",
    description:
      "List tasks. A task is a workspace-wide kind of work (for example \"Design review\"), not part of a project: an entry carries a project and a task independently.",
    scope: "catalog:read",
    inputSchema: taskListSchema,
    readOnly: true,
    async run(client, args) {
      const { data } = await client.request("GET", "/tasks", { query: args as QueryParams });
      return textResult(`${(data as unknown[]).length} tasks.`, data);
    },
  },
  {
    name: "list_tags",
    title: "List tags",
    description: "List tags with how many entries carry each one and their total time.",
    scope: "catalog:read",
    inputSchema: tagListSchema,
    readOnly: true,
    async run(client, args) {
      const { data } = await client.request("GET", "/tags", { query: args as QueryParams });
      return textResult(`${(data as unknown[]).length} tags.`, data);
    },
  },
  {
    name: "create_client",
    title: "Create a client",
    description: "Create a client. A colour is assigned when none is given.",
    scope: "catalog:write",
    inputSchema: createClientSchema.omit({ originId: true }),
    readOnly: false,
    async run(client, args) {
      const { data } = await client.request("POST", "/clients", { body: args });
      return textResult(`Created client "${(data as Json).name as string}".`, data);
    },
  },
  {
    name: "create_project",
    title: "Create a project",
    description:
      "Create a project, optionally under a client (clientId from list_clients), with an hourly rate, a billable default, estimated hours or a budget.",
    scope: "catalog:write",
    inputSchema: createProjectSchema.omit({ originId: true }),
    readOnly: false,
    async run(client, args) {
      const { data } = await client.request("POST", "/projects", { body: args });
      return textResult(`Created project "${(data as Json).name as string}".`, data);
    },
  },
  {
    name: "create_task",
    title: "Create a task",
    description:
      "Create a workspace-wide task, a name for a kind of work that any project's entries can use. Task names are unique per workspace.",
    scope: "catalog:write",
    inputSchema: createTaskSchema.omit({ originId: true }),
    readOnly: false,
    async run(client, args) {
      const { data } = await client.request("POST", "/tasks", { body: args });
      return textResult(`Created task "${(data as Json).name as string}".`, data);
    },
  },
  {
    name: "create_tag",
    title: "Create a tag",
    description: "Create a tag. Entries can carry several tags, and reports can group by them.",
    scope: "catalog:write",
    inputSchema: createTagSchema.omit({ originId: true }),
    readOnly: false,
    async run(client, args) {
      const { data } = await client.request("POST", "/tags", { body: args });
      return textResult(`Created tag "${(data as Json).name as string}".`, data);
    },
  },
  // ── reports ────────────────────────────────────────────────────────
  {
    name: "summary_report",
    title: "Summarise time",
    description:
      "Total, billable time and amount for a date range, broken down by project, client, task or tag (or by day, week or month), plus a daily series. Grouped by tag, each entry counts fully toward every tag it carries, so tag rows can add up to more than the total. Refused when the token's owner may not see other members' money.",
    scope: "reports:read",
    inputSchema: summaryInput,
    readOnly: true,
    async run(client, args) {
      const { timeZone, from, to, ...filters } = args as z.infer<typeof summaryInput>;
      const zone = resolveZone(timeZone);
      const range = resolveRange(from, to, zone);
      const { data } = await client.request("GET", "/reports/summary", {
        query: { ...filters, ...range, timeZone: zone },
      });
      const report = data as {
        totalSec: number;
        billableSec: number;
        totalAmount: number;
        currency: string;
        groups: { label: string; seconds: number; amount: number }[];
      };
      const lines = [
        `${duration(report.totalSec)} tracked (${duration(report.billableSec)} billable, ${report.totalAmount.toFixed(2)} ${report.currency}) between ${range.from} and ${range.to}, grouped by ${filters.groupBy}:`,
        ...report.groups.map(
          (group) => `- ${group.label}: ${duration(group.seconds)}, ${group.amount.toFixed(2)} ${report.currency}`,
        ),
      ];
      return textResult(lines.join("\n"), data);
    },
  },
];

/**
 * Register every tool the token may call.
 *
 * With the scopes known, a tool the token cannot use is not offered at all —
 * a model that sees `start_timer` will try it, and a refusal after the fact
 * costs the person a turn. With the scopes unknown (the server was unreachable
 * at start), everything is offered and a refusal explains itself.
 */
export function registerTools(
  server: McpServer,
  client: RestClient,
  scopes: ReadonlySet<ApiTokenScope> | null,
): string[] {
  const registered: string[] = [];
  const context: ToolContext = { scopes };
  for (const tool of TOOLS) {
    if (scopes && tool.scope && !scopes.has(tool.scope)) continue;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.readOnly,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
      async (args: Json) => {
        try {
          return await tool.run(client, args, context);
        } catch (err) {
          return errorResult(err);
        }
      },
    );
    registered.push(tool.name);
  }
  return registered;
}
