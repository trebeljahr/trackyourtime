/**
 * Where to send somebody after they sign in or sign up.
 *
 * `?next=` exists so a signed-out visit to `/invite/?id=…` or
 * `/app/device/?user_code=…` comes back to the same page after authenticating,
 * instead of being dropped on /track with the id or code lost.
 *
 * It is also the textbook open redirect: the login page is trusted, so a link
 * that signs somebody in and then forwards them to a look-alike page is a
 * phishing kit. So the value is accepted only when it is unmistakably a path
 * on THIS origin, and only for the screens that genuinely need a return trip:
 *
 *  - it must start with exactly one "/" — "//evil.com" is a protocol-relative
 *    URL to another host, and "/\evil.com" is read the same way by browsers
 *    that normalise backslashes;
 *  - no backslash, whitespace or control character anywhere — browsers strip
 *    tabs and newlines out of URLs, so "/\t/evil.com" becomes "//evil.com"
 *    after this check would have passed it;
 *  - it must still resolve to this origin once parsed, which also normalises
 *    dot segments, so "/app/track/../evil" is judged as "/app/evil";
 *  - its path must be under one of {@link SAFE_NEXT_PREFIXES}.
 *
 * Anything else answers `null`, and the caller uses its default.
 */

/** The only screens a `next` may point at. */
export const SAFE_NEXT_PREFIXES = [
  "/invite",
  "/app/device",
  "/app/track",
  "/app/members",
  "/app/settings",
] as const;

/** Longer than any real return path; a cap keeps a crafted value cheap to reject. */
const MAX_NEXT_LENGTH = 2048;

/** A base with a reserved TLD, so parsing can never borrow a real host. */
const PARSE_BASE = "https://next.invalid";

const UNSAFE_CHARACTER = /[\\\s\u0000-\u001f\u007f]/;

const underAllowedPrefix = (pathname: string): boolean =>
  SAFE_NEXT_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

/**
 * The normalised same-origin path `raw` names, or `null` when it is not a
 * return path this app will follow.
 */
export const safeNext = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_NEXT_LENGTH) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (UNSAFE_CHARACTER.test(raw)) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw, PARSE_BASE);
  } catch {
    return null;
  }
  if (parsed.origin !== PARSE_BASE) return null;
  if (!underAllowedPrefix(parsed.pathname)) return null;

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
};

/** `next` from a query string (`window.location.search`), validated. */
export const safeNextFromSearch = (search: string): string | null =>
  safeNext(new URLSearchParams(search).get("next"));

/**
 * `/login/` or `/signup/` carrying a validated return path and, optionally,
 * an email to prefill. A `next` that fails validation is left off rather than
 * forwarded, so an unsafe value cannot survive a hop between the two pages.
 */
export const authPageHref = (
  page: "login" | "signup",
  options: { next?: string | null; email?: string | null } = {},
): string => {
  const params = new URLSearchParams();
  const next = safeNext(options.next ?? null);
  if (next !== null) params.set("next", next);
  if (options.email) params.set("email", options.email);
  const query = params.toString();
  // The bare form stays `/login`, the path every existing redirect and test
  // already uses; `trailingSlash` makes the router land on `/login/` either way.
  return query === "" ? `/${page}` : `/${page}/?${query}`;
};

/**
 * `/login`, carrying the page a signed-out visitor was trying to reach.
 *
 * Without it a signed-out visit to `/app/device/?user_code=ABCD` signed in and
 * landed on /track with the code gone. The protected layout calls this at
 * redirect time with `window.location` (never during render, which is
 * prerendered in Node), and a page outside the allowlist simply goes to
 * `/login` as it always did.
 */
export const loginRedirectHref = (
  location: Pick<Location, "pathname" | "search">,
): string =>
  authPageHref("login", { next: `${location.pathname}${location.search}` });
