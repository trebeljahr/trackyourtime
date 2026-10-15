#!/usr/bin/env node
/**
 * Prepare the web export for the hosted Cloudflare Worker, and check it fits.
 *
 *   node scripts/cloudflare-static.mjs write <out-dir>   write _redirects and _headers
 *   node scripts/cloudflare-static.mjs check <out-dir>   Workers Free limits, after the carry
 *
 * Only the hosted upload runs this. The phone, desktop, E2E and self-host
 * builds never get the two files. Logic and tests: scripts/lib/cloudflare-static.mjs.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { checkLimits, renderHeaders, renderRedirects } from "./lib/cloudflare-static.mjs";

const [command, outDir] = process.argv.slice(2);
if ((command !== "write" && command !== "check") || !outDir) {
  console.error("usage: node scripts/cloudflare-static.mjs write|check <out-dir>");
  process.exit(2);
}
if (!existsSync(join(outDir, "index.html"))) {
  console.error(`${outDir} holds no index.html; build the web export first.`);
  process.exit(1);
}

if (command === "write") {
  writeFileSync(join(outDir, "_redirects"), renderRedirects());
  writeFileSync(join(outDir, "_headers"), renderHeaders());
  console.log(`wrote ${join(outDir, "_redirects")} and ${join(outDir, "_headers")}`);
} else {
  const read = (name) => (existsSync(join(outDir, name)) ? readFileSync(join(outDir, name), "utf8") : undefined);
  const { problems, files, bytes } = checkLimits(outDir, { headers: read("_headers"), redirects: read("_redirects") });
  console.log(`${outDir}: ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MiB`);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`ERROR: ${problem}`);
    process.exit(1);
  }
}
