# Track Your Time desktop app — implementation plan

Written 2026-09-15 from a survey of `electron/`, `src-tauri/`, the client's
native seams, the release workflows and `docs/mobile-app-plan.md`, whose
structure and lessons this plan reuses. Nothing below has been run yet; the
claims marked **(unverified)** are what Stage 0 exists to confirm or refute.

## Implementation notes

None yet. Stage 0 writes the first ones; every later stage adds what its own
text got wrong.

## Where it stands

**Electron exists, has never been packaged, and would not work if it were.**

What is there:

- `electron/main.ts` (323 lines): one window, a persisted fullscreen pref,
  external-link handling, a macOS app menu, and `powerMonitor` idle reporting
  over IPC.
- `electron/preload.ts`: `window.electronAPI` with `quit`, fullscreen,
  `openExternal`, `getIdleState`, `onIdleState`.
- The client consumes exactly two of those: `hooks/use-idle-signal.ts` (OS idle
  time, which the web app cannot see) and `google-sign-in-button.tsx` (disables
  Google in the shell).
- The server already knows the client: `trackyourtime-desktop` is in the
  device-flow allowlist (`auth/client-label.ts`), `desktop` gets the 30-day
  stored-token session lifetime (`auth/session-lifetime.ts`), and `desktop` is a
  valid `TimeEntry.source`. `@starter/core/activity` already types an
  `ActivitySource` of `"desktop"`.
- `package.json` scripts `dev:desktop`, `build:desktop`, `electron:build`,
  `electron:preview`, `icons:desktop`, and an electron-builder `build` block
  (dmg/zip, nsis, AppImage, `appId com.trebeljahr.trackyourtime`).
- `.github/workflows/desktop-release.yml`: manual dispatch, unsigned, pushes to
  itch.io when butler secrets exist (a game-starter leftover).

What would break in a packaged build today:

1. **Every route but `/` is broken.** The app loads `out/index.html` off
   `file://`. With `trailingSlash: true` and `assetPrefix: "./"`, the document at
   `/track/` asks for `./_next/…`, which resolves to `out/track/_next/…` — the
   same failure `next.config.ts` documents for Capacitor. Client-side navigation
   to `/track/` resolves against the filesystem root. **(unverified — Stage 0)**
2. **Sign-in cannot succeed.** `file://` sends `Origin: null`, which no
   `TRUSTED_ORIGINS` entry can match, and better-auth rejects it before the
   password is checked. The README already says a custom protocol is needed;
   none is registered.
3. **Even with an origin, cookies would not flow.** Any shell origin is
   cross-site to `api.trackyourtime.dev`, so SameSite cookies are not sent. The
   Capacitor shells solved this with the bearer token; every one of those code
   paths is gated on `isNative()`, which reads `window.Capacitor` and is `false`
   in Electron.
4. **The binary would ship the phone.** Root `dependencies` are exactly the
   eleven Capacitor packages (`@capacitor/ios`, `@capacitor/android`, …), and
   electron-builder packs the app directory's production dependencies into the
   asar.
5. **macOS header collides with the traffic lights.** `titleBarStyle:
   "hiddenInset"` with no drag region and no inset padding in the web header.
6. **White flash in dark mode** (`backgroundColor: "#ffffff"`), the bug the
   mobile plan fixed for the splash.
7. **Two instances can run at once**, each with its own socket, both writing the
   same `localStorage` offline queue.
8. **No tray, no global shortcut, no auto-update, no signing, no tests, no CI
   build on pull requests.** README and ROADMAP both say so.

`src-tauri/` is 24 lines of Rust plus a Steamworks block. ROADMAP says not to
invest in it. This plan does not touch it until the cleanup stage.

**Verdict: roughly 10% of a desktop app.** The window and idle bridge are real;
routing, auth, packaging, native affordances and release are all missing.

## Summary

