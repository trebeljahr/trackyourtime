// The MCP server end to end: the real binary on stdio, talking to a real API
// server with its own database, with tokens minted the way a person mints them.
//
//   pnpm --filter @starter/mcp test:integration
//
// Needs `mongod` on PATH (started on a random port with a temp data dir), or
// MONGODB_URI naming a database this suite may write to.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RestClient } from "../../api-client.js";
import { describeError } from "../../format.js";
import { createServer } from "../../server.js";
import { REPO_ROOT, canRunLocalServer, startLocalServer, type LocalServer } from "./local-server.js";

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function textOf(result: ToolResult): string {
  return (result.content as { text?: string }[]).map((part) => part.text ?? "").join("\n");
}

/** The JSON half of a tool's text result. */
function dataOf<T>(result: ToolResult): T {
  const text = textOf(result);
  return JSON.parse(text.slice(text.indexOf("\n\n") + 2)) as T;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name} failed:\n${textOf(result)}`);
  return result;
}

const available = canRunLocalServer();

describe("the MCP server against a local API", { skip: available.ok ? false : available.reason }, () => {
  let local: LocalServer;
  let fullToken: string;
  let readOnlyToken: string;
  let mcp: Client;

  before(async () => {
    local = await startLocalServer();
    const cookie = await local.signUp(`mcp-${Date.now()}@example.test`);
    fullToken = await local.mintToken(cookie, [
      "entries:read",
      "entries:write",
      "catalog:read",
      "catalog:write",
      "reports:read",
    ]);
    readOnlyToken = await local.mintToken(cookie, ["entries:read"]);

    mcp = new Client({ name: "integration", version: "0.0.0" });
    await mcp.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", join(REPO_ROOT, "packages/mcp/src/index.ts")],
        cwd: join(REPO_ROOT, "packages/mcp"),
        env: {
          PATH: process.env.PATH ?? "",
          TRACKYOURTIME_API_URL: local.apiUrl,
          TRACKYOURTIME_API_TOKEN: fullToken,
        },
        stderr: "ignore",
      }),
    );
  });

  after(async () => {
    await mcp?.close();
    await local?.stop();
  });

  it("connects and reports the token's scopes", async () => {
    const result = await call(mcp, "get_token_info");
    const me = dataOf<{ scopes: string[] }>(result);
    assert.equal(me.scopes.length, 5);
    assert.match(textOf(result), new RegExp(`Connected to ${local.apiUrl}/api/v1`));
  });

  it("builds a catalog, tracks time against it and reports on it", async () => {
    const acme = dataOf<{ id: string }>(await call(mcp, "create_client", { name: "Acme" }));
    const website = dataOf<{ id: string }>(
      await call(mcp, "create_project", { name: "Website", clientId: acme.id, hourlyRate: 90 }),
    );
    const review = dataOf<{ id: string }>(await call(mcp, "create_task", { name: "Design review" }));
    const deepWork = dataOf<{ id: string }>(await call(mcp, "create_tag", { name: "deep work" }));

    const projects = dataOf<{ name: string; clientName: string }[]>(await call(mcp, "list_projects"));
    assert.deepEqual(projects.map((p) => [p.name, p.clientName]), [["Website", "Acme"]]);
    assert.equal(dataOf<unknown[]>(await call(mcp, "list_clients")).length, 1);
    assert.equal(dataOf<unknown[]>(await call(mcp, "list_tasks")).length, 1);
    assert.equal(dataOf<unknown[]>(await call(mcp, "list_tags")).length, 1);

    assert.match(textOf(await call(mcp, "get_running_timer")), /^No timer is running\./);

    const started = await call(mcp, "start_timer", {
      description: "Homepage layout",
      projectId: website.id,
      taskId: review.id,
      tagIds: [deepWork.id],
      timeZone: "Europe/Berlin",
    });
    assert.match(textOf(started), /Started "Homepage layout" on Acme \/ Website \/ Design review/);

    const running = await call(mcp, "get_running_timer");
    assert.match(textOf(running), /^Running: "Homepage layout"/);
    assert.equal(dataOf<{ source: string }>(running).source, "api");

    const stopped = await call(mcp, "stop_timer");
    assert.match(textOf(stopped), /^Stopped "Homepage layout"/);

    const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
    yesterday.setUTCHours(9, 0, 0, 0);
    const twoHoursLater = new Date(yesterday.getTime() + 2 * 3600 * 1000);
    const logged = await call(mcp, "log_time_entry", {
      description: "Client call",
      projectId: website.id,
      billable: true,
      start: yesterday.toISOString(),
      end: twoHoursLater.toISOString(),
    });
    assert.match(textOf(logged), /^Logged 2h 0m for "Client call" on Acme \/ Website/);

    const backwards = await mcp.callTool({
      name: "log_time_entry",
      arguments: { start: twoHoursLater.toISOString(), end: yesterday.toISOString() },
    });
    assert.equal(backwards.isError, true);
    assert.match(textOf(backwards), /400 Bad Request \(invalid-request\)/);
    assert.match(textOf(backwards), /End must be after start/);

    const from = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    const to = new Date(Date.now() + 3600 * 1000).toISOString();
    const listed = dataOf<{ entries: { description: string; projectName: string }[]; nextCursor: null }>(
      await call(mcp, "list_entries", { from, to }),
    );
    assert.deepEqual(
      listed.entries.map((e) => e.description).sort(),
      ["Client call", "Homepage layout"],
    );
    assert.equal(listed.nextCursor, null);

    const searched = dataOf<{ entries: { description: string }[] }>(
      await call(mcp, "list_entries", { from, to, search: "call" }),
    );
    assert.deepEqual(searched.entries.map((e) => e.description), ["Client call"]);

    const summary = await call(mcp, "summary_report", { from, to, groupBy: "project" });
    const report = dataOf<{ totalSec: number; groups: { label: string }[] }>(summary);
    assert.ok(report.totalSec >= 7200);
    assert.deepEqual(report.groups.map((g) => g.label), ["Website"]);
    assert.match(textOf(summary), /- Website: 2h/);
  });

  it("offers a read-only token only the tools it can call", async () => {
    const created = await createServer({ apiUrl: local.apiUrl, token: readOnlyToken });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "read-only", version: "0.0.0" });
    await Promise.all([created.server.connect(serverSide), client.connect(clientSide)]);
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["get_running_timer", "get_token_info", "list_entries"]);
    await client.close();
  });

  it("passes the server's own scope refusal through as a readable error", async () => {
    const rest = new RestClient({ apiUrl: local.apiUrl, token: readOnlyToken });
    const err = await rest.request("POST", "/entries/start", { body: {} }).then(
      () => assert.fail("a read-only token started a timer"),
      (caught: unknown) => caught,
    );
    const text = describeError(err);
    assert.match(text, /403 Forbidden \(insufficient-scope\)/);
    assert.match(text, /entries:write/);
    assert.match(text, /Fix: Mint a token/);
  });

  it("starts with a bad token and explains it on the first call", async () => {
    const created = await createServer({ apiUrl: local.apiUrl, token: "tt_notreal_notreal" });
    assert.equal(created.probe.kind, "unknown");
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bad-token", version: "0.0.0" });
    await Promise.all([created.server.connect(serverSide), client.connect(clientSide)]);
    const result = await client.callTool({ name: "get_token_info", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /401 Unauthorized \(invalid-token\)/);
    assert.match(textOf(result), /TRACKYOURTIME_API_TOKEN/);
    await client.close();
  });
});
