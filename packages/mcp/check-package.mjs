// Run against an isolated npm installation, never the workspace's source files.
// Usage: node check-package.mjs /absolute/path/to/isolated-install
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

assert(process.argv[2], "Pass the directory containing the isolated node_modules");
const install = resolve(process.argv[2]);
const require = createRequire(resolve(install, "package.json"));
const { Client } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")));
const { StdioClientTransport } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/stdio.js")));
const pkg = require("trackyourtime-mcp/package.json");
assert(!Object.keys(pkg.dependencies).some((name) => name.startsWith("@starter/")));

let requests = 0;
const api = createServer((req, res) => {
  assert.equal(req.headers.authorization, "Bearer tt_package_check");
  assert.equal(req.method, "GET");
  assert.equal(req.url, "/api/v1/me");
  requests++;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: {
    tokenId: "package-test", workspaceId: "package-workspace", userId: "package-user",
    scopes: ["entries:read"],
    visibility: { canViewOthersTime: false, canViewOthersMoney: false },
  } }));
});
await new Promise((done) => api.listen(0, "127.0.0.1", done));
const client = new Client({ name: "package-check", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(install, "node_modules/trackyourtime-mcp/dist/index.js")],
  env: {
    PATH: process.env.PATH,
    TRACKYOURTIME_API_TOKEN: "tt_package_check",
    TRACKYOURTIME_API_URL: `http://127.0.0.1:${api.address().port}`,
  },
  stderr: "pipe",
});
try {
  await client.connect(transport);
  assert.equal(client.getServerVersion().version, pkg.version);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["get_running_timer", "get_token_info", "list_entries"]);
  const result = await client.callTool({ name: "get_token_info", arguments: {} });
  assert(!result.isError);
  assert.match(result.content[0].text, /package-workspace/);
  assert.equal(requests, 2);
  console.log(`Package ${pkg.name}@${pkg.version}: stdio handshake, scoped tools and REST call passed.`);
} finally {
  await client.close();
  await new Promise((done) => api.close(done));
}
