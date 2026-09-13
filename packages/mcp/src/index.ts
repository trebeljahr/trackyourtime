#!/usr/bin/env node
// The `trackyourtime-mcp` binary: an MCP server on stdio.
//
// stdout belongs to the protocol. Everything meant for a person goes to
// stderr, which MCP clients show in their server log — a stray console.log
// here would corrupt the JSON-RPC stream and read as a crash.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, resolveConfig, type McpConfig } from "./config.js";
import { createServer, SERVER_VERSION } from "./server.js";

async function main(): Promise<void> {
  if (process.argv.includes("--version")) {
    process.stderr.write(`${SERVER_VERSION}\n`);
    return;
  }

  let config: McpConfig;
  try {
    config = resolveConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`[trackyourtime-mcp] ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const { server, tools, probe } = await createServer(config);
  if (probe.kind === "known") {
    process.stderr.write(
      `[trackyourtime-mcp] ${config.apiUrl}: token scopes ${[...probe.scopes].join(", ") || "(none)"}; offering ${tools.length} tools.\n`,
    );
  } else {
    process.stderr.write(
      `[trackyourtime-mcp] Could not read the token's scopes from ${config.apiUrl}, so every tool is offered.\n${probe.reason}\n`,
    );
  }

  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  process.stderr.write(`[trackyourtime-mcp] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
