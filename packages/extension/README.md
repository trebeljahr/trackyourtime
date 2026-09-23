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
pnpm run build:extension          # development -> dist/,         http://localhost:5159
pnpm run build:extension:prod     # production  -> dist-prod/,    https://api.trackyourtime.dev
pnpm run build:extension:firefox  # firefox     -> dist-firefox/, https://api.trackyourtime.dev
```

Both targets are described in `manifest.config.ts`, in TypeScript that ships in
the repo rather than in `.env.development` / `.env.production` — those two
filenames are commonly gitignored, which would make a fresh clone build an
extension with no URL in it and no error to say so.

Each target gets its own name (`Track Your Time` vs `Track Your Time (dev)`), so
the two can be installed side by side. Neither asks for host access or cookies:

| | development (`dist/`) | production (`dist-prod/`) | firefox (`dist-firefox/`) |
|---|---|---|---|
| `permissions` | `storage`, `alarms`, `idle` | `storage`, `alarms`, `idle` | `storage`, `alarms`, `idle` |
| `optional_permissions` (asked for from Settings → Activity) | `tabs` | `tabs` | `tabs` |
| `background` | service worker | service worker | event page (`scripts`) |
| `externally_connectable.matches` | `http://localhost/*`, `http://127.0.0.1/*` | `https://trackyourtime.dev/*` | absent — Gecko has no such thing |
| `host_permissions`, `optional_host_permissions`, `cookies` | none | none | none |
| `key` | none — id follows the load path | the Web Store key (`STORE_EXTENSION_KEY`) | none — `browser_specific_settings.gecko.id` |

`externally_connectable` is generated from `extensionBridgeMatchPatterns` in
`@starter/shared/extension-bridge`, and the same target is baked into the
bundle as `VITE_BRIDGE_TARGET`, so the manifest and the worker's own origin
check cannot disagree. `manifest.test.ts` pins all of it.

`VITE_API_URL=… pnpm --filter @starter/extension run build` still overrides the
default URL for a one-off build.

## The Firefox build

Same code, a different engine, and three rules that come with it. What was
measured rather than assumed is in
[docs/firefox-extension-spike.md](../../docs/firefox-extension-spike.md).

- **Its origin is `moz-extension://<uuid>`, new on every install.** No server
  can list it, so a server trusts the SHAPE instead, and only for requests
  carrying no session cookie — `TRUST_EXTENSION_ORIGINS=true`, which
  `TRUST_STORE_APPS=true` implies. Without it every request is refused by CORS
  and the popup says which setting the server's admin needs. `pnpm run dev`
  sets it for local work.
- **There is no web-app bridge.** Firefox implements `externally_connectable`
  for extensions only, never for web pages, so signing in at trackyourtime.dev
  does not sign the add-on in and `background/bridge.ts` registers no listener
  (`bridgeTarget: "none"`). Sign in with the popup's password form, or with
  "Sign in with the web app" — the device flow, and the way in for an account
  with two-factor authentication.
- **The sync socket needs an https server.** A `moz-extension://` page is a
  secure context and Firefox blocks an insecure `ws://` from it, with no
  loopback exception and whatever host permissions are held. Against a local
  `http://` dev server the extension works and live updates do not; test socket
  behaviour against https.

`browser_specific_settings.gecko.id` (`trackyourtime@ricoslabs.com`) is
permanent once the add-on is listed — AMO keys the listing on it, and Firefox
keys the profile's stored data (the offline queue, the workspace choice,
captured activity) on it too. `strict_min_version` is 140 because AMO requires
`data_collection_permissions` on a new submission and that key is only read
from 140.

Loading it for development, without stealing the screen:

```bash
MOZ_HEADLESS=1 npx web-ext@8 run --source-dir packages/extension/dist-firefox \
  --firefox-profile /tmp/tyt-firefox --profile-create-if-missing --no-input
```

