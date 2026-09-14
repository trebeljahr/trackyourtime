import type { Config } from "@docusaurus/types";

import { llmsMarkdownPlugin } from "./plugins/llms-markdown";

/**
 * The docs are served at https://trackyourtime.dev/docs/, from inside the web
 * app's image: `scripts/docs/build-into-client.mjs` builds this site and copies
 * it to `packages/client/out/docs/`, and `serve.mjs` serves it with the rest of
 * the export. A folder of the main domain rather than a `docs.` host keeps one
 * site for search engines, and needs no proxy routing — see docs/deploy.md.
 *
 * Both values are literals on purpose. This site used to read its address from
 * an env var and fall back to a placeholder host, which switched on `noIndex`
 * and a disallow-all robots.txt: a deploy that forgot the variable would have
 * shipped an unindexable site that looked fine in every browser. There is one
 * address now, and `build-into-client.mjs` fails the build if any page carries
 * `noindex` or a canonical link to another host.
 */
const siteUrl = "https://trackyourtime.dev";
const baseUrl = "/docs/";

const docsTitle = "Track Your Time docs";
const docsDescription =
  "Documentation for Track Your Time, the open-source time tracker you host on your own server: self-hosting, the MCP server and the REST API.";

const config: Config = {
  title: docsTitle,
  tagline: "Time tracking, and reporting that answers",
  url: siteUrl,
  baseUrl,
  // Same as the web app (`trailingSlash: true` in packages/client/next.config.ts),
  // so every page on the domain has one address shape and `serve.mjs` resolves
  // `/docs/x/` to `x/index.html` exactly as it does `/privacy/`.
  trailingSlash: true,
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
        // Written to /docs/sitemap.xml. The domain's only robots.txt is the web
        // app's (packages/client/src/app/robots.ts), which lists this sitemap
        // beside its own; a robots.txt under /docs/ would be read by nobody.
        //
        // No `lastmod`: Docusaurus reads it from git history, and the client
        // image builds from a context with no `.git` (and no git binary). A
        // repo-less git fails the build outright, and a missing binary drops
        // the field in the image while local builds keep it — a sitemap that
        // differs by where it was built is worse than one without dates.
        sitemap: {
          lastmod: null,
          changefreq: "weekly",
          priority: 0.7,
        },
      },
    ],
  ],

  plugins: [llmsMarkdownPlugin],

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
        { href: `${siteUrl}/`, label: "trackyourtime.dev", position: "right", target: "_self" },
        { href: "https://github.com/trebeljahr/trackyourtime", label: "GitHub", position: "right" },
      ],
    },
    colorMode: {
      respectPrefersColorScheme: true,
    },
  },
};

export default config;
