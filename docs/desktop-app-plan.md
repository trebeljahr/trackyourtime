# Track Your Time desktop app — implementation plan

Written 2026-09-15 from a survey of `electron/`, `src-tauri/`, the client's
native seams, the release workflows and `docs/mobile-app-plan.md`, whose
structure and lessons this plan reuses. Nothing below has been run yet; the
claims marked **(unverified)** are what Stage 0 exists to confirm or refute.

## Answers to the open questions (2026-09-15)

1. **Distribution:** GitHub Releases (electron-updater feed), Mac App Store,
   Microsoft Store, Linux package managers, and Homebrew. Store submission
   itself is a manual step; the repo produces store-ready artifacts, manifests
   and pipelines that fail closed without credentials.
2. **Signing:** both — Apple Developer ID + notarization (plus Mac App Store
   distribution certs) and Windows code signing.
3. **Platforms:** macOS, Windows and Linux, all verified.
4. **Desktop activity capture:** wanted, but in a separate workflow after the
   main app runs. Stage 8 is not part of the first build.
5. **Tauri:** delete it. Moved into Stage 1.
6. **Global shortcut:** ship a default that does not collide with common OS and
   app shortcuts, and make shortcuts extensible — several bindable actions, each
   rebindable or clearable in Settings → Desktop.
7. **Hatchkit:** it should never rewrite a customised `electron/`. Checked and
   fixed, if needed, in the hatchkit repo as a separate task.

Execution order for the first build: Stage 0 → 1 (+ Tauri removal) → 2 + 3 →
4 + 5 → 6 → 7. Stage 8 waits.

## Implementation notes

Every stage adds what its own text got wrong. Newest stage last.

### Stage 0 — spike (2026-09-16)

Run on macOS arm64, Electron 42.1.0, electron-builder 26.8.1, against a
production-mode API (`NODE_ENV=production`, own `mongod`, random ports). Spike
code lived in the session scratchpad and is not committed. Step 5 (hatchkit
`--dry-run`) was **not** done here; it is a separate task and open question 7
stays with it.

**Verdict: the risky assumption holds. Bearer `fetch` and a `bearer.`
WebSocket from a privileged `app://-` document work with a correct CORS answer,
and fail without one. No main-process `net` proxy is needed; Stages 2 and 4
stand as written.**

Step 3, what was observed (throwaway main: `registerSchemesAsPrivileged` with
`standard, secure, supportFetchAPI, corsEnabled, stream`; a `protocol.handle`
page at `app://-/index.html`; `sandbox: true`, `contextIsolation: true`;
headers read both with `session.webRequest.onBeforeSendHeaders` and by a Node
echo server):

- `location.origin === "app://-"` and `isSecureContext === true`.
- API with `TRUSTED_ORIGINS=app://-`: `POST /api/auth/sign-in/email` from the
  page with `credentials: "omit"` → 200, and `set-auth-token` is readable (it
  is in the server's `exposedHeaders`). Every request, preflight included, sent
  `Origin: app://-`, `Sec-Fetch-Site: cross-site`, `Sec-Fetch-Mode: cors` and
  **no `Cookie`**. `GET /api/trpc/entries.current` and `POST
  /api/trpc/entries.start` with `Authorization: Bearer <token>` and
  `x-trackyourtime-client` → 200 with data, after a preflight the `cors`
  package answered by reflecting the requested headers. Without the header →
  401. So better-auth's forced origin check (triggered by the `Sec-Fetch-*`
  headers) accepts `app://-` exactly like any other trusted origin.
- `new WebSocket("ws://…/api/ws", ["bearer." + encodeURIComponent(token)])`
  → open, the server echoed the subprotocol, still open after 2 s. The upgrade
  carried `Origin: app://-` and no cookie (echo server). A bad token → closed.
- Negative controls, so the positives are not vacuous: an echo endpoint with no
  `Access-Control-Allow-Origin` → `TypeError: Failed to fetch` (Chromium
  enforces CORS for the custom origin); the same API restarted **without**
  `app://-` in `TRUSTED_ORIGINS` → every fetch fails CORS and the server logs
  `[ws] upgrade refused: untrusted origin app://-`.
- `corsEnabled` is **not** needed for outgoing requests (same results with it
  off). It governs requests *to* `app://`; keep it for workers/fonts, but do not
  expect it to be what makes the API reachable.
- **Trap:** the raw `set-auth-token` value (`<id>.<base64 signature>=`)
  is not a valid subprotocol token — the `WebSocket` constructor throws
  `SyntaxError` synchronously. `@starter/core`'s `sync-client.ts` already
  `encodeURIComponent`s it and `ws/auth.ts` decodes it; anything new that
  builds a subprotocol by hand must do the same.
- `webRequest.onBeforeSendHeaders` did not report the `ws://` upgrade in this
  setup; use the server side to inspect upgrade headers.

Step 1, `RELATIVE_ASSET_PREFIX=1 NEXT_PUBLIC_API_URL=… pnpm electron:preview`:

