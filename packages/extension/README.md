# @starter/extension

A popup-only MV3 browser extension for Track Your Time. The toolbar button opens a
popup that shows the running entry, starts and stops the timer, and reports
today's total. There are no content scripts and nothing is injected into any
page.

## Build modes

The API URL is baked in at build time, so a build **is** a target — there is no
one bundle that works against both a laptop and the deployed server.

```bash
pnpm run build:extension        # development -> dist/,      http://localhost:5159
pnpm run build:extension:prod   # production  -> dist-prod/, https://api.trackyourtime.dev
```

Both targets are described in `manifest.config.ts`, in TypeScript that ships in
the repo rather than in `.env.development` / `.env.production` — those two
filenames are commonly gitignored, which would make a fresh clone build an
extension with no URL in it and no error to say so.

Each target gets its own name (`Track Your Time` vs `Track Your Time (dev)`) and its own
`host_permissions`, so the two can be installed side by side and neither asks
for access to hosts it will never talk to. `VITE_API_URL=… pnpm --filter
@starter/extension run build` still overrides the URL for a one-off build.

The popup can repoint the API URL at runtime, but only within the host
permissions its build declared: a production build cannot be aimed at
localhost. That is deliberate — use the development build for that.

### Production ids and TRUSTED_ORIGINS

The two builds live in different directories, so as unpacked extensions they
have **different ids** — and each id's origin has to be in the server's
`TRUSTED_ORIGINS` or sign-in returns `403 INVALID_ORIGIN`:

```bash
pnpm run extension:id prod
```

An unpacked id follows the path it was loaded from, which is no use for a
server that must trust the extension before anyone has installed it. Pin a key
to fix the id instead:

```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out tracktime-extension.pem
openssl rsa -in tracktime-extension.pem -pubout -outform DER | base64 | tr -d '\n'
```

Pass that public half as `EXTENSION_KEY` when building; keep the `.pem` out of
the repo. `pnpm run extension:id prod` then reports the pinned id, which stays
the same wherever the build is loaded — including once it is uploaded.

## The server has to trust this extension's origin

Sign-in answers `403 {"code":"INVALID_ORIGIN"}` until it does, before the
password is even looked at. better-auth force-validates the `Origin` header on
any request carrying `Sec-Fetch-*` headers — which every real browser fetch
does — so the extension's origin has to be in the server's `TRUSTED_ORIGINS`.

An unpacked extension has no signing key, so Chrome derives its id from the
absolute path it was loaded from. That makes the id stable for a directory and
different for every checkout, which is why it is computed rather than
hardcoded:

```bash
pnpm run extension:id
```

Put the printed `chrome-extension://<id>` into `TRUSTED_ORIGINS` in
`packages/server/.env.development` and **restart the server** — the env file is
read at boot, and `tsx watch` only watches `src/`.

`chrome-extension://*` also works as a pattern and survives the directory
moving, but it trusts every extension installed in the browser, so it is a
local-dev shortcut rather than something to ship.

For a shipped build, pin a `key` in `manifest.json` (or publish to the Web
Store) so the id stops depending on a path, and list that one origin.


## Architecture

The **service worker** (`src/background/`) owns everything stateful: the
session token, the `@starter/core` api-client, the sync WebSocket and the
offline queue. The **popup** (`src/popup/`) is stateless — it sends a message,
receives a full `BackgroundState` snapshot and renders it. Live elapsed
seconds are computed in the popup from `running.start`, so the clock ticks
smoothly even while the worker is asleep.

The message contract lives in `src/lib/messaging.ts`.

### The socket is an optimisation, not the transport

Every read and write goes over HTTP. The WebSocket only delivers *other*
devices' changes, so it is treated as something that may simply not be there —
a refused upgrade, a proxy that will not upgrade, an origin missing from
`TRUSTED_ORIGINS`, or an MV3 eviction that took the reconnect timer with it.

Three rules keep a socket-less worker honest, and the footer says which state
it is in:

- The cached running entry expires after ten seconds while the socket is down
  (it never expires while it is up — the events keep it true), so the
  30-second badge alarm re-reads `entries.current` and the toolbar stays in
  step with the web app and Raycast. A non-empty offline queue overrides this:
  its optimistic entry is the truth the server has not been told yet.
- That same alarm nudges the socket back up and drains the offline queue.
  Queued work used to wait for the socket to open, which never came for a
  client whose upgrade was being refused.
- `serverReachable` is reported separately from `syncStatus`. **Offline** now
  means the server did not answer; a socket that is down while HTTP is fine
  reads **Polling**, because nothing is being lost — other devices' changes
  just arrive on the next poll instead of instantly.

## Build and load

```bash
pnpm build:extension          # from the repo root — builds shared, core, then this
pnpm dev:extension            # vite build --watch, for iterating
```

Then in Chrome:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select `packages/extension/dist`

After a rebuild, hit the reload arrow on the extension card. Changes to the
popup take effect when you reopen it; changes to the service worker need that
reload.

## Pointing it at your dev server

`pnpm run dev` picks a **random API port** on every run, so the URL baked in
at build time (`VITE_API_URL`, defaulting to `http://localhost:5159`) is
almost never the one you want in development. Open the popup, expand the API
URL setting and paste the API URL the dev script printed. It is stored in
`chrome.storage.local` and survives rebuilds.

## Sign-in

Email and password, entered in the popup. The resulting better-auth session
token is kept in `chrome.storage.session` — memory-only, so it never touches
disk and is gone after a browser restart. Signing in again is the intended
cost of that; do not move the token to `chrome.storage.local`.

The session appears in Settings → Devices as `tracktime-extension` and can be
revoked from there, which kills both the HTTP and the WebSocket path.

## Icons

The four PNGs in `public/icons/` are generated, not hand-drawn — regenerate
them from the repo root after any change to the brand mark:

```bash
pnpm icons:brand
```

The source is `packages/client/public/brand/mark-tile.svg`. Chrome takes PNG
only in `icons` and `action.default_icon`, and a service worker cannot
rasterize an SVG itself, so the bitmaps have to be committed — the script is
what keeps them derived from the SVG rather than drifting.

The same command regenerates every other bitmap the repo ships from that one
file: the Electron and Tauri icon source, Raycast's command and menu bar
icons, and the Capacitor icon and splash. They are one mark on purpose, so run
it for all of them, not just these four.

The tile variant is deliberate. The bare timer arc draws its track ring in a
page-background neutral that vanishes against the browser toolbar, whereas the
tile brings its own indigo ground and reads on light and dark chrome alike. At
16px the arc gap closes up and the mark reads as a ring — that is the honest
limit of the shape at that size, not a rendering fault.

## Before shipping

`host_permissions` currently includes `https://*/*`, which is far broader than
this extension needs and will draw a review objection on the Chrome Web Store.
It is wide only so a build works against any dev or staging host. Narrow it to
the real API origin (e.g. `https://api.tracktime.example/*`) in
`public/manifest.json` before publishing, and drop the localhost entries from
a production build.

`minimum_chrome_version` is `116` because WebSocket activity only keeps an MV3
service worker alive from that version on, and the sync socket depends on it.

## Safari

Safari supports MV3 web extensions, and this bundle converts:

```bash
xcrun safari-web-extension-converter packages/extension/dist
```

That produces a standalone Xcode project which is **not** wired into this
repo's build — it is a manual, separately maintained step.
