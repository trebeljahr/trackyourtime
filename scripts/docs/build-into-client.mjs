#!/usr/bin/env node
/**
 * Builds the docs site and puts it inside the web app's static export, so the
 * client image serves it at https://trackyourtime.dev/docs/.
 *
 *   pnpm build:client && node scripts/docs/build-into-client.mjs
 *   pnpm build:web                                   # the same two steps
 *
 * Run after the client build, never as part of it. `packages/client/out` is
 * written by the web build AND by Playwright (with a throwaway API port), and
 * the Electron and Capacitor shells use `out-desktop` / `out-mobile`. Only
 * the web image wants the docs, so only `packages/client/Dockerfile` calls
 * this; `@starter/client`'s own `build` script stays docs-free.
 *
 * A subfolder of the main domain rather than a `docs.` host or a proxy path:
 * one domain for search engines, and no routing in caddy-docker-proxy, which
 * merges same-host sites and strips `handle_path` prefixes (docs/deploy.md).
 *
 * After copying, the tree is checked for the failures that look like success —
 * a page that tells search engines not to index it, a canonical link to
 * another host, a stray robots.txt, a sitemap with the wrong addresses — and
 * the script exits non-zero on any of them.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DOCS_BUILD_DIR = resolve(REPO_ROOT, "docs-site/build");
export const CLIENT_OUT_DIR = resolve(REPO_ROOT, "packages/client/out");

/** Where the docs live on the domain. Must match `url` + `baseUrl` in docs-site/docusaurus.config.ts. */
export const DOCS_ORIGIN = "https://trackyourtime.dev";
export const DOCS_BASE = "/docs/";

/** Pages whose absence means the site did not build the way the links on trackyourtime.dev expect. */
const REQUIRED_FILES = ["index.html", "self-hosting/index.html", "api/index.html", "mcp/index.html", "sitemap.xml", "llms.txt"];

/** @param {string} dir @returns {string[]} every file below `dir`, relative to it, POSIX separators. */
function listFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(dir, path).split("\\").join("/"));
    }
  };
  walk(dir);
  return out;
}

/**
 * Everything wrong with a built docs tree, as sentences. Empty means shippable.
 *
 * @param {string} dir the docs tree (`docs-site/build` or `out/docs`)
 * @returns {string[]}
 */
export function problemsInDocsTree(dir) {
  const problems = [];
  const files = listFiles(dir);
  const base = `${DOCS_ORIGIN}${DOCS_BASE}`;

  for (const required of REQUIRED_FILES) {
    if (!files.includes(required)) problems.push(`${required} is missing.`);
  }

  if (files.includes("robots.txt")) {
    problems.push("robots.txt was written under /docs/. The domain's robots.txt is the web app's; remove the docs one.");
  }

  for (const file of files.filter((name) => name.endsWith(".html"))) {
    const html = readFileSync(join(dir, file), "utf8");
    if (/<meta[^>]+name=["']robots["'][^>]*noindex/i.test(html)) {
      problems.push(`${file} carries a noindex robots meta tag.`);
    }
    // Docusaurus gives its 404 page a canonical of `/docs/404.html/`. It is only
    // ever served with a 404 status, which search engines do not index.
    if (file === "404.html") continue;
    const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1];
    if (!canonical) problems.push(`${file} has no canonical link.`);
    else if (!canonical.startsWith(base)) problems.push(`${file} has canonical ${canonical}, not under ${base}.`);
  }

  if (files.includes("sitemap.xml")) {
    const locs = [...readFileSync(join(dir, "sitemap.xml"), "utf8").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    if (locs.length === 0) problems.push("sitemap.xml lists no pages.");
    for (const loc of locs.filter((url) => !url.startsWith(base))) {
      problems.push(`sitemap.xml lists ${loc}, not under ${base}.`);
    }
  }

  return problems;
}

function run() {
  if (!existsSync(join(CLIENT_OUT_DIR, "index.html"))) {
    console.error(`[docs] No web export at ${CLIENT_OUT_DIR}. Run \`pnpm build:client\` first.`);
    process.exit(1);
  }

  const build = spawnSync("pnpm", ["--filter", "docs-site", "run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  if (build.status !== 0) {
    console.error("[docs] The docs site failed to build.");
    process.exit(build.status ?? 1);
  }

  const target = join(CLIENT_OUT_DIR, DOCS_BASE);
  rmSync(target, { recursive: true, force: true });
  cpSync(DOCS_BUILD_DIR, target, { recursive: true });

  const problems = problemsInDocsTree(target);
  if (problems.length > 0) {
    console.error(`[docs] ${target} is not fit to ship:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`[docs] Copied the docs site to ${relative(REPO_ROOT, target)} (served at ${DOCS_ORIGIN}${DOCS_BASE}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run();
}