Keep the shape the phone app proved: **one UI, one static export, the Express
API always remote, bearer auth, the renderer owns all state.** Electron adds a
privileged `app://` scheme that serves the export like `serve.mjs` does, an
OS-keychain-backed token store behind a narrow preload, and a small main process
that renders a tray and a global shortcut as *views* of state the renderer
publishes over IPC. Desktop-only affordances are gated by an `html.electron`
marker and an `isElectron()` check, never by a second composition. Release is
electron-builder with signing, notarization and electron-updater on GitHub
Releases, and every stage ends on a packaged build rather than `dev:desktop`.

## Decisions

### Serve the export from a privileged `app://-` scheme, not `file://` and not a loopback HTTP server.

`protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard,
secure, supportFetchAPI, corsEnabled, stream } }])` before `ready`, then
`protocol.handle("app", …)` resolving paths the way `packages/client/serve.mjs`
does (`/x/` → `x/index.html`, unknown → `404.html`, reject `..`). The origin is
the constant `app://-`.

**Why:** a standard scheme gives real origin semantics, so root-absolute
`/_next/…` works and Electron drops `RELATIVE_ASSET_PREFIX` exactly as Capacitor
did. A constant origin keeps `localStorage` and the trust list stable forever.

**Rejected:** `file://` (null origin, broken routing). `http://127.0.0.1:<port>`
(the port is part of the origin, so a busy port on some launch moves every
stored value to a new origin — the queue included — and it exposes the app to
other local processes).

**Rule once shipped:** never change the scheme or host. Same rule as
`iosScheme`/`androidScheme`: the scheme *is* the origin.

### Own export directory `packages/client/out-desktop`.

**Why:** `out/` is written by the web build and by Playwright, which bakes a
throwaway API port. The mobile plan hit exactly this and moved to `out-mobile`.

### Bearer token, stored with Electron `safeStorage`, reached through the preload.

The renderer never sees the filesystem. `electronAPI.secureStore.get/set/delete`
over IPC; the main process encrypts with `safeStorage.encryptString` into
`userData/session.bin`.

