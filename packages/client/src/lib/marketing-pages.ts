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

export function socialCardPath(locale: string, path: string): string {
  const slug = path.replace(/^\/+|\/+$/g, "").replaceAll("/", "-") || "home";
  return `/marketing/og/${locale}/${slug}.png`;
}
