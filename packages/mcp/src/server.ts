// Building the MCP server, separate from the process that runs it, so the
// tests can connect a client over an in-memory transport to exactly what the
// binary serves.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { API_TOKEN_SCOPES, type ApiTokenScope } from "@starter/shared/api-tokens";
import { RestClient, type FetchLike } from "./api-client.js";
import type { McpConfig } from "./config.js";
import { describeError } from "./format.js";
import { registerTools } from "./tools.js";

export const SERVER_NAME = "trackyourtime";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = [
  "Track Your Time is a time tracker for people who bill clients by the hour.",
  "Entries carry an optional project (which may belong to a client), an optional task and any number of tags.",
  "Look up ids with list_projects, list_tasks, list_tags and list_clients before starting a timer or logging time against them.",
  "Durations are in seconds; bare dates are read in the time zone of the machine running this server unless a tool is given timeZone.",
  "There are no invoice tools: invoices are managed in the web app.",
].join(" ");

export type ScopeProbe =
  | { kind: "known"; scopes: ReadonlySet<ApiTokenScope> }
  | { kind: "unknown"; reason: string };

/**
 * Ask the API what the token may do, once, before offering any tool.
 *
 * Failure is not fatal. A server that is down at launch, or a token that was
 * revoked, still gets an MCP server that starts — every tool then answers with
 * the real reason, which is far more useful in a chat than a client reporting
 * "server exited with code 1".
 */
export async function probeScopes(client: RestClient): Promise<ScopeProbe> {
  try {
    const { data } = await client.request("GET", "/me");
    const scopes = (data as { scopes?: unknown }).scopes;
    if (!Array.isArray(scopes)) return { kind: "unknown", reason: "GET /me returned no scopes" };
    const known = new Set<ApiTokenScope>(
      scopes.filter((scope): scope is ApiTokenScope =>
        (API_TOKEN_SCOPES as readonly string[]).includes(scope as string),
      ),
    );
    return { kind: "known", scopes: known };
  } catch (err) {
    return { kind: "unknown", reason: describeError(err) };
  }
}

export type CreatedServer = {
  server: McpServer;
  client: RestClient;
  tools: string[];
  probe: ScopeProbe;
};

export async function createServer(
  config: McpConfig,
  options: { fetch?: FetchLike } = {},
): Promise<CreatedServer> {
  const client = new RestClient(config, {
    fetch: options.fetch,
    userAgent: `${SERVER_NAME}-mcp/${SERVER_VERSION}`,
  });
  const probe = await probeScopes(client);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  const tools = registerTools(server, client, probe.kind === "known" ? probe.scopes : null);
  return { server, client, tools, probe };
}