**Why:** the Capacitor path (`lib/native-session.ts`, `lib/trpc.ts`,
`lib/auth-client.ts`, the socket's `bearer.` subprotocol) is already written and
tested; Electron needs a storage backend, not a second auth design.

**Linux trap:** `safeStorage.getSelectedStorageBackend()` returns `basic_text`
when no keyring exists, which is obfuscation, not encryption. Refuse to persist
the token in that case (session lasts until quit) and say so in Settings →
Devices, rather than write a credential in the clear quietly.

**Rejected:** `keytar` (archived, native module). Cookies (cross-site, see
above).

### Split `isNative()` by what each caller actually means.

20 files call `isNative()`. They mean one of three different things, and
Electron wants only some of them:

| Meaning | New predicate | Capacitor | Electron | Call sites (current) |
| --- | --- | --- | --- | --- |
| Phone UI (tab bar, `html.cap`, back button, splash, status bar) | `isCapacitor()` | yes | **no** | `mobile-tab-bar`, `bridge`, `app-shell`, `pre-paint`, `tracker-bar` (verify) |
| Token-auth shell (bearer, server picker, client header, entry source, Google/2FA gating, signed-in redirect) | `isTokenShell()` | yes | yes | `native-session`, `api-origin`, `trpc`, `auth-client`, `entry-source`, `login/page`, `google-sign-in-button`, `signed-in-redirect`, `workspace-switcher` (verify) |
| Durable storage / radio network truth | `isCapacitor()` | yes | no — Chromium `localStorage` in `userData` is not evicted, `navigator.onLine` is usable on desktop | `preferences-storage`, `running-mirror`, `offline`, `network`, `query-client` |

`isNative()` is deleted, not aliased, so no call site keeps an ambiguous
meaning. `lib/shell.ts` owns all three predicates plus `clientId()` and
`entrySource()`. Each file is classified by reading it in Stage 0; the table's
last column is the survey's starting guess.

**Why not just make `isNative()` true in Electron:** it would put the phone tab
bar, 16px fields and top-anchored dialogs on a 1280px window, and route the
queue through a Capacitor Preferences plugin that does not exist there.

### The renderer owns state; the tray and the global shortcut are views and remotes.

The renderer publishes `desktop:timer-state` (running entry, start time,
description, project colour, recent entries, localized menu labels, unsent
queue count) whenever it changes. The main process draws the tray from that and
ticks the title locally once a second from `startedAt`. Tray clicks and the
shortcut send `desktop:command` back, and the renderer executes them through
`useEntryMutations` — the same rule the command palette follows.

**Why:** the renderer already holds the socket, the offline queue, the
running-timer store and the locale. A main-process API client would be a second
queue and a second source of truth, which is precisely the cross-process
staleness problem the Raycast timer echo exists to patch.

**Consequence:** the window's renderer must stay alive while the app runs.
Closing the window hides it; Quit quits.

**Rejected:** a second small "quick entry" `BrowserWindow` (a second renderer
means a second socket and queue). Revisit only with a shared-worker design.

### Desktop sign-in adds "Sign in with your browser" (device flow).

The login page on desktop keeps the password form and adds a button that runs
`startDeviceAuthorization` / `pollForDeviceSession` from `@starter/core` with
client id `trackyourtime-desktop` and opens `verificationUriComplete` through
`openExternal`.

**Why:** the password form in a shell cannot finish a two-factor challenge
(`NATIVE_TWO_FACTOR_UNSUPPORTED`) and cannot do Google OAuth. The browser that
approves the device code already passed both. This is a zero-server-change fix
for exactly the desktop users most likely to have 2FA on.

### `html.electron` marker, set pre-paint, for window chrome only.

Set in `app/pre-paint.ts` beside `html.cap` (the preload has already run when
head scripts execute, so `window.electronAPI` is readable before paint) and
styled in a new `styles/desktop.css` imported from `globals.css`: header drag
region (`-webkit-app-region: drag`, `no-drag` on controls), left inset for the
traffic lights on macOS (`data-platform="darwin"`), nothing else.

**Why `<html>`:** the same hydration argument as `html.cap` in CLAUDE.md.

### Bundle main and preload with esbuild into `electron/dist/`; package only `dist` and `out-desktop`.

**Why:** today `tsc -p electron` writes `.js` beside `.ts`, and electron-builder
would pull the Capacitor dependencies into the asar. A bundle has no runtime
`node_modules`, so `files` can be exactly `electron/dist/**` and
`packages/client/out-desktop/**`, with `electron-updater` inlined. Stage 0
measures the asar before and after.

### Electron security baseline is a stage-1 deliverable, not a hardening pass.

`sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`; every
`ipcMain.handle` checks `event.senderFrame.url` starts with `app://-/` (or the
dev URL in dev); `setPermissionRequestHandler` denies everything except
`notifications`; `will-navigate` and `setWindowOpenHandler` allow only
`app://-`; a CSP meta (`connect-src https: wss: http://localhost:* ws://localhost:*`
— the server picker means any https origin); `@electron/fuses` with RunAsNode,
NodeOptions and CLI inspect off and asar integrity on; DevTools and Reload
removed from the production menu.

### Distribution: GitHub Releases, updated by electron-updater. Drop itch.io.

**Why:** electron-updater reads GitHub Releases natively, the repo already
publishes release notes there, and itch.io is a game store left from the
starter. macOS updates require a signed app, so signing precedes updates.

Gated on open questions 1 and 2.

## Stages

Every stage ends on `pnpm electron:preview` (a packaged `--dir` build over
`app://`) against a pinned local API — **never** on `dev:desktop` alone, whose
`http://localhost` origin is same-site with the dev API and makes cookie auth
look like it works. The server-side tell is the same as on iOS: a request from
the shell carries **no `Cookie` header**.

In a worktree:

```bash
API_PORT=51591 PORT=33921 pnpm run dev
NEXT_PUBLIC_API_URL=http://localhost:51591 pnpm build:desktop
pnpm electron:preview
```

Each stage lands on `main` on its own (commit → rebase → ff-merge) and updates
the "Implementation notes" section at the top of this file with anything the
stage text got wrong, as the mobile plan did.

### Stage 0 — Spike: confirm the breakage and the three risky assumptions (half a day, no merge except notes)

1. Run `RELATIVE_ASSET_PREFIX=1 NEXT_PUBLIC_API_URL=… pnpm electron:preview`.
   Record: does `/` render, does navigating to Track/Reports work, does sign-in
   return 403 `INVALID_ORIGIN`. Screenshot each.
2. List the asar (`npx @electron/asar list …/app.asar | head`), record its size
   and whether `@capacitor/*` is inside.
3. In a 30-line throwaway main, register `app://` as privileged and `fetch` the
   local API with `credentials: "omit"` and an `Authorization` header. Confirm:
   the request carries `Origin: app://-`, the server's CORS answer with
   `Access-Control-Allow-Origin: app://-` is accepted by Chromium, and a
   `new WebSocket(…, ["bearer.<token>"])` upgrade carries the same origin.
   **If CORS from a custom scheme fails**, stop and re-plan: the fallback is
   proxying API calls through the main process's `net` module, which changes
   Stages 2 and 4.
4. Read every `isNative()` call site and fill in the classification table above.
5. Check whether `hatchkit update` / `hatchkit regen-infra` rewrite `electron/`
   or the root `build` block (run with `--dry-run`, never for real). Answer
   open question 7.

Output: the "Implementation notes" section, committed.

### Stage 1 — A packaged app that navigates: `app://`, own export, bundle, security baseline, window chrome, e2e harness

(a) Build. `scripts/build-desktop.mjs`, modelled on `scripts/build-mobile.mjs`:
refuse without `NEXT_PUBLIC_API_URL`; delete an inherited `NEXT_DIST_DIR`;
refuse while a dev server owns `packages/client/.next`; build the export into
`packages/client/out-desktop` (no `RELATIVE_ASSET_PREFIX`); assert the API literal
is in an emitted chunk and that no HTML contains `"./_next`; esbuild
`electron/src/main.ts` and `electron/src/preload.ts` into `electron/dist/`.
`build:desktop`, `electron:build`, `electron:preview` go through it.
`RELATIVE_ASSET_PREFIX` stays for `build:tauri` only, with the comment in
`next.config.ts` updated to say so.

(b) Main process split into `electron/src/`: `protocol.ts` (the path resolver is
a pure function with unit tests: trailing slash, `index.html`, `404.html`,
`..`, percent-encoding, query strings), `window.ts` (bounds persisted in
`userData/window-state.json`, `nativeTheme`-aware `backgroundColor`, hide on
close), `ipc.ts` (sender validation wrapper — every handler registers through
it), `idle.ts` (moved as is), `menu.ts`, `security.ts` (permissions,
navigation, CSP), `main.ts` (single-instance lock: a second launch focuses the
first window and exits).

(c) One contract. Move the preload's type into `packages/shared/src/desktop-bridge.ts`
and import it from both `electron/src/preload.ts` and
`packages/client/src/types/electron.d.ts`, so the two cannot drift.

(d) Chrome. `html.electron` + `data-platform` in `pre-paint.ts`;
`styles/desktop.css` with the drag region and traffic-light inset;
`pre-paint.test.ts` asserts the marker is absent without `electronAPI`.

(e) electron-builder config moves out of root `package.json` into
`electron-builder.config.mjs` with `files` limited to `electron/dist/**` and
`packages/client/out-desktop/**`, `asar: true`, and `afterPack` flipping fuses.

(f) E2E harness. `e2e/desktop/` with Playwright's `_electron.launch` against
`electron/dist/main.js` and the built export, following the E2E isolation
convention (own `mongod`, random ports). First specs: every `NAV_SECTIONS`
destination renders; a hard reload on `/reports/` renders; an unknown path shows
the 404 page; `ipcMain` refuses a call from a frame outside `app://-` (use
`electronApp.evaluate` to inspect handlers); a second launch exits.
Add a `desktop` job to CI that builds and runs these on `ubuntu-latest` under
`xvfb-run`.

Acceptance: `pnpm electron:preview` opens without a flash in dark mode; every
nav destination renders; reload on a deep route renders; the macOS header can
drag the window and clears the traffic lights; asar contains no `@capacitor`;
DevTools cannot be opened from the production menu; the CI job is green. Sign-in
is still expected to fail — that is Stage 2.

### Stage 2 — Signed in on a packaged build: shell predicates, bearer via `safeStorage`, trust, server picker

(a) `lib/shell.ts` with `isCapacitor()`, `isElectron()`, `isTokenShell()`,
`clientId()` (`"web" | "trackyourtime-mobile" | "trackyourtime-desktop"`) and
`entrySource()`. Replace every `isNative()` per the Stage 0 table and delete it.
`hooks/use-is-native.ts` becomes `use-shell.ts` with the same
hydrates-as-web behaviour.

(b) `lib/native-session.ts` takes a `SecureTokenStore` (`get/set/delete`), with
the Keychain plugin behind it on Capacitor and `electronAPI.secureStore` on
Electron. The fresh-install marker stays Capacitor-only (a deleted Mac app
leaves `userData` and the `safeStorage` key together, so they agree).
Main side: `secure-store.ts`, refusing to persist on `basic_text`.

(c) Trust. `DESKTOP_APP_ORIGIN = "app://-"` in `packages/shared/src/store-clients.ts`,
added to what `TRUST_STORE_APPS=true` trusts and to `scripts/dev.mjs`'s trusted
list; `tests/env.test.ts` covers it. Docs: `docs/deploy.md`,
`docs/self-hosting.md`, the README's origin list (replacing the `app://-`
aspiration with fact).

