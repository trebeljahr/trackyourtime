// What the web app's static host must do beyond serving files, in one place
// for both hosts that serve the export:
//
// - serve.mjs, which serves out/ in the E2E suite and in the Coolify client
//   image (kept while the Cloudflare Worker soaks), applies these rules per
//   request.
// - The hosted site is an assets-only Cloudflare Worker, which has no code to
//   run them. scripts/cloudflare-static.mjs renders them into out/_redirects
//   and out/_headers before each upload (docs/deploy.md → Web app on
//   Cloudflare).
//
// Kept beside serve.mjs because the Coolify image copies the two files and
// nothing else from the repo.

/**
 * The signed-in screens lived at the root (`/track`, `/settings`, …) until
 * they moved under `/app/`. Links to the old addresses outlive the move:
 * bookmarks and saved logins, reminder and device-flow emails already sent,
 * and extension and Raycast builds already installed. Each is answered with a
 * permanent redirect to the same path under `/app/`, query string kept.
 *
 * Here and not in the app: the export has no middleware, and a client-side
 * redirect page per old route would put these names back into the route tree.
 */
export const LEGACY_APP_SEGMENTS = Object.freeze([
  "calendar",
  "clients",
  "device",
  "invoices",
  "members",
  "profile",
  "projects",
  "reports",
  "settings",
  "tags",
  "tasks",
  "timesheet",
  "track",
]);

const LEGACY = new Set(LEGACY_APP_SEGMENTS);

/** `/app/<path>` for a pre-move app address, or null for anything else. */
export function legacyAppRedirect(url) {
  const [path, query] = splitOnce(url, "?");
  const segment = path.split("/")[1] ?? "";
  if (!LEGACY.has(segment)) return null;
  return `/app${path}${query === null ? "" : `?${query}`}`;
}

function splitOnce(value, separator) {
  const at = value.indexOf(separator);
  return at === -1 ? [value, null] : [value.slice(0, at), value.slice(at + 1)];
}

/**
 * No page of the app may be framed by another site. Beyond clickjacking, a
 * cross-site frame gets no session cookie (SameSite=Lax), so the app inside it
 * believes nobody is signed in — and the extension bridge would pass that on
 * to the browser extension as a sign-out. The bridge also refuses frames on
 * both ends; this header is the defence in depth.
 */
export const NO_FRAMING = Object.freeze({
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
});

/** The export is same-origin static files only; nothing may be sniffed into another type. */
export const NO_SNIFFING = Object.freeze({
  "x-content-type-options": "nosniff",
});
