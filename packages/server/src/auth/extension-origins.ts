/**
 * Trusting a browser extension whose origin nobody can know in advance.
 *
 * Chrome derives an extension's origin from its public key, so
 * `chrome-extension://<id>` is a constant this repo can pin and a server can
 * list (`STORE_EXTENSION_ID` in `@starter/shared`). Firefox does not: every
 * install gets a fresh random UUID, so the origin is
 * `moz-extension://<uuid>` — different on every machine, unknowable before
 * the install exists, and therefore impossible to put in `TRUSTED_ORIGINS`.
 * Safari does the same with `safari-web-extension://<uuid>`.
 *
 * Without a rule the Firefox build cannot make a single request: it holds no
 * host permissions, so every request it makes — tRPC, better-auth,
 * `/api/health` — is an ordinary CORS request, and sign-in in particular is
 * refused with `403 INVALID_ORIGIN` before the password is read, because
 * better-auth force-validates the Origin of anything carrying `Sec-Fetch-*`
 * headers (measured: docs/firefox-extension-spike.md).
 *
 * So the rule is per-SCHEME rather than per-origin, and it is narrowed by the
 * two things that make it safe:
 *
 *  1. **No session cookie on the request.** The clients that use these
 *     origins sign in with a bearer token and send `credentials: "omit"`, so
 *     they never need a cookie to be honoured. Refusing a cookie-carrying
 *     request is what stops some *other* extension on the same machine from
 *     riding the signed-in person's session — which matters most on the
 *     WebSocket upgrade, where there is no CORS to hide behind and no
 *     `credentials` option to turn cookies off with.
 *  2. **Never `Access-Control-Allow-Credentials`.** An extension origin's
 *     CORS answer is uncredentialed, so a browser will not even send a
 *     credentialed request to it, let alone let the caller read the response.
 *
 * Off unless the server opts in — `TRUST_EXTENSION_ORIGINS=true`, implied by
 * `TRUST_STORE_APPS=true` (docs/self-hosting.md). A rule that trusts a whole
 * scheme is a decision an operator makes, not a default the hosted deploy
 * acquires by upgrading.
 */

/**
 * The shape check itself is in `@starter/shared`, beside the store clients'
 * pinned origins: the extension's popup needs the same answer to say which
 * setting a refusing server needs. `chrome-extension:` is deliberately not in
 * it — those ids are derivable and pinned, so a Chromium extension is trusted
 * by its exact origin or not at all, never by its scheme.
 */
import { isRandomExtensionOrigin } from "@starter/shared";

export { isRandomExtensionOrigin };

/**
 * Whether a `Cookie` header carries a better-auth session cookie.
 *
 * Keyed on the session cookie rather than on "any cookie at all", and that is
 * load-bearing in both directions. A WebSocket upgrade cannot opt out of
 * cookies, and a cookie that is eligible cross-site — a CDN's `__cf_bm` is
 * `SameSite=None` — rides along on every upgrade from an extension origin
 * (measured). "Any cookie" would therefore silently refuse the Firefox socket
 * for everybody behind such a CDN. better-auth's own session cookie is
 * `SameSite=Lax` and is never sent cross-site, so its presence means the
 * request is NOT the extension's bearer path, whatever it claims to be.
 *
 * The name is matched by suffix so the `__Secure-` prefix better-auth adds on
 * https, and a configured `cookiePrefix`, are covered without this file having
 * to know either.
 */
export function carriesSessionCookie(cookieHeader: string | undefined | null): boolean {
  if (typeof cookieHeader !== "string" || cookieHeader === "") return false;
  return cookieHeader
    .split(";")
    .map((pair) => pair.split("=")[0]?.trim().toLowerCase() ?? "")
    .some((name) => name.endsWith("session_token"));
}

/** One request, as much of it as the rule reads. */
export type ExtensionOriginRequest = {
  origin: string | undefined | null;
  cookie: string | undefined | null;
  /** Whether the server has opted in at all. */
  enabled: boolean;
};

/**
 * The whole rule: an extension-scheme origin, no session cookie, switched on.
 *
 * Every caller — better-auth's `trustedOrigins`, the CORS delegate,
 * `/api/health`'s `originTrusted`, the WebSocket upgrade — asks this one
 * function, so the four cannot answer differently about the same request.
 */
export function extensionOriginTrusted({
  origin,
  cookie,
  enabled,
}: ExtensionOriginRequest): boolean {
  if (!enabled) return false;
  if (!isRandomExtensionOrigin(origin)) return false;
  return !carriesSessionCookie(cookie);
}

/**
 * What better-auth's `trustedOrigins` option answers for one request: the
 * static list, plus this request's own extension origin when the rule allows
 * it.
 *
 * Its own function so the integration test drives exactly what `auth.ts`
 * passes to better-auth, rather than a second copy of the same three lines.
 */
export function trustedOriginsForRequest(
  staticOrigins: string[],
  request: Request | undefined,
  enabled: boolean,
): string[] {
  const origin = request?.headers.get("origin");
  return extensionOriginTrusted({
    origin,
    cookie: request?.headers.get("cookie"),
    enabled,
  })
    ? [...staticOrigins, origin as string]
    : staticOrigins;
}
