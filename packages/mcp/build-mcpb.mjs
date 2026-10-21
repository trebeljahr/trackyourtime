// Stage an MCPB from the same isolated installation checked by check-package.mjs.
import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

assert(process.argv[2] && process.argv[3], "Usage: node build-mcpb.mjs <isolated-install> <new-output-directory>");
const install = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const pkg = JSON.parse(await readFile(resolve(install, "node_modules/trackyourtime-mcp/package.json"), "utf8"));
// Refuse an existing directory so stale files or credentials cannot enter a bundle.
await mkdir(output);
await cp(resolve(install, "node_modules"), resolve(output, "node_modules"), { recursive: true });
for (const file of ["README.md", "LICENSE"]) {
  await cp(resolve(install, "node_modules/trackyourtime-mcp", file), resolve(output, file));
}
await writeFile(resolve(output, "manifest.json"), `${JSON.stringify({
  manifest_version: "0.3",
  name: pkg.name,
  display_name: "Track Your Time",
  version: pkg.version,
  description: pkg.description,
  author: { name: "Rico Trebeljahr", url: "https://ricos.site" },
  repository: { type: "git", url: "https://github.com/trebeljahr/trackyourtime" },
  homepage: "https://trackyourtime.dev",
  documentation: pkg.homepage,
  support: pkg.bugs,
  license: pkg.license,
  privacy_policies: ["https://trackyourtime.dev/privacy/"],
  compatibility: { platforms: ["darwin", "win32", "linux"], runtimes: { node: pkg.engines.node } },
  tools_generated: true,
  server: {
    type: "node",
    entry_point: "node_modules/trackyourtime-mcp/dist/index.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/node_modules/trackyourtime-mcp/dist/index.js"],
      env: {
        TRACKYOURTIME_API_TOKEN: "${user_config.api_token}",
        TRACKYOURTIME_API_URL: "${user_config.api_url}",
      },
    },
  },
  user_config: {
    api_token: {
      type: "string", title: "API token", sensitive: true, required: true,
      description: "Create a workspace API token in Track Your Time under Settings → Integrations.",
    },
    api_url: {
      type: "string", title: "API origin", required: false,
      default: "https://api.trackyourtime.dev",
      description: "Use the hosted API or enter the origin of your own Track Your Time server.",
    },
  },
}, null, 2)}\n`);
console.log(`Staged ${pkg.name}@${pkg.version} in ${output}`);