(d) Server picker and `lib/server-switch.ts` render and run on `isTokenShell()`;
`api-origin.ts` stores the choice in `localStorage` on Electron (not
Preferences). `server-picker.test.tsx`'s identical-prerender assertion extended to
the Electron case.

(e) Two-factor and Google gating read `isTokenShell()`; desktop shows the same
unsupported message until Stage 3.

Acceptance, on `electron:preview` against the pinned API: sign in; the server
log shows tRPC requests with `Authorization` and **no `Cookie`**; Settings →
Devices lists "Desktop app"; a started entry has `source: "desktop"`; a timer
started on the web appears in the app within a second; revoking the desktop row
from the web closes the socket with 4401 and lands the app on `/login` with the
unsent-changes count; quit and relaunch stays signed in; switching server signs
out of the old one first; OS idle past the threshold raises the idle prompt
(the existing `use-idle-signal` path, now reachable). Web unchanged:
`lib/trpc.test.ts` still asserts byte-identical web requests; the client unit
suite and the phone Playwright project pass.

### Stage 3 — "Sign in with your browser" for 2FA and Google accounts

A button on `/login` rendered for `isElectron()` after mount. It starts the
device flow, shows the user code, opens the approval URL externally, polls, and
stores the token through the Stage 2 store. Cancel stops polling. Errors
(`expired_token`, `access_denied`) are translated in the `common`/`settings`
catalogs, English and German.