- **The packaging step itself fails** before anything can be run:
  `Application entry file "index.js" … was not found in this archive`. The root
  `package.json` has no `main`, and electron-builder packs the root. The asar is
  still written (so step 2 could measure it). To go on, the spike re-ran
  `electron-builder --dir -c.extraMetadata.main=electron/main.js`. Stage 1's
  `electron-builder.config.mjs` must set `extraMetadata.main` (to
  `electron/dist/main.js`).
- electron-builder **downloaded its own Electron zip** (118 MB) instead of
  using `node_modules/electron`, and on this Mac **auto-discovered and signed
  with a local "Developer ID Application" identity** even for `--dir`
  (notarization skipped). A preview build should set
  `CSC_IDENTITY_AUTO_DISCOVERY=false` (or `mac.identity: null` for `--dir`) so it
  is fast and identical on every machine; Stage 6 turns signing on explicitly.
- `/` renders from `file://` (screenshot: landing page, but the root-absolute
  `/marketing/popup.png` hero image is broken — `file:///marketing/popup.png`
  not found). Within about a second `ShellEntryRedirect` does
  `router.replace("/app/track")`, whose RSC fetch goes to
  `file:///app/track/index.txt` → `ERR_FILE_NOT_FOUND`, Next falls back to a
  browser navigation to `file:///app/track/`, and the window ends on
  `chrome-error://chromewebdata/`, blank. **A packaged build today never shows
  anything but a blank error page.** `/app/track/`, `/app/reports/` and
  `/login/` are unreachable (each hard navigation stays on the error page).
- Sign-in, tried from the held `file://` landing document: **403
  `MISSING_OR_NULL_ORIGIN`** ("Missing or null Origin"), not `INVALID_ORIGIN` as
  the plan predicted — better-auth distinguishes a null origin from an untrusted
  one. Same conclusion: no trust-list entry can fix `file://`.

Step 2, the asar of that build: 10.8 MB, 1,029 entries; 8.87 MB is
`packages/client/out`, **1.69 MB is `node_modules`: all ten `@capacitor/*`
packages (`android`, `ios`, `app`, `core`, `keyboard`, `network`,
`preferences`, `screen-orientation`, `splash-screen`, `status-bar`) plus
`@aparajita/capacitor-secure-storage`**; the rest is `electron/main.js`,
`preload.js`, `package.json`. The `.app` is 278 MB. This is the "before" figure
for Stage 1's bundle.

Step 4: the classification table under "Split `isNative()`" now holds the
verified call sites. One change of meaning from the guess: the running-timer
mirror is wanted on Electron too (with a `localStorage` store).

Tooling facts for Stage 1:

- Confirmed: `pnpm-workspace.yaml` `allowBuilds` has no `electron`, so a fresh
  `pnpm install` never runs Electron's postinstall and `node_modules/electron`
  has no binary. This worktree's binary was extracted by hand from
  `~/Library/Caches/electron`; Stage 1 must add `electron: true` (and check CI).
- Playwright's `_electron.launch({ executablePath })` drives the packaged
  `.app` binary fine. `electronApplication.evaluate` runs in the main process
  **without** `require` (a `ReferenceError`), so use the modules passed in as
  the first argument.
- `firstWindow()` resolves after the shell redirect has already happened; a
  test that wants the pre-redirect document must intercept navigation first.
- A production API from `packages/server` with `NODE_ENV=production … node
  --import tsx src/index.ts` needs `SCHEDULER_ENABLED=false` only to keep logs
  quiet; with no mail transport, sign-up needs no email verification.

### Stage 1 — packaged app that navigates, and the Tauri deletion (2026-09-16)

Run on macOS arm64, Node 24.14.1, Electron 42.1.0, electron-builder 26.8.1.
Verified on `pnpm electron:preview` (packaged, fused, ad-hoc signed) against a
production-mode API with its own `mongod`, and by `pnpm test:e2e:desktop`
(10 specs, green). What the stage text got wrong or left out:

- **`allowBuilds: electron` fixes nothing.** Electron 42's package has *no*
  install script: the binary is downloaded lazily by `index.js` on the first
  `require("electron")`, or by its `install.js`. The entry was not added;
  `scripts/ensure-electron.mjs` (`pnpm electron:ensure`) downloads explicitly
  and is called by the build, the harness and CI. Measured on a fresh clone:
  under **Node 26** `install.js` stops mid-extraction (a truncated
  `Electron.app`, no `path.txt`) and still exits 0; Node 24 extracts fully. The
  script checks `path.txt`, `dist/version` and the executable instead of the
  exit code, and names Node 24 in its error. Run everything desktop on Node 24
  (`.nvmrc`); the client Vitest suite also fails under Node 26 (localStorage).
- **Fuses use electron-builder's built-in `electronFuses`**, not an `afterPack`
  hook — it flips them right before signing, as required, and re-signs
  ad hoc on arm64 (`resetAdHocDarwinSignature`). Read back from the binary:
  RunAsNode, NodeOptions and CLI-inspect off; asar integrity, only-load-from-
  asar and cookie encryption on; file-protocol extra privileges off.
