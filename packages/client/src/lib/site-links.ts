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
export const API_DOCS_URL = `${DOCS_URL}api/`;
/** Every route, with a link to the OpenAPI document (`/docs/openapi.json`). */
export const API_REFERENCE_URL = `${DOCS_URL}api/reference/`;
export const MCP_DOCS_URL = `${DOCS_URL}mcp/`;
export const ISSUES_URL = `${REPO_URL}/issues`;
export const CONTACT_EMAIL = "ricotrebeljahr@gmail.com";

/**
 * Where people can support development. `null` until a donation page exists;
 * the "Support development" block renders only when this is set, so a page
 * never asks for money through a link that goes nowhere.
 */
export const DONATE_URL: string | null = null;

/** The product name as a stranger reads it. Identifiers use `trackyourtime`. */
export const PRODUCT_NAME = "Track Your Time";

export type StoreId = "chrome" | "raycast" | "appStore" | "googlePlay";

export type StoreListing = {
  /**
   * The listing's address, or `null` while it is not live. What the button
   * says either way is in the `marketing` catalog under `stores.<id>`.
   */
  url: string | null;
};

export const STORES: Record<StoreId, StoreListing> = {
  chrome: { url: null },
  raycast: { url: null },
  appStore: { url: null },
  googlePlay: { url: null },
};