Acceptance: an account with TOTP enabled signs in to the desktop app through the
browser; a Google-only account does too; the Devices row says "Desktop app";
denying in the browser returns the app to the form with a message.

### Stage 4 — Tray timer, global shortcut, launch at login

(a) Renderer publisher `components/desktop/desktop-bridge-publisher.tsx`, mounted
in `AppShell` beside the offline queue, sending `desktop:timer-state` on change
(debounced to the frame) and handling `desktop:command` (`start`, `stop`,
`continue:<entryId>`, `show`, `focus-description`) through `useEntryMutations`.
Recents come from the same `entries.recent` data the tracker uses.

(b) Main `tray.ts`: macOS template icon plus `setTitle` with `m:ss` / `h:mm`
while running and nothing when idle (mirror Raycast's `titleMode`/`idleTitle`
defaults); Windows and Linux use the tooltip and an alternate icon, because
`setTitle` is macOS-only. Menu: running entry with Stop, up to five recents to
continue, "Start timer…" (shows the window focused on the description), unsent
count when non-zero, Open, Settings, Quit. Labels arrive localized in the state
payload; main has no i18n catalog.

(c) Global shortcut, configurable in a new Settings → Desktop section (rendered
only under `isElectron()` after mount): toggle — stop what runs, else continue
the newest entry inside the same `RECENT_DAYS` window Raycast's `toggle-timer`
uses, else show the window on the description field. Put that decision in
`@starter/core` if it is not already there, and make Raycast call the shared
version in the same commit. Registration failure (shortcut taken) is shown in
Settings, not swallowed.

