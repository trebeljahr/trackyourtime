import type { Config } from "@docusaurus/types";
import type { Plugin } from "@docusaurus/types";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const docsUrl = process.env.DOCS_SITE_URL ?? "https://docs.example.com";
const usesPlaceholderUrl = docsUrl === "https://docs.example.com";
const docsTitle = "Track Your Time docs";
const docsDescription =
  "Documentation for Track Your Time — the time tracker, its web app, browser extension, Raycast extension, desktop and mobile builds, and the API they share.";

function generatedRobotsPlugin(): Plugin<void> {
  return {
    name: "generated-robots",
    postBuild({ outDir }) {
      const body = usesPlaceholderUrl
        ? "User-agent: *\nDisallow: /\n"
        : `User-agent: *\nAllow: /\n\nSitemap: ${docsUrl.replace(/\/+$/, "")}/sitemap.xml\n`;

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

  plugins: [generatedRobotsPlugin],

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
