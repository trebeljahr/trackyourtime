import { copyFile, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

// Bundle the private workspace code; consumers install only public npm dependencies.
const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  external: ["@modelcontextprotocol/sdk/*", "zod", "zod/*"],
  sourcemap: true,
  sourcesContent: true,
  metafile: true,
});
for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (dependency.external && dependency.path.startsWith("@starter/")) {
      throw new Error(`Private workspace import remains: ${dependency.path}`);
    }
  }
}

await copyFile(resolve(root, "../../LICENSE"), resolve(root, "LICENSE"));
await writeFile(resolve(root, "dist/server.json"), `${JSON.stringify({
  $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  name: pkg.mcpName,
  title: "Track Your Time",
  description: "Track time, manage entries and catalog, and summarize hours on hosted or self-hosted accounts.",
  repository: { url: "https://github.com/trebeljahr/trackyourtime", source: "github", subfolder: "packages/mcp" },
  websiteUrl: pkg.homepage,
  version: pkg.version,
  packages: [{
    registryType: "npm",
    identifier: pkg.name,
    version: pkg.version,
    transport: { type: "stdio" },
    environmentVariables: [
      { name: "TRACKYOURTIME_API_TOKEN", description: "A workspace API token created in Settings → Integrations.", isRequired: true, isSecret: true, format: "string" },
      { name: "TRACKYOURTIME_API_URL", description: "API origin. Defaults to https://api.trackyourtime.dev; use your own instance's origin for self-hosting.", isRequired: false, format: "string" },
    ],
  }],
}, null, 2)}\n`);
