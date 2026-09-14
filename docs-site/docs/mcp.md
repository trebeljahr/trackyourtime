---
title: MCP server
sidebar_label: MCP server
description: Start and stop timers, log time, list entries, manage clients, projects, tasks and tags, and summarise hours from Claude or any MCP client, on the hosted service or your own server.
---

# MCP server

Ask an assistant "what did I work on last week?" or "start a timer for the Acme
website" and it answers from your own Track Your Time account. The MCP server
connects any [Model Context Protocol](https://modelcontextprotocol.io) client —
Claude Desktop, Claude Code, or another MCP client — to the
[REST API](./api/overview.md) with a personal API token.

It works with the hosted service at `https://api.trackyourtime.dev` and with any
self-hosted instance. The REST API is the same code on both.

What it does not do yet:

- It is not published to npm. You run it from a clone of the repository.
- It speaks stdio only. There is no hosted MCP endpoint.
- It has no invoice tools, because the REST API has no invoice routes. Invoices
  stay in the web app.
- A token reaches one workspace, the one you created it in.

## 1. Create an API token

In the web app, open **Settings → Integrations → API tokens** and create a token. Tick only the
scopes you want the assistant to have. The token is shown once, and it starts
with `tt_`.

| Scope | Tools it enables |
| --- | --- |
| `entries:read` | `get_running_timer`, `list_entries` |
| `entries:write` | `start_timer`, `stop_timer`, `log_time_entry` |
| `catalog:read` | `list_clients`, `list_projects`, `list_tasks`, `list_tags` |
| `catalog:write` | `create_client`, `create_project`, `create_task`, `create_tag` |
| `reports:read` | `summary_report` |
| none | `get_token_info` |

At start-up the server reads the token's scopes from `GET /api/v1/me` and offers
only the tools the token can call. A read-only token therefore never shows the
assistant a `start_timer` tool.

With `catalog:read` as well, the timer tools add project, client and task names to
their answers. Without it they return ids only.

**Treat the token like a password.** It sits in plain text in your MCP client's
configuration file. Revoke it in **Settings → Integrations → API tokens** when you stop using it.

## 2. Build the server

You need Node.js 24 or newer, pnpm and git.

```bash
git clone https://github.com/trebeljahr/trackyourtime.git
```

```bash
cd trackyourtime && pnpm install && pnpm build:mcp
```

**Expect:** the last line of output comes from `tsc` with no errors, and
`packages/mcp/dist/index.js` exists.

Check the server can reach your account before you add it to a client:

```bash
TRACKYOURTIME_API_TOKEN=tt_your_token node packages/mcp/dist/index.js
```

**Expect:** one line on stderr, then the process waits for input. Press Ctrl+C to
quit.

```
[trackyourtime-mcp] https://api.trackyourtime.dev: token scopes entries:read, entries:write; offering 6 tools.
```

For a self-hosted instance, add `TRACKYOURTIME_API_URL=https://track.example.com`
in front of the command.

## 3. Add it to your MCP client

The server reads two environment variables.

| Variable | Value |
| --- | --- |
| `TRACKYOURTIME_API_TOKEN` | Required. The `tt_…` token from step 1. |
| `TRACKYOURTIME_API_URL` | Optional. Defaults to `https://api.trackyourtime.dev`. For a self-hosted instance, use its origin, for example `https://track.example.com`. A pasted `…/api/v1` suffix is accepted too. |

Replace `/path/to/trackyourtime` below with the absolute path of your clone.

### Claude Code

```bash
claude mcp add trackyourtime --env TRACKYOURTIME_API_TOKEN=tt_your_token -- node /path/to/trackyourtime/packages/mcp/dist/index.js
```

For a self-hosted instance, add a second `--env`:

```bash
claude mcp add trackyourtime --env TRACKYOURTIME_API_TOKEN=tt_your_token --env TRACKYOURTIME_API_URL=https://track.example.com -- node /path/to/trackyourtime/packages/mcp/dist/index.js
```

Add `--scope user` to make it available in every project. Run `claude mcp list` to
see whether it connected.

### Claude Desktop

Open **Settings → Developer → Edit Config**. That opens
`claude_desktop_config.json` (on macOS in `~/Library/Application Support/Claude/`,
on Windows in `%APPDATA%\Claude\`). Add the server under `mcpServers`:

```json
{
  "mcpServers": {
    "trackyourtime": {
      "command": "node",
      "args": ["/path/to/trackyourtime/packages/mcp/dist/index.js"],
      "env": {
        "TRACKYOURTIME_API_TOKEN": "tt_your_token",
        "TRACKYOURTIME_API_URL": "https://api.trackyourtime.dev"
      }
    }
  }
}
```

Restart Claude Desktop. The tools appear under the tools menu in a new chat.

### Other MCP clients

Any client that launches stdio servers works. Give it:

- **command:** `node`
- **arguments:** `/path/to/trackyourtime/packages/mcp/dist/index.js`
- **environment:** `TRACKYOURTIME_API_TOKEN`, and `TRACKYOURTIME_API_URL` for a
  self-hosted instance

If `node` is not on the client's `PATH`, use the absolute path that `which node`
prints.

## Tools

| Tool | What it does |
| --- | --- |
| `get_token_info` | Confirms the connection and shows the token's workspace, scopes and what it may see. |
| `get_running_timer` | Returns the running timer and how long it has run, or says none is running. |
| `start_timer` | Starts a timer now or at a given time, with an optional description, project, task, tags and billable flag. A timer already running in the workspace stops first. |
| `stop_timer` | Stops the running timer, now or at a given time. |
| `log_time_entry` | Creates a finished entry with a start and an end, for work nobody timed. |
| `list_entries` | Lists entries in a date range, newest first, filtered by project, client, task, tag, billable flag or a text search. Up to 500 per page, with a cursor for the next page. |
| `list_clients`, `list_projects`, `list_tasks`, `list_tags` | Lists the catalog. Projects include tracked time and budget progress. Tags include usage counts. |
| `create_client`, `create_project`, `create_task`, `create_tag` | Adds to the catalog. A project can have a client, an hourly rate, a billable default, estimated hours and a budget. |
| `summary_report` | Totals, billable time and amount for a range, grouped by project, client, task, tag, day, week or month. |

The tool arguments use the same validation rules as the REST API, so a name that
is too long or a colour that is not a hex value is refused before any request is
sent.

A task in Track Your Time is a kind of work, like "Design review", and not a part
of a project. An entry can carry a project and a task independently.

### Dates and time zones

`list_entries` and `summary_report` take `from` and `to` as either a date
(`2026-09-01`) or a full ISO-8601 timestamp. A date covers the whole day: `from:
2026-09-01, to: 2026-09-30` is all of September.

Dates are read in the time zone of the machine that runs the MCP server. Pass
`timeZone` (an IANA name such as `Europe/Berlin`) to read them in another zone.
The summary report also buckets days in that zone.

## When something goes wrong

Every failed tool call returns the server's own error, the problem type from the
[RFC 9457 error document](./api/errors.md), and one sentence on what to change.

| What the assistant reports | Cause and fix |
| --- | --- |
| `401 Unauthorized (invalid-token)` | The token is wrong, revoked or expired, or it belongs to a different server than `TRACKYOURTIME_API_URL`. Create a new token on the right server. |
| A tool you expected is missing | The token lacks that scope. Scopes cannot be added to a token, so create a new one with the scopes you need. |
| `403 Forbidden (insufficient-scope)` | Same cause. This appears instead when the server could not read the token's scopes at start-up. |
| `403 Forbidden (money-visibility-required)` | The workspace does not let this member see other members' money, so reports are refused. |
| `429 Too Many Requests (rate-limited)` | More than the per-token limit in one minute. The error says how many seconds to wait. |
| `Could not reach …: ECONNREFUSED` or `ENOTFOUND` | `TRACKYOURTIME_API_URL` is wrong, or the server is down. A self-hosted server answers `GET /api/health`. |
| `… answered HTTP 404 with text/html, not JSON` | The URL points at something other than the API, such as the web app on a split-domain setup. Use the API's origin. |

The server writes one line to its log at start-up with the scopes it found, or the
reason it could not read them. Claude Code shows server logs with `claude --debug`.
Claude Desktop writes them to `mcp-server-trackyourtime.log` in its logs folder.

## Check a self-hosted install with an assistant

Once your instance is up, create a token with all five scopes and connect the MCP
server to it. Then ask the assistant to call `get_token_info`, start and stop a
timer, and run `summary_report` for today. Each call goes through the proxy, the
API, the database and the token checks, so four successful answers mean those
parts work.