`npx web-ext@8 lint --source-dir packages/extension/dist-firefox` runs the
AMO linter. It reports zero errors and three warnings — React's `innerHTML`
and zod's feature probe for `Function` — neither of which is a blocker.

## Choosing a server

Track Your Time can be self-hosted, and the Web Store build is one bundle for
everybody, so the server is the person's choice. The sign-in screen says which
server it is about to sign in to, with a **Change server** control; Settings →
Account shows the server, its version and the same control. The picker offers
"Track Your Time cloud" (in a development build: "Default (localhost:5159)")
or "My own server" with an address field.

Choosing a server runs in two steps:

1. **The address is checked in the popup** (`normalizeServerInput` from
   `@starter/core`): no scheme means https, a pasted page URL keeps only its
   origin, and plain http is refused for anything but localhost.
2. **The worker checks it again** (`config:set-server`): the address, and
   `GET <origin>/api/health` through `checkServer`, which has to answer as a
   working Track Your Time server that trusts this extension's origin
   (`originTrusted`). A server that says `false` is refused with
   `ORIGIN_NOT_TRUSTED`; one too old to say is let through. Nothing changes
   unless every check passes.

There is no Chrome prompt: the extension holds no host access, so there is
nothing to request and nothing to give back.

Moving to a **different** server signs out of the old one, and the session is
revoked there whichever way it was signed in — every session is the
extension's own row. The extension's sign-out then drops its offline queue, as
it always has, so a switch with unsent changes first shows a confirm naming
how many will be discarded — and the worker refuses the switch with
`UNSENT_CHANGES` unless that confirm was answered, so a popup whose count is a
poll behind cannot discard work silently.

Queued rows are stamped with the server they were made against, and the flush
only replays rows for the server in use (`isQueuedOn`).

### When the server does not trust the extension

Every request the extension makes — tRPC, better-auth, `/api/health` — is an
ordinary CORS request, answered only when `chrome-extension://<id>` is in the
server's trust list (`TRUST_STORE_APPS=true`, or the origin in
`TRUSTED_ORIGINS`). A refused request fails in `fetch` exactly like a dead
network, so on a transport failure the worker re-asks `/api/health` (which
answers any origin) at most once a minute. When it says `originTrusted: false`,
every snapshot carries it and the popup shows a notice above every screen
naming both settings and this extension's origin. Queued changes stay queued;
nothing is dropped. The first request that gets through clears the notice.

### Chrome Web Store permission justification

The extension requests `storage`, `alarms` and `idle`, plus the optional `tabs`.
It requests no host permissions and no `cookies` permission, has no content
scripts, and does not read or change any web page.

- `storage` keeps the server address, the offline queue and the session token
  (the token in memory-only session storage).
- `alarms` keeps the toolbar badge and queued changes going while Chrome has
  stopped the background worker.
- `idle` notices when the person has walked away from a running timer.
- `tabs` (optional) is for activity capture. It is not granted at install and
  is requested only when the person turns on Settings → Activity, from that
  click. With it the extension reads the hostname (and, behind a second
  opt-in, the title) of the active tab so it can suggest time entries. What it
  reads stays in the browser's IndexedDB on that device; it is never sent
  anywhere, and only an entry the person accepts reaches the server.

`externally_connectable` lists `https://trackyourtime.dev/*`. It is not a
permission: it lets trackyourtime.dev tell the extension that you signed in or
out there, so the extension can sign itself in or out to match.

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

