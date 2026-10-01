#!/usr/bin/env node
/**
 * Print the Chrome extension id, and the origin the server has to trust.
 *
 * The origin matters because better-auth force-validates it on sign-in. A real
 * browser sends `Sec-Fetch-Site`/`Sec-Fetch-Mode`, which makes better-auth
 * check the `Origin` header against `trustedOrigins` even with no cookie on
 * the request; an untrusted extension origin gets a flat
 * `403 {"code":"INVALID_ORIGIN"}` before the password is ever looked at.
 *
 * Two ways an id comes about, and this reports whichever applies:
 *
 *  - A `key` pinned in the manifest fixes the id wherever it is loaded from.
 *    That is the only way to know a production id before uploading anything.
 *  - Otherwise an unpacked extension's id is derived from the absolute path it
 *    was loaded from — stable for a directory, different for every checkout.
 *
 *   node scripts/extension-id.mjs [dev|hmr|prod|<path-to-unpacked-dir>]
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { extensionId } from "./lib/extension-id.mjs";

const EXTENSION = new URL("../packages/extension/", import.meta.url).pathname;

const TARGETS = {
  hmr: join(EXTENSION, "dist-hmr"),
  dev: join(EXTENSION, "dist"),
  development: join(EXTENSION, "dist"),
  prod: join(EXTENSION, "dist-prod"),
  production: join(EXTENSION, "dist-prod"),
};

const argument = process.argv[2] ?? "dev";
const target = resolve(TARGETS[argument] ?? argument);

if (!existsSync(target)) {
  console.error(`No such directory: ${target}`);
  console.error(
    argument === "prod" || argument === "production"
      ? "Build it first with:  pnpm run build:extension:prod"
      : "Build it first with:  pnpm run build:extension",
  );
  process.exit(1);
}

const { id, source } = extensionId(target);
const key = source === "pinned manifest key";

console.log(`path:   ${target}`);
console.log(`source: ${source}`);
console.log(`id:     ${id}`);
console.log(`origin: chrome-extension://${id}`);
console.log();
if (key) {
  console.log("Pinned by a manifest key, so this id holds wherever it loads from.");
} else {
  console.log("Derived from the path — loading the same build from elsewhere");
  console.log("changes the id. Pin EXTENSION_KEY to fix it (see manifest.config.ts).");
}
console.log();
console.log("`pnpm run dev` already trusts the dev id above — it derives it the");
console.log("same way. This is for the production origin, or for a server started");
console.log("some other way: add it to TRUSTED_ORIGINS in packages/server/.env.<env>,");
console.log("then restart the server — the env file is read at boot, not watched.");
