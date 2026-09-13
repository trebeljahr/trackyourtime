import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { API_TOKEN_SCOPES } from "@starter/shared/api-tokens";
import { resolveRange } from "../format.js";
import { TOOLS } from "../tools.js";
import { connect, fakeApi, meRoute, textOf, type FakeRoute } from "./helpers.js";

const ALL_SCOPES = [...API_TOKEN_SCOPES];

const runningEntry = {
  id: "e1",
  workspaceId: "w1",
  authorId: "u1",
  description: "Design review",
  projectId: "p1",
  taskId: null,
  billable: true,
  start: "2026-09-13T08:00:00.000Z",
  end: null,
  durationSec: 0,
  hourlyRate: 90,
  currency: "EUR",
  source: "api",
  timeZone: "Europe/Berlin",
  runaway: null,
  tagIds: [],
  invoiceId: null,
  importId: null,
  createdAt: "2026-09-13T08:00:00.000Z",
  updatedAt: "2026-09-13T08:00:00.000Z",
};

const projectRoute: FakeRoute = () => ({
  status: 200,
  body: { data: { id: "p1", name: "Website", clientName: "Acme" } },
});

describe("which tools are offered", () => {
  it("offers every tool to a token with every scope", async () => {
    const api = fakeApi({ "GET /me": meRoute(ALL_SCOPES) });
    const { client, close } = await connect(api.fetch);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      TOOLS.map((tool) => tool.name).sort(),
    );
    await close();
  });

  it("hides the tools a token's scopes cannot call", async () => {
    const api = fakeApi({ "GET /me": meRoute(["entries:read"]) });
    const { client, close } = await connect(api.fetch);
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["get_running_timer", "get_token_info", "list_entries"]);
    await close();
  });

  it("offers everything when the scopes cannot be read, so each call explains itself", async () => {
    const unreachable = async (): Promise<Response> => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    };
    const { client, created, close } = await connect(unreachable);
    assert.equal(created.probe.kind, "unknown");
    assert.equal((await client.listTools()).tools.length, TOOLS.length);

    const result = await client.callTool({ name: "get_running_timer", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Could not reach https:\/\/api\.example\.test\/api\/v1\/entries\/current: ECONNREFUSED/);
    assert.match(textOf(result), /TRACKYOURTIME_API_URL/);
    await close();
  });

  it("has no invoice tools, because /api/v1 has no invoice routes", () => {
    assert.equal(TOOLS.some((tool) => /invoice/i.test(tool.name)), false);
  });

  it("maps every tool to one of the five token scopes, or none", () => {
    for (const tool of TOOLS) {
      assert.ok(tool.scope === null || ALL_SCOPES.includes(tool.scope), tool.name);
    }
  });
});

