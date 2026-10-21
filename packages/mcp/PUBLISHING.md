# Publishing the MCP package

Run these commands from the repository root with Node.js 24 and pnpm.
The package version follows the app version. npm versions cannot be replaced.

## Check the npm artifact

```bash
pnpm build:mcp
pnpm --filter trackyourtime-mcp typecheck
pnpm --filter trackyourtime-mcp test
node --test scripts/lib/version-sync.test.mjs
```

Choose a new temporary directory for each release:

```bash
release_dir=$(mktemp -d)
pnpm --filter trackyourtime-mcp pack --out "$release_dir/package.tgz"
npm install --prefix "$release_dir/install" --ignore-scripts --no-audit --no-fund "$release_dir/package.tgz"
node packages/mcp/check-package.mjs "$release_dir/install"
tar -tzf "$release_dir/package.tgz"
```

The runtime check starts the installed executable over stdio. It verifies the
handshake, scope filtering and a tool call against a temporary local API with
synthetic data. It closes both processes afterward.

The tarball contains the executable, its source map, `server.json`, package
metadata, README and AGPL license. Private workspace code is bundled. Only public
npm packages remain as runtime dependencies. The source map includes the bundled
TypeScript source.

## Publish npm and the MCP Registry

```bash
npm login --auth-type=web
npm publish "$release_dir/package.tgz" --access public
npm view trackyourtime-mcp version dist.integrity
mcp-publisher login github
mcp-publisher publish packages/mcp/dist/server.json
```

`build.mjs` generates the registry manifest from the package name and version.
Its name matches `mcpName` in the npm package. Publish npm first: the registry
checks that package for ownership. The GitHub namespace is
`io.github.trebeljahr/trackyourtime`.

Check the public record at
<https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.trebeljahr%2Ftrackyourtime>.
Install the published version into another new directory and run
`check-package.mjs` again.

## Publish the local MCPB bundle

Smithery distributes stdio servers as MCPB bundles. This does not need a hosted
MCP endpoint or a production API token.

```bash
node packages/mcp/build-mcpb.mjs "$release_dir/install" "$release_dir/bundle"
npx --yes @anthropic-ai/mcpb@2.1.2 pack "$release_dir/bundle" "$release_dir/trackyourtime.mcpb"
mkdir "$release_dir/extracted"
unzip -q "$release_dir/trackyourtime.mcpb" -d "$release_dir/extracted"
node packages/mcp/check-package.mjs "$release_dir/extracted"
npx --yes smithery@1.2.0 auth login
npx --yes smithery@1.2.0 mcp publish "$release_dir/trackyourtime.mcpb" -n trebeljahr/trackyourtime
```

Inspect the extracted manifest and file list before uploading. The bundle asks
each user for their own API token. Never upload a real token for directory scans.
Glama submissions use the public GitHub repository through its Add Server form.

After publication, update the user docs with the public npm installation command
and verified directory links. Keep the source-build instructions as an alternative.