- **Consequence: Playwright's `_electron.launch` cannot drive a packaged build**
  (it needs `--inspect`; measured: a 15 s timeout). The harness runs
  `electron/dist/main.js` unpackaged, which is the same main, scheme and export.
  The packaged build was driven with `--remote-debugging-port` +
  `chromium.connectOverCDP` (no fuse covers that switch; Stage 6 should decide
  whether a release build strips it). Note that `connectOverCDP` emulates a light
  colour scheme, so dark-mode checks need raw CDP.
- **The CSP is a response header** from the protocol handler (`csp.ts`), not a
  `<meta>`, so the web export stays byte-identical. `script-src` needs
  `'unsafe-inline'` (pre-paint scripts, RSC payload). No CSP violations were
  logged on any nav destination.
- **`@electron/asar` listing: 9.0 MB, 497 entries, no `node_modules`** (Stage 0:
  10.8 MB with ten `@capacitor/*` packages). `files` needs an explicit
  `!node_modules/**`: electron-builder adds production dependencies whatever
  `files` lists. The `.app` is still 275 MB (it is Electron). The build script
  fails if the asar holds anything but `package.json`, `electron/dist/` and
  `packages/client/out-desktop/`.
- **Hide-on-close is macOS-only for now.** On Windows and Linux the window
  quits on close until Stage 4's tray exists — hiding with no tray leaves an
  app nobody can reach or quit.
- **A window drag region needs a no-drag list**, and the macOS brand row needed
  more than an inset: 80 px of traffic-light clearance in the 14rem sidebar
  wrapped "Track Your Time" onto two lines, so on macOS it is one size smaller
  and `nowrap`. The brand row is a drag handle there, so the brand link is not
  clickable on macOS (Track in the nav is the same place). The window's
  800 px minimum is above Tailwind's `md`, so the sidebar always shows and the
  hamburger never sits under the traffic lights. Screens without the shell
  (login, 404) get a 2.5rem drag strip via `body:not(:has([data-window-drag]))`.
  `trafficLightPosition` is `{ x: 16, y: 20 }` with `titleBarStyle: "hidden"`.
- **`TRACKYOURTIME_USER_DATA_DIR`** moves `userData` (and with it the
  single-instance lock) — the harness needs a fresh profile per launch. A
  packaged app ignores `ELECTRON_DEV_URL` (verified by launching one with it set).
