import type { Config } from "@docusaurus/types";
import type { Plugin } from "@docusaurus/types";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { AI_CRAWLERS } from "../scripts/llms/site.mjs";
import { llmsMarkdownPlugin } from "./plugins/llms-markdown";

const docsUrl = process.env.DOCS_SITE_URL ?? "https://docs.example.com";
const usesPlaceholderUrl = docsUrl === "https://docs.example.com";
const docsTitle = "Track Your Time docs";
const docsDescription =
  "Documentation for Track Your Time, the open-source time tracker you host on your own server: self-hosting, the MCP server and the REST API.";

/**
 * robots.txt, by whether this build has a real address.
 *
 * With the placeholder URL nothing may be indexed: every canonical link and
 * sitemap entry would name docs.example.com. With a real one, everything is
 * allowed, and the crawlers that fetch pages for AI assistants are named in a
 * group of their own. A crawler that finds a group naming it ignores the `*`
 * group, so being named is how "allowed" survives a later `*` restriction.
 */
function generatedRobotsPlugin(): Plugin<void> {
  return {
    name: "generated-robots",
    postBuild({ outDir }) {
      const body = usesPlaceholderUrl
        ? "User-agent: *\nDisallow: /\n"
        : [
            "User-agent: *",
            "Allow: /",
            "",
            ...AI_CRAWLERS.map((agent) => `User-agent: ${agent}`),
            "Allow: /",
            "",
            `Sitemap: ${docsUrl.replace(/\/+$/, "")}/sitemap.xml`,
            "",
          ].join("\n");

      writeFileSync(join(outDir, "robots.txt"), body);
    },
  };
}

const config: Config = {
  title: docsTitle,
  tagline: "Time tracking, and reporting that answers",
  url: docsUrl,
  baseUrl: "/",
  noIndex: usesPlaceholderUrl,
  titleDelimiter: "·",
  onBrokenLinks: "throw",
  onBrokenMarkdownLinks: "warn",
  favicon: "img/favicon.svg",

  presets: [
    [
      "classic",
      {
        docs: {
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
        },
        blog: false,
        sitemap: usesPlaceholderUrl
          ? false
          : {
              lastmod: "date",
              changefreq: "weekly",
              priority: 0.7,
            },
      },
    ],
  ],

  plugins: [generatedRobotsPlugin, llmsMarkdownPlugin],

  themeConfig: {
    image: "img/social-card.png",
    metadata: [
      { name: "description", content: docsDescription },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: docsTitle },
      { property: "og:image:alt", content: docsTitle },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image:alt", content: docsTitle },
    ],
    navbar: {
      title: docsTitle,
      items: [
        { type: "docSidebar", sidebarId: "docs", position: "left", label: "Docs" },
      ],
    },
    colorMode: {
      respectPrefersColorScheme: true,
    },
  },
};

export default config;
