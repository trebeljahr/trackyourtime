#!/usr/bin/env node
/**
 * Writes trackyourtime.dev's `llms.txt` and `llms-full.txt`.
 *
 *   pnpm llms:emit
 *
 * Both files are committed under `packages/client/public/` and served as
 * static files by the web app. They are generated rather than hand-written
 * because `llms-full.txt` carries the full text of the self-hosting guide, the
 * MCP page and the API pages, and a hand-kept copy of those drifts the first
 * time any of them is edited. `scripts/lib/llms.test.mjs` fails when the
 * committed files no longer match what this script would write.
 *
 * Every docs link here points at the docs site's Markdown copy of that page,
 * `https://trackyourtime.dev/docs/<page>.md`, which the same client image
 * serves (`scripts/docs/build-into-client.mjs`). The docs site also writes its
 * own pair of files at `/docs/llms.txt`, at build time
 * (`docs-site/plugins/llms-markdown.ts`).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isExternal, splitFrontMatter, splitTarget, titleOf, toCleanMarkdown } from "./markdown.mjs";
import {
  BLOB_URL,
  DOCS_URL,
  DOC_SECTIONS,
  OPENAPI_URL,
  OPTIONAL_DOC_IDS,
  RAW_URL,
  WEB_URL,
  renderLlmsFull,
  renderLlmsTxt,
} from "./site.mjs";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const LLMS_TXT_PATH = "packages/client/public/llms.txt";
export const LLMS_FULL_PATH = "packages/client/public/llms-full.txt";

/**
 * Where a docs id's text is read from. The docs site's self-hosting page is
 * generated from `docs/self-hosting.md`, so the original is read instead of
 * the copy with its links already rewritten for the docs site.
 */
const SOURCE_OVERRIDES = { "self-hosting": "docs/self-hosting.md" };

/** Titles and descriptions for sources whose own front matter cannot supply them. */
const LINK_OVERRIDES = {
  "self-hosting": {
    title: "Self-hosting guide",
    description:
      "Run Track Your Time on one server with one domain and Docker Compose: install, first account, email, backups, upgrades and troubleshooting.",
  },
};

/** The docs site's own index page, which only maps the other pages. */
const SKIPPED_ON_WEB = new Set(["intro"]);

/** The pages whose full text goes into `llms-full.txt`, in order. */
const FULL_TEXT_IDS = [
  "choosing-a-self-hosted-time-tracker",
  "self-hosting",
  "mcp",
  "api/overview",
  "api/authentication",
  "api/errors",
];

const WEB_PAGES = [
  {
    title: "Home",
    url: `${WEB_URL}/`,
    description: "Free, open-source time tracking on every device, offline included. Reports, invoices, teams, import, export and an API, on the hosted service or on your own server with the same app.",
  },
  {
    title: "Chrome extension",
    url: `${WEB_URL}/extension/`,
    description: "Start and stop the timer from the Chrome toolbar, add time you forgot, get entry suggestions from browsing activity, and keep tracking when the connection drops.",
  },
  {
    title: "Raycast extension",
    url: `${WEB_URL}/raycast/`,
    description: "Start and stop the timer with a hotkey, and see it running in the Mac menu bar.",
  },
  {
    title: "iPhone and Android",
    url: `${WEB_URL}/mobile/`,
    description: "Track billable time on an iPhone or Android phone without signal, against the hosted service or your own server. Changes sync when the connection returns.",
  },
];

/** @param {string} id */
function sourcePathOf(id) {
  return SOURCE_OVERRIDES[id] ?? `docs-site/docs/${id}.md`;
}

/**
 * The docs site's Markdown copy of a page: `mcp` → `…/docs/mcp.md`. A `slug`
 * in the page's front matter moves it, as it moves the page (`api/overview`
 * has `slug: /api/` → `…/docs/api.md`; the intro's `/` → `…/docs/index.md`).
 * Mirrors `markdownPathFor` in `docs-site/plugins/llms-markdown.ts`.
 *
 * @param {string} root
 * @param {string} id
 */
export function docsMarkdownUrl(root, id) {
  const slug = splitFrontMatter(readSource(root, `docs-site/docs/${id}.md`)).data.slug;
  const route = (typeof slug === "string" ? slug : id).replace(/^\/+|\/+$/g, "");
  return `${DOCS_URL}/${route === "" ? "index" : route}.md`;
}

/**
 * @param {string} root
 * @param {string} relativePath
 */
function readSource(root, relativePath) {
  const absolute = resolve(root, relativePath);
  if (!existsSync(absolute)) {
    throw new Error(`llms: ${relativePath} does not exist, and llms.txt links to it.`);
  }
  return readFileSync(absolute, "utf8");
}

