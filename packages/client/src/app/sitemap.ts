import type { MetadataRoute } from "next";

// `output: "export"` writes this once, at build time, to `out/sitemap.xml`.
export const dynamic = "force-static";

const SITE_URL = "https://trackyourtime.dev";

/**
 * The public marketing pages, with the trailing slash `trailingSlash: true`
 * serves them under and each page's canonical link names. The app's own
 * screens need a session and have nothing for a search engine, so they are
 * not listed. `llms.txt` and `llms-full.txt` are not HTML pages and are
 * found through their conventional addresses instead.
 */
const PAGES = [
  "/",
  "/invoice-generator/",
  "/extension/",
  "/raycast/",
  "/mobile/",
  "/download/",
  "/press/",
  "/privacy/",
  "/support/",
];

export default function sitemap(): MetadataRoute.Sitemap {
  return PAGES.map((path) => ({
    url: `${SITE_URL}${path}`,
    changeFrequency: "monthly",
    priority: path === "/" ? 1 : 0.7,
  }));
}
