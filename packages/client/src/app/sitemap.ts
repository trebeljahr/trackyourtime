import type { MetadataRoute } from "next";
import { localizedPath, MARKETING_LOCALES } from "@/i18n/marketing";
import { MARKETING_PAGES, MARKETING_MODIFIED } from "@/lib/marketing-pages";

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
export default function sitemap(): MetadataRoute.Sitemap {
  return MARKETING_PAGES.flatMap((path) => {
    const languages = Object.fromEntries([
      ...MARKETING_LOCALES.map((locale) => [locale, `${SITE_URL}${localizedPath(locale, path)}`]),
      ["x-default", `${SITE_URL}${path}`],
    ]);
    return MARKETING_LOCALES.map((locale) => ({
      url: `${SITE_URL}${localizedPath(locale, path)}`,
      lastModified: MARKETING_MODIFIED,
      alternates: { languages },
    }));
  });
}