(d) Settings → Desktop also holds: open at login (`app.setLoginItemSettings`),
show timer in menu bar/tray, close button hides vs quits (Windows/Linux only).

(e) `scripts/icons-brand.mjs` generates tray icons (macOS `…Template.png` @1x/@2x,
Windows `.ico` 16/32, Linux 22/44 PNG) from the brand mark.

Acceptance: start from tray, stop from web — tray clears within a second; stop
from the shortcut with the window hidden; network off, start and stop from the
tray, the unsent count shows in the menu, network on, the rows flush and the web
shows both; German locale shows German tray labels; open-at-login survives a
reboot on macOS. E2E: `desktop:command` round-trips through `electronApp.evaluate`.

### Stage 5 — Attention: notifications for prompts the hidden window would otherwise swallow

A tray app hides its window, so every in-window prompt needs a way out:

- Idle prompt raised while hidden → system notification ("You were away for
  24 min") whose click shows the window on the prompt.
- Runaway guard `ask` flag → notification, same click behaviour.
- Quit with unsent queue rows → a native dialog naming the count and saying they
  will send on next launch (quit still proceeds; nothing is dropped).
- macOS dock badge / Windows overlay icon while a timer runs (setting, off by
  default).

Notifications go through the renderer's `Notification` API so text stays in the
catalogs; the permission handler from Stage 1 allows `notifications` only.

Acceptance: each of the four, with the window hidden, on macOS and Windows.

### Stage 6 — Packaging, signing, notarization — GATED on open questions 2 and 3

- macOS: `hardenedRuntime`, `entitlements.mac.plist` (JIT and
  unsigned-executable-memory, which Electron needs; network client), universal or
  split arm64/x64 dmg + zip, notarization through `APPLE_API_KEY`/`APPLE_API_KEY_ID`/
  `APPLE_API_ISSUER`.
- Windows: nsis, signed via Azure Trusted Signing (or the answer to question 2).
- Linux: AppImage + deb.
- Version from root `package.json`; `scripts/build-desktop.mjs` asserts the
  packaged `version` matches, like `build-mobile.mjs` does for
  `MARKETING_VERSION`.
- `desktop-release.yml`: drop butler; keep `--publish never` and the existing
  "export is the export we asked for" step, now pointed at `out-desktop`; fail
  closed when signing secrets are partially set (the Android signing rule);
  verify signatures (`codesign --verify --deep --strict`, `spctl -a`,
  `signtool verify /pa`).
- `docs/deploy.md` → "Desktop release signing", the one-time manual steps.

Acceptance: a dispatch produces a notarized dmg that opens on a clean Mac
without a Gatekeeper warning and a signed exe that SmartScreen does not block
as unsigned.

### Stage 7 — Auto-update and distribution — GATED on open question 1

- `electron-updater` with the GitHub provider; check on launch and every 6h;
  download in background; install on quit; "Restart to update" in Settings →
  Desktop and the tray. Never force a restart: a restart mid-edit loses a form,
  and the queue survives but the person's typing does not.
- Release workflow on `v*` tags builds and uploads to a **draft** GitHub Release
  with `latest*.yml`; a human publishes it. Publishing is the release decision,
  consistent with `docs/releasing.md`.
- `/download` marketing page (English and German, per
  `copywriting-style-rules.md`), `docs-site/docs/desktop.md`, README Clients table,
  ROADMAP "Shipping the desktop and mobile shells", CLAUDE.md desktop section
  rewritten to what exists.

Acceptance: install 0.1.0 from a draft-then-published release, publish 0.1.1,
the app offers the update and installs it on quit; Linux AppImage the same.

### Stage 8 — Desktop activity capture — DEFERRABLE, gated on open question 4

A main-process capturer of the frontmost app (and window title where the OS
permits) feeding `@starter/core/activity`'s `mergeSegments` / `buildSuggestions`
with `ActivitySource "desktop"`, stored locally in `userData`, off by default,
with the extension's rules carried over unchanged (scope `<userId>:<workspaceId>`,
"never record" purges the past, nothing leaves the device until an entry is
accepted). macOS titles need Screen Recording permission; app names alone do
not. Needs a Suggestions screen in the web app gated on `isElectron()` — the
extension's lives in the popup. Large enough to plan separately when picked up.

