# What a Firefox extension's background page actually sends

Measured, not read: Firefox 156.0.1 on macOS, MV3 event-page extensions loaded
as temporary add-ons with `web-ext run` (headless, `MOZ_HEADLESS=1`), against a
Node server that logged every request header it received. Four extension
variants — with and without host permissions, plus WebSocket-only ones — and a
plain web page as the control. Run on 2026-09-23.

Everything below is a measurement. Where a measurement was impossible in the
sandbox it says so rather than guessing.

## The headers

A `fetch` from the background page of an extension with **no host permissions**
(the shape this repo ships — see "Browser extension build modes" in CLAUDE.md):

| header | value |
|---|---|
| `Origin` | `moz-extension://<random uuid>` — e.g. `moz-extension://42a04a0c-c28d-4f59-8694-9623ce55de3d` |
| `Sec-Fetch-Site` | `cross-site` |
| `Sec-Fetch-Mode` | `cors` |
| `Sec-Fetch-Dest` | `empty` |
| `Cookie` | absent with `credentials: "omit"` |

So every request is an ordinary CORS request with a preflight when it carries
`content-type: application/json` or `authorization` — exactly like the Chrome
build, except that the origin is a **per-install random UUID**. It cannot be
listed in `TRUSTED_ORIGINS`: nobody knows it before the install exists, and it
differs for every person. That is the whole reason this repo needs a
scheme-level rule; see "Firefox and the extension-scheme origins" in CLAUDE.md.

`Sec-Fetch-*` being present is what makes better-auth **force-validate** the
origin (`validateFormCsrf` → `validateOrigin(ctx, true)` in
`better-auth/dist/api/middlewares/origin-check.mjs`), so sign-in answers
`403 INVALID_ORIGIN` before the password is looked at unless the origin is
trusted. curl sends none of these headers, which is why curl cannot be used to
test this.

## Cookies

- `credentials: "omit"` → **no `Cookie` header**, measured on every request the
  extension made, including after the server had set cookies on that host.
- `credentials: "include"` → the cookies that a cross-site request may carry
  arrive: a cookie with **no** `SameSite` and one with `SameSite=None` were
  sent; `SameSite=Lax` and `SameSite=Strict` were not. Firefox does not apply
  Lax-by-default, so "no SameSite" behaves as `None`.

better-auth's session cookie is `SameSite=Lax`, so it is never sent from an
extension origin. A cookie that *is* sent cross-site — a CDN's `__cf_bm` is
`SameSite=None` — will still appear. That distinction is why the server rule
below keys on the **session** cookie rather than on any cookie at all.

## With host permissions, Firefox changes the shape entirely

The same code in an extension holding `host_permissions: ["http://127.0.0.1/*"]`:

- **no `Origin` header at all** on simple requests,
- `Sec-Fetch-Site: same-origin`,
- **no preflight**,
- `credentials: "include"` carries every cookie, `SameSite=Lax` and `Strict`
  included — the request is treated as same-site.

This looks like the easy fix and is not one. With `Sec-Fetch-*` present and no
`Origin`, better-auth's forced validation throws
`MISSING_OR_NULL_ORIGIN` — the same wall the Electron `file://` origin hit
(CLAUDE.md, "Desktop"). It would also mean asking every Firefox user for access
to every site, which is the permission prompt the Chrome build exists without.

## WebSockets

| from | scheme | result |
|---|---|---|
| background page, no host permissions | `wss://` | **upgrade reaches the server**, with `Origin: moz-extension://<uuid>` and the `bearer.<token>` subprotocol intact |
| background page, with `ws://…` host permission | `ws://` | never leaves the browser — no upgrade request, `onerror`, even for `ws://127.0.0.1` |
| background page, no host permissions | `ws://` | same: never leaves the browser |
| ordinary web page on `http://127.0.0.1` | `ws://` | upgrade reaches the server |

So: a `moz-extension://` document is a secure context, and Firefox blocks
insecure `ws://` from it — with no loopback exception, unlike Chrome, and
`security.mixed_content.block_active_content=false` and
`network.websocket.allowInsecureFromHTTPS=true` do not lift it. Host
permissions change nothing.

Consequences:

- Against an **https** server (every real deployment) the sync socket works in
  Firefox with no host permissions, and the upgrade carries the extension
  origin — so `ws/handler.ts`'s origin check has to accept it.
- Against a **local dev server on http** the socket cannot open at all in
  Firefox. The extension keeps working (polling and alarms); live sync does
  not. Test socket behaviour for Firefox against an https server.

The `wss://` row was measured against a local TLS server whose self-signed
certificate was trusted through a `cert_override.txt` written into the test
profile; the sandbox this ran in has no outbound network, so no public endpoint
was involved.

### A WebSocket upgrade carries cookies, and cannot opt out

The `WebSocket` constructor has no `credentials` option. Measured: after the
server set cookies, the extension's `wss://` upgrade carried
`Cookie: nosamesite=1; none=1` — the cross-site-eligible ones — while the
`SameSite=Lax` cookie stayed behind.

That is the attack the server rule has to stop: WebSockets are not subject to
CORS, so without a rule any Firefox extension on the machine could open a
socket to the API and have it authenticated by the signed-in user's cookie. It
is also why the rule cannot be "refuse any cookie": a CDN cookie on the API
host would then silently kill the Firefox socket for everybody behind it.

## What the server does with this

`packages/server/src/auth/extension-origins.ts`, wired into better-auth's
`trustedOrigins`, the Express `cors()` delegate, `/api/health`'s
`originTrusted` and the WebSocket upgrade check. An origin of the shape
`moz-extension://<uuid>` (or `safari-web-extension://<uuid>`, for a later
Safari port) is trusted **only when the request carries no better-auth session
cookie**, and its CORS answer never carries
`Access-Control-Allow-Credentials` — the extension signs in with a bearer
token and `credentials: "omit"`, so it needs neither. Off unless
`TRUST_EXTENSION_ORIGINS=true`, which `TRUST_STORE_APPS=true` implies.

## End to end, against a real server

With that rule on (`TRUST_EXTENSION_ORIGINS=true`), an MV3 extension in Firefox
156 signed in and worked against a dev server, from a background page with no
host permissions:

| step | result |
|---|---|
| `POST /api/auth/sign-in/email`, `credentials: "omit"` | `200`, with a `set-auth-token` the extension can store |
| `GET /api/trpc/workspaces.list` with `Authorization: Bearer …` | `200` |
| `POST /api/trpc/entries.start` | `200` — a timer started |
| `GET /api/trpc/devices.list` | the session reads **"Firefox extension on macOS"** |

The device label comes from the user agent (`auth/client-label.ts`); nothing
had to be added for Firefox.

## Reproducing it

The harness is not committed — it is a throwaway of about 150 lines. To run it
again: a Node server that logs `req.headers` for every request and for
`server.on("upgrade")`, an MV3 extension whose `background.scripts` fetches it
and posts the results back, and

```bash
MOZ_HEADLESS=1 npx web-ext@8 run --source-dir <ext> --firefox <firefox-binary> \
  --no-input --no-reload --firefox-profile <profile> --profile-create-if-missing
```

`MOZ_HEADLESS=1` matters for more than speed: a visible Firefox steals focus
from whoever is using the machine.
