/**
 * The checks `scripts/docs/build-into-client.mjs` runs on the docs tree before
 * the client image ships it at trackyourtime.dev/docs/.
 *
 * Each one guards a failure that deploys green: a noindex tag, a canonical link
 * to another host, a stray robots.txt, a sitemap naming the wrong addresses.
 * Checked here on small fixture trees, because the real tree only exists after
 * a docs build.
 *
 * Run by the server package's `test` script (`pnpm test:unit`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { DOCS_BASE, DOCS_ORIGIN, REPO_ROOT, problemsInDocsTree } from "../docs/build-into-client.mjs";

const BASE = `${DOCS_ORIGIN}${DOCS_BASE}`;

const page = (canonical, extraHead = "") =>
  `<!doctype html><html><head>${extraHead}<link data-rh="true" rel="canonical" href="${canonical}"></head><body></body></html>`;

/** A tree that passes, with `overrides` (path → content, or null to delete) applied. */
function fixture(overrides = {}) {
  const files = {
    "index.html": page(BASE),
    "self-hosting/index.html": page(`${BASE}self-hosting/`),
    "api/index.html": page(`${BASE}api/`),
    "mcp/index.html": page(`${BASE}mcp/`),
    "404.html": page(`${BASE}404.html/`),
    "sitemap.xml": `<urlset><url><loc>${BASE}</loc></url><url><loc>${BASE}mcp/</loc></url></urlset>`,
    "llms.txt": "# Track Your Time\n",
    ...overrides,
  };
  const dir = mkdtempSync(join(tmpdir(), "docs-tree-"));
  for (const [path, content] of Object.entries(files)) {
    if (content === null) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

describe("problemsInDocsTree", () => {
  it("passes a tree served under trackyourtime.dev/docs/", () => {
    assert.deepEqual(problemsInDocsTree(fixture()), []);
  });

  it("refuses a noindex page", () => {
    const dir = fixture({ "mcp/index.html": page(`${BASE}mcp/`, '<meta name="robots" content="noindex, nofollow">') });
    assert.deepEqual(problemsInDocsTree(dir), ["mcp/index.html carries a noindex robots meta tag."]);
  });

  it("refuses a canonical link to another host, or none", () => {
    const dir = fixture({
      "index.html": page("https://docs.example.com/"),
      "mcp/index.html": "<html><head></head></html>",
    });
    const problems = problemsInDocsTree(dir);
    assert.equal(problems.length, 2);
    assert.match(problems.join("\n"), /index\.html has canonical https:\/\/docs\.example\.com\//);
    assert.match(problems.join("\n"), /mcp\/index\.html has no canonical link/);
  });

  it("refuses a robots.txt, a missing page and a sitemap on the wrong base", () => {
    const dir = fixture({
      "robots.txt": "User-agent: *\nDisallow: /\n",
      "api/index.html": null,
      "sitemap.xml": "<urlset><url><loc>https://trackyourtime.dev/mcp/</loc></url></urlset>",
    });
    const problems = problemsInDocsTree(dir).join("\n");
    assert.match(problems, /robots\.txt was written under \/docs\//);
    assert.match(problems, /api\/index\.html is missing/);
    assert.match(problems, /sitemap\.xml lists https:\/\/trackyourtime\.dev\/mcp\//);
  });

  it("agrees with the address in docusaurus.config.ts", () => {
    const config = readFileSync(resolve(REPO_ROOT, "docs-site/docusaurus.config.ts"), "utf8");
    assert.match(config, new RegExp(`const siteUrl = "${DOCS_ORIGIN}";`));
    assert.match(config, new RegExp(`const baseUrl = "${DOCS_BASE}";`));
  });
});
