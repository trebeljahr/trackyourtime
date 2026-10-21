# Track Your Time MCP server

Start a timer, record missed hours, or ask for a report from your MCP client.
Use the hosted Track Your Time service or your own server.

Requires Node.js 24 or newer and a Track Your Time API token.

## Connect

Create a token in **Settings → Integrations → API tokens**.
Select only the scopes you need. The token belongs to one workspace.

Add this entry to your MCP client's configuration:

```json
{
  "mcpServers": {
    "trackyourtime": {
      "command": "npx",
      "args": ["-y", "trackyourtime-mcp"],
      "env": {
        "TRACKYOURTIME_API_TOKEN": "tt_your_token"
      }
    }
  }
}
```

For self-hosting, also set `TRACKYOURTIME_API_URL` to your instance's origin, such as `https://time.example.com`.

Treat the API token like a password. MCP client configuration files usually store it in plain text.
Revoke the token in Track Your Time when you stop using it.

## Available tools

The server reads your token's scopes and offers the tools those scopes permit:

| Scope | Tools |
| --- | --- |
| None | `get_token_info` |
| `entries:read` | `get_running_timer`, `list_entries` |
| `entries:write` | `start_timer`, `stop_timer`, `log_time_entry` |
| `catalog:read` | `list_clients`, `list_projects`, `list_tasks`, `list_tags` |
| `catalog:write` | `create_client`, `create_project`, `create_task`, `create_tag` |
| `reports:read` | `summary_report` |

There are no invoice tools or hosted MCP endpoint. This package uses stdio and calls your server's REST API.

[Full documentation](https://trackyourtime.dev/docs/mcp/) · [Source](https://github.com/trebeljahr/trackyourtime/tree/main/packages/mcp)

Licensed under AGPL-3.0-or-later. The published bundle includes source maps with the bundled TypeScript source.