- **The "every nav destination renders" spec needs a session, and Stage 1 has
  no desktop sign-in.** The harness signs up from Node (with `Origin: app://-`:
  Node's `fetch` sends `Sec-Fetch-Mode`, so better-auth demands a trusted origin)
  and the main process attaches the cookie to API requests with
  `webRequest.onBeforeSendHeaders`. Marked as a stand-in in
  `e2e/desktop/support.ts`; Stage 2 replaces it with the login form. The spec
  also asserts the client-side clicks stayed in one document (a marker on
  `window`), because Next falls back to a full load when the RSC fetch fails,
  which would pass every URL assertion — a negative control (404 for `.txt`)
  failed as expected.
- **`DESKTOP_APP_ORIGIN` lives in `packages/shared/src/desktop-bridge.ts`**
  beside the bridge type and IPC channel names, not in `store-clients.ts`.
  Stage 2(c) should import it from there rather than define a second one.
- Routes are `/app/…` now (the plan's `/reports/` is `/app/reports/`).
- **Tauri is gone** (answer 5): `src-tauri/`, `tauri-release.yml`, the four
  scripts, `@tauri-apps/cli`, `RELATIVE_ASSET_PREFIX` (no `assetPrefix` remains
  in `next.config.ts`), the `__TAURI_INTERNALS__` check and the docs. No code
  ever listed `tauri://` origins — only README and CLAUDE.md did — so nothing in
  a self-hoster's env becomes invalid. CHANGELOG and the v0.1.0 release notes
  still mention `tauri-release.yml`, as history.
- `desktop-release.yml` now calls `scripts/build-desktop.mjs` and the config
  file; butler and signing stay for Stage 6.
- The CI `desktop` job (build-and-deploy.yml) is written but **has not run**: it
  lifts Ubuntu 24.04's `apparmor_restrict_unprivileged_userns` so Chromium's
  sandbox works under `xvfb-run` rather than disabling the sandbox. Check its
  first run.
- **Not verified here:** a real mouse drag of the window and a screenshot of
  the traffic lights (the computed `-webkit-app-region` values and the brand
  inset were checked in the packaged app; an OS-level attempt read a zero
  window geometry and was abandoned), Windows and Linux at runtime, and
  `canDownloadFiles()`'s save dialog in Electron (the plan table's Stage 1 item).

### Stage 1 — review (2026-09-17)

An adversarial pass over `26ab6f0..6d2c91e`, run on macOS arm64 with Node
24.14.1. Re-checked, not taken on trust: `pnpm test:e2e:desktop` (16 specs; 15
pass and the clipboard spec is skipped locally, see below), `pnpm test:electron`
(37), `pnpm typecheck`, `pnpm run test:client` (1210). A fresh
`pnpm electron:preview`, driven headless over `--remote-debugging-port`, opened
on `app://-/login/` with `ELECTRON_DEV_URL` set (so it was ignored), showed the
404 page with status 404, answered `/..%2f..%2fpackage.json` with 400, and
reloaded in place. Fuses were read back from the macOS binary. Cross-built
`--linux --win --x64 --dir` on the Mac: both asars hold the same 497 entries
with no `node_modules` or Capacitor, and both binaries carry the same fuse wire.
That checks the packaging only; neither was run.

Defects found and fixed:

- **`mailto:` links did nothing.** The navigation guard handed only http(s)
  to the OS, and the support page's contact address (linked from the 404 page)
  is a `mailto:`. `isOsHandledUrl` in `trust.ts` adds `mailto:` and nothing
  else. The spec stubs `shell.openExternal` so no mail client opens.
- **`win.maximize()` shows a hidden window** (Electron's docs say so). It ran
  straight after construction, so a profile last closed maximised showed an
  unpainted window before `ready-to-show`. It also made a headless launch
  visible. Maximise now waits for `ready-to-show`. Headless never restores the
  maximised or fullscreen state, and a spec seeds both.
- **The profile directory came from package.json.** Electron derives
  `userData` from `productName`, else `name`. A `productName` added later would
  have moved every installed app to an empty profile and stranded its offline
  queue. The unpackaged `dev:desktop` also shared the installed app's profile,
  so it shared the single-instance lock: with the installed app open,
  `dev:desktop` exited at once and printed nothing. `profile.ts` pins
  `trackyourtime` for a packaged app and `trackyourtime-dev` for an unpackaged
  run. A second instance now logs why it exits.
- **The clipboard spec writes the real system clipboard** and can restore
  only its text, so it would lose a copied image or file on a developer's Mac.
  It runs on CI, or locally with `DESKTOP_E2E_CLIPBOARD=1`.

Checked and found sound: the path resolver (encoded `..`, `%5c`, NUL, malformed
escapes, foreign hosts, drive-letter segments caught by the root prefix
check), IPC sender checks (the preload never reaches subframes, and a dev URL
counts only when unpackaged and http(s)), the permission handlers, the web CSP
(the web has none, so the extra pre-paint script cannot break it), hydration
(both markers are on `<html>`, which already suppresses the warning) and
leftover Tauri references (only history remains: CHANGELOG, release notes,
`mobile-app-plan.md`).

Left for later stages:

- **CSP `connect-src` is narrower than `isLoopbackHost`.** It allows plain
  http/ws for `localhost` and `127.0.0.1` only. The server picker also accepts
  `[::1]`, `*.localhost` and other `127.x` addresses, and those would be blocked.
  CSP host sources cannot express IPv6 literals or IP ranges, so Stage 2 has to
  choose between `http:`/`ws:` and a narrower picker on desktop.
- **A second launch may not bring the app forward on macOS.** `revealWindow`
  calls `show()` and `focus()` without `app.focus({ steal: true })`. Checking
  that needs a visible window, so it was not run.
- **A Linux AppImage with `sandbox: true`** hits the same Ubuntu 24.04 AppArmor
  user-namespace restriction the CI job lifts with `sysctl`. End users cannot
  lift it that way, so Stage 6 must ship an AppArmor profile or a deb.
- Still not run: a real window drag, the traffic lights on screen, Windows and
  Linux at runtime, and the CI `desktop` job itself (including the clipboard
  spec under xvfb, which is new on CI).

### Stages 2 and 3 — signed in on a packaged build, and browser sign-in (2026-09-17)

Run on macOS arm64, Node 24.14.1, Electron 42.1.0. Verified two ways against
production-mode APIs with their own `mongod` on random ports:

- **Packaged** (`pnpm electron:preview`, fused, ad-hoc signed), launched headless
  with `--remote-debugging-port` and driven over `connectOverCDP`, against an API
  preloaded with `e2e/desktop/record-requests.mjs`. 17 checks passed: form
  sign-in; `source: "desktop"`; Devices row "Desktop app on macOS"; 27 requests
  from `app://-` with **no Cookie**, every tRPC call after sign-in `Bearer` from
  `trackyourtime-desktop`, the socket upgrade on the `bearer.` subprotocol;
  `session.bin` written (83 bytes, `v10` ciphertext) and a relaunch landing on
  `/app/track`; a TOTP account pointed from the form to the browser, signed in
  by device flow, labelled "Desktop app"; a revoke with one queued start landing
  on `/login` with "1 unsent change".
- **Harness** (`pnpm test:e2e:desktop`, 25 pass, clipboard skipped as before),
  which adds what a packaged build cannot be driven through: the server switch,
  the idle prompt, a timer started on the web appearing within a second, a
  passwordless account and a declined code.

The web stayed green: `pnpm typecheck`, `pnpm run test:client` (130 files,
1229 tests), the server env and admin-cli tests, and the web Playwright specs
`auth`, `two-factor`, `smoke`, `move-server`, `timer` plus the `phone` project
(45 pass).

What the stage text got wrong or left out:

- **The no-Cookie claim needs a server-side recorder, and a control.** Electron's
  `webRequest` does not see the upgrade, and a page-side check cannot see what
  the network stack adds. `record-requests.mjs` patches `http.Server#emit` in the
  harness API and logs origin, client header, auth scheme and a cookie boolean
  (never values). A control spec adds a Cookie through the main process and
  asserts the log sees it. The harness's own Node calls send the app's Origin, so
  they carry `user-agent: desktop-e2e-harness` and are filtered out.
- **The auth client omits credentials in Electron.** Unlike WKWebView,
  Electron's jar accepts third-party cookies, so better-fetch's default
  `credentials: "include"` would store the API's session cookie on sign-in and
  the socket upgrade would carry it beside the token. The tRPC link already
  omitted once a token existed; sign-in did not. Capacitor is unchanged (not
  retested on a device here) — worth the same change after an iOS check.
- **Headless must not touch the Keychain.** Chromium's OSCrypt (cookies, and now
  `safeStorage`) reads or creates "<app name> Safe Storage"; the login keychain
  here already held "trackyourtime Safe Storage" and "Electron Safe Storage" from
  Stages 0–1. Measured with a probe under a throwaway name: without
  `--use-mock-keychain` an item is created, with it none is and encryption still
  round-trips. Headless now appends the switch, so a headless profile's
  `session.bin` only decrypts under another headless run.
- **Headless must not open the OS browser either.** Browser sign-in calls
  `openExternal`; a packaged build cannot be stubbed from Playwright (no
  inspector fuse). `electron/src/external.ts` records the URL (global and
  stdout) under `TRACKYOURTIME_HEADLESS=1`; the mailto spec now traps
  `shell.openExternal` to prove it is never called.
- **The bridge is key-less:** `secureStore.getToken/setToken/deleteToken/status`.
  There is one credential; a key parameter across IPC would only be something
  to validate. `status()` reports `{ persistent, backend }`, and Settings →
  Devices shows a note when not persistent (Linux `basic_text`, or encryption
  unavailable). That path is unit-tested only (`secure-store.test.ts`); no Linux
  run.
- **`DESKTOP_APP_ORIGIN` stays in `desktop-bridge.ts`**; `store-clients.ts`
  imports it into `STORE_APP_ORIGINS`. `env.test.ts` spells out `app://-` so a
  change to the constant fails a test instead of moving what servers trust.
- **The "does not accept sign-ins from this app" messages named the Capacitor
  origins.** They take `{origins}` now (`shellTrustedOrigins()`), so the desktop
  app tells an administrator to add `app://-`.
- **Revocation is not "within a minute".** Deleting a session sweeps live
  sockets at once (`auth.ts` → `revokeStaleSockets`); the minute-long re-check is
  the fallback. The 4401 close arrived in under a second in both runs, and
  `revokeThisDevice` (the notice) has no caller but `onSessionRevoked`.
- **The idle acceptance cannot be shortened by editing the entry from the web.**
  Another device's edit is proof of life and restarts the idle clock, and no
  span may begin before the entry did, so the spec waits out the one-minute
  minimum threshold. It feeds `idle:state` from the main process exactly as
  `idle.ts` broadcasts it; the OS idle counter itself was not moved.
- **Meanings kept to Capacitor:** bounded query retries (battery), the
  `pagehide` unload latch (Electron keeps the web one: `pagehide` fires on quit
  and reload, not on hide-on-close), `@capacitor/network`, Preferences storage,
  `autoFocus` on the tracker. `isAppShell()`'s "any non-http protocol" fallback
  existed for Tauri and went with `lib/app-shell-host.ts`.
- **Strings live in the `shell` namespace** (`auth.browserSignIn.*`,
  `auth.twoFactor.desktopUseBrowser`, `auth.google.desktopNote`) beside the rest
  of `/login`, not in `common`/`settings` as the stage said; the Devices note is
  `settings`' `devices.tokenNotPersisted`.
- **CSP `connect-src` stays narrow** (Stage 1 review's open choice): plain
  http/ws only to `localhost` and `127.0.0.1`. Allowing `http:`/`ws:` everywhere
  to cover `[::1]` and `*.localhost` would permit cleartext to any host, which
  the picker refuses anyway. Expected, not tried: a picker entry of
  `http://[::1]:…` is blocked by the CSP and fails its health check.
- The server-picker's prerender test covers Electron, and the login page's
  browser sign-in renders nothing until after hydration.

Not run, and why:

- **A real Google account.** OAuth cannot complete against a local API. The
  harness removes the credential account from Mongo instead, leaving an account
  only another sign-in method reaches; the device flow does not depend on how
  the approving browser signed in.
- **The server switch and the idle prompt on the packaged build**: the switch
  would have needed a second API in the packaged run and was covered by the
  harness on the same main process and export; the idle payload needs the main
  process, which the fuses close to a driver.
- **Windows and Linux at runtime**, the Linux keyring-less path, a visible
  window, and the CI `desktop` job (still never run; it now needs a second API
  database, derived from `MONGODB_URI`).

### Stages 2 and 3 — review (2026-09-17)

Re-read every former `isNative()` call site, the token store, the auth and tRPC
fetches, the device-flow component and the trust-list change. Re-ran on Node
24.14.1: `pnpm typecheck`, `pnpm run test:client` (130 files, 1229 tests),
`pnpm test:electron` (47), the server `env.test.ts` (13) and the full
`pnpm test:e2e:desktop` with a rebuilt export (25 pass, clipboard skipped), then
the shell and sign-in specs again after the fix below (21 pass).

- **Fixed: a headless launch could sign the installed app's user out.** Headless
  appends `use-mock-keychain`, and `secure-store.ts` deletes a `session.bin` that
  does not decrypt. With no `TRACKYOURTIME_USER_DATA_DIR`, a headless packaged
  run (how agents verify builds) opened the real `trackyourtime` profile, failed
  to decrypt the Keychain-encrypted token and deleted it, and would have flushed
  that person's offline queue from an invisible window. Headless now defaults to
  `<profile>-headless` (`profile.ts`, unit-tested); an explicit override still
  wins, so the harness is unchanged.
- **Node 26 breaks the client suite** (localStorage undefined in 18 files, 123
  tests) independently of this branch; Node 24 passes it. Same Node as the
  Electron install note.
- Checked and left as is: web requests are unchanged (`trpc.ts`/`auth-client.ts`
  take the old path when `!isTokenShell()`); `set-auth-token` is written only when
  truthy and the main store ignores `""`; `basic_text`/`unknown`/unavailable never
  read or write `session.bin`; the device flow stops on cancel and unmount (the
  sleep rejects on abort and every await re-checks the signal); a browser
  sign-in refreshes `useAuth().user` through `AuthProvider`'s per-token refetch;
  `app://-` is trusted only through `TRUST_STORE_APPS` and dev.

### Stages 4 and 5 — tray, global shortcuts, login item, attention (2026-09-17)

Run on macOS arm64, Node 24.14.1, Electron 42.1.0. Verified by
`pnpm test:e2e:desktop` (31 pass, clipboard skipped as before; six new specs in
`tray.spec.ts`, and the idle spec now also checks its notification), a negative
control (the main process dropping the unsent count made the offline spec fail
with 2 expected, 0 received), `pnpm test:electron` (83), core (107), the client
suite (133 files, 1252 tests), `pnpm typecheck`, and the web Playwright specs
`command-palette`, `mobile-shell`, `smoke` and `timer` (40 pass, own `mongod`).
A packaged `pnpm electron:preview`, launched headless and driven over CDP
against its own API, passed 9 checks: the bridge's `desktop` surface, the default
shortcut registered before sign-in, Settings → Desktop showing `⌥⇧⌘Space`,
recording suspending every registration, a recorded `Control+Alt+N` saved to
`desktop-settings.json` and registered, `notify` accepted from a hidden window,
and `tray-labels.json` written from the renderer. The asar holds
`electron/dist/tray/` (11 icons, 511 entries).

**Where it lives.** Main: `desktop.ts` wires everything; `tray-model.ts`
(menu, clock, tooltip, IPC payload parsing), `shortcuts.ts`,
`desktop-settings.ts` and `login-item.ts` are pure and unit-tested; `tray.ts` is
the Electron binding. Renderer: `components/desktop/desktop-bridge-publisher.tsx`
(mounted in `AppShell`), `components/settings/desktop-settings.tsx`,
`lib/desktop-shell.ts` (key recorder, accelerator display, `notifyDesktop`).
Contract: `DesktopShell` in `desktop-bridge.ts`, the action registry and
accelerator grammar in `packages/shared/src/desktop-shortcuts.ts`. The toggle
decision is `decideTimerToggle` in `@starter/core` (`timer-toggle.ts`), and
Raycast's `toggle-timer` calls it in the same change.

**The default shortcut: `CommandOrControl+Alt+Shift+Space`** (⌥⇧⌘Space on a
Mac, Ctrl+Alt+Shift+Space elsewhere), bound to "Start or stop the timer" only;
the other three actions ship unbound. How it was chosen:

- One or two modifiers are where every common binding lives, so three were a
  given. A letter plus Option on a Mac types a character, which a global
  shortcut would take away from every text field, so Command had to be in it.
- `…+T` (for timer) was the first candidate and is out: Ctrl+Alt+Shift+T is
  JetBrains' "Refactor This" on Windows and Linux (checked against JetBrains'
  keymap documentation).
- Space with one or two modifiers is taken everywhere: Spotlight ⌘Space, Finder
  search ⌥⌘Space, input sources ⌃Space/⌃⌥Space, the character viewer ⌃⌘Space
  (Apple's shortcut list, fetched), Alfred and Raycast ⌥Space, PowerToys Run
  Alt+Space, Windows input switching Win+Space, GNOME Super+Space, VS Code and
  JetBrains Ctrl+Shift+Space. Apple's list has no Command-Option-Shift-Space; a
  search found only one niche Windows audio app (DAISY Tobi) using
  Ctrl+Shift+Alt+Space. Browsers, Slack and terminals bind nothing with three
  modifiers and Space as far as their documented defaults go.
- Residual risks, stated rather than hidden: on Windows, Ctrl+Alt is AltGr, and
  a layout that maps AltGr+Shift+Space to a character would lose it; KDE lets
  users bind anything; and registration on Linux under Wayland (outside
  XWayland) is not expected to work at all in Electron 42. In each case the
  failure is the one Settings shows, never a silent one.

What the stage text got wrong or left out:

- **Headless creates none of it.** No `Tray`, no `globalShortcut.register` (an
  in-memory registrar), no `Notification`, no dialog, no badge, no
  `setLoginItemSettings` (a memory login item, also for any unpackaged run, so a
  test never registers `node_modules/electron` as a login item). Each is
  recorded on `globalThis.__trackYourTimeDesktop`, which the specs drive: tray
  clicks, shortcut triggers, a chord "taken" by another app, notification
  clicks. `revealWindow` itself now returns early in headless, as a second
  guard.
- **Notifications go through the main process, not the renderer's
  `Notification` API.** Text still comes from the catalogs (the renderer sends
  it), but a renderer notification cannot be suppressed in headless runs, and
  its click cannot show a hidden window without IPC anyway. The main process
  posts only when the window is hidden, minimised or not focused, replaces a
  notice with the same tag, and on click shows the window and sends
  `open-prompt`, which routes to `/app/track`.
- **The idle and runaway guards run on every screen in the desktop app only.**
  On the web they stay in the tracker bar. The first version left them there
  for Electron too, so a window hidden on Reports watched for no idleness and
  posted no notification: Stage 5 was silent on every screen but one. Review
  fix: `DesktopBridgePublisher` mounts `DesktopAttentionGuards` in Electron,
  off `/app/track` only, so exactly one copy of each guard runs (two would
  double every prompt). `electron` hydrates as false, so the prerender is
  unchanged. The runaway notification is sent only for the `flagged` action
  (a question about a timer still running).
- **`backgroundThrottling: false` for every window, not only headless.** The
  hidden renderer owns the socket, the queue and the tray state, and Chromium's
  intensive throttling would hold a hidden page's timers to once a minute. The
  publisher also coalesces through React effects, not `requestAnimationFrame`,
  which does not run in a hidden window.
- **The tray has no clock in its menu**, only in the macOS title and the
  Windows/Linux tooltip: rebuilding a context menu every second closes it on
  Windows. Linux AppIndicator shows no tooltip, so Linux shows no running time;
  the running icon variant is the signal there.
- **The tray's labels are remembered** (`userData/tray-labels.json`), so a
  German tray stays German before sign-in; a first launch shows English
  fallbacks from `tray-model.ts`.
- **Close button:** macOS always hides. Windows defaults to hide (the tray is
  always there), Linux defaults to quit, because GNOME without the
  AppIndicator extension shows no tray icon and Electron cannot detect that. The
  plan's "detect and fall back" is not possible; the default is the fallback.
  Hiding also requires the tray setting to be on.
- **Open at login:** Linux has no Electron API, so `login-item.ts` writes
  `~/.config/autostart/trackyourtime.desktop` (the AppImage path from
  `$APPIMAGE`). Windows and Linux launch with `--hidden` and stay in the tray
  when it is on; a second instance launched with `--hidden` does not bring the
  window forward. macOS 13+ registers through SMAppService, which passes no
  arguments, so a Mac opens its window at login. `requires-approval` is shown in
  Settings. A stored preference is not re-applied at launch, so removing the
  item in System Settings is respected.
- **Recording a shortcut unregisters all of them** (`suspendShortcuts`), because
  macOS delivers a registered global chord to its handler and never to the
  page. They come back on save, Escape, leaving the page, a renderer reload or
  crash, or after 60 s.
- **A binding is refused before saving** when it does not parse (a bare key,
  Shift plus a key, an unknown key) or repeats another action's chord on this
  platform; a chord `register` returns false for is saved and reported as taken.
  Keys are read from `KeyboardEvent.code`, not `key`, so Option on a Mac and
  non-US layouts record the physical key Electron expects. Option-only chords
  on a Mac show a warning.
- **Quit with unsent changes** is an informational box with one button, shown
  once per quit and skipped on OS shutdown (`powerMonitor` `shutdown`). The e2e
  spec emits `before-quit` rather than quitting, to read the record.
- **Running badge:** macOS `dock.setBadge("●")`, Windows a taskbar overlay
  (`overlay-running.png`), nothing on Linux (the Settings row is hidden there).
- **Icons** are generated by `scripts/icons-brand.mjs` into
  `electron/assets/tray/` (committed) and copied to `electron/dist/tray/` by
  `build-desktop.mjs`, which fails without them. The macOS template icons
  change shape when running (a closed ring with a filled centre), since a
  template image cannot carry colour.
- The toggle continues the newest *recent combination* (`entries.recent`,
  author-scoped) inside Raycast's 7-day window, through `startQuickStart`, so it
  works offline from the cached list. Raycast continues the newest own *entry*;
  both pick the same work.

Not run, and why:

- **Anything visible:** a real tray icon or menu, a real global shortcut press,
  a posted notification and its click, the Dock badge, the quit dialog. Each
  needs a non-headless launch on a machine someone is using. The handlers they
  reach were driven through the test hook.
- **Open at login surviving a reboot** (the stage's macOS acceptance): needs a
  real login item and a reboot.
- **Windows and Linux at runtime**: tray click behaviour, `.ico` rendering,
  AppIndicator, the autostart file on a real session, Wayland shortcuts, the
  taskbar overlay. The Linux autostart writer is unit-tested only.
- **Stage 5 "on macOS and Windows"**: the four attention paths were verified
  headless on macOS through the hook; none were seen on screen, and nothing ran
  on Windows.
- The CI `desktop` job (still never run).

Stage 4+5 review (2026-09-17). Rico asked mid-review that agents stop launching
Electron sessions, which flash and take focus on his screen even with the
headless switch set. So the review ran no Electron binary at all, and no
harness spec or packaged build was run again. It read every change in the
range and ran the plain-Node and jsdom suites on Node 24: client (133 files,
1253 tests), the `electron/src` units (83) and core (107). The client suite
fails 123 tests under Node 26, whose own `localStorage` global shadows
jsdom's; this is not caused by this branch. A re-run of the harness should
wait until Rico agrees to it. Also check whether macOS shows a Dock icon for
the unpackaged `Electron.app` before `main.js` sets the accessory policy.

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

`isNative()` (and the helpers built on it: `useIsNative`,
`shouldUseNativeStorage`, `isAppShell`) is read in 20 files. They mean one of
three different things, and Electron wants only some of them. **Verified in
Stage 0 by reading every call site (2026-09-16):**

| Meaning | New predicate | Capacitor | Electron | Call sites (verified) |
| --- | --- | --- | --- | --- |
| Phone UI | `isCapacitor()` | yes | **no** | `mobile/bridge.ts` (`initMobile`: splash, status bar, orientation, back button, lifecycle); `components/tracker/tracker-bar.tsx` (`autoFocus={!isNative()}` — a desktop keeps focus-on-mount); `app/pre-paint.ts` `NATIVE_SHELL_SCRIPT` (reads `window.Capacitor` directly, not `isNative()`; stays as is, `html.electron` is a separate script); `components/reports/export-menu.tsx` `canDownloadFiles()` (reads `window.Capacitor` directly; Electron can download — confirm the default save dialog in Stage 1). `mobile-tab-bar`, `app-shell` and `workspace-switcher` only *mention* `isNative()` in comments and branch on nothing. |
| Token-auth shell | `isTokenShell()` (or `clientId()` / `entrySource()`) | yes | yes | `lib/native-session.ts` (token store — backend differs, see Stage 2b); `lib/trpc.ts` (bearer + `credentials: "omit"` → `isTokenShell()`; client header → `clientId()`); `lib/auth-client.ts` (`clientHeader` → `clientId()`; rebasing fetch wrapper → `isTokenShell()`); `lib/entry-source.ts` → `entrySource()`; `lib/api-origin.ts` (server choice; storage is Preferences on Capacitor, `localStorage` on Electron); `app/login/page.tsx` (two-factor unsupported message); `components/server-picker.tsx` and `components/data/move-server-panel.tsx` via `useIsNative` (the latter hardcodes `"trackyourtime-mobile"` → `clientId()`); `lib/app-shell-host.ts` `isAppShell()` — already true in Electron via `"electronAPI" in window`, consumed by `google-sign-in-button.tsx` and `marketing/shell-entry-redirect.tsx`; becomes `isTokenShell()` once Tauri is gone. Indirect, through `native-session`: `app/app/layout.tsx` (`hasStoredToken`), `hooks/use-sync.ts`, `providers/auth-provider.tsx`, `invite/invite-acceptance.tsx`, `lib/server-switch.ts`, `lib/revoke-this-device.ts`. There is no `signed-in-redirect`; the survey meant `shell-entry-redirect`. |
| Durable storage / radio network truth / phone battery | `isCapacitor()` | yes | no — Chromium `localStorage` in `userData` is not evicted, `navigator.onLine` is usable on desktop | `mobile/preferences-storage.ts` `shouldUseNativeStorage()` → consumed by `lib/offline.ts` (queue store) and `lib/active-workspace.ts` (workspace choice, including its sync-hydrate-on-web path); `mobile/network.ts` (`@capacitor/network`); `lib/query-client.ts` (bounded retries are a battery rule; the `onlineManager` feed comes from `network.ts`); `lib/offline.ts` `watchDocumentUnload` (the web teardown latch is right on Electron: `pagehide` fires on quit and reload, not on hide-on-close). |
| **Changed from the guess:** running-timer mirror | `isTokenShell()` for the behaviour, `isCapacitor()` for the backing store | yes (Preferences) | yes (`localStorage`) | `lib/running-mirror.ts`, seeded from `mobile/MobileBridgeLoader.tsx`. It exists for the cold *offline* launch with a stored token, which a laptop opened on a train has exactly as a phone does: `app/app/layout.tsx` keeps the token user in, the query never answers, and without the mirror the running clock is blank. Only the store is phone-specific. Stage 2 moves the seed call out of the Capacitor-only loader. |

`isNative()` is deleted, not aliased, so no call site keeps an ambiguous
meaning. `lib/shell.ts` owns all three predicates plus `clientId()` and
`entrySource()`.

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
