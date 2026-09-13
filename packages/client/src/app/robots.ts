import type { MetadataRoute } from "next";

// `output: "export"` writes this once, at build time, to `out/robots.txt`.
export const dynamic = "force-static";

const SITE_URL = "https://trackyourtime.dev";

/**
 * Crawlers that fetch pages for AI assistants and AI search. A crawler that
 * finds a group naming it ignores the `*` group, so the named group repeats
 * the same rules. `scripts/llms/site.mjs` (`AI_CRAWLERS`) holds the docs
 * site's copy of this list, and `scripts/lib/llms.test.mjs` fails when the two
 * disagree.
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
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
