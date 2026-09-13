import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";

import type { LoadContext, Plugin } from "@docusaurus/types";

import { isExternal, splitTarget, titleOf, toCleanMarkdown } from "../../scripts/llms/markdown.mjs";
import {
  DOC_SECTIONS,
  EXCLUDED_DOC_IDS,
  OPTIONAL_DOC_IDS,
  renderLlmsFull,
  renderLlmsTxt,
} from "../../scripts/llms/site.mjs";

/**
 * Writes a plain Markdown copy of every docs page, plus `llms.txt` and
 * `llms-full.txt`, into the build output.
 *
 * An assistant asked about Track Your Time reads a page far more reliably as
 * Markdown than as rendered HTML with a navbar and a sidebar around it. So
 * every page at `/x` also answers at `/x.md` (and the root at `/index.md`),
 * made from the same source file the HTML was built from. `llms.txt`
 * (https://llmstxt.org) lists those copies, and `llms-full.txt` concatenates
 * them.
 *
 * The prose around the links, and which page goes in which section, lives in
 * `scripts/llms/site.mjs`. trackyourtime.dev's own `llms.txt` is rendered from
 * the same module, so the two cannot describe different products.
 *
 * Links in the copies are absolute, built on `siteConfig.url`: a `.md` file
 * fetched on its own has no page around it to resolve a relative link against.
 */

/** The slice of a docs plugin doc this plugin reads. */
type DocMetadata = {
  id: string;
  title: string;
  description: string;
  source: string;
  permalink: string;
  draft?: boolean;
  unlisted?: boolean;
};

type DocsContent = { loadedVersions: Array<{ docs: DocMetadata[] }> };

type PageLink = { title: string; url: string; description?: string };

/** `/api/overview` → `/api/overview.md`, `/` → `/index.md`. */
export function markdownPathFor(permalink: string): string {
  return permalink.endsWith("/") ? `${permalink}index.md` : `${permalink}.md`;
}

export function llmsMarkdownPlugin(context: LoadContext): Plugin<void> {
  const { siteDir, siteConfig } = context;
  const origin = siteConfig.url.replace(/\/+$/, "");
  const baseUrl = siteConfig.baseUrl;
  let docs: DocMetadata[] = [];

  /** `@site/docs/api/overview.md` → `docs/api/overview.md`, POSIX separators. */
  const sitePath = (source: string): string =>
    source.startsWith("@site/") ? source.slice("@site/".length) : relative(siteDir, source).split("\\").join("/");

  const absolute = (path: string): string => `${origin}${path}`;

  function linkRewriter(doc: DocMetadata): (target: string) => string {
    const bySource = new Map(docs.map((d) => [sitePath(d.source), d]));
    const byPermalink = new Map(docs.map((d) => [d.permalink.replace(/\/$/, "") || "/", d]));
    const from = posix.dirname(sitePath(doc.source));

    return (target) => {
      if (target.startsWith("pathname://")) return absolute(target.slice("pathname://".length));
      if (target.startsWith("#") || isExternal(target)) return target;

      const { path, suffix } = splitTarget(target);
      if (path === "") return target;

      if (path.startsWith("/")) {
        const linked = byPermalink.get(path.replace(/\/$/, "") || "/");
        return linked ? absolute(markdownPathFor(linked.permalink)) + suffix : absolute(path) + suffix;
      }

      const linked = bySource.get(posix.normalize(posix.join(from, path)));
      return linked ? absolute(markdownPathFor(linked.permalink)) + suffix : target;
    };
  }

  const readSource = (doc: DocMetadata): string => readFileSync(join(siteDir, sitePath(doc.source)), "utf8");

  /**
   * The page's own heading wins over Docusaurus's title. Docusaurus takes the
   * title from an H1 only when it is the first thing in the body, so a page
   * that opens with an MDX comment (the generated API reference) is titled
   * after its file name instead.
   */
  const titleFor = (doc: DocMetadata): string => titleOf(readSource(doc)) ?? doc.title;

  function markdownOf(doc: DocMetadata): string {
    return toCleanMarkdown(readSource(doc), { title: titleFor(doc), rewriteLink: linkRewriter(doc) });
  }

  return {
    name: "llms-markdown",

    async allContentLoaded({ allContent }) {
      const content = allContent["docusaurus-plugin-content-docs"]?.default as DocsContent | undefined;
      docs = (content?.loadedVersions ?? [])
        .flatMap((version) => version.docs)
        .filter((doc) => !doc.draft && !doc.unlisted);
    },

    async postBuild({ outDir }) {
      if (docs.length === 0) {
        throw new Error("llms-markdown: the docs plugin loaded no pages, so there is nothing to export.");
      }

      const markdown = new Map<string, string>();
      for (const doc of docs) {
        const text = markdownOf(doc);
        markdown.set(doc.id, text);
        const file = join(outDir, markdownPathFor(doc.permalink).slice(baseUrl.length));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
      }

      const byId = new Map(docs.map((doc) => [doc.id, doc]));
      const toLink = (doc: DocMetadata): PageLink => ({
        title: titleFor(doc),
        url: absolute(markdownPathFor(doc.permalink)),
        description: doc.description || undefined,
      });
      const present = (ids: readonly string[]): DocMetadata[] =>
        ids.flatMap((id) => (byId.has(id) ? [byId.get(id) as DocMetadata] : []));

      const placed = new Set([
        ...DOC_SECTIONS.flatMap((section) => section.ids),
        ...OPTIONAL_DOC_IDS,
        ...EXCLUDED_DOC_IDS,
      ]);
      const optional = [...present(OPTIONAL_DOC_IDS), ...docs.filter((doc) => !placed.has(doc.id))];

      const sections = DOC_SECTIONS.map((section) => ({
        title: section.title,
        links: present(section.ids).map(toLink),
      }));
      sections
        .find((section) => section.title === "REST API")
        ?.links.push({
          title: "OpenAPI document",
          url: absolute(`${baseUrl}openapi.json`),
          description: "The machine-readable description of every /api/v1 route.",
        });
      sections.push({ title: "Optional", links: optional.map(toLink) });

      const llmsTxt = renderLlmsTxt(sections);
      const fullTextDocs = [...DOC_SECTIONS.flatMap((section) => present(section.ids)), ...optional];
      const llmsFull = renderLlmsFull(
        llmsTxt,
        fullTextDocs.map((doc) => ({
          url: absolute(markdownPathFor(doc.permalink)),
          markdown: markdown.get(doc.id) ?? "",
        })),
      );

      writeFileSync(join(outDir, "llms.txt"), llmsTxt);
      writeFileSync(join(outDir, "llms-full.txt"), llmsFull);
    },
  };
}
