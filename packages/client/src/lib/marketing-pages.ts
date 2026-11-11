/** Public paths, modification dates and social-card names share one registry. */
export const MARKETING_PAGES = [
  "/", "/invoice-generator/", "/extension/", "/raycast/", "/mobile/",
  "/download/", "/press/", "/privacy/", "/imprint/", "/support/",
  "/self-hosting/",
  "/api/",
  "/invoicing/",
  "/offline/",
  "/time-reports/",
  "/freelancers/",
  "/studios/",
  "/developers/",
  "/import-csv/",
  "/guides/offline-phone/",
  "/guides/move-server/",
  "/changelog/",
] as const;

// A content revision, deliberately not the build date. Update when public copy changes.
export const MARKETING_MODIFIED = "2026-10-22";

/**
 * The English home card is the wordmark card from docs/marketing (a JPEG
 * under its own name, so link previews refetch it); every other page and
 * language keeps its generated PNG.
 */
export const HOME_WORDMARK_CARD = "/marketing/og/en/home-wordmark.jpg";

export function socialCardPath(locale: string, path: string): string {
  const slug = path.replace(/^\/+|\/+$/g, "").replaceAll("/", "-") || "home";
  if (locale === "en" && slug === "home") return HOME_WORDMARK_CARD;
  return `/marketing/og/${locale}/${slug}.png`;
}
