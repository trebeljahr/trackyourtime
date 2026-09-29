/**
 * Every outbound address the marketing pages use, in one place.
 *
 * A store URL is `null` until that listing is live. The pages read `null` as
 * "not in the store yet" and say so, rather than linking a listing that does
 * not exist — so filling one in here is the whole change when a store approves
 * a submission.
 */

export const REPO_URL = "https://github.com/trebeljahr/trackyourtime";
/**
 * The docs site, built into the client image and served at /docs/
 * (scripts/docs/build-into-client.mjs). Absolute, not `/docs/`: the self-host
 * image renders these same pages on somebody else's domain, where no docs are
 * served.
 */
export const DOCS_URL = "https://trackyourtime.dev/docs/";
export const SELF_HOSTING_URL = `${DOCS_URL}self-hosting/`;
/** Where a "your server is too old" banner sends a person. */
export const SELF_HOSTING_UPGRADING_URL = `${SELF_HOSTING_URL}#upgrading`;
export const API_DOCS_URL = `${DOCS_URL}api/`;
/** Every route, with a link to the OpenAPI document (`/docs/openapi.json`). */
export const API_REFERENCE_URL = `${DOCS_URL}api/reference/`;
export const MCP_DOCS_URL = `${DOCS_URL}mcp/`;
/** ZUGFeRD / XRechnung e-invoices (docs-site/docs/e-invoices.md). */
export const EINVOICE_DOCS_URL = `${DOCS_URL}e-invoices/`;
/** How to build, install and update the desktop app (docs-site/docs/desktop.md). */
export const DESKTOP_DOCS_URL = `${DOCS_URL}desktop/`;
export const ISSUES_URL = `${REPO_URL}/issues`;
export const CONTACT_EMAIL = "ricotrebeljahr@gmail.com";

/**
 * The one donate page for all of Rico's projects, on ricos.site. `from` names
 * this project there and tags the payment; after paying, the page links back
 * to `/?supported=1` (lib/donation-return.ts). The footer's "Donate" link, and
 * the repo's FUNDING.yml, point here. Never linked inside the phone apps
 * (App Store 3.1.1, Google Play payments policy).
 */
export const DONATE_URL = "https://ricos.site/donate/track-your-time";
/**
 * The landing page's "you can support development" sentence, an inline ask.
 * Off until an ask can stay quiet for 90 days after a donation, which
 * `donation-supported-at` is recorded for.
 */
export const LANDING_DONATE_ASK: boolean = false;

/** The product name as a stranger reads it. Identifiers use `trackyourtime`. */
export const PRODUCT_NAME = "Track Your Time";

export type StoreId = "chrome" | "firefox" | "raycast" | "appStore" | "googlePlay";

export type StoreListing = {
  /**
   * The listing's address, or `null` while it is not live. What the button
   * says either way is in the `marketing` catalog under `stores.<id>`.
   */
  url: string | null;
};

export const STORES: Record<StoreId, StoreListing> = {
  chrome: { url: "https://chromewebstore.google.com/detail/track-your-time/opibnndhibnigcfgfbgbipakadhnbjfi" },
  // addons.mozilla.org, once a version has been submitted AND approved. The
  // same rule as every other entry: a listing nobody can open is `null`, and
  // the page says "not in the store yet" rather than linking a 404.
  firefox: { url: null },
  raycast: { url: null },
  appStore: { url: null },
  googlePlay: { url: null },
};

/**
 * Where each desktop build can be downloaded. `null` until it really can:
 * the direct downloads until a release is PUBLISHED on GitHub (a draft does
 * not count), a store until it approves the listing. The /download page reads
 * `null` as "not released yet" and says so, like `STORES`.
 *
 * When a release is published, the three direct entries become
 * `https://github.com/trebeljahr/trackyourtime/releases/latest`.
 */
export type DesktopDownloadId =
  | "mac"
  | "windows"
  | "linux"
  | "homebrew"
  | "macAppStore"
  | "microsoftStore"
  | "flathub"
  | "snapStore";

export const DESKTOP_DOWNLOADS: Record<DesktopDownloadId, StoreListing> = {
  mac: { url: null },
  windows: { url: null },
  linux: { url: null },
  homebrew: { url: null },
  macAppStore: { url: null },
  microsoftStore: { url: null },
  flathub: { url: null },
  snapStore: { url: null },
};
