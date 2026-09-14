import type { MetadataRoute } from "next";

// `output: "export"` writes this once, at build time, to `out/robots.txt`.
export const dynamic = "force-static";

const SITE_URL = "https://trackyourtime.dev";

/**
 * Crawlers that fetch pages for AI assistants and AI search. A crawler that
 * finds a group naming it ignores the `*` group, so the named group repeats
 * the same rules.
 */
const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "anthropic-ai",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot-Extended",
  "CCBot",
  "meta-externalagent",
  "Amazonbot",
  "DuckAssistBot",
  "cohere-ai",
];

/** `/sub/` is the newsletter sign-up and its confirmation pages, which carry `noindex` too. */
const DISALLOW = ["/sub/"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: DISALLOW },
      { userAgent: AI_CRAWLERS, allow: "/", disallow: DISALLOW },
    ],
    // The docs at /docs/ are a separate Docusaurus build copied into the export
    // (scripts/docs/build-into-client.mjs) with a sitemap of its own. This is
    // the domain's only robots.txt, so it names both.
    sitemap: [`${SITE_URL}/sitemap.xml`, `${SITE_URL}/docs/sitemap.xml`],
  };
}