/**
 * The docs id a repo path is published as, or null: `docs-site/docs/mcp.md` →
 * `mcp`, and the self-hosting guide's source → `self-hosting`.
 *
 * @param {string} root
 * @param {string} repoPath
 */
function docsIdOf(root, repoPath) {
  const override = Object.entries(SOURCE_OVERRIDES).find(([, path]) => path === repoPath);
  if (override) return override[0];
  const match = repoPath.match(/^docs-site\/docs\/(.+)\.md$/);
  return match && existsSync(resolve(root, repoPath)) ? match[1] : null;
}

/**
 * Point a link found in `sourcePath` at an address that works outside the
 * repo: docs pages at their Markdown copy on the docs site, other Markdown
 * files at their raw GitHub URL, other repo files at their GitHub page, the
 * docs site's OpenAPI link at the live API.
 *
 * @param {string} root
 * @param {string} sourcePath
 * @returns {(target: string) => string}
 */
export function webLinkRewriter(root, sourcePath) {
  return (target) => {
    if (target === "pathname:///openapi.json") return OPENAPI_URL;
    if (target.startsWith("#") || isExternal(target)) return target;

    const { path, suffix } = splitTarget(target);
    if (path === "") return target;

    let repoPath;
    if (path.startsWith("/")) {
      // A root-relative link in a docs page is a docs route.
      const doc = `docs-site/docs${path.replace(/\/$/, "")}.md`;
      if (!existsSync(resolve(root, doc))) return target;
      repoPath = doc;
    } else {
      repoPath = posix.normalize(posix.join(posix.dirname(sourcePath), path));
      if (repoPath.startsWith("..")) return target;
    }

    const docsId = docsIdOf(root, repoPath);
    if (docsId) return `${docsMarkdownUrl(root, docsId)}${suffix}`;
    return /\.mdx?$/.test(repoPath) ? `${RAW_URL}/${repoPath}${suffix}` : `${BLOB_URL}/${repoPath}${suffix}`;
  };
}

/**
 * @param {string} root
 * @param {string} id
 */
function linkFor(root, id) {
  const sourcePath = sourcePathOf(id);
  const source = readSource(root, sourcePath);
  const override = LINK_OVERRIDES[id] ?? {};
  return {
    title: override.title ?? titleOf(source) ?? id,
    url: docsMarkdownUrl(root, id),
    description: override.description ?? splitFrontMatter(source).data.description,
  };
}

/**
 * Both files, as they should be on disk.
 *
 * @param {{ root?: string }} [options]
 * @returns {Record<string, string>} Repo-relative path to file content.
 */
export function buildWebLlmsFiles({ root = REPO_ROOT } = {}) {
  const sections = DOC_SECTIONS.map((section) => ({
    title: section.title,
    links: section.ids.filter((id) => !SKIPPED_ON_WEB.has(id)).map((id) => linkFor(root, id)),
  }));

  const api = sections.find((section) => section.title === "REST API");
  api?.links.push({
    title: "OpenAPI document",
    url: OPENAPI_URL,
    description: "The machine-readable description of every /api/v1 route, served by the hosted API.",
  });

  sections.push({ title: "Web pages", links: WEB_PAGES });
  sections.push({
    title: "Optional",
    links: [
      ...OPTIONAL_DOC_IDS.map((id) => linkFor(root, id)),
      {
        title: "README",
        url: `${RAW_URL}/README.md`,
        description: "The full feature list, the repository layout and the development setup.",
      },
      {
        title: "llms-full.txt",
        url: `${WEB_URL}/llms-full.txt`,
        description: "This file plus the full text of the self-hosting guide, the MCP page and the main API pages.",
      },
      { title: "Privacy", url: `${WEB_URL}/privacy/`, description: "What the hosted service stores, why, who else sees it, and how to get it back or have it deleted." },
      { title: "Support", url: `${WEB_URL}/support/`, description: "How to get help, and answers to common questions." },
    ],
  });

  const llmsTxt = renderLlmsTxt(sections);
  const pages = FULL_TEXT_IDS.map((id) => {
    const sourcePath = sourcePathOf(id);
    const source = readSource(root, sourcePath);
    return {
      url: docsMarkdownUrl(root, id),
      markdown: toCleanMarkdown(source, { rewriteLink: webLinkRewriter(root, sourcePath) }),
    };
  });

  return {
    [LLMS_TXT_PATH]: llmsTxt,
    [LLMS_FULL_PATH]: renderLlmsFull(llmsTxt, pages),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  for (const [path, content] of Object.entries(buildWebLlmsFiles())) {
    writeFileSync(resolve(REPO_ROOT, path), content);
    console.log(`[llms] wrote ${path} (${content.length} bytes)`);
  }
}