Every request the extension makes is a CORS request, so nothing works until
the server trusts `chrome-extension://<id>` — the popup says so (see
[When the server does not trust the extension](#when-the-server-does-not-trust-the-extension)).
Sign-in in particular answers `403 {"code":"INVALID_ORIGIN"}` before the
password is even looked at: better-auth force-validates the `Origin` header on
any request carrying `Sec-Fetch-*` headers, which every real browser fetch
does.

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
`chrome.storage.local` and survives rebuilds. There is no Chrome prompt; the dev
server has to trust the extension's origin, which `pnpm run dev` arranges.

## Sign-in

Three ways in, on the sign-in screen:

- **Email and password**, for any server. An account with two-factor
  authentication cannot finish here (`TWO_FACTOR_UNSUPPORTED`), and the popup
  points it at the next option.
- **Sign in with the web app**: the RFC 8628 device flow
  (`src/background/device-sign-in.ts`), for any server and for two-factor
  accounts. The approval page (`/app/device?user_code=…`) opens in a tab, the
  popup shows the code it shows, and the worker finishes on its own after the
  popup closes: the pending authorization is kept in `chrome.storage.session`,
  and an alarm, the popup opening or any other wake-up makes one token
  exchange. It never long-polls — MV3 stops the worker mid-wait.
- **Follow the web app** (below), on the hosted service. Production builds also
  offer **Open Track Your Time** on the sign-in screen, because opening the web
  app is what links the extension.

Every session token is kept in `chrome.storage.session` — memory-only, so it
never touches disk and is gone after a browser restart. For a session linked to
the web app, the next Track Your Time tab signs the extension back in; otherwise
signing in again is the intended cost. Do not move the token to
`chrome.storage.local`. The stored session records how it was signed in
(`web`, `password` or `device`).

Every session appears in Settings → Devices as `trackyourtime-extension` and can
be revoked from there, which kills both the HTTP and the WebSocket path.

### Following the web app's sign-in

The web app messages the extension through `externally_connectable` — after
mount, on the web only, by the pinned extension id — and
`src/background/bridge.ts` answers. The protocol is
`@starter/shared/extension-bridge`; the extension never initiates.

- **Web sign-in, extension signed out:** the extension starts a device
  authorization and replies with the user code; the page approves it with its
  own session and says so; the extension fetches its own token, checks with
  `get-session` that it belongs to the user the page named, and keeps it
  (source `web`). No token crosses the bridge.
- **Web sign-out:** an extension linked to the web app signs out too, revokes
  its own session and keeps its offline queue.
- **Web account switch:** the old linked session is left the same way, and the
  new account is linked. The old account's queued rows stay, held for that
  account (every row is stamped with its owner), and are listed with a discard.
- **Extension sign-out:** revokes the session and leaves a marker in
  `chrome.storage.local`. The next `sync` from a web tab of the same person, on
  the same server, whose session began before the sign-out, is answered with
  `sign-out-web`, and the page signs out. Markers expire after seven days.
  It also blocks linking: no web session that began before the sign-out links
  the extension again, whoever it belongs to and however old, until somebody
  signs in.
- A `password` or `device` session is never displaced by the web app, in
  either direction.
- A message is accepted only from a tab's top-level page (not a frame, not an
  incognito tab, not another extension) whose origin
  is in the build's allowlist and is the web app of the server the extension
  points at, and only about that server. A message never changes the server,
  workspace, queue or settings. A self-hosted web app on its own domain cannot
  message the store extension; use password or device sign-in there.

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
file: the Electron icon source, Raycast's command and menu bar
icons, and the Capacitor icon and splash. They are one mark on purpose, so run
it for all of them, not just these four.

The tile variant is deliberate. The bare timer arc draws its track ring in a
page-background neutral that vanishes against the browser toolbar, whereas the
tile brings its own indigo ground and reads on light and dark chrome alike. At
16px the arc gap closes up and the mark reads as a ring — that is the honest
limit of the shape at that size, not a rendering fault.

## Publishing to the Chrome Web Store

A `vX.Y.Z` tag runs `.github/workflows/extension-release.yml`. It builds
`dist-prod`, checks that the manifest version equals the tag, removes `key`
from the zipped manifest and submits the new version for review through the
Chrome Web Store API. The version comes from the root `package.json`, so bump
it there before tagging. The job skips the store when the
`CWS_SERVICE_ACCOUNT_JSON` and `CWS_PUBLISHER_ID` secrets are not set.

Setup and dispatch options: [docs/releasing.md → Chrome Web Store](../../docs/releasing.md#chrome-web-store).

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
