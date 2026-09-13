/**
 * The llms.txt pipeline: the Markdown cleaner both sites use, and whether
 * trackyourtime.dev's committed `llms.txt` / `llms-full.txt` still match their
 * sources.
 *
 * The staleness check exists for the same reason as
 * `packages/server/src/tests/openapi-document.test.ts`: `llms-full.txt` holds
 * the full text of the self-hosting guide, the MCP page and the API pages, and
 * a copy that stopped tracking them would tell an assistant something the docs
 * no longer say. When it fails, run `pnpm llms:emit` and commit the result.
 *
 * Run by the server package's `test` script (`pnpm test:unit`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { REPO_ROOT, buildWebLlmsFiles, webLinkRewriter } from "../llms/build-llms.mjs";
import { splitFrontMatter, titleOf, toCleanMarkdown } from "../llms/markdown.mjs";
import { AI_CRAWLERS, OPENAPI_URL, RAW_URL } from "../llms/site.mjs";

describe("splitFrontMatter", () => {
  it("reads flat fields and unquotes values", () => {
    const { data, body } = splitFrontMatter('---\nslug: /\ndescription: "A page: with a colon"\n---\n\n# Hi\n');
    assert.deepEqual(data, { slug: "/", description: "A page: with a colon" });
    assert.equal(body, "\n# Hi\n");
  });

  it("returns the whole file as body when there is no front matter", () => {
    assert.deepEqual(splitFrontMatter("# Hi\n"), { data: {}, body: "# Hi\n" });
  });
});

describe("toCleanMarkdown", () => {
  it("strips front matter and keeps the page's own H1", () => {
    const out = toCleanMarkdown("---\ndescription: x\n---\n\n# Errors\n\nBody.\n");
    assert.equal(out, "# Errors\n\nBody.\n");
  });

  it("adds a title heading when the body has none", () => {
    const out = toCleanMarkdown("---\ntitle: Intro\n---\n\nBody.\n");
    assert.equal(out, "# Intro\n\nBody.\n");
    assert.equal(titleOf("---\ntitle: Intro\n---\nBody"), "Intro");
  });

  it("removes MDX comments and ESM lines, but not inside code fences", () => {
    const source = [
      "{/* Generated — do not edit. */}",
      "",
      "# Reference",
      "",
      "import Tabs from '@theme/Tabs';",
      "Text {/* inline */} here.",
      "{/* a comment",
      "   over two lines */}",
      "```js",
      'import express from "express";',
      "{/* kept */}",
      "```",
      "export it once per shell:",
    ].join("\n");
    const out = toCleanMarkdown(source);
    assert.equal(
      out,
      [
        "# Reference",
        "",
        "Text  here.",
        "```js",
        'import express from "express";',
        "{/* kept */}",
        "```",
        "export it once per shell:",
        "",
      ].join("\n"),
    );
  });

  it("rewrites link targets outside code, including multi-line link text", () => {
    const source = [
      "# Page",
      "",
      "See [the",
      "reference](./reference.md#top) and `[not](./a-link.md)`.",
      "",
      "[def]: ./errors.md",
      "",
      "```",
      "[also not](./code.md)",
      "```",
    ].join("\n");
    const out = toCleanMarkdown(source, { rewriteLink: (target) => `X${target}` });
    assert.match(out, /reference\]\(X\.\/reference\.md#top\)/);
    assert.match(out, /`\[not\]\(\.\/a-link\.md\)`/);
    assert.match(out, /\[def\]: X\.\/errors\.md/);
    assert.match(out, /\[also not\]\(\.\/code\.md\)/);
  });
});

describe("webLinkRewriter", () => {
  const rewrite = webLinkRewriter(REPO_ROOT, "docs-site/docs/api/overview.md");

  it("points repo Markdown at raw GitHub and other files at their GitHub page", () => {
    assert.equal(rewrite("./errors.md#slugs"), `${RAW_URL}/docs-site/docs/api/errors.md#slugs`);
    assert.equal(
      webLinkRewriter(REPO_ROOT, "docs/self-hosting.md")("../.github/workflows/release.yml"),
      "https://github.com/trebeljahr/tracktime/blob/main/.github/workflows/release.yml",
    );
  });

  it("sends the docs site's OpenAPI link to the live API and leaves anchors alone", () => {
    assert.equal(rewrite("pathname:///openapi.json"), OPENAPI_URL);
    assert.equal(rewrite("#getting-started"), "#getting-started");
    assert.equal(rewrite("https://example.com/x"), "https://example.com/x");
  });
});

describe("trackyourtime.dev llms files", () => {
  const expected = buildWebLlmsFiles();

  for (const [path, content] of Object.entries(expected)) {
    it(`${path} is up to date (run \`pnpm llms:emit\` if not)`, () => {
      const committed = readFileSync(resolve(REPO_ROOT, path), "utf8");
      assert.equal(committed, content, `${path} is stale. Run \`pnpm llms:emit\` and commit the result.`);
    });
  }

  it("llms.txt follows the llmstxt.org shape", () => {
    const text = expected["packages/client/public/llms.txt"];
    assert.match(text, /^# Track Your Time\n\n> /);
    assert.match(text, /\n## Optional\n/);
    assert.doesNotMatch(text, /\]\(\.{0,2}\//, "every link in llms.txt is absolute");
  });
});

describe("robots.ts", () => {
  it("names the same AI crawlers as the docs site's robots.txt", () => {
    const source = readFileSync(resolve(REPO_ROOT, "packages/client/src/app/robots.ts"), "utf8");
    const listed = [...source.matchAll(/^\s+"([^"]+)",$/gm)].map((match) => match[1]);
    assert.deepEqual(listed, AI_CRAWLERS);
  });
});