### Stage 9 — Cleanup

- Decide Tauri (question 5): delete `src-tauri/`, `tauri-release.yml`,
  `build:tauri`/`dev:tauri`/`icons:tauri`, `RELATIVE_ASSET_PREFIX` and the
  `__TAURI_INTERNALS__` check, or keep them explicitly as scaffolding.
- Remove `app:quit`'s destroy-all loop and the fullscreen IPC if nothing in the
  client calls them by then.

## Risks worth watching

- **CORS from a custom scheme** is the assumption everything after Stage 1
  rests on; Stage 0 step 3 exists for it.
- **`dev:desktop` masks auth bugs** (same-site origin, cookies). It pins port 7130
  and starts no API; keep it for UI iteration, never for acceptance.
- **Hidden-window renderer throttling.** Chromium throttles timers in hidden
  windows; the socket and the flush are event-driven, but check that the idle
  signal and the queue flush still run while hidden
  (`backgroundThrottling: false` on the window if not).
- **Sleep and resume.** Reuse the phone's resume order from
  `hooks/use-native-lifecycle.ts` (reconnect, tick, flush, refetch only when
  nothing was queued) on `powerMonitor` `resume`, forwarded over IPC — a laptop
  lid is the desktop's backgrounding.
- **Linux tray** requires AppIndicator on GNOME; without it the tray silently
  does not appear. Detect and fall back to keeping the window visible.

## Open questions

1. **Distribution channel.** GitHub Releases + electron-updater (recommended),
   a download page on trackyourtime.dev serving the same files, or also the Mac
   App Store (sandboxing rules out Stage 8 and complicates the global shortcut)?
2. **Signing identities.** Is the Apple Developer account used for iOS available
   for a Developer ID Application certificate? For Windows: Azure Trusted
   Signing, an OV certificate, or ship Windows unsigned at first?
3. **Platforms for 1.0.** macOS first and Windows/Linux as best effort, or all
   three verified per stage?
4. **Desktop activity capture** — wanted for 1.0, later, or never?
5. **Tauri** — delete now that Electron is the desktop app?
6. **Default global shortcut**, or none until the person sets one (safer: no
   collision with other apps on first launch)?
7. **Hatchkit ownership of `electron/`** — does a future `hatchkit update`
   rewrite `electron/main.ts` or the root `build` block? Stage 0 checks with
   `--dry-run`.

## Deliberately out of scope

- A second renderer window (quick-entry popover). See the state-ownership
  decision.
- A main-process API client or local database.
- Mac App Store and Microsoft Store listings.
- A menu-bar-only mode with no window.
- Google sign-in inside the shell (Stage 3's browser sign-in covers it).
- Offline-first reads beyond what the web app's React Query cache already gives.
