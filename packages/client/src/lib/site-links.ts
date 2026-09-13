/**
 * Every outbound address the marketing pages use, in one place.
 *
 * A store URL is `null` until that listing is live. The pages read `null` as
 * "not in the store yet" and say so, rather than linking a listing that does
 * not exist — so filling one in here is the whole change when a store approves
 * a submission.
 */

export const REPO_URL = "https://github.com/trebeljahr/tracktime";
export const OPENAPI_URL = "https://api.trackyourtime.dev/api/v1/openapi.json";
export const SELF_HOSTING_URL = `${REPO_URL}/blob/main/docs/self-hosting.md`;
export const ISSUES_URL = `${REPO_URL}/issues`;
export const CONTACT_EMAIL = "ricotrebeljahr@gmail.com";

/**
 * Where people can support development. `null` until a donation page exists;
 * the "Support development" block renders only when this is set, so a page
 * never asks for money through a link that goes nowhere.
 */
export const DONATE_URL: string | null = null;

/** The product name as a stranger reads it. Code, storage keys and headers keep `tracktime`. */
export const PRODUCT_NAME = "Track Your Time";

export type StoreId = "chrome" | "raycast" | "appStore" | "googlePlay";

export type StoreListing = {
  /** What the page says instead of a button while the listing is not live. */
  pending: string;
  /** What the button says once the listing is live. */
  label: string;
  url: string | null;
};

export const STORES: Record<StoreId, StoreListing> = {
  chrome: { pending: "Not in the Chrome Web Store yet", label: "Add to Chrome", url: null },
  raycast: { pending: "Not in the Raycast Store yet", label: "Install from the Raycast Store", url: null },
  appStore: { pending: "Not on the App Store yet", label: "Download on the App Store", url: null },
  googlePlay: { pending: "Not on Google Play yet", label: "Get it on Google Play", url: null },
};