describe("input schemas", () => {
  it("leave out the fields the transport owns and add a time zone", async () => {
    const api = fakeApi({ "GET /me": meRoute(ALL_SCOPES) });
    const { client, close } = await connect(api.fetch);
    const { tools } = await client.listTools();
    const start = tools.find((tool) => tool.name === "start_timer");
    const props = Object.keys(start?.inputSchema.properties ?? {});
    assert.ok(props.includes("description"));
    assert.ok(props.includes("tagIds"));
    assert.ok(props.includes("timeZone"));
    assert.equal(props.includes("originId"), false);
    assert.equal(props.includes("source"), false);

    const log = tools.find((tool) => tool.name === "log_time_entry");
    assert.deepEqual([...(log?.inputSchema.required ?? [])].sort(), ["end", "start"]);

    const summary = tools.find((tool) => tool.name === "summary_report");
    assert.ok((summary?.inputSchema.required ?? []).includes("groupBy"));
    await close();
  });

  it("rejects arguments the shared schema rejects, before any request", async () => {
    const api = fakeApi({ "GET /me": meRoute(ALL_SCOPES) });
    const { client, close } = await connect(api.fetch);
    const before = api.requests.length;
    const result = await client.callTool({ name: "create_tag", arguments: { name: "" } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Name is required/);
    assert.equal(api.requests.length, before);
    await close();
  });
});

describe("timer tools", () => {
  it("start_timer sends the token, the caller's zone, and names the project", async () => {
    const api = fakeApi({
      "GET /me": meRoute(ALL_SCOPES),
      "POST /entries/start": () => ({ status: 200, body: { data: runningEntry } }),
      "GET /projects/p1": projectRoute,
    });
    const { client, close } = await connect(api.fetch);
    const result = await client.callTool({
      name: "start_timer",
      arguments: { description: "Design review", projectId: "p1", timeZone: "Europe/Berlin" },
    });
    assert.equal(result.isError, undefined);
    assert.match(textOf(result), /Started "Design review" on Acme \/ Website/);

    const start = api.requests.find((request) => request.url.pathname === "/api/v1/entries/start");
    assert.equal(start?.headers.authorization, "Bearer tt_test_secret");
    assert.deepEqual(start?.body, { description: "Design review", projectId: "p1", timeZone: "Europe/Berlin" });
    await close();
  });

  it("start_timer skips the name lookup when the token cannot read the catalog", async () => {
    const api = fakeApi({
      "GET /me": meRoute(["entries:write"]),
      "POST /entries/start": () => ({ status: 200, body: { data: runningEntry } }),
    });
    const { client, close } = await connect(api.fetch);
    const result = await client.callTool({ name: "start_timer", arguments: { projectId: "p1" } });
    assert.equal(result.isError, undefined);
    assert.equal(api.requests.some((request) => request.url.pathname.startsWith("/api/v1/projects")), false);
    await close();
  });

  it("get_running_timer says plainly when nothing runs", async () => {
    const api = fakeApi({
      "GET /me": meRoute(ALL_SCOPES),
      "GET /entries/current": () => ({ status: 200, body: { data: null } }),
    });
    const { client, close } = await connect(api.fetch);
    const result = await client.callTool({ name: "get_running_timer", arguments: {} });
    assert.match(textOf(result), /^No timer is running\./);
    await close();
  });
});

describe("errors reach the model as sentences", () => {
  it("passes an RFC 9457 scope refusal through with the fix", async () => {
    // Scopes unreadable at start, so the tool is offered and the server refuses.
    const api = fakeApi({
      "GET /me": () => ({ status: 500, body: { status: 500, detail: "The server could not complete this request." } }),
      "POST /entries/stop": () => ({
        status: 403,
        body: {
          type: "https://trackyourtime.dev/problems/insufficient-scope",
          title: "Forbidden",
          status: 403,
          detail: "This token does not carry the `entries:write` scope.",
          instance: "/api/v1/entries/stop",
        },
      }),
    });
    const { client, close } = await connect(api.fetch);
    const result = await client.callTool({ name: "stop_timer", arguments: {} });
    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /403 Forbidden \(insufficient-scope\)/);
    assert.match(text, /does not carry the `entries:write` scope/);
    assert.match(text, /Fix: Mint a token that includes this scope in Settings → Integrations → API tokens/);
    assert.match(text, /Problem type: https:\/\/trackyourtime\.dev\/problems\/insufficient-scope/);
    await close();
  });

  it("tells the model how long to wait on a rate limit", async () => {
    const api = fakeApi({
      "GET /me": meRoute(ALL_SCOPES),
      "GET /tags": () => ({
        status: 429,
        headers: { "retry-after": "17" },
        body: {
          type: "https://trackyourtime.dev/problems/rate-limited",
          title: "Too Many Requests",
          status: 429,
          detail: "Rate limit of 600 requests per minute exceeded. Retry in 17s.",
          instance: "/api/v1/tags",
        },
      }),
    });
    const { client, close } = await connect(api.fetch);
    const result = await client.callTool({ name: "list_tags", arguments: {} });
    assert.match(textOf(result), /Fix: Wait 17 seconds/);
    await close();
  });

  it("recognises a URL that is not the API at all", async () => {
    const htmlPage = async (): Promise<Response> =>
      new Response("<!doctype html><title>Track Your Time</title>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    const { client, close } = await connect(htmlPage);
    const result = await client.callTool({ name: "list_clients", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /not JSON/);
    await close();
  });

  it("refuses an unknown time zone without calling the API", async () => {
    const api = fakeApi({ "GET /me": meRoute(ALL_SCOPES) });
    const { client, close } = await connect(api.fetch);
    const result = await client.callTool({
      name: "list_entries",
      arguments: { from: "2026-09-01", to: "2026-09-30", timeZone: "Mars/Olympus" },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Unknown time zone "Mars\/Olympus"/);
    assert.equal(api.requests.some((request) => request.url.pathname.endsWith("/entries")), false);
    await close();
  });
});

describe("ranges and queries", () => {
  it("reads bare dates as whole days in the given zone", () => {
    assert.deepEqual(resolveRange("2026-09-01", "2026-09-30", "Europe/Berlin"), {
      from: "2026-08-31T22:00:00.000Z",
      to: "2026-09-30T22:00:00.000Z",
    });
    assert.deepEqual(resolveRange("2026-09-01T08:00:00Z", "2026-09-01T09:30:00Z", "Europe/Berlin"), {
      from: "2026-09-01T08:00:00.000Z",
      to: "2026-09-01T09:30:00.000Z",
    });
    assert.throws(() => resolveRange("2026-09-02", "2026-09-01", "UTC"), /must be after/);
  });

  it("list_entries encodes filters the way /api/v1 coerces them", async () => {
    const api = fakeApi({
      "GET /me": meRoute(ALL_SCOPES),
      "GET /entries": () => ({ status: 200, body: { data: [], nextCursor: null } }),
    });
    const { client, close } = await connect(api.fetch);
    await client.callTool({
      name: "list_entries",
      arguments: {
        from: "2026-09-01",
        to: "2026-09-01",
        timeZone: "UTC",
        projectIds: ["p1", "p2"],
        billable: true,
        search: "review",
      },
    });
    const request = api.requests.find((r) => r.url.pathname === "/api/v1/entries");
    const params = request?.url.searchParams;
    assert.deepEqual(params?.getAll("projectIds"), ["p1", "p2"]);
    assert.equal(params?.get("billable"), "true");
    assert.equal(params?.get("search"), "review");
    assert.equal(params?.get("from"), "2026-09-01T00:00:00.000Z");
    assert.equal(params?.get("to"), "2026-09-02T00:00:00.000Z");
    assert.equal(params?.get("limit"), "100");
    assert.equal(params?.has("timeZone"), false);
    await close();
  });

  it("summary_report sends the grouping and zone and summarises the groups", async () => {
    const api = fakeApi({
      "GET /me": meRoute(ALL_SCOPES),
      "GET /reports/summary": () => ({
        status: 200,
        body: {
          data: {
            totalSec: 5400,
            billableSec: 3600,
            totalAmount: 90,
            currency: "EUR",
            groups: [{ key: "p1", label: "Website", color: null, seconds: 5400, billableSec: 3600, amount: 90 }],
            timeline: [],
          },
        },
      }),
    });
    const { client, close } = await connect(api.fetch);
    const result = await client.callTool({
      name: "summary_report",
      arguments: { from: "2026-09-01", to: "2026-09-30", groupBy: "project", timeZone: "Europe/Berlin" },
    });
    const request = api.requests.find((r) => r.url.pathname === "/api/v1/reports/summary");
    assert.equal(request?.url.searchParams.get("groupBy"), "project");
    assert.equal(request?.url.searchParams.get("timeZone"), "Europe/Berlin");
    assert.match(textOf(result), /1h 30m tracked \(1h 0m billable, 90\.00 EUR\)/);
    assert.match(textOf(result), /- Website: 1h 30m, 90\.00 EUR/);
    await close();
  });
});

describe("the docs page", () => {
  it("lists every tool under the scope that enables it", async () => {
    const { readFile } = await import("node:fs/promises");
    const page = await readFile(new URL("../../../../docs-site/docs/mcp.md", import.meta.url), "utf8");
    // Rows of the scope table: | `entries:read` | `get_running_timer`, `list_entries` |
    const documented = new Map<string, string | null>();
    for (const match of page.matchAll(/^\| (`[a-z]+:[a-z]+`|none) \| (.+) \|$/gm)) {
      const scope = match[1] === "none" ? null : match[1].replaceAll("`", "");
      for (const name of match[2].matchAll(/`([a-z_]+)`/g)) documented.set(name[1], scope);
    }
    assert.deepEqual(
      [...documented.entries()].sort(),
      TOOLS.map((tool) => [tool.name, tool.scope] as const).sort(),
      "docs-site/docs/mcp.md's scope table no longer matches TOOLS",
    );
  });
});
