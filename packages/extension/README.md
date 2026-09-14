# @starter/extension

A popup-only MV3 browser extension for Track Your Time. The toolbar button opens a
popup that shows the running entry, starts and stops the timer, and reports
today's total. There are no content scripts and nothing is injected into any
page.

## Build modes

The **default** API URL is baked in at build time, so a build is a target: a
development bundle starts out pointed at a laptop, a production bundle at the
hosted API. Either can then be pointed at any Track Your Time server from the
popup — see [Choosing a server](#choosing-a-server).

```bash
pnpm run build:extension        # development -> dist/,      http://localhost:5159
pnpm run build:extension:prod   # production  -> dist-prod/, https://api.trackyourtime.dev
```

Both targets are described in `manifest.config.ts`, in TypeScript that ships in
the repo rather than in `.env.development` / `.env.production` — those two
filenames are commonly gitignored, which would make a fresh clone build an
extension with no URL in it and no error to say so.

Each target gets its own name (`Track Your Time` vs `Track Your Time (dev)`) and its own
permissions, so the two can be installed side by side:

| | development (`dist/`) | production (`dist-prod/`) |
|---|---|---|
| `host_permissions` (granted at install) | `http://localhost/*`, `http://127.0.0.1/*` | `https://api.trackyourtime.dev/*` |
| `optional_host_permissions` (asked for per server) | `https://*/*` | `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*` |
| `key` | none — id follows the load path | the Web Store key (`STORE_EXTENSION_KEY`) |

`VITE_API_URL=… pnpm --filter @starter/extension run build` still overrides the
default URL for a one-off build.

## Choosing a server

Track Your Time can be self-hosted, and the Web Store build is one bundle for
everybody, so the server is the person's choice. The sign-in screen says which
server it is about to sign in to, with a **Change server** control; Settings →
Account shows the server, its version and the same control. The picker offers
"Track Your Time cloud" (in a development build: "Default (localhost:5159)")
or "My own server" with an address field.

Choosing a server runs in this order, and the order is load-bearing:

1. **The address is checked in the popup** (`normalizeServerInput` from
   `@starter/core`): no scheme means https, a pasted page URL keeps only its
   origin, and plain http is refused for anything but localhost.
2. **Chrome is asked for that one host** (`src/lib/server-access.ts`),
   `https://<host>/*` with no port, straight from the click. Chrome only shows
   the prompt inside a user gesture, and the gesture ends at the first
   `await` — so nothing is awaited before this step (`src/popup/switch-server.ts`,
   pinned by its test).
3. **The worker checks it again** (`config:set-server`): the address, the
   grant, and `GET <origin>/api/health` through `checkServer`, which has to
   answer as a working Track Your Time server. Nothing changes unless all
   three pass. If the worker refuses, the popup gives the new grant back, so a
   typo or a server that is down does not leave a standing permission behind.

Moving to a **different** server signs out of the old one. A password session
the extension created is revoked on the old server; a session borrowed from the
web app's cookie is not, because that tab is still using it. The extension's
sign-out then drops its offline queue, as it always has, so a switch with
unsent changes first shows a confirm naming how many will be discarded — and
the worker refuses the switch with `UNSENT_CHANGES` unless that confirm was
answered, so a popup whose count is a poll behind cannot discard work silently.

Queued rows are stamped with the server they were made against, and the flush
only replays rows for the server in use (`isQueuedOn`).

### When Chrome takes access away

Anyone can remove a site's access at `chrome://extensions`. The worker listens
for `chrome.permissions.onRemoved` (and `onAdded`) and rebuilds, and every
snapshot carries `serverAccess`. While it is false the popup shows "Chrome no
longer lets the extension reach <host>." above every screen, signed in or out,
with an **Allow access** button that asks again from the click. Without it a
revoked grant would look exactly like being offline.

The web app's cookie is still borrowed for a self-hosted server: the `cookies`
permission covers granted optional hosts the same as required ones.

### Chrome Web Store permission justification

`host_permissions` lists only `https://api.trackyourtime.dev/*`, the hosted
API the extension uses by default. `optional_host_permissions` lists
`https://*/*`, `http://localhost/*` and `http://127.0.0.1/*` because Track Your
Time is open source and people run their own server on a domain the extension
cannot know in advance. None of these are granted at install. The extension
requests exactly one host, `https://<server>/*`, only when the person types
that server's address into the extension's server picker and clicks to use it,
and only for that server. It never requests access to sites the person browses,
has no content scripts, and does not read or change any web page. Plain http is
accepted for localhost only, for someone running the server on the same
machine.

`optional_permissions` lists `tabs`, for activity capture. It is not granted at
install and is requested only when the person turns on Settings → Activity,
from that click. With it the extension reads the hostname (and, behind a
second opt-in, the title) of the active tab so it can suggest time entries.
What it reads stays in the browser's IndexedDB on that device; it is never
sent anywhere, and only an entry the person accepts reaches the server.

### Production ids and TRUSTED_ORIGINS

The production build pins the Web Store key, so its id is
`opibnndhibnigcfgfbgbipakadhnbjfi` (`STORE_EXTENSION_ID` in `@starter/shared`)
wherever it is loaded from — unpacked from `dist-prod/`, or installed from the
store. A self-hosted server trusts that origin by default, which is what lets
the store build sign in to it with no configuration:

```bash
pnpm run extension:id prod
```

A fork that publishes under its own listing passes its own public key as
`EXTENSION_KEY`, which overrides the store key for either build:

```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out trackyourtime-extension.pem
openssl rsa -in trackyourtime-extension.pem -pubout -outform DER | base64 | tr -d '\n'
```

Keep the `.pem` out of the repo. That fork's servers then need its
`chrome-extension://<id>` in `TRUSTED_ORIGINS`.

The development build pins no key: its id follows the load path, and
`pnpm run dev` derives the same id to trust.

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

The production build does not have this problem: it pins the Web Store key,
so its id is fixed (see above).


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

## Activity capture

Off by default. Settings → Activity turns it on, which asks Chrome for the
optional `tabs` permission. While it is on, the worker records which site has
the person's attention — hostname only, titles behind their own switch — into
IndexedDB, and the Suggestions screen (✦ in the header) offers the untracked
stretches of a day as entries to accept, edit, dismiss or file by a local
"always file this site under…" rule.

- Code: `src/background/activity/` (capture, storage, retention, suggestions)
  over the pure `@starter/core/activity` module (merging, subtraction, rules).
- Never recorded: incognito tabs, excluded hosts, non-`http(s)` pages.
- Nothing under `src/background/activity/` may import the runtime, the API
  client or any network code; `import-graph.test.ts` walks the imports to
  enforce it. An accepted suggestion leaves through `createEntry` in
  `background/entries.ts`, offline queue included.
- Activity, rules and dismissals are keyed by user id plus workspace id and
  are deleted on sign-out and when another account signs in.

```bash
pnpm --filter @starter/extension test   # Vitest, with a fake chrome and fake-indexeddb
```

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

`pnpm run dev` pins the API to `http://localhost:5159`, the development build's
default. In a git worktree it picks a **random port** instead, so open the
popup, choose **Change server → My own server** and paste the API origin the
dev script printed (for example `localhost:51590`). It is stored in
`chrome.storage.local` and survives rebuilds. The development build already
holds `http://localhost/*`, so there is no Chrome prompt for it.

## Sign-in

Email and password, entered in the popup. The resulting better-auth session
token is kept in `chrome.storage.session` — memory-only, so it never touches
disk and is gone after a browser restart. Signing in again is the intended
cost of that; do not move the token to `chrome.storage.local`.

The session appears in Settings → Devices as `trackyourtime-extension` and can be
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

`minimum_chrome_version` is `116` because WebSocket activity only keeps an MV3
service worker alive from that version on, and the sync socket depends on it.

## Safari

Safari supports MV3 web extensions, and this bundle converts:

```bash
xcrun safari-web-extension-converter packages/extension/dist
```

That produces a standalone Xcode project which is **not** wired into this
repo's build — it is a manual, separately maintained step.
