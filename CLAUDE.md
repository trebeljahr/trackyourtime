# node-realtime-starter

A stampable starter repo for multiplayer web games and SaaS apps. Express backend, Next.js frontend, MongoDB, tRPC, better-auth, Stripe, WebSocket support.

## Product name

The product people see is **Track Your Time** (`PRODUCT_NAME` in
`packages/client/src/lib/site-links.ts`); it was "tracktime" until 2026-09-13.
Home-screen labels use the short form **Track Time** — the web manifest's
`short_name`, Capacitor `appName`, `CFBundleDisplayName` and the Android
`app_name` / `title_activity_main`, which `scripts/build-mobile.mjs` asserts
agree.

Every identifier is `trackyourtime` too, since 2026-09-14, before any release
or store listing existed: the GitHub repo, the GHCR images, the bundle id
`com.trebeljahr.trackyourtime`, storage/Keychain keys, the
`x-trackyourtime-client` header and client ids, the `X-TrackYourTime-*` webhook
headers, `TRACKYOURTIME_VERSION`, database names and export filenames. From
here on these are contracts — a rename would break stored sessions, queued
data, integrations and self-hosters' `.env` files.

What still says `tracktime`, on purpose: the `*.tracktime.trebeljahr.com` hosts
in the deploy history and the hatchkit dev URL, the `tracktime` slug and every
provisioned resource in `.hatchkit.json` (the SES identity), because those name live infrastructure that code cannot move;
and the on-disk checkout path `~/projects/tracktime`.

## Hatchkit Context

This starter is normally generated and maintained by `hatchkit`.
If `.hatchkit.json` exists at the project root, treat the repo as a
Hatchkit-managed project.

Useful Hatchkit commands from inside a generated project:

```bash
hatchkit overview --json                 # inspect manifest/project state
hatchkit update                          # add supported features additively
hatchkit add <project> [services]        # provision GlitchTip/OpenPanel/Plausible/Listmonk+SES/S3/email/search
hatchkit keys push <project>             # push dotenvx private key to Coolify/GitHub Actions
hatchkit sync                            # sync/deploy existing project state
hatchkit rename-domain                   # update domain-related deploy config
hatchkit regen-infra                     # regenerate infra/deploy files
hatchkit provision s3                    # create project buckets + env entries
hatchkit assets pull                     # mirror remote object storage assets locally
```

Newsletter / Listmonk + SES smoke commands (run from the project root
once `hatchkit add <project> listmonk-ses` has populated env):

```bash
pnpm newsletter:verify              # full smoke — API reach, list ids, subscriber, real tx send
pnpm newsletter:test-tx             # send one /api/tx email to LISTMONK_TEST_RECIPIENT
pnpm newsletter:welcome             # send emails/welcome.html to LISTMONK_TEST_RECIPIENT
pnpm newsletter:draft emails/digest-sample.html --subject "Issue 1"   # stage digest as a Listmonk draft
NODE_ENV=production pnpm newsletter:send emails/digest-sample.html --subject "..." --confirm   # real broadcast
```

Hatchkit auto-subscribes your default forwarding email onto
`<project>-test` and writes it to `.env.development` as
`LISTMONK_TEST_RECIPIENT`, so the smoke scripts work end-to-end on a
fresh provision with no extra setup.

Before giving Hatchkit setup advice, run `hatchkit status --json` and
read `providers[]`, `nextStep`, and `suggestions[]`. For provider failures,
run `hatchkit doctor --json` and surface the failing `checks[].hint[]`
lines. Never print dotenvx private keys unless the user specifically asks.

If a Hatchkit command breaks in this project, report the failing command,
cwd, Hatchkit version, output, suspected source area, and safe undo path.
When asking another agent to fix it, include a repair prompt with those details
and tell it to preserve existing user setups, use `--dry-run` where possible,
and ask before provider/DNS/Coolify/Terraform/keychain mutations.

Do not run commands that may alter existing infrastructure unless the user
explicitly asks. Prefer giving the command to the user, or using preview modes
such as `hatchkit destroy <project> --recipe`, `hatchkit gh-pages --undo
--dry-run`, and other command-specific `--dry-run` options.

## Tech Stack

- **Backend:** Express + TypeScript, tRPC for typed API, better-auth for authentication, Stripe for payments
- **Frontend:** Next.js (App Router) + Tailwind CSS + shadcn/ui, tRPC React Query client
- **Database:** MongoDB (Mongoose) + Redis (ioredis)
- **Real-time:** Native `ws` WebSocket on same Express process
- **Monorepo:** pnpm workspaces — `packages/server`, `packages/client`, `packages/shared`

## How to Run

```bash
pnpm install                          # install all dependencies
pnpm run dev:infra                    # start MongoDB and Redis (Docker, one-time)
pnpm run dev                          # client 3392, server 5159, docs 4000
pnpm run dev:auto                     # same, but every port auto-picked
pnpm run dev:fixed                    # the pinned ports, or fail — never a fallback
```

Two dev commands, because the two callers want opposite things:

- **`pnpm run dev`** pins **client 3392, API 5159, docs 4000** (`DEV_*_PORT` in
  `scripts/dev.mjs`). The origins never move, so password managers, saved logins
  and bookmarks keep working — and so do the clients that bake the API URL in at
  build time (browser extension, Raycast, desktop/mobile), none of which can
  follow a port that changes per run.
- **`pnpm run dev:auto`** auto-picks every port. Use it for agents and for any
  second instance, so nothing fights over the pinned three.

`pnpm run dev` inside a git worktree behaves like `dev:auto` automatically, so
several agents can run side by side without stepping on the main checkout. A
worktree therefore does NOT serve the ports the extension and Raycast default
to — point them at the printed ports, or run `dev:fixed` there when the worktree
is the thing being tested.

`PORT`, `API_PORT` and `DOCS_PORT` pin individual ports, and `--fixed` wins over
all of it, worktree included. If a pinned port is busy, `dev` warns and falls
back to a random one for that run rather than refusing to start; `dev:fixed`
exits instead, because "these exact ports" was the point. `node scripts/dev.mjs
--dry-run` resolves and prints ports without starting anything.

`dev` also derives the dev browser extension's `chrome-extension://<id>` origin
from `packages/extension/dist`'s absolute path — the same hash Chrome uses — and
passes it to the server as `TRUSTED_ORIGINS`, so no id is ever pasted by hand
for local work. Anything in `TRUSTED_ORIGINS` in the environment is kept
alongside it. Production origins belong in the server app's `TRUSTED_ORIGINS`
field in Coolify — `.env.production` is untracked here and never reaches the
image.

**Every Next route answers 404 while `public/` files load** means `next dev`
could not open file watches (`Watchpack Error (watcher): Error: EMFILE: too many
open files, watch` in the client log): with no watcher it never scans `app/`.
The cause was dev watchers from earlier runs that never died — `dev.mjs` used to
`execSync` concurrently, so a signal to its pid alone (a harness SIGTERM,
SIGKILL, a closed agent shell) orphaned `tsx watch` and `next dev` for days. Now
concurrently leads its own process group, which `dev.mjs` stops on
SIGINT/SIGTERM/SIGHUP, on EPIPE and when reparented, and `scripts/lib/dev-reaper.mjs`
stops it when `dev.mjs` dies any other way. `dev` warns at start about orphaned
watchers of this repo and prints a boxed explanation on the first EMFILE/ENOSPC;
it never kills them. Stop only what you started, or run
`WATCHPACK_POLLING=true pnpm run dev`. The server's `tsx watch` passes
`--exclude "../../node_modules/**"`: tsx's own `**/node_modules/**` ignore is
resolved against `packages/server`, so every dependency under the root
`node_modules/.pnpm` was watched (~3,200 fds per process; 38 with the exclude,
reload from `packages/shared/src` intact).

## How to Test

```bash
pnpm run test:unit                    # server unit tests (node:test)
pnpm run test:client                  # client unit tests (Vitest)
pnpm --filter @starter/extension test  # extension unit tests (Vitest, fake chrome)
pnpm run test:e2e                     # Playwright E2E tests
pnpm run build                        # build all packages
```

## Desktop (Electron) + Mobile (Capacitor)

All native targets wrap the Next.js client as a **static export** (`output: "export"`).
The Express server is always remote — the client talks to it over HTTPS.

Electron is the one desktop wrapper. The Tauri scaffold the starter shipped
was deleted on 2026-09-16 (`docs/desktop-app-plan.md`, answer 5).

### Desktop (Electron)

```bash
NEXT_PUBLIC_API_URL=http://localhost:51591 pnpm electron:preview  # export + bundle + unpacked app in release/
NEXT_PUBLIC_API_URL=… pnpm build:desktop  # export (out-desktop) + electron/dist, no packaging
pnpm electron:build                   # the same, then electron-builder → dmg/zip/exe/AppImage
pnpm dev:desktop                      # Next dev on 7130 + Electron window (UI iteration only)
pnpm prod:desktop                     # unpacked app against api.trackyourtime.dev, then opens it
pnpm test:electron                    # node:test over electron/src (part of test:unit)
pnpm test:e2e:desktop                 # Playwright _electron harness; own mongod + API
pnpm electron:ensure                  # download the Electron binary if it is missing
pnpm icons:desktop                    # regenerate icns/ico from build/icon.png
node scripts/build-desktop.mjs --channel mac --package --mac dmg zip --arm64  # a release leg, locally
node scripts/desktop-release-draft.mjs --artifacts <dir> --out <dir>         # what a tag attaches to the draft
```

`build/icon.png` is generated — run `pnpm icons:brand` to re-derive it (and
every other shipped bitmap) from `packages/client/public/brand/mark-tile.svg`,
then `pnpm icons:desktop` to fan it out to icns/ico. Do not hand-edit it.

The plan and its measured corrections are `docs/desktop-app-plan.md`. What is
built, and the rules that fail quietly if broken:

- **The packaged app serves the export from `app://-`** (`electron/src/protocol.ts`,
  a privileged standard scheme), resolving paths like `serve.mjs`
  (`resolve-app-path.ts`, unit-tested). Never `file://`: that origin is `null`,
  sign-in answers 403 `MISSING_OR_NULL_ORIGIN`, and every route but `/` blanks.
  **Never change the scheme or host** — the origin keys `localStorage` (the
  offline queue) and every server's `TRUSTED_ORIGINS`.
- **Own export directory, `packages/client/out-desktop`,** written only by
  `scripts/build-desktop.mjs`, which requires `NEXT_PUBLIC_API_URL`, asserts
  it is in a chunk, refuses `"./_next` in any HTML and refuses while a dev
  server owns `.next`. There is no `assetPrefix` anywhere any more.
- **Main and preload are esbuild bundles in `electron/dist/`**; the package
  holds only those, the export and package.json (`electron-builder.config.mjs`
  `files`, with `!node_modules/**` — electron-builder otherwise packs the root
  `dependencies`, which are the Capacitor plugins). The build lists the asar and
  fails on anything else.
- **Electron 42 has no install script.** The binary downloads on first
  `require("electron")`; `scripts/ensure-electron.mjs` does it explicitly and
  detects the truncated extraction Node 26 leaves behind (use Node 24).
- **`window.electronAPI`'s type is `DesktopBridge` in
  `packages/shared/src/desktop-bridge.ts`**, imported by the preload and by
  `types/electron.d.ts`, with the IPC channel names beside it.
- **Every IPC handler registers through `handle()` in `ipc.ts`,** which refuses
  a sender frame outside `app://-` (or the dev URL, unpackaged only). A packaged
  app ignores `ELECTRON_DEV_URL`.
- **Security baseline** (`security.ts`): navigation and `window.open` never
  leave the app origin (http(s) goes to the OS browser), no `<webview>`, every
  permission denied but notifications; a CSP response header on HTML
  (`csp.ts`, so the web export is untouched); `devTools: false` and no
  Reload/DevTools menu items outside dev; fuses (RunAsNode, NODE_OPTIONS and
  `--inspect` off, asar integrity and only-load-from-asar on). The inspector
  fuse means Playwright's `_electron.launch` cannot drive a **packaged** build
  (it times out); drive it with `--remote-debugging-port` and
  `chromium.connectOverCDP`, or use the harness, which runs the same
  `electron/dist/main.js` unpackaged.
- **`html.electron` + `data-platform`** are set pre-paint
  (`DESKTOP_SHELL_SCRIPT` in `app/pre-paint.ts`) and style only window chrome in
  `styles/desktop.css`: `[data-window-drag]` (the app header) is the drag region,
  and on macOS `[data-window-inset]` (the sidebar brand row) clears the traffic
  lights of the title-bar-less window. Never `html.cap` — that means phone.
- **Tests and agents run headless: `TRACKYOURTIME_HEADLESS=1`**
  (`electron/src/headless.ts`). The window is never shown or focused, and on
  macOS the app uses the accessory activation policy with no Dock icon, so a
  launch never steals focus or flashes across the screen of whoever is using
  the machine. Hidden windows still paint, so Playwright screenshots work.
  `e2e/desktop/support.ts` sets it on every launch and a spec asserts it.
  Launch the packaged binary with it too; never `open` the `.app`.
- **One instance per profile** (`requestSingleInstanceLock`); a second launch
  focuses the first and exits. The profile is pinned by name in `profile.ts`
  (`trackyourtime` packaged, `trackyourtime-dev` unpackaged, so `dev:desktop`
  never shares the installed app's lock or offline queue), never derived from
  package.json. `TRACKYOURTIME_USER_DATA_DIR` moves it (and the lock) — the
  harness uses it.
- **Closing the window hides it** on macOS always, and on Windows and Linux
  only while the tray is on and "Keep running when the window is closed" is
  (default on for Windows, off for Linux, where GNOME may show no tray icon).
- **The tray and global shortcuts are views of renderer state** (plan Stages 4
  and 5, `electron/src/desktop.ts`). `DesktopBridgePublisher` in `AppShell`
  publishes the timer, recents, unsent count and translated labels; commands
  come back and run through `useEntryMutations`. Headless runs create no tray,
  register no OS shortcut, post no notification and touch no login item: each
  is recorded on `globalThis.__trackYourTimeDesktop` for the specs. Shortcut
  actions and the accelerator grammar are in
  `packages/shared/src/desktop-shortcuts.ts`, with one default
  (`CommandOrControl+Alt+Shift+Space`, toggle timer; reasoning in the plan). The
  toggle rule is `decideTimerToggle` in core, shared with Raycast's
  `toggle-timer`. Tray icons come from `pnpm icons:brand` into
  `electron/assets/tray/`.
- **The desktop app signs in with the phone's bearer path, never a cookie.**
  `lib/shell.ts` splits the old `isNative()` into `isCapacitor()` (phone UI,
  Preferences storage, the radio), `isElectron()` and `isTokenShell()` (either:
  bearer token, server picker, running-timer mirror); `hooks/use-shell.ts`
  hydrates them as web. Never branch phone chrome on `isTokenShell()`. The
  token is `userData/session.bin`, encrypted by `safeStorage` in the main
  process (`electron/src/secure-store.ts`) and reached through
  `electronAPI.secureStore`; on Linux's `basic_text` backend it is refused and
  kept in memory, and Settings → Devices says so. The auth client sends
  `credentials: "omit"` in Electron so the API's cookie never lands in
  Chromium's jar — a second, silent credential would mask a broken bearer path.
- **"Sign in with your browser"** (`components/browser-sign-in.tsx`) is the
  device flow with client id `trackyourtime-desktop`: the way in for two-factor
  and Google accounts, which the password form cannot finish in a shell.
- **Headless launches never touch the Keychain or the OS browser.** Headless
  appends `use-mock-keychain` (measured: no "<name> Safe Storage" item is
  created, and one is without it), and `openInOs` (`external.ts`) records URLs
  on `globalThis.__trackYourTimeOpenedExternally` and stdout instead of opening
  them. A spec that needs the approval URL reads it from there.
  A headless launch with no `TRACKYOURTIME_USER_DATA_DIR` uses
  `<profile>-headless`, never the installed app's profile: the mock keychain
  cannot decrypt its `session.bin`, and the store deletes what it cannot decrypt.
- **Every channel is built by one workflow, and signing fails closed**
  (`.github/workflows/desktop-release.yml`, `scripts/lib/desktop-release.mjs`,
  docs/deploy.md → "Desktop release"). No secrets for a channel builds files
  named `-unsigned`; a partial set refuses before the export. Which channel a
  running copy came from is `distribution.ts` (`process.mas`,
  `process.windowsStore`, `SNAP`, `FLATPAK_ID`, `APPIMAGE`), and it decides
  both open at login and updates.
- **Only direct downloads update themselves** (`updater-model.ts`,
  `updater.ts`): the Developer ID dmg/zip, the NSIS installer and the
  AppImage, and only when the app has an `app-update.yml`. The stores, Snap,
  Flatpak, deb, rpm and tar.gz never load electron-updater. The feed comes from
  `updateFeedFor` in the builder config: signed mac and win builds and every
  Linux build get GitHub Releases, everything else gets `publish: null` —
  **explicitly null**, because left undefined electron-builder guesses a GitHub
  feed from `GH_TOKEN`, which every CI runner has. electron-updater is bundled
  into `main.js` by esbuild and loaded lazily, never packed as a dependency.
- **Never restart for an update on the person's behalf.** A download installs
  on quit (`autoInstallOnAppQuit`); `quitAndInstall` has exactly one call site,
  reached only from the tray's "Restart to update" item and the Settings →
  Desktop button, and `updater-model.test.ts` greps the source to keep it that
  way. `markQuitting()` (window.ts) runs first, because on macOS Squirrel
  closes windows before `before-quit` and the hide-on-close handler would
  otherwise swallow the restart. Headless runs a memory updater: no network, and
  `__trackYourTimeDesktop.update` drives it.
- **A tag builds a DRAFT release, and a person publishes it.** The
  `draft-release` job attaches signed downloads and each `latest*.yml`, checks
  every file a feed names against its sha512 and size, never attaches
  `-unsigned` files or store packages, and never touches a published release.
  electron-updater reads only published releases, so publishing is the release
  decision. The Homebrew cask says `auto_updates true` for the same reason.
- **`/download` never links what does not exist.** Every channel's address is
  `DESKTOP_DOWNLOADS` in `lib/site-links.ts`, `null` until a release is
  published or a store approves the listing.
- **The harness proves auth from the server side.** `e2e/desktop/record-requests.mjs`
  is preloaded into the harness APIs and logs every request's origin, client,
  auth scheme and whether a Cookie was present; the harness's own Node calls
  send `user-agent: desktop-e2e-harness` so `appRequests()` excludes them.

**`prod:desktop`, `prod:ios` and `prod:android` are for a person checking the
real apps against the live servers**: each bakes `https://api.trackyourtime.dev`
into a production-shaped bundle (the same bundle path as a release, not a dev
server) and opens it in a visible window, Simulator or emulator. Agents and
tests never run them — they take focus, and they write to production. The
desktop one needs `app://-` in the live server's `TRUSTED_ORIGINS` (or
`TRUST_STORE_APPS=true`); `/api/health` with an `Origin: app://-` header says
whether it is (`originTrusted`).

**Simulator and emulator runs never take focus either.** `IOS_HEADLESS=1 pnpm
dev:ios` drives simctl only (without it Simulator.app is opened with `open -g`),
and `ANDROID_HEADLESS=1 pnpm dev:android` boots the emulator with `-no-window`.
Screenshot with `simctl io` / `adb exec-out screencap`, never by bringing a
window forward.

### Mobile

```bash
pnpm cap:add:ios                      # one-time — requires Xcode
pnpm cap:add:android                  # one-time — requires Android Studio / SDK
pnpm dev:ios                          # live-reload on Simulator
pnpm dev:android                      # live-reload on emulator/device
pnpm build:mobile [ios|android]       # build + verify + cap sync, as one step
pnpm prod:ios                         # the real bundle against api.trackyourtime.dev, on a Simulator
pnpm prod:android                     # the same on an emulator or device
pnpm mobile:assets                    # generate icons/splash from resources/
pnpm build:android:release            # AAB for Play Store
pnpm build:ios:release                # opens Xcode for App Store archive
```

`ios/` and `android/` are both **committed** — the ATS exception, the
orientation set, the debug-only cleartext config, `versionName` and (later)
entitlements and signing are hand-edits that live only in those trees, and a
fresh checkout has to build the real app without a generator run.
`.github/workflows/mobile-release.yml` also assumes both trees exist while
never running `cap add`.

What `cap add` *does* write, contrary to a note that survived several stages
here: `@capacitor/cli` 8.3.4 calls `editProjectSettingsIOS` /
`editProjectSettingsAndroid` right after extracting the template
(`dist/tasks/add.js`), so `PRODUCT_BUNDLE_IDENTIFIER`, `CFBundleDisplayName`,
`namespace`, `applicationId` and `res/values/strings.xml` all come out correct.
It writes them **once**: `cap sync` never revisits them, so a later change to
`appId` or `appName` in `capacitor.config.ts` silently does not reach the
native trees. That is the drift `scripts/build-mobile.mjs` asserts against, for
both platforms, along with `MARKETING_VERSION` / `versionName` versus the root
`package.json`.

Generated-but-tracked inside them: `ios/App/CapApp-SPM/Package.swift`,
`android/capacitor.settings.gradle` and `android/app/capacitor.build.gradle`,
all rewritten by every `cap sync` (a diff there after a build is normal —
commit it when the plugin set changed), plus the `Assets.xcassets` catalog and
the Android `res/` icon and splash sets, regenerated by `pnpm mobile:assets`
from `resources/`. Not tracked, and regenerated by the same sync: the copied
web assets (`ios/App/App/public`, `android/app/src/main/assets/public`) and
`android/capacitor-cordova-android-plugins/`. A checkout that has never run
`pnpm build:mobile` therefore cannot open in Xcode or Gradle — build first.

Three Android-only notes. Its **document origin is `https://localhost`**, iOS's
is `capacitor://localhost`; both are in the dev trust list. Never set a custom
`iosScheme`/`androidScheme` — the scheme *is* the origin, so changing it later
orphans every stored Preference and invalidates the trust list at once. And
Android blocks cleartext HTTP for `targetSdk` 28+ while Capacitor 8's Android
runtime no longer reads `server.cleartext` at all, so a dev build talking to a
local API needs `app/src/debug/res/xml/network_security_config.xml`. It is in
the **debug** source set: release builds get no cleartext exception, which is
stricter than the iOS side's `Info.plist`.

And the **hardware back button takes two presses with the keyboard up**, one
without. Android gives the first press to the IME, which dismisses the
keyboard; the WebView is never told, so `mobile/back-button.ts` is not called
and the open dialog stays open. The second press reaches it and closes it. That
is the platform's ordering and the one users expect — do not import
`@capacitor/keyboard` to collapse it into one press, which would take back away
from the keyboard. A test in `back-button.test.ts` pins that the module never
does.

**Release signing is environment-driven and optional.**
`android/app/build.gradle` builds a `signingConfigs.release` only when
`android/app/release.keystore` exists *and* `KEYSTORE_PASSWORD`, `KEY_ALIAS`
and `KEY_PASSWORD` are all exported; otherwise it logs and produces an
unsigned bundle, so `./gradlew bundleRelease` works on a checkout with no key.
`mobile-release.yml` supplies all four from secrets, refuses a half-configured
set, and runs `jarsigner -verify` on the artifact — CI is where an unsigned AAB
must not pass quietly. Generating the keystore and setting the four secrets is
a manual, one-time step: `docs/deploy.md` → "Android release signing".

`pnpm mobile:assets` also rewrites `ios/App/App.xcodeproj/project.pbxproj`,
stripping the leading zero from `LastSwiftUpdateCheck`/`LastUpgradeCheck`.
Harmless, but `git checkout` it rather than committing the churn.

`Package.swift` hardcodes pnpm's content-addressed store paths
(`node_modules/.pnpm/@capacitor+app@8.1.0_@capacitor+core@8.3.4/...`), and every
Capacitor dependency is declared as a `^8.x` range — so any lockfile refresh
renames those directories and the committed file points at paths that no longer
exist. Run `pnpm build:mobile ios` after any `pnpm install` and before opening
`ios/App` in Xcode directly, or SPM resolution fails on a checkout that has
never built.

**`NEXT_PUBLIC_API_URL` is required and baked in at build time — as the
DEFAULT server.** A person can point the store app at any other Track Your
Time server from the login screen (see "Choosing a server on the phone"
below); the baked value is where a fresh install starts. `scripts/build-mobile.mjs`
refuses to run without it, and afterwards asserts the
literal is really in an emitted chunk — an unset value otherwise ships an app
that resolves every request against `capacitor://localhost`, fails on device and
builds green. It also preflights the toolchain (Xcode selected, a simulator
available, `cap ls` loading the config, every plugin shipping a `Package.swift`,
the native identifiers agreeing with `capacitor.config.ts` and `package.json`)
and warns when nothing is listening on the baked host:port.

**It syncs the platforms this machine can build, not the ones that exist.**
Both native trees are committed, so every checkout has an `android/` whether or
not it has a JDK and an SDK. A platform named on the command line
(`pnpm build:mobile android`) is a demand and a missing toolchain is an error;
an auto-detected one is an offer and a missing toolchain is skipped with a
note. So a Mac with no Android SDK, and the Linux runner with no Xcode, both
run a bare `pnpm build:mobile` without failing on the half they never wanted.

The mobile export has its own directory, `packages/client/out-mobile`, and
`capacitor.config.ts` points `webDir` at it. `out/` is written by the web build,
and Playwright (which bakes a throwaway 127.0.0.1 API
port), and `cap run` syncs implicitly — a shared directory means a test run can
silently be installed as the app. Never run bare `cap sync` / `cap run ios`;
`cap:run:*` and `build:ios:release` go through the script and then `--no-sync`.

**In a worktree**, `pnpm run dev` picks random ports, and a bundle cannot follow
a port that changes per run. Pin them and bake the same value:

```bash
API_PORT=51590 PORT=33920 pnpm run dev        # high ports, no clash with 5159/3392
NEXT_PUBLIC_API_URL=http://localhost:51590 pnpm build:mobile ios
```

A dev server for the checkout owns `packages/client/.next`, which a production
build needs too (with `output: "export"` a custom `distDir` is the *out* dir and
the build dir is forced back to `.next`), so `build:mobile` refuses while one is
live. Stop it, or give dev its own with `INSTANCE_ID=<name> pnpm run dev`.

`capacitor://localhost`, `https://localhost` and `http://10.0.2.2:51740` are
trusted by `scripts/dev.mjs` directly — not via `.env.development`, whose value
dotenvx skips because the dev script already set the key in the server child's
environment. The third one is `pnpm dev:android`'s live-reload origin: under
live reload the WebView loads the Next dev server rather than the bundle, so
the document origin is the dev server's and the API must trust *that*. Only the
default port is listed; `NEXT_PORT=<n>` or a physical device on `LAN_IP` needs
`TRUSTED_ORIGINS=http://<host>:<n> pnpm run dev`, which the script prints.

**Live reload is not the app.** Under `dev:ios` / `dev:android` the document
origin is the dev server's, so neither the real origin nor its place in the
trust list is exercised — verify auth changes against a `pnpm build:mobile`
bundle. Android live reload additionally needs the dev origin in Next's
`allowedDevOrigins` (Next 16 blocks cross-origin `/_next` dev resources);
`scripts/android-dev.sh` exports `NEXT_DEV_ORIGINS`, which `next.config.ts`
merges. Without it the document is served, every chunk is blocked, and the app
sits on a splash that `launchAutoHide: false` never hides.

**Verifying on the emulator without Android Studio.** `pnpm dev:android` boots
one and deploys; for a bundled build the loop is `pnpm build:mobile android`,
then `cd android && ./gradlew :app:assembleDebug`, then `adb install -r
app/build/outputs/apk/debug/app-debug.apk` and `adb shell am start -n
com.trebeljahr.trackyourtime/.MainActivity`. `adb exec-out screencap -p > shot.png`
is the screenshot. Three traps that cost real time:

- A bundled build's origin is `https://localhost`, and a fetch from an https
  document to a plain-http one is blocked as mixed content unless the target is
  a loopback address. So bake `http://localhost:<API_PORT>` and run
  `adb reverse tcp:<API_PORT> tcp:<API_PORT>`; `10.0.2.2` works for live
  reload, where the document is itself http, but not for the bundle.
- `adb shell input text` is split by the *device's* shell, so only the first
  word of "two words" arrives. Use `%s` for spaces.
- The **first** back press with a dialog open is eaten by the IME whenever a
  field is focused (`dumpsys input_method | grep mInputShown` says so), even
  with no on-screen keyboard visible because a hardware keyboard is attached.
  That is Android's own behaviour, not a bug in the overlay stack — press back
  twice, or check `mInputShown` first.

Bridge runs in `packages/client/src/mobile/bridge.ts` — lifecycle, splash,
status bar, orientation.

**What survives an OS kill, and where.** Three separate stores, on purpose:

- The **session token** is in the Keychain (`lib/native-session.ts`). It is a
  credential; Preferences is plain `UserDefaults` and readable from an
  unencrypted backup.
- The **offline queue** and the **running-timer mirror** are in Capacitor
  Preferences (`mobile/preferences-storage.ts`, `lib/running-mirror.ts`). They
  are data, and what matters is that iOS cannot evict them: WKWebView
  classifies `localStorage` as *non-critical web data* and reclaims it after
  low disk or roughly a week of not opening the app. `webStorage()` swallows
  every throw, so that loss would be silent — and what is in the queue is time
  the user tracked that no server has ever seen. The adapter hands over
  anything a pre-Preferences build left in `localStorage`, once, behind a
  marker; without that, changing the address *is* the data loss.
- Everything else (a remembered filter, the theme) stays in `localStorage`,
  where eviction costs nothing.

**Network truth comes from the radio, not the browser.** `navigator.onLine`
reports `true` on a dead radio in WKWebView and never fires for airplane mode,
so `mobile/network.ts` reads `@capacitor/network` on native and feeds one
verdict to `isOnline()`, to `useOfflineQueue`'s subscription and to React
Query's `onlineManager`. Two consequences worth knowing before touching any of
it:

- `isNetworkError()` short-circuits on `isOnline()`, so a wrong verdict decides
  whether a refused mutation is queued for replay or rolled back.
- **The mutations the offline queue owns run in `networkMode: "always"`** —
  and *only* those. React Query otherwise *pauses* a mutation while it believes
  the device is offline: `mutationFn` never runs, `onError` never fires, and
  `onError` is where `use-entry-mutations.ts` queues offline work. With the
  radio's real answer wired in, the default would make start/stop in airplane
  mode do nothing at all. The offline queue is this app's pause mechanism and
  it needs the failure to happen. The option is `OFFLINE_QUEUED_MUTATION` in
  `lib/query-client.ts`, spread into the entry mutations, the timesheet grid's
  writes and the queue's own replay; it is deliberately **not** a
  `defaultOptions.mutations`, which would take pause-and-resume away from the
  forty-odd mutations that queue nothing — on web as much as on the phone —
  and leave them toasting "network error" on a blip where they used to wait.
  Queries keep the default too, where pausing is exactly right.

**The running timer is mirrored, and the mirror is only overwritten by an
answer.** `lib/running-mirror.ts` writes every resolution of
`trpc.entries.current` to Preferences and `MobileBridgeLoader` seeds the timer
store from it at boot. `useRunningEntry` then waits for `query.isSuccess`
before touching the store: on a cold offline launch the query never answers, so
an ungated effect reads `data === undefined` as "nothing is running" and wipes
the seed on the first render — which is exactly the launch the mirror exists
for. A pending or failed read is not a statement about the timer.

**Resume order is load-bearing** (`hooks/use-native-lifecycle.ts`): reconnect,
tick, flush the queue — and refetch `entries.current` *only* when nothing was
queued. Refetching first asks a server that has never heard of the start the
user made with no signal, gets `null`, and blanks the running clock until the
flush lands. The socket is reconnected because the server pings every 10s and
drops on the first missed pong, so it is dead server-side within ~20s of every
backgrounding, while a frozen socket delivers no close event and the client
still says "open".

**The offline queue is mounted in `AppShell`**, not in `TrackerBar`. Everything
that drains it lives inside `useOfflineQueue`, so while it was mounted on
`/app/track` only, reconnecting on any other screen drained nothing — a plain web
bug, and a guaranteed one on a phone, which resumes on whatever screen it was
left on.

**Verifying on the Simulator without Xcode's GUI.** Build, install, launch and
screenshot from a shell:

```bash
UDID=$(xcrun simctl list devices available | grep -m1 "iPhone 17 (" | sed -E "s/.*\(([0-9A-F-]{36})\).*/\1/")
xcrun simctl boot "$UDID"
NEXT_PUBLIC_API_URL=http://localhost:51590 pnpm build:mobile ios
cd ios/App && xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
  -sdk iphonesimulator -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath /tmp/dd build
xcrun simctl install "$UDID" /tmp/dd/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch "$UDID" com.trebeljahr.trackyourtime
xcrun simctl io "$UDID" screenshot --type=png out.png
```

Three traps in that loop, each of which produces a *working-looking* app that
is quietly wrong:

- **Do not pass `CODE_SIGNING_ALLOWED=NO`.** Without the ad-hoc signature
  Xcode applies by default for the simulator SDK, every Keychain call fails
  with `StorageError: An OS error occurred (-34018)`
  (`errSecMissingEntitlement`). The session token is then never stored, the app
  silently falls back to the cookie, and the bearer path looks fine while being
  entirely untested.
- **The Simulator's WKWebView does send cookies to `http://localhost:<port>`**,
  and its cookie store survives `simctl uninstall`. So cookie auth appears to
  work from `capacitor://localhost` and masks a broken bearer path — the same
  trap as `pnpm dev:ios`, one layer down. The tell is on the server: a tRPC
  request from the app must arrive with **no** `Cookie` header at all, because
  `lib/trpc.ts` switches to `credentials: "omit"` the moment a token exists.
  `xcrun simctl erase <udid>` is the only reliable clean slate.
- **Never return a Capacitor plugin handle from an `async` function.** A plugin
  handle is a Proxy that answers every property with a callable, `then`
  included, so the promise machinery adopts it as a thenable and calls
  `Plugin.then(resolve, reject)` — a bridge message for a native method nobody
  implements. It neither resolves nor rejects, and with
  `launchAutoHide: false` the app freezes on the splash with no console to
  read. Wrap the handle in a plain object; `lib/native-session.ts` does, and
  `native-session.test.ts` has the regression.
- **`simctl` alone never shows the software keyboard.** The Simulator counts
  the Mac's keyboard as connected until `Simulator.app` itself has read
  `defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool
  false`, so a headless loop screenshots a focused field with no keyboard under
  it and nothing about the layout is being tested. Write the default, then
  `open -g -a Simulator` once — `-g` opens it in the background; a plain
  `open -a` activates it and takes keyboard focus from the person at the Mac.

**Native chrome lives in `packages/client/src/styles/native.css`**, imported by
one line from `globals.css`. Every selector in it is under `html.cap` — safe-area
padding, 16px fields, `.cap-touch`, the two-row tracker composer, the top-anchored
dialog — so it is inert on web *by construction*, and `e2e/mobile-shell.spec.ts`
(the `phone` Playwright project, `devices["Pixel 5"]`) asserts that at 393pt.
Rules that would also be right on web belong in `globals.css` instead.

`html.cap` is set twice on purpose: by an inline script in `<head>` in
`app/layout.tsx`, before the first paint, and again by `mobile/bridge.ts` after
its dynamic imports resolve. The pre-paint one is what matters on a WebView
reload, which has no splash to hide the unpadded frame.

**The marker is on `<html>`, not `<body>`, and that is a correctness decision,
not a style one.** A pre-paint script that mutates `<body>` makes the served
HTML and the hydrated DOM disagree about body's attributes, and the only way to
silence that is `suppressHydrationWarning` on `<body>` — which then silences
every *other* body-level mismatch, for the web app, forever. `<html>` already
carries the attribute for the theme script, so the second marker rides along for
free and `<body>` keeps its warnings. It is also why the script can sit in
`<head>`: `document.documentElement` exists during head parsing, `document.body`
does not.

**`viewport-fit=cover` ships to every host, web included, and the PWA is the
one that notices.** The `viewport` export is static — one static export serves
the browser, the installed PWA and both native shells — so there is no build in
which the meta tag can be left out for web. In a normal mobile browser it is
harmless (the browser applies no insets), but an installed PWA gets the real
insets with none of `native.css` applying to it, so content runs under the
notch. `styles/standalone.css` is the answer: `@media (display-mode: standalone)`
copies of the header / main / dialog safe-area rules, scoped `html:not(.cap)` so
they can never double up with the native ones. It is a separate file from
`native.css` precisely because it is *not* inert by construction.

Two things that look like ordinary CSS and are not. Tailwind v4's `translate-*`
utilities compile to the `translate` **property**, so the way to undo a
`translate-y-[-50%]` is `--tw-translate-y: 0`, never a `transform` (which stacks
on top of it). And `native.css` is unlayered while Tailwind's utilities are in
`@layer utilities`, so its rules already beat them — no `!important` needed, and
adding one would only hide the fact that the cascade is doing the work.

**The bottom tab bar renders on every platform.** `components/mobile-tab-bar.tsx`
ships in the web bundle too and is `display: none` there — Tailwind's `hidden`,
undone by the one `html.cap` rule in `native.css`. It must not branch on
`isCapacitor()`: under `output: "export"` every page is prerendered in Node, where
`window.Capacitor` cannot exist, so a tree that differs at hydration is a
mismatch React resolves by discarding the served DOM. The same argument applies
to anything else the phone shows and the web does not. Three tabs, and the third
opens the *existing* drawer with the *existing* `NAV_SECTIONS` — there is no
second list of destinations, so a new web screen reaches the phone for free.

**Native handlers are registered with `setMobileHandlers`, never through
`initMobile`.** `initMobile` latches on its first call, and that call is
`MobileBridgeLoader` at the app root — before `AppShell` exists, and on screens
where it never mounts. Handlers passed in afterwards are dropped in silence.
The `backButton` and `appStateChange` listeners are registered unconditionally
and read through a mutable table that `setMobileHandlers` fills from a React
effect; it returns its own teardown, and the teardown clears only the exact
functions it installed.

Adding a `backButton` listener also *overrides* Capacitor's default, so that
callback is the whole behaviour of the button. `event.canGoBack` is not the
signal it looks like: a single-page app accumulates history entries just by
moving between tabs, so it is nearly always true. The order is
`mobile/back-button.ts` — close the top overlay, else go to `/app/track`, else
return `false`, which means exit. Overlays register themselves in
`mobile/overlay-stack.ts`; dialogs do it once in `ui/dialog.tsx` rather than
eleven times, and only when controlled (an uncontrolled dialog has no
`onOpenChange`, so back would swallow the press and do nothing).

### Native client auth

Better-auth uses cookies; native shells need extra CORS/trust origins.
Set `TRUSTED_ORIGINS` on the server (comma-separated):

```
TRUSTED_ORIGINS=capacitor://localhost,https://localhost
```

or `TRUST_STORE_APPS=true`, which adds both of those, the desktop app's
`app://-` and the Chrome Web Store extension's pinned `chrome-extension://` id from
`packages/shared/src/store-clients.ts` — the self-host compose file defaults it
on, so the store clients can sign in to a fresh self-hosted server with no
manual step. For the extension the trust covers every request, not only
sign-in: it has no host permissions, so all of its traffic is CORS. Off unless set, so the hosted deploy's list stays what Coolify
says. `STORE_EXTENSION_ID` is recomputed from `STORE_EXTENSION_KEY` in
`tests/env.test.ts`; rotate both or neither.

Electron serves the app from `app://-` (`electron/src/protocol.ts`), the
origin to trust; `file://` would send `Origin: null`, which can't be trusted
with credentials.

### Choosing a server on the phone

The store app is one build for everybody, so `NEXT_PUBLIC_API_URL` is only its
default. The login screen's picker (`components/server-picker.tsx`, native
only) stores another origin in Capacitor Preferences, and `lib/api-origin.ts`
is the one place that answers "which server". Rules that fail quietly if
broken:

- **The web app never has a choice.** Every export of `lib/api-origin.ts`
  returns the build's origin on web; nothing reads storage, awaits or rewrites a
  URL there. The picker renders nothing on web and nothing on the first client
  render anywhere (`hooks/use-shell.ts` hydrates as `false`), so the
  prerendered login page is identical on both — `server-picker.test.tsx`
  compares the two `renderToString`s.
- **Module-scope clients keep their build-time URL, and each request is
  rebased at send time.** The tRPC link's `fetch` and better-auth's
  `customFetchImpl` both `await whenApiOriginReady()` and `rebaseApiUrl()` on
  native. A client built per server would have to be rebuilt mid-session; a
  request that left before the stored choice was read would go to the wrong
  server with this server's token.
- **The choice is part of the native readiness gate.** `hydrateNativeSession`
  waits for it beside the Keychain token, and `useSync` keys its socket on it.
- **Switching is `lib/server-switch.ts`, in order:** sign out of the OLD server
  while requests still go there, clear the running-timer mirror, keep the
  offline queue, save, reload. Signing out after saving would send the old
  token to the new server and leave the old session alive.
- **Every queued row carries the server it was queued against** (`server` on
  `QueuedMutation`, beside `owner`). The flush, the pending count, adoption,
  `cancelQueuedForTemp` and `discardDeletedAccountQueue` all stay on the current
  server; a row with no stamp belongs to the build's default server, where every
  such row was made. Rows for another server are listed in Settings → Devices,
  grouped per server beside another account's rows, never replayed and never
  deleted without a confirmation. Raycast stamps the same field (claiming
  unstamped rows for its current API URL on first run) and binds its stored
  token to the server that issued it.
- **Validate before saving.** `normalizeServerInput` (sync: a URL, and http
  only on loopback) and `checkServer` (`/api/health` answers, as Track Your
  Time, database up) in `@starter/core/server-origin.ts`. `/api/health` answers
  any origin with `Access-Control-Allow-Origin: *` and reports `originTrusted`,
  so the picker refuses a server that would 403 the sign-in and names the
  setting to change.

### The Capacitor shells do not use cookies

A `capacitor://localhost` document is cross-site to the API whatever SameSite
says, and WKWebView's tracking prevention drops the cookie sooner or later. So
the mobile shells take the same bearer path as Raycast and the extension — but
through the ordinary `/login` form rather than the device flow, because on a
phone the "second, already signed-in browser" a device flow assumes is often
the very thing being replaced.

- `lib/native-session.ts` owns the token: hydrated from the Keychain
  (`@aparajita/capacitor-secure-storage`) at boot, published as a store so
  consumers gate *behaviour* rather than the React tree — under
  `output: "export"` a component that rendered `null` while hydrating would
  disagree with the prerendered HTML.
- `lib/auth-client.ts` reads the token back on every call
  (`fetchOptions.auth`, which omits the header entirely when it returns
  `undefined`) and captures new ones from the `set-auth-token` response header.
  **Only ever store a truthy value**: the bearer plugin emits that header only
  when the response carries a session cookie, so an unconditional write erases
  a good token on the first `/get-session`.
- `lib/trpc.ts` adds `Authorization` and switches to `credentials: "omit"` when
  a token exists. With none — every web request — it is byte-identical to what
  it was, which `lib/trpc.test.ts` asserts rather than assumes.
- The socket takes the token as a **getter**, and `useSync`'s effect is keyed on
  it. The Keychain answers after mount, so a snapshot would open one tokenless
  socket, be refused, and retry that refusal forever — taking the offline
  queue's flush trigger down with it, since that fires on `syncStatus === "open"`.
- A Keychain item **outlives the app** on iOS. A `@capacitor/preferences`
  marker (which does not) is what tells a fresh install from a relaunch, so
  delete-and-reinstall means signed out rather than resuming a previous — possibly
  a previous *user's* — session.
- Session lifetime is **per client kind**, in `auth/session-lifetime.ts`:
  thirty days for a stored-token client (mobile, desktop, Raycast, extension,
  CLI), seven for a browser cookie session. The long window exists because a
  phone left in a drawer over a holiday would otherwise come back to a session
  row the next lookup deletes, and replay a day of offline-tracked time into
  401s; the short one exists because nothing about a browser needs a month, and
  a laptop signed in once and never touched again should not stay signed in
  that long.
  `session.expiresIn` really is a single global number, but it is not the last
  word: `databaseHooks.session.create.before` **and** `.update.before` both get
  to rewrite `expiresAt`, and between them they cover the two places better-auth
  reads the global (row creation, and the refresh in `api/routes/session.mjs`).
  The create hook alone is the trap — a shortened row comes back at the global
  value the first time it is used. The refresh reads the client **stamped on
  the session row**, never the request that triggered it, so a WebSocket
  re-check (whose handshake carries no `x-trackyourtime-client`) cannot demote a
  phone, and a browser cannot promote itself later. The global stays at the
  long value on purpose — the refresh *trigger* is computed against it — and
  `ws/auth.ts` asks with `disableRefresh` so a socket's liveness probe stops
  renewing the session it is only supposed to be checking. All of it is argued
  in the module and run against the real library in
  `tests/session-lifetime-integration.test.ts`.
- An expired or revoked session **stops** the offline flush and keeps the rows
  (`isAuthError` in `lib/offline.ts`). Dropping them is the default for a server
  refusal and is right for a validation error; it is never right for "we do not
  know who you are".
- **Because the rows survive a sign-out, every row records who queued it.**
  `QueuedMutation.owner` is the user id, stamped by `enqueueOffline` and checked
  by the flush filter, so the next account to sign in on the device cannot
  replay the previous one's starts and stops into its own workspace. The field
  is optional and must stay so — `decodeOfflineMutation` reads rows written
  before it existed, and the first account to sign in adopts them
  (`adoptUnowned`). The browser extension solves the same problem by
  **clearing** its queue in `forgetSession()`, which is the right trade there
  and the wrong one here — these rows are the phone's only copy of the time.
- **The stamp cannot come from `useSession()` alone.** `app/app/layout.tsx`
  keeps a phone with a stored token inside the app when the session check
  cannot reach the server (`verdictForRejection`), so the tracker is fully
  usable on a cold offline launch while `useAuth().user` is still null — which
  is the launch the queue exists for. The last owner is therefore remembered
  beside the queue (`OFFLINE_QUEUE_OWNER_STORAGE_KEY`, same store, same
  durability) and used for stamping when the session has not resolved.
  Stamping only: replay reads the live session, because a stamp says who *made*
  a mutation and is never a licence to send it. Sign-out — the one moment the
  device knows it has stopped being that person's — calls
  `sealOfflineQueueOwner()`, which claims whatever is still unowned and then
  forgets the stamp. A `null` session anywhere else means "not resolved yet".
- **A row belonging to somebody else is neither replayed nor deleted**, which
  on its own makes it immortal. The tracker bar counts it (`foreign`) and links
  to Settings → Devices, where `ForeignQueuePanel` lists what the rows are and
  offers the one deliberate way out. No age-based expiry: deleting somebody's
  tracked time on a timer is still deleting it silently.

### Workspaces in the clients

A person can belong to several workspaces, and every first-party client names
the one it means on **every request** (`input.workspaceId`). Each keeps its own
choice — the web app in `lib/active-workspace.ts` (Preferences on the phone),
the extension in `chrome.storage.local` (`lib/workspace-choice.ts`), Raycast in
`LocalStorage` (`lib/workspace.ts`) — and none follows the session's
`activeOrganizationId`. That value is one per session, the extension is often
linked to the web app's sign-in, and a switch in one client must never retarget
a timer started from another. The extension and Raycast never call
`workspaces.setActive`. The rules shared by all three (how a stored id
resolves, which socket events concern the screen, whose entries a total
counts, the stored record's shape) are `workspace-context.ts` in core.

What fails quietly if it is changed:

- **A queued row is stamped with its workspace, and the replay sends the
  stamp.** `QueuedMutation.workspaceId` is optional forever (legacy rows are
  adopted by the first resolved workspace). The api client's `workspaceId`
  getter and the web tRPC link only fill a gap, so a row queued in A replays
  into A after a switch to B.
- **A row for a workspace the person left is held**: never replayed, never
  dropped, counted with the foreign rows and named with a deliberate discard.
  Every flush first asks `workspaces.list`, and sends nothing without an
  answer — the server refuses such a row with NOT_FOUND, which is a permanent
  rejection the flush would otherwise drop. Held rows are excluded from the
  "is something ahead of a new mutation" count, or every future start would
  queue behind a row that never drains.
- **The stamp is read once per write.** The request and the queued row name
  the same workspace: the extension pins it with `addressedWrite()`, Raycast
  stamps with the api client's own value, the web tracker and timesheet
  capture it before their first await. Reading it again when a hung request
  finally fails stamps the row with whatever was switched to meanwhile.
- **A NOT_FOUND on a stamped row asks again before dropping.** The
  membership list is only as fresh as the start of the flush; a removal
  landing during it reads exactly like "entry gone". The row is kept unless
  the workspace is confirmed (`refusalKeepsRow` in core), and the re-ask never
  goes through anything that touches the queue the flush is holding.
- **Only UNAUTHORIZED halts a flush.** FORBIDDEN is a per-row permanent
  refusal (`PERMANENT_REJECTIONS` includes 403): in a shared workspace it is a
  role change refusing one row, not a lost session. A status is only a verdict
  when tRPC gave it — a `PARSE_ERROR` body (a WAF page, a proxy's HTML 404) is
  never permanent.
- **A write that settles after a switch leaves the cache alone.** React Query
  keys do not carry the workspace, so its answer or its rollback snapshot
  would land in the new workspace's screens (`stillInWorkspace` in the
  tracker, `stillHere` in the timesheet).
- **Anything cached is keyed by workspace.** The web app clears the React
  Query cache on a switch; the extension drops its per-workspace caches;
  Raycast keys its read cache, overlay and every `useApi` slot by workspace and
  tags loaded data with the workspace it was fetched for, because
  `useCachedPromise` keeps the previous key's data across a key change.
- **The running timer is the person's.** Another workspace's timer events
  still move it (`syncEventReach` → `"timer"`); nothing else of that workspace
  reaches the screen. A colleague's timer event never becomes the extension
  badge, and every personal total (extension Today, Raycast menu bar, Continue,
  Show All Time) counts only the signed-in person's entries — an unknown user
  owns nothing.

### Clients without a cookie jar (Raycast, CLI, extensions)

There are no API tokens to mint or paste. Every client signs in normally
and keeps the resulting better-auth **session token**, which it sends as
`Authorization: Bearer <token>` (and as the `bearer.<token>` WebSocket
subprotocol). Server side this is the `bearer` plugin in `auth/auth.ts` —
by the time `getSession()` runs, a token client and a cookie client are
indistinguishable, so there is exactly one auth path to reason about.

Use the helpers in `@starter/core` (`session-auth.ts`):

```ts
// Client shows its own sign-in form (browser extension popup):
const { token } = await signInWithPassword(
  { baseUrl, clientId: "trackyourtime-extension" },
  { email, password },
);

// Client cannot show a form (Raycast, CLI), or the account has two-factor
// on (the extension's "Sign in with the web app") — RFC 8628 device flow:
const auth = await startDeviceAuthorization({ baseUrl, clientId: "trackyourtime-raycast" });
// show auth.userCode, open auth.verificationUriComplete
const { token } = await pollForDeviceSession(
  { baseUrl, clientId: "trackyourtime-raycast" },
  auth.deviceCode,
  { intervalSeconds: auth.intervalSeconds },
);
```

The browser extension uses both: the popup's password form, and the device
flow — started by "Sign in with the web app" in the popup, or by the web app
itself through the bridge (see "Web app ↔ extension bridge"). A single
exchange attempt is `requestDeviceToken`, which `pollForDeviceSession` loops
over; the extension needs the single attempt because Chrome stops an idle
service worker in the middle of a long poll.

A client that runs **in a browser** must have its **origin in
`TRUSTED_ORIGINS`**, or sign-in answers `403 INVALID_ORIGIN` before the password
is checked: better-auth force-validates `Origin` whenever a request carries
`Sec-Fetch-*` headers, which every real browser fetch does (curl does not —
which makes curl a misleading way to test this). For the extension it is more
than sign-in: it has no host permissions, so every request it makes — tRPC,
REST, auth — is an ordinary CORS request, and an untrusted origin is refused
by the browser on all of them. An unpacked extension's id
comes from the absolute path it was loaded from; `pnpm run dev` derives it and
trusts it automatically, and `pnpm run extension:id` prints it for any other
server.

Raycast and CLIs need **no origin at all**, and have none to give: their `fetch`
sends neither `Origin` nor `Sec-Fetch-*`, and better-auth's `validateOrigin`
returns early unless the request carries cookies or those headers. What guards
them instead is the device flow — a code the user approves in an already
signed-in browser — plus the client-id allowlist in `auth/client-label.ts` and
per-session revocation in Settings → Devices.

Store that token in real secret storage (Keychain, `chrome.storage.session`,
the Raycast password store), never a plain config file. Clients send
`x-trackyourtime-client` so their session is named in Settings → Devices, where
any of them can be signed out. Device-flow client ids are allowlisted in
`auth/client-label.ts`.

**A socket's room comes from its session and nothing else.** `ws/handler.ts`
places every socket in `user:<its authenticated user id>` at the upgrade, and
`RoomManager.join` takes a user id rather than a room name, so there is no API
through which client input could choose a room. The starter's `?roomId=` and
`join-room` message let any signed-in user subscribe to anybody's sync events;
both are gone, along with the rest of the room/chat protocol. The socket is a
one-way feed: every client frame is ignored, and never answered with a close,
because a close would put an older build into a reconnect loop.
`ws-room-authorization.test.ts` pins both spoofs over a real handshake.

Revocation has to reach the socket, not just HTTP. `ws/handler.ts`
authenticates at the upgrade, and a phone then holds that socket open for
days — so the session behind every live socket is re-checked once a minute
(`ws/session-watch.ts`), and one that no longer exists is dropped out of its
room and closed with code 4401. Two things there are load-bearing: the
re-check passes `disableCookieCache`, or a revoked web session keeps
answering out of the five-minute cookie cache; and a lookup that *throws* is
"unknown", never "revoked", because one bad database minute must not sign
every connected device out. A timer rather than a revoke event, because
expiry and a row deleted straight out of the database are revocations too,
and no event is published for either.

The client half is in `@starter/core`'s sync client and is the reason 4401 is
a number and not a comment: `SESSION_REVOKED_CLOSE_CODE` lives in
`@starter/shared`, so the end that writes it and the ends that read it cannot
drift. On that code the client stops reconnecting — permanently, for that
client instance — instead of entering backoff, because the credential it was
built with will never be accepted again and the alternative is a reconnect
loop behind a sync dot that never settles. Hosts recover by *building a new
client* when their session changes (`useSync` is keyed on the token, the
extension's `reload()` rebuilds its runtime, a Raycast command is a fresh
process), so nothing has to un-latch one. Clearing the credential is the
host's job — Keychain, `chrome.storage`, Raycast's store — and
`onSessionRevoked` is how it is asked; the web app wires that to
`lib/revoke-this-device.ts`, which signs out, forgets the Keychain token,
tells the user and lands them on /login.

Only the *session* is discarded. The offline queue is kept: those rows are
time the server has never seen, and "this device's access was revoked" is no
verdict on it — the same rule `isAuthError` already follows mid-flush. The
count of unsent changes is shown on the login screen rather than left for the
user to discover, since keeping them silently and dropping them silently look
identical from the outside.

### Two-factor authentication and account controls

better-auth's `twoFactor` plugin (TOTP + ten encrypted, single-use backup
codes), change password, change email and the Google button. The server
pieces live in `auth/account-security.ts` and are run against the real library
in `tests/two-factor-integration.test.ts`; the web surfaces are the second step
in `app/login/page.tsx` (`components/two-factor-challenge.tsx`) and the rows in
Settings → Account (`settings/two-factor.tsx`, `settings/account-credentials.tsx`).

Five rules, each of which fails quietly if broken:

- **`twoFactorPlugin()` is registered before `bearer()`.** After-hooks run in
  registration order. Password sign-in creates a session that the two-factor
  hook deletes again; with bearer first, `set-auth-token` is emitted for that
  deleted session and a token client stores a credential that answers 401
  everywhere. The integration test reads `auth.ts` to pin the order.
- **The challenge is a signed cookie, and nothing else completes it.** Spike
  result for the native follow-up: `/two-factor/verify-*` reads only
  `better-auth.two_factor`; the sign-in body is `{ twoFactorRedirect,
  twoFactorMethods }` with no challenge in it. A WKWebView or extension `fetch`
  can neither read `set-cookie` nor send `Cookie`, so bearer-only completion is
  impossible with this configuration — forwarding the cookie by hand works
  (the test does), so the follow-up needs a header carrying the challenge (an
  after-hook copying it out, a before-hook turning it back into the cookie),
  not a different flow. Until then `/login` on a native shell shows
  `NATIVE_TWO_FACTOR_UNSUPPORTED` and `signInWithPassword` in core throws
  `TWO_FACTOR_UNSUPPORTED`. The device flow is unaffected: its approval happens
  in a browser that already passed the second factor. That is why the
  extension popup answers `TWO_FACTOR_UNSUPPORTED` by pointing at "Sign in
  with the web app", and why a 2FA account signed in on the web app links the
  extension through the bridge without any second step.
- **Email verification is required only when `isEmailDeliveryConfigured()`.**
  A self-host with no transport would otherwise lock every new account out.
  `sendVerificationEmail` belongs in the `emailVerification` block — under
  `emailAndPassword` better-auth never calls it. Accounts created before mail
  was configured are marked verified by `scripts/backfill-email-verified.ts`
  (idempotent, `--before <cutoff>`); `docs/deploy.md` says when to run it.
  `autoSignInAfterVerification` stays off: a mailed link is not a second factor.
- **The Google button renders in every build and decides after mount**
  (`components/google-sign-in-button.tsx`): disabled in the prerendered HTML,
  enabled only on the web app when `health.check` reports
  `authConfig.googleEnabled`, and disabled with a note in Capacitor and Electron,
  where the OAuth redirect cannot return to the shell's origin.
- **Some of these calls replace the caller's own session, and its socket
  still holds the old one.** better-auth's `changePassword` with
  `revokeOtherSessions`, and switching two-factor on (the first verify) or
  off, each create a new session and delete the current one. The server's
  re-check then closes this device's socket with 4401, and the app used to
  sign itself out — every tab of the browser, since they share the new cookie.
  Two answers, both needed: the password row calls `changePassword` without
  the flag and then `/revoke-other-sessions`, which keeps the current session
  (the `hooks.after` sweep runs before the response, so a rotated cookie would
  lose that race); and `lib/session-revoked.ts` asks `getSession` (no cookie
  cache) before signing out, and on a live session rebuilds the sync client
  instead. A native shell must keep storing only a truthy `set-auth-token` —
  the two-factor toggles hand it a fresh one.

Callback URLs in mail and OAuth are built with `webCallbackUrl()` from
`lib/auth-client.ts`: the API is a different origin, and a relative
`callbackURL` would land on the API's 404. **Never pass `callbackURL` to
`signIn.email`**: the response then carries `{ url, redirect: true }` and
better-auth's client reloads the browser onto it, so the page never navigates
to `/app/track` and the session looks lost. That is why `sendOnSignIn` is off and
`/login` requests the verification link itself on `EMAIL_NOT_VERIFIED`.

### Account deletion

Settings → Account → Delete account is better-auth's own `POST
/api/auth/delete-user`, not a tRPC procedure. better-auth resolves the session
with the cookie cache off, accepts the bearer token (so the mobile shells use
the same path), verifies the password and removes the user, accounts and
every session. trackyourtime's data goes in `beforeDelete`
(`auth/account-deletion.ts` → `services/account-deletion/`).

What is deleted:

- **A workspace the person is alone in**, with everything scoped to it:
  entries, catalog, favorites, invoices, import batches, API tokens, webhooks
  and their deliveries, workspace settings, the business profile, invitations,
  the organization and both membership records.
- **In a workspace other people use**, only the person's own rows: entries
  they authored that are NOT on an invoice, favorites, API tokens, webhooks
  they created (with deliveries), imports they ran, invitations they sent, and
  both membership records. The catalog, invoices, invoiced entries,
  workspace settings and the business profile stay with the workspace.
- **Everywhere**: user preferences, profile, device-flow codes, the two-factor
  secret and backup codes, and pending invitations addressed to the email.

Five rules, each of which fails quietly if broken:

- **A shared workspace always keeps an owner.** The plan names who owns it
  afterwards — an existing owner, else the longest-standing admin, else the
  longest-standing member — and `ensureOwner` writes that into BOTH the app's
  `WorkspaceMember` and better-auth's `member`. Naming an owner even when no
  promotion is needed is what lets a retry finish a promotion a crash cut in
  half.
- **The cascade is idempotent, and membership rows go last.** Every step is a
  delete or update by filter; the rows that locate a workspace are removed
  after everything in it. A failure in `beforeDelete` stops better-auth
  before it deletes the user, so the person simply tries again.
  `account-deletion.test.ts` fails the run at every write in turn and checks
  that a retry converges.
- **Membership is read from both records.** The app mirror and better-auth's
  `member` can disagree after a crash; reading only one would call a shared
  workspace solo and delete colleagues' work.
- **A password account must send its password.** better-auth alone would
  delete on a session under 24 hours old, and a browser session lasts seven
  days. User hooks run before the bearer plugin, so the hook cannot see the
  account; it records "password sent" per `Request` and `beforeDelete` reads
  it back. An account with no password keeps better-auth's fresh-session rule.
  The refusal code is `ACCOUNT_DELETION_PASSWORD_REQUIRED` in `@starter/shared`.
- **`afterDelete` runs the cascade again**, then sweeps sockets. A request from
  another device can recreate a personal workspace between the first pass and
  the user row going; the second pass removes it, and the sweep closes every
  socket at once instead of on the next minute's re-check.

On the device, `deleteAccount` in `lib/auth-client.ts` acts only on a success:
`discardDeletedAccountQueue` drops the deleted account's queued rows AND the
unowned ones (the reverse of sign-out, which keeps them — a deleted account can
never send them, and they must not replay under the next account), clears the
running-timer mirror and the Keychain token. Rows another account queued stay.

### Workspaces, members and invitations

Membership changes only through tRPC — `workspaces`, `members` and
`invitations`, one line each over `services/membership/`. better-auth's
organization plugin stays installed for its tables (`organization`, `member`,
`invitation`, the session's `activeOrganizationId`) and for the server-side
`auth.api.createOrganization` the signup hook calls, but **every
`/api/auth/organization/*` request that arrives over HTTP answers 404**
(`organization-lockdown.ts`, wired as the instance's one `hooks.before`). Its
endpoints write only `member`, never `WorkspaceMember`, accept `"admin,owner"`
as a role, and refuse with 403/400 — each one was a way around the rules below.
`tests/organization-http-lockdown.test.ts` hits all of them against the real
library. `disableOrganizationDeletion` is on even server-side.

Six rules, each of which fails quietly if broken:

- **The mirror grants access; it is written last and deleted first.** The app
  authorizes from `WorkspaceMember` alone (workspace middleware, API tokens,
  webhook deliveries, sync fan-out). So add writes `member` then the mirror,
  remove deletes the mirror, stops that person's running entry *in that
  workspace only*, then deletes `member`. A crash in between always leaves less
  access, and re-running the operation finishes it. Remove and leave keep the
  person's entries — `memberDepartureSteps` deletes them and is for account
  deletion only.
- **Never zero owners.** Transfer promotes the target in both records first,
  then demotes the previous owner — `member` before the mirror, so the person
  who retries a half-finished transfer is still an owner. The last owner cannot
  leave, be demoted or removed while anybody else remains; the only member
  cannot leave at all. `membership-lifecycle.test.ts` fails every write in turn.
- **Roles are exactly `owner|admin|member`; flags follow the role.** An owner's
  two visibility flags are forced on; everybody else, invited admins included,
  starts closed; a role change never grants a flag except to an owner. Owner is
  reachable only by transfer — never by invitation or `updateRole`. A stored
  unrecognised role reads as `member`.
- **Foreign ids are NOT_FOUND before any permission is consulted.** Every
  member/invitation lookup carries `ctx.workspaceId`; only a real row of the
  caller's own workspace can earn FORBIDDEN, whose message is a stable code from
  `MEMBERSHIP_REFUSALS` in `@starter/shared`. The matrix is in
  `permissions.ts` and `members-permissions.test.ts`.
- **Accepting an invitation needs the invited email, not a verified one.**
  The proof is possession of the id — 96 CSPRNG bits (never an adapter
  ObjectId, which is guessable), delivered to that inbox, or handed over by the
  inviter from the link the UI shows when no mail transport is configured.
  Requiring verification would make invitations unusable on exactly the
  self-hosted instances with no mail to verify with. The email match
  (case-insensitive) is what stops a forwarded link from being accepted under
  somebody else's account, and it is checked before the status, so a wrong
  account learns nothing about whether the link is live. The link is
  `${FRONTEND_URL}/invite/?id=<id>` — a query parameter, because the static
  export cannot serve `/invite/<id>`.
- **An explicit `workspaceId` never falls back; a stale session default does.**
  A request naming a workspace the caller is not in is NOT_FOUND — the offline
  queue relies on a replayed row never landing in another workspace. A session
  whose `activeOrganizationId` points at a workspace the person left falls back
  to their oldest membership. `workspaces.setActive` writes the session row,
  which the five-minute cookie cache can hide for that long; first-party
  clients therefore send `workspaceId` explicitly, and every
  `workspaceProcedure` must take an object input that allows it
  (`workspace-resolution.test.ts` walks the router).

Invitations are rows in better-auth's `invitation` collection with the
plugin's field names, so account deletion's invitation cleanup covers them. A
re-invite of a pending address refreshes and re-sends the same row; a workspace
holds at most 50 pending, and an inviter sends at most 20 per hour (Redis when
present, per process otherwise). The email goes through
`sendWorkspaceInvitationEmail` with both names escaped after translation;
with no transport, or a failed send, the invitation is kept, the URL is logged
and `emailSent: false` tells the inviter to share the link.

`entries.start` and `entries.continue` answer `replaced` when the start
stopped a timer running in a different workspace — one running timer per
person is the invariant, and nothing in workspace B shows A's timer ending.
REST's start is confined to its token's workspace and is unchanged.
Every lifecycle write publishes `membership.changed` to the workspace, and to
the removed, leaving or accepting person directly, since the workspace fan-out
no longer (or does not yet) reaches them.

### Members screen, invite page and `?next=`

The web half of the above: `/app/members` (`components/members/`), the public
`/invite/?id=` page (`components/invite/`) and Settings → Workspace. Four rules
that fail quietly if broken:

- **`/invite` lives outside `/app/` and reads a query parameter.** Under
  the protected layout a signed-out invitee is bounced to /login before the
  page can say whose workspace it is; a `/invite/[id]` segment 404s under
  `output: "export"`. `app/invite/route-shape.test.ts` pins both.
- **`?next=` goes through `lib/safe-next.ts` and nothing else.** Login, signup
  and the protected layout's redirect all use it. It accepts only a single-`/`
  path with no backslash, whitespace or control character, still on this
  origin after URL parsing, under an allowlisted prefix (`/invite`, `/app/device`,
  `/app/track`, `/app/members`, `/app/settings`). The login page is the one everybody
  trusts, which makes an unvalidated `next` a phishing redirect. It is also
  what keeps `/app/device/?user_code=` through sign-in. Never put the email in a
  verification `callbackURL`: the link already knows the address.
- **Joining or leaving a workspace is a full page load** (`enterWorkspace`):
  store the choice with `chooseWorkspaceForNextLoad` (Preferences on the
  native shells, so never `localStorage` directly), then
  `window.location.assign`. A client-side route change keeps every cached
  query, the socket and the timer mirror built for the previous workspace's
  permissions. The screens' own workspace (`useActiveWorkspace` in
  `components/members/`) is the switcher's active id, not the session default —
  otherwise Members would manage one workspace while requests address another.
- **The tracker, runaway guard and calendar show only the viewer's own
  entries** (`components/tracker/own-entries.ts`). `entries.list` returns the
  whole workspace to somebody with time visibility, and those screens would
  draw edit controls and runaway prompts for colleagues' rows. Colleagues'
  time belongs in Reports. The nav's `requires` field (Invoices hidden without
  `permissions.invoices`) is cosmetic; the server refuses either way.

The screens call tRPC only — never `authClient.organization.*`, whose HTTP
endpoints answer 404. `use-sync.ts` already refetches everything on
`membership.changed`, so the screens add no subscription of their own.

### Catalog shape

There is one hierarchy, and it is two levels deep: Client → Project. Tasks and
tags sit beside it, not under it.

A **task** is a workspace-wide name for a kind of work — "Design review",
"Invoicing" — and an entry carries a task and a project as two independent
references. Any combination is legal: both, either, neither. Nothing anywhere
infers one from the other, and deleting a project detaches its entries without
touching a single task. Folding tasks under projects meant re-creating
"Design review" once per project and made every cross-project question about
what the work WAS unanswerable.

Three places this used to leak, each of which now deliberately does nothing:

- `entries.start/create/update` validate `projectId` and `taskId`
  independently. There is no "task does not belong to the given project".
- `withProject` in `@starter/core` leaves the task alone. Changing a project
  used to clear the task in the same write.
- `cascadeDeleteProject` deletes no tasks. `CatalogRemoveResult.tasksDeleted`
  survives only for an import undo, which does delete the tasks it created.

Task documents written before this may still carry a stray `projectId`; the
strict mongoose schema drops it on read, so there is nothing to backfill. Task
names are unique per workspace rather than per project, which existing
duplicates across projects are grandfathered past — they only block a new
create or rename.

### Project billing and booked time

The Projects table edits a project's billable default and rate in one cell
(`project-billing-cell.tsx`), which shows the workspace default rate when the
project has none. Entries snapshot flag and rate when saved, so a change reaches
new time only — unless the person accepts the prompt in
`apply-to-entries-prompt.tsx`, which the project dialog uses too. Accepting sends
`applyToEntries` to `projects.update`; `services/catalog/project-entry-billing.ts`
does the rewrite. Three limits, each an existing rule:

- **Invoiced entries are skipped**, and counted on screen. `billable` is an
  invoice-relevant field.
- **Only the caller's own entries.** Entry editing is author-only.
- **Each entry's flag moves only when the project default did.** A rate change
  alone reprices billable entries and leaves a hand-set non-billable one alone.

`applyToEntries` lives on `updateProjectWithEntriesSchema`, never on
`updateProjectSchema`: REST validates with the latter and publishes it as
OpenAPI, and a bulk rewrite of history is not part of the public API.

### Colleagues' time and money

A `WorkspaceMember` carries `canViewOthersTime` and `canViewOthersMoney`, and
every surface that serves another person's work answers both, server-side.
The helpers are in `@starter/shared/visibility.ts`; the rule is REST's:
projected where that is honest, refused where it is not, never recomputed.

- **The sync socket is per recipient.** `publishSync` (`ws/sync.ts`) reads the
  memberships fresh on every publish and runs `projectSyncEventFor` per member:
  an entry event reaches the author unchanged, a member without time NOT AT
  ALL, a member without money with `hourlyRate` stripped. `entry.deleted` and
  `data.imported` carry no author, so their call sites pass
  `audience: { authorId }`; a call without one reaches only members who see
  everybody's time. `invoice.changed` reaches only `canUseInvoices`. A new kind
  that carries an entry must be added to the switch — unknown kinds pass
  through. Every `tt:sync` envelope from it carries `workspaceId`.
- **Money in a withheld slot is `null`, never `0`.** `DetailedEntry.amount`,
  report group amounts and totals are `number | null`; zero is what unbillable
  time earns. `entries.list`/`get` project colleagues' rows with
  `projectDetailedEntry` in the service, so every client inherits it.
- **Reports withhold every amount, not a partial sum**, when
  `reportMoneyVisible` is false (time on, money off) and say so with
  `moneyVisible: false` — the caller's own groups and detailed rows included
  (the entry list keeps own rates; a report is one document). CSV drops the money
  COLUMNS and PDF drops the money columns and stats; a blank column sums to
  zero in a spreadsheet. REST keeps refusing that visibility with 403.
- **`memberIds` is intersected with the author scope** as two separate `$and`
  conditions (`pushAuthorConditions`). Folding them into one `$in` is how a
  filter widens a scope; a closed member naming a colleague gets an empty
  report, not an error. `groupBy: "member"` labels only authors of matched rows
  (live `user` name, then the membership mirror, then "Former member").
- **Budget progress needs both flags** (`canSeeBudgetProgress`), decided in
  `aggregateProjects` before the whole-workspace entry read. A future budget
  alert must ask it per RECIPIENT.
- **Invoices need owner/admin plus both flags** (`canUseInvoices`), asked before
  any query: `list` answers `[]`, anything by id answers NOT_FOUND (FORBIDDEN
  would confirm the id), `preview`/`create` answer FORBIDDEN
  `invoice-permission-required`. Workspace exports omit invoices by the same
  rule.

The tests drive the real routers against an in-memory copy of a shared
workspace (`tests/support/shared-workspace.ts`), which evaluates each
resolver's actual filter rather than returning canned rows.

### Tags

Tags are the other catalog dimension outside the client/project hierarchy:
many per entry rather than one, so "invoicing" or "deep work" can be reported
on across every project. Entries carry `tagIds: string[]`.

Three rules that fail quietly if broken:

- **`TimeEntry.tagIds` is never `required`.** Entries written before tags
  existed have no such field, and a required array would fail validation on
  each of them the next time it was saved. (Same trap as
  `TimeEntry.description`, and as `createdBy` on the catalog models.)
- **Deleting a tag `$pull`s it off every entry** — never `$set: []` and never
  `$unset`, either of which takes that entry's *other* tags with it.
- **Tags ride alongside `QuickStart`, never inside `quickStartKey`.** Folding
  them into the key would split one recurring combination into a recent per
  set of labels, so a favorite tagged differently one day fragments the
  recents list. Quick starts therefore open untagged.

`reports.summary` with `groupBy: "tag"` gives an entry's **full** duration to
each of its tags, so the group rows deliberately sum to more than the range
total. Splitting the duration evenly would invent time nobody spent. The
overlap is real, so the table states it on screen rather than showing a
breakdown that cannot reconcile; the report's own totals stay single-counted.

Every client can set tags. The offline payload types in `@starter/core`
(`OfflineStartInput` and friends) carry an optional `tagIds`, so a tag applied
offline survives the replay from the web app, the extension or Raycast alike.
Optional, because a row queued by a build that predates tags must still decode
and replay: the server reads an absent list as "no tags" on start/create and
as "leave them alone" on update.

### Import and export

`data.analyze` / `data.commit` bring a tracked history in from a file, and
`data.exportJson` / `data.exportCsv` take a whole workspace out. Parsing lives
in `packages/server/src/services/import/` and is pure, so it is unit-tested
without a database.

Four rules, each of which fails silently if broken:

- **Column shapes, not vendors.** Headers are matched to roles by an alias
  table (`columns.ts`), and the values decide the granularity: a `Start`
  holding `2026-08-21 09:00` is a `start`, one holding `09:00` is a
  `startTime` needing a `date` beside it. Nothing anywhere names a product.
- **`analyze` and `commit` take the same input and run the same parser.** The
  preview is a description, never a token — the commit re-reads the file
  instead of trusting rows handed back to it, so a tampered preview cannot
  make it write something the user never approved.
- **Day/month order is decided per file, then stated on screen.** `03/04` is
  valid either way round, and a wrong guess moves entries by months without
  ever erroring. Any value over 12 settles it; when nothing does, the preview
  says so and the user picks (`dateOrder`).
- **Every import is a batch.** Entries carry `importId`, so undo is one
  indexed delete; the batch document lists only the catalog it created, which
  is deleted on undo only when nothing else has come to use it. A batch whose
  entries are on an invoice refuses to undo.

Files with a date and a number of hours but no clock time (`date-duration`)
get their entries stacked back-to-back from `IMPORT_DAY_START_HOUR`, in file
order, per day. The times of day are invented — the day totals are not — and
the preview says so rather than letting it pass for recorded fact.

**Moving between servers** (Settings → Data → Move to another server,
`components/data/move-server-panel.tsx` over `lib/server-move.ts`) is this same
export and import, driven from one device holding a session on both servers —
no new server capability, so it works hosted → self-hosted and back. Four
rules:

- **Direct only when the target trusts the caller's origin** (`originTrusted`
  from its `/api/health`). A web app on another domain is refused by the
  browser, so the dialog falls back to downloading the parts and importing them
  on the target's own Settings → Data, where `Restore workspace settings` and
  `Restore pinned quick starts` default on for an empty workspace.
- **Parts, never truncation.** One import takes `MAX_IMPORT_ROWS` rows in
  `MAX_IMPORT_BYTES`; `planMoveParts` splits the history by start date until
  each part fits both, and refuses a single day that cannot.
- **Settings are restored only with the first part and only into an empty
  workspace**; pins only with the first part.
- **"Complete" is arithmetic, not optimism**: created + already-there must equal
  exported. A part the target answers "Nothing to import" for counts as already
  there, which is what makes re-running a stopped move finish it.

The CSV export is written in the exact column shape the importer recognises,
so a spreadsheet round trip is supported rather than lucky. The JSON export is
the lossless one (colors, archived catalog rows, project rates, client
billing details, the business profile) and references the catalog **by name**,
so it can be imported into a different workspace or into an empty one after
the database it came from is gone.

### Invoice issuer and recipient

An invoice names two parties. The **business profile** (`BusinessProfile`,
one per workspace, every field optional) is the issuer: legal name, address,
tax id, contact, payment details, payment terms, footer. **`Client.billing`**
(optional subdocument) is the recipient: legal name, address, tax id, email,
the customer's reference. `@starter/shared/business-identity` owns the one
rule for both — blank is `null`, never `""` — and the snapshot helpers.

Four rules, each of which fails quietly if broken:

- **Both parties are frozen at `invoices.create`** (`Invoice.issuer`,
  `Invoice.recipient`) and never re-read: the PDF renders from the invoice
  alone, so fixing an address later cannot rewrite a document a customer
  holds. Neither subdocument has a default, for the reason `Invoice.locale`
  has none. An invoice without them prints the client name as "Billed to".
- **`Client.billing` is never `required` and has no default.** A client row
  from before it validates, saves and exports untouched; the wire reads it as
  `null`. `clients.update` merges the input over the stored subdocument (a key
  left out keeps its value, `null` clears it; `billing: null` clears it all),
  and an all-blank one is stored as `null`. `settings.updateBusinessProfile`
  merges the same way.
- **The profile is read like money.** `settings.businessProfile` answers owner,
  admin or a member with `canViewOthersMoney`; `settings.updateBusinessProfile`
  is owner/admin. A redacted export drops the profile and the invoice parties
  whole (they carry payment details); a client's billing address is catalog and
  stays. An import restores the profile only with `restoreSettings`, under the
  same owner/admin check, and client billing only onto clients it creates.
- **The PDF's words come from the `invoice` server catalog** in the invoice's
  snapshotted language; payment terms print as "payable within N days, by
  <due date>", where the date is the invoice's own `dueDate` — the create
  dialog only *suggests* it from the terms (`dueDateFromTerms`).

The e-invoice fields (VAT ID, tax number, bank, electronic address, default
VAT, …) are more keys on these same two parties and snapshots; their rules are
in "E-invoices (ZUGFeRD / XRechnung)" below.

### Background jobs (scheduler)

`services/scheduler/` runs recurring jobs inside the server process. One
`ScheduledJob` row per job name is shared by every process on the database; a
job runs only after an atomic `findOneAndUpdate` claims it, so several
replicas run each job once per interval. It polls every 30s, starts from
`index.ts` after the DB connects, and is gated by `SCHEDULER_ENABLED` (on by
default). Later jobs register with `registerRecurringJob(name, intervalMs,
handler)`. The webhook sweeper keeps its own loop.

```bash
TEST_MONGODB_URI=mongodb://127.0.0.1:<port> pnpm --filter @starter/server test
```

The database-backed unit tests (`scheduler-lease`, `runaway-reminder`) skip
without `TEST_MONGODB_URI`, and each connects to a throwaway database of its
own (`tests/support/test-database.ts`). CI sets it.

Four rules, each of which fails quietly if broken:

- **The claim moves `nextRunAt` forward, not the release.** That is what makes
  it once per interval rather than once per free moment. `lockedUntil` only
  keeps a run slower than its interval from starting beside itself; a process
  that dies mid-run loses that run and frees the job when the lease lapses.
- **Release filters on `lockedBy`.** A process whose lease lapsed and was taken
  over must not clear the new holder's lease on its way out.
- **`runaway-reminder` (every 5 min) calls `enforceMaxEntryDuration` and nothing
  else to enforce**, per person with a timer running. The lazy call sites in
  `entries/timer.ts` and `ws/handler.ts` stay as the fallback, and both are
  idempotent against the job: a cap needs `end: null`, a flag needs
  `runaway: null`. Never add a second enforcement path.
- **One reminder email per entry, keyed on `TimeEntry.reminderSentAt`,**
  claimed atomically BEFORE sending and given back if the send throws. Sent for
  an unanswered `ask` flag, or past 8h with the guard off. The notifications
  toggle (`Profile.preferences.notifications`) suppresses the email only,
  never the cap or stop. With no transport the reminder is logged and still
  claimed, so the log gets one line per timer, not one per poll.
  `reminderSentAt` has no default and is never required, so old rows validate.

### Migrations and indexes at boot

`index.ts` runs `db/prepare.ts` right after `connectToDB()` and before
anything else: `services/migrations/` (records in `schema_migrations`, lock in
`app_meta`), then `db/indexes.ts`. `SCHEMA_VERSION` is the id of the last entry
in `services/migrations/registry.ts`. `admin migrate --status|--dry-run` and
`doctor` read the same state. User docs: `docs/self-hosting.md` → Migrations.

Five rules, each of which fails quietly if broken:

- **Migrations are append-only, 1…n, idempotent and on the raw driver.** A
  process can die between `up` and the record, and a lease can lapse mid-run;
  both re-run `up`. Today's mongoose models are not what an old database needs.
- **`minReaderSchema` stays low unless older code would misread the result.**
  Raising it makes every older build refuse to start on that database, which
  is the point for a breaking change and an outage for an additive one.
- **The readable check runs before the lock.** A too-old build must exit
  without touching the database or waiting on a newer build's lock.
- **Never `syncIndexes()`.** It drops indexes a newer release added. A failed
  index in `CRITICAL_INDEXES` stops the boot; every other failure warns. A new
  model goes in `models/registry.ts`, or neither the boot nor `doctor` checks it.
- **No `enum` on a field a create copies from another stored document**
  (`models/README.md`). A newer release may have written a value this one does
  not know; normalise it where it is read instead. better-auth is pinned
  exactly, and an upgrade is migration-bearing (`docs/versioning.md`).

### E-invoices (ZUGFeRD / XRechnung)

An invoice downloads three ways: the plain PDF, a ZUGFeRD PDF (PDF/A-3b with
the EN 16931 XML embedded as `factur-x.xml`) and an XRechnung 3.0 XML file.
There is no second data model: e-invoicing extends the two parties of
"Invoice issuer and recipient" above. The business profile (Settings →
Billing → Business profile, `settings.businessProfile` /
`updateBusinessProfile`) gains `vatId`, `taxNumber`, `registrationNumber`,
`sellerIdentifier`, `contactName`, `electronicAddress` + scheme, `iban`,
`bic`, `bankName`, `accountHolder`, `smallBusiness` + note and a default VAT
category and rate. `Client.billing` (Clients → Edit → Billing details, written
by `clients.create/update`) gains `vatId`, `electronicAddress` + scheme,
`preferredFormat` and `defaultTaxCategory`. `Invoice.issuer` /
`Invoice.recipient` snapshot the same keys. The field sets live once, in
`models/einvoice-schemas.ts`, spread into the four schemas; the shared types
and checks are `@starter/shared/einvoice`. User docs:
`docs-site/docs/e-invoices.md`.

Procedures, all spread into the invoices router from
`trpc/routers/invoice-einvoice.ts`: `invoices.einvoiceCheck` (issues, what a
fill would write, issues left after it, the client's preferred format,
whether an issued XML is stored), `invoices.attachEinvoiceData` (the fill),
`invoices.exportZugferd` and `invoices.exportXrechnung`. `invoices.preview`
and `invoices.create` resolve per-line VAT (`services/einvoice/resolve-tax.ts`).
Every one of them runs the invoice gate (`trpc/routers/invoice-gate.ts`) first,
so a caller without invoice access gets `NOT_FOUND`, as on `invoices.get`.

`services/einvoice/cii.ts` writes UN/CEFACT CII for both outputs: the
`factur-x.xml` inside a ZUGFeRD PDF (profile `en16931`) and an XRechnung 3.0
file (profile `xrechnung`). It is hand-written over a small tree writer
(`xml.ts`), with no XML dependency.

```bash
UPDATE_GOLDEN=1 pnpm --filter @starter/server test      # regenerate the golden XML files
JAVA=/opt/homebrew/opt/openjdk@11/bin/java pnpm einvoice:validate   # Mustang + KoSIT over every sample
pnpm --filter @starter/server run einvoice:samples -- --out <dir>   # the sample files alone, no Java
TEST_MONGODB_URI=mongodb://127.0.0.1:<port> pnpm --filter @starter/server test   # invoice-einvoice / invoice-create-tax need a database
E2E_SERVER_PORT=<free> E2E_CLIENT_PORT=<free> MONGODB_URI=mongodb://127.0.0.1:<port>/<own-db> \
  npx playwright test e2e/einvoice.spec.ts e2e/invoices.spec.ts   # UI flow; asserts file bytes, never runs Java
```

The data rules first. Each of these fails without an error anywhere:

- **Party data is a snapshot, filled per value and never overwritten.**
  Main's rule decides whether a snapshot exists at create (`issuerSnapshot`:
  profile not empty; `recipientSnapshot`: client has billing), and either may
  be incomplete. `invoices.attachEinvoiceData` fills only absent parts and
  `null` leaves from *today's* profile and client, after the user confirmed
  the exact list, and logs it in `Invoice.einvoice.fills` (on the wire:
  `einvoiceFills`). Its write is conditional on `updatedAt` (`CONFLICT` when
  the invoice changed since the read), it publishes a sync event and sends no
  webhook. Overwriting a stored value would make the e-invoice disagree with
  the PDF the customer already holds; refusing to fill at all would lock an
  invoice out of e-invoicing forever over one missing postcode.
- **A profile save and a client billing update merge; they never replace.**
  `mergeIdentityInput` overlays the keys the input carries: a key left out
  keeps its stored value and `null` clears it, so a stale tab, an older export
  or an integrator on an older API version cannot erase a field it never knew.
  The cross-field checks (`businessProfileProblems`,
  `electronicAddressProblems`) run on the MERGED row;
  `BusinessProfileInvalidError` becomes `BAD_REQUEST` in
  `settings.updateBusinessProfile`.
- **Main's free-text `taxId` stays, and nothing guesses what it is.** An
  e-invoice must say VAT ID (BT-31) or tax number (BT-32). The PDF prints
  `taxId` beside them unless it repeats one of the two (`taxIdentityLines` in
  `invoice-pdf-blocks.ts`, the one copy of that rule), so a fill that adds a
  VAT ID never takes a tax number off a sent page; an issuer with only `taxId`
  is refused with `SELLER_TAX_ID_UNCLASSIFIED`, and both forms offer a
  one-click move into the right field.
- **`ClientBilling.reference` is BT-10**, the buyer reference, which is where a
  public-sector client's Leitweg-ID goes. XRechnung requires it
  (`BUYER_REFERENCE_MISSING`, BR-DE-15); ZUGFeRD does not.
- **The electronic address defaults from the email once, at snapshot time**
  (`withDefaultElectronicAddress`, scheme `EM`), so the XML reads the snapshot
  and derives nothing, and a fill copies the defaulted pair.
- **BT-20 is `Invoice.paymentTerms`**, the due sentence the plain PDF prints,
  frozen at create or fill (`payment-terms.ts`). A fill never takes
  `paymentTermsDays` from today's profile, so the PDF and the XML cannot state
  different terms.
- **A VAT category is chosen, never inferred from a rate.** 0 % is exempt,
  reverse charge, not subject to VAT or zero rated, and each needs different
  wording and different identifiers. Per line the first match wins: a
  `lineTax` entry, the request's `tax`, its `taxRate > 0` (S at that rate), the
  client's default category, a small-business profile (E), the profile's
  default. When a line matches nothing, no line gets a category and the
  invoice is plain-PDF only, exactly as before. A legacy invoice with a rate
  above 0 becomes `S` at that rate on fill; one at 0 % or `null` makes the
  user pick.
- **Stored amounts are the contract, so a rounding difference refuses.** VAT
  is computed per (category, rate) from the summed line cents, rounded once
  (`totals.ts`). A legacy invoice's tax was rounded with float
  `Math.round(x * 100) / 100`, whose half-cent ties can land a cent away;
  `TOTALS_MISMATCH` then refuses the fill and the export, with both figure
  sets, and writes nothing. Never "repair" the stored totals.
- **An issued XML makes the snapshot final.** Once `einvoice.issuedXml` holds
  either profile, `einvoiceCheck` answers `fill: null, fillLocked: true` and
  `attachEinvoiceData` refuses with `FILL_LOCKED_BY_ISSUED_XML` (its filter
  also requires both paths null, since storing the XML never bumps
  `updatedAt`). Otherwise a fill would redraw the ZUGFeRD page around an XML
  that no longer matches it. The fill `$set`s only the dotted leaves it lists
  (`FillPlan.writes`), never a normalised party, so an old snapshot gains no
  key it never had. Refusals without issues carry a code in
  `error.data.einvoiceFillRefusal`, which the client translates.
- **The first export of a non-draft invoice is stored and served forever.**
  `einvoice.issuedXml.<profile>` is written once with a conditional update, and
  a racing export serves the winner's bytes. Drafts are generated fresh. This
  is deliberately not tied to `updateStatus`: marking an invoice sent must
  never fail because e-invoice data is missing.
- **A refusal is structured, not a string.** Exports throw
  `PRECONDITION_FAILED` whose `cause` carries the issues; the tRPC
  `errorFormatter` copies them to `error.data.einvoiceIssues`. Each issue has a
  `code`, the dotted `field` of the exact input, `fixIn` (`businessProfile`,
  `clientBilling` or `invoice`) and, for client issues, `clientId`. Every other
  error carries `einvoiceIssues: null`. The panel builds its deep links from
  exactly those, so a message that names a field without the `field` path
  gives the user nothing to click.
- **The new fields go wherever main's identity fields already go.** Client
  billing is on the `Client` wire, in `GET /api/v1/clients` (the hand-written
  `clientBillingResponseSchema` in `routes-table.ts`, then
  `pnpm run openapi:emit`), in webhooks, in the JSON export and import. The
  importer degrades an invalid value to `null` and reads a profile's e-invoice
  keys only when the file has them, so restoring an older file keeps them. A
  redacted export drops the profile, both parties and `taxBreakdown`, and nulls
  each line's `taxRate`. REST v1 still has no invoice routes, and
  `einvoice.issuedXml` is never mapped by `toClientInvoice`, never exported
  and never on a webhook.

On the client (`components/einvoice/`, `components/invoices/einvoice-*`):

- **The download buttons are never disabled by the check.** `einvoiceCheck`
  only decides the hint and whether the panel opens. The server is the
  authority, and a stored issued XRechnung XML downloads even when today's
  check would complain, so a check stale by one settings edit must not block
  the file. ZUGFeRD is the exception: its page is drawn from the snapshot, so
  `exportZugferd` validates the snapshot even when an issued XML is stored.
- **Client and server validate a field with the same zod schema.**
  `billing-fields.ts` maps each input to the shared schema from
  `@starter/shared`; a second regex in a component is how the two start
  disagreeing about what a VAT ID is.
- **No second form.** The e-invoice fields are sections of main's
  `business-profile-form.tsx` and of the billing section of
  `client-form-dialog.tsx` (ids and test ids `${prefix}-${key}` with prefixes
  `business-profile` and `client-billing`, via `IdentityInput` /
  `PostalFields`). Each saves with its existing mutation.
- **Deep links are `/app/settings?tab=billing&field=<key>` and
  `/app/clients?billing=<clientId>&field=<key>`, plus `&from=invoice:<id>`, read
  from `location` in an effect.** `useSearchParams` would force a Suspense
  boundary under the static export. `useDeepLinkFocus` finds the input through
  its wrapper's `data-field="<key>"`, and `<key>` is the issue's `field` path
  after its first dot (`clientBilling.reference` → `reference`). Rename a key
  on one side and the link opens the right page with nothing selected;
  `e2e/einvoice.spec.ts` asserts the focus.
- **The client dialog focuses its field in `onOpenAutoFocus`, too.** Opened
  over the invoice dialog ("Add the VAT ID"), the form's own effect runs before
  the new dialog's focus scope is active, so the outer dialog's trap takes the
  focus straight back. The e2e spec asserts the focused VAT ID.

The output rules:

- **The two e-invoice profiles differ in BT-24 and nothing else.**
  `buildCiiXml(invoice, "en16931")` and `(…, "xrechnung")` must stay identical
  apart from the guideline id line, and `einvoice-cii.test.ts` asserts that line
  by line. A branch on `profile` anywhere else in `cii.ts` forks the validated
  output in two. What a profile *requires* belongs in `validate.ts`.
- **No empty element, ever.** PEPPOL-EN16931-R008 rejects an XRechnung that
  contains `<ram:LineTwo></ram:LineTwo>`, and nothing about such a file looks
  wrong. `el()` returns `null` for blank text and for a parent whose children all
  dropped, so optional business terms are passed in unconditionally. Do not
  "simplify" that into string templates.
- **Order is schema, not style.** CII is `xs:sequence` all the way down. In
  `ram:ApplicableTradeTax`, `ExemptionReason` comes before `BasisAmount`, and
  `ExemptionReasonCode` after `CategoryCode`. A reordered builder still produces
  well-formed XML, which only the validators reject.
- **Every amount is `formatCents(toCents(x))`.** `String(0.1 + 0.2)` and
  `1e21.toString()` are XML-valid numbers, and BR-DEC rejects both. Rates are
  `formatPercent`, prices `formatDecimal`, hours `billedHoursQuantity` (6 dp).
  A 2-dp quantity trips PEPPOL-EN16931-R120 on an ordinary hourly line.
- **The serializer reads the snapshot and computes nothing.** The breakdown and
  totals are the stored ones, and `assertCiiInvariants` throws when they disagree
  with the lines. Do not "fix" a mismatch there by recomputing. That would issue
  an XML whose totals differ from the PDF the customer already has.
- **`Invoice.to` is exclusive and `issueDate` is UTC.** BT-74 and BT-72 are
  `lastBilledDateKey(to)`; the raw bound is one day late. `from` and `to` are
  server-local midnights, issue and due dates UTC midnights, and
  `services/einvoice/format.ts` reads each the way the router wrote it.
- **Golden files are the contract. `UPDATE_GOLDEN=1` is a decision, not a fix.**
  After regenerating, read the diff and run `pnpm einvoice:validate` before
  committing. The Java validators are the only check of schema and schematron;
  the Node tests check structure. The sample generator refuses to run on output
  that differs from the goldens, so CI never validates something the unit tests
  would reject. Java never runs in `pnpm test`.
- **The validator script fails closed.** It requires an explicit `rep:accept`
  and Mustang's final `valid` in addition to exit codes. For a PDF it reads
  Mustang's `<pdf>` section (flavour `3b`, `isCompliant=true`, no failed
  clause) on its own: Mustang 2.26.0 exits 0 and ends on an overall `valid` for
  a PDF veraPDF rejects, so exit code and final summary say nothing about
  PDF/A. It also proves each run against three deliberately broken files (one
  per verdict: KoSIT, Mustang XML, veraPDF), because a validator that stopped
  detecting errors looks exactly like one that found none. Waiving a KoSIT
  warning means adding its code to `WAIVED_KOSIT_WARNINGS` with a reason, in the
  diff. Tool versions and checksums live in `scripts/einvoice-validate.mjs` only.
- **The ZUGFeRD PDF is the plain renderer with registered fonts.**
  `renderZugferdPdf` (`services/einvoice/pdfa3.ts`) passes a variant to
  `renderInvoicePdf` that registers Noto Sans under the names `Helvetica` and
  `Helvetica-Bold`; pdfkit resolves registered names first, so there is no second
  drawing to drift. Any literal standard-14 name in `invoice-pdf.ts`
  (`.font("Times-Roman")`) silently puts an unembedded font into every ZUGFeRD
  PDF and breaks PDF/A. Use `INVOICE_PDF_FONT_NAMES`. `invoice-pdf-blocks.ts`
  holds pure helpers only (tax identity lines, breakdown rows, exemption
  reasons, bank lines) and draws nothing; every label comes from the `invoice`
  server catalog.
- **The variant constructs the document with `font: ""`.** pdfkit's default
  loads the standard Helvetica and caches it under the very name the variant
  registers, so that cached standard font would win. Passing the Noto path
  instead is valid PDF but never caches the registered alias, and pdfkit
  re-parses the TTF on every `font()` call: seconds per invoice.
- **pdfkit writes `info.Title/Author/Subject/Keywords` into XMP unescaped.** An
  invoice number or seller name with `&` produces malformed XMP, and the PDF then
  fails PDF/A with nothing visibly wrong. The variant deletes those keys before
  `end()` and appends its own escaped `dc:` block (`services/einvoice/xmp.ts`).
  Never set them in a PDF/A variant.
- **`pdfVersion: "1.7"` is load-bearing.** With pdfkit's default 1.3,
  `endMetadata()` writes no `/Metadata` stream at all, and the file is not PDF/A.
- **A glyph the font lacks is a PDF/A violation, not a missing character.**
  `coverInvoiceText` replaces it with `?` in the drawn copy only; the embedded
  XML and the XMP keep the real text. `loadPdfFonts().hasGlyph` reads pdfkit's
  private `_font.font`, which `pdf-fonts.test.ts` pins.
- **The embedded XML is the argument, byte for byte.** `renderZugferdPdf` never
  builds XML, so a stored issued XML is re-wrapped unchanged, and
  `einvoice-pdfa3.test.ts` inflates the attachment and compares bytes.
- **The fonts ship only if the Dockerfile copies `assets/`.** The runtime stage
  copies `dist`, `package.json` and `node_modules`; without
  `COPY --from=build /prod/assets ./assets` every ZUGFeRD export in production is
  a 500 while every test passes. `assets/fonts/README.md` holds each file's
  SHA-256, and `pdf-fonts.test.ts` checks the files against it.
- **The plain PDF stays PDF 1.3 with Helvetica, and says what the XML says.**
  Main's renderer prints the VAT ID / tax number / registration number lines
  (and no legacy `taxId` beside them), one tax row per breakdown row with the
  old single tax row as the fallback, the exemption reasons, the bank lines,
  and the stored `paymentTerms` as its due line. Each is drawn only when the
  invoice carries it, so a legacy invoice prints as before. On an invoice with
  a category O line no VAT ID prints, matching BR-O-02 in the XML. The Period
  row ends on the last billed day (`billedPeriodDates`, BT-74) only when the
  invoice froze a `paymentTerms` sentence, i.e. was created with this feature;
  an older one keeps printing the exclusive `to` it was sent with, because a
  re-render must reproduce the page the customer holds
  (`invoice-pdf-locale.test.ts` pins that page). Tax rows format through
  `pdfFormat(locale)` like every other figure — German reads "USt. 19 % auf
  1.234,50".
- **What the validators confirm, and nothing more.** CI's `einvoice-validate`
  workflow passes every sample through Mustang 2.26.0 (veraPDF for PDF/A-3b)
  and the KoSIT validator 1.6.3 with the XRechnung 3.0.2 configuration. User
  docs and copy say exactly that; never "certified" or "compliant".

### Public REST API and webhooks

`/api/v1` is the token-authenticated REST surface third parties integrate
against — entries, catalog and reports, with webhooks pushing the same events
out. `docs/api.md` is the maintainer's view; `docs-site/docs/api/` is the
integrator's.

**REST never enters tRPC.** A request authenticates in `api/v1/auth.ts`, builds
a `WorkspaceScope`, and calls the same extracted services (`services/entries/`,
`services/catalog/`) the tRPC resolvers call. No synthetic context, no token
path through `workspaceProcedure`. That is what makes "a token can never name a
workspace of its own" structural rather than a rule per handler: the request
never reaches `workspaceIdFromInput` at all. It also means a REST write
publishes the same sync event and enqueues the same webhooks as a tRPC one —
nothing under `api/v1/` re-implements a business rule.

```bash
pnpm run openapi:emit                 # regenerate the two committed artifacts
```

Five rules, each of which fails quietly if broken:

- **`API_ROUTES` in `api/v1/routes-table.ts` is the only source of truth.**
  Express mounts from it and `z.toJSONSchema` builds the OpenAPI document from
  the same shared zod schemas the handlers validate with (zod 4, native — never
  add a zod-to-openapi dependency). A route not in the table is not mounted; a
  route in it with no handler throws at boot rather than 404-ing in production.
- **`docs-site/static/openapi.json` and `docs-site/docs/api/reference.md` are
  committed.** A spec regenerated at deploy time is a spec nobody reviews in a
  diff. `tests/openapi-document.test.ts` fails when either is stale.
- **A token's visibility is live, intersected with a frozen ceiling.** Revoking
  a permission narrows it on the next request; granting one never widens a
  token minted before. A removed member's token is dead — `401`, not `403`.
- **Money is projected where that is honest and refused where it is not.**
  `GET /entries*` nulls a colleague's `hourlyRate`, `GET /projects*` nulls
  `progress`, and `GET /reports/*` answers `403 money-visibility-required`
  rather than inventing a total. No invoice, CSV or PDF routes in v1, for the
  same reason. Never recompute an amount at read time.
- **Cross-workspace and foreign ids answer 404, never 403.** A 403 confirms the
  id exists somewhere. `403` is for a scope or money refusal on a resource this
  workspace genuinely owns, and every 5xx `detail` is the same fixed string in
  every environment — the global `errorHandler` returns `err.message` verbatim
  outside production, so REST answers its own errors instead of throwing into
  it.

Errors are RFC 9457 `application/problem+json`; successes are `{ data }`, with
`nextCursor` always present and `null` on a list's last page. Rate limiting is
a fixed 60s window per token (`API_RATE_LIMIT_PER_MINUTE`, default 600), Redis
when there is one and per-process when there is not.

Webhooks sign `HMAC-SHA256(secret, "<timestamp>.<rawBody>")` as `v1=<hex>`, over
a `rawBody` computed ONCE and handed to `fetch` unchanged — stringify it twice
and every receiver doing its job rejects the delivery as forged. Deliveries are
projected at send time against the owner's live visibility (withheld reads as
`skipped_visibility`, a permission outcome and not a failure), and
`assertDeliverableUrl` re-resolves DNS before every attempt because a
create-time-only SSRF check is decorative against rebinding.
`WEBHOOK_ALLOW_PRIVATE_TARGETS=true` lifts the https and private-address rules
for a local listener and belongs nowhere else.

### MCP server

`packages/mcp` (`@starter/mcp`, binary `trackyourtime-mcp`) is an MCP server on
stdio over `/api/v1`, configured by `TRACKYOURTIME_API_TOKEN` and
`TRACKYOURTIME_API_URL` (default `https://api.trackyourtime.dev`). The user
docs are `docs-site/docs/mcp.md`.

```bash
pnpm build:mcp                        # shared, then the server into packages/mcp/dist
pnpm --filter @starter/mcp test       # fake API, in-memory MCP client; part of test:unit
pnpm test:mcp:integration             # the real binary on stdio against a real API
```

Four rules, each of which fails quietly if broken:

- **It is a REST client, never a tRPC one.** Everything goes through the token
  path, so scopes, visibility and money projection are the server's decisions
  and the MCP server cannot be the place one of them is skipped. No invoice
  tools while v1 has no invoice routes.
- **Input schemas come from `@starter/shared`**, minus `originId` and `source`
  (the server stamps `api`). `createEntrySchema` is refined, and zod refuses
  `.omit` on a refined object, so that one is rebuilt from `.shape`.
- **Bare dates are resolved in the tool, not by the server.** `GET /entries`
  reads `to=2026-09-30` as midnight UTC at the start of that day and the
  reports read it as the end of that day in the server's zone. `resolveRange`
  sends both routes full timestamps computed in the caller's zone, so "to" is
  an inclusive day in every tool.
- **Scopes are probed once at start (`GET /me`) and tools are filtered by
  them.** A failed probe offers every tool rather than exiting: a client shows
  "server exited" with no reason, while a tool call returns the real problem.
  Stdout is the protocol — log to stderr only.

`tools.test.ts` fails when the scope table in `docs-site/docs/mcp.md` stops
matching `TOOLS`. The integration suite starts its own `mongod` on a random
port with a temp data dir (or uses `MONGODB_URI`), signs up over better-auth
and mints tokens through `apiTokens.create`, per the E2E isolation convention.

### Raycast extension

`packages/raycast` is a Raycast extension with a deliberately small surface —
**five** commands: `menu-bar` (the macOS menu bar timer), `toggle-timer`
("Start / Stop Timer", the `no-view` hotkey), `timer` (the live view that ticks
by the second and is *both* start and stop), `entries` ("Show All Time"), and
`open-dashboard`. Everything else — reports, invoices, the calendar, catalog
curation — is web app work, reached in one keystroke rather than reimplemented
as a launcher command.

Composing an entry is one surface, not three. `components/entry-fields.tsx`
renders the five fields an entry is, and the three forms that write one — start
a timer, log past time (⌘⇧N), edit an entry — all call into it, which is what
keeps a project dropdown grouped by client from being grouped in only one of
them. Two of the three are composers and adopt a project's `billableDefault`;
the editor deliberately does not, because the flag on an existing entry is an
answer somebody already gave and a rate may already be snapshotted from it.

```bash
pnpm dev:raycast                      # re-vendors core, then `ray develop`
pnpm build:raycast                    # re-vendors core, then `ray build -e dist`
pnpm vendor:raycast                   # regenerate packages/raycast/src/vendor
pnpm export:raycast [dir] --license MIT --author <raycast-username> [--lint] [--build]   # store copy (default packages/raycast/store; --draft skips author/license)
```

It is a thin shell over `@starter/core` — `createApiClient` for the tRPC
HTTP endpoints, `session-auth.ts` for the device flow, the shared
`formatDuration` helpers for display. Domain logic belongs in `core` so
the browser extension and CLI inherit it; only Raycast UI belongs here.

**The extension imports core through `src/vendor/`, never `@starter/core`.**
The Raycast Store builds the extension alone with `npm ci`, where
`workspace:*` cannot resolve, so `scripts/vendor-core.mjs` copies exactly the
core and shared files the extension reaches (import lines rewritten to name
the declaring file, everything else byte-for-byte) and writes
`src/vendor/index.ts` with the names the sources import from it. Never edit
`src/vendor/`: change `packages/core` or `packages/shared` and run
`pnpm vendor:raycast`. `vendor-core.test.mjs` (in `pnpm test:unit`) fails on a
stale copy, and on any runtime path to `zod` other than core's stored-data
readers (`stored-entry.ts`, `stored-catalog.ts`, which validate the local
cache and make `zod` a runtime dependency of the extension). Type-only files
such as `shared/members.ts` are vendored for `tsc` and must stay type-only
imports, or every command bundle carries their schemas. The allowlist is
`RUNTIME_ZOD_FILES` in that test. Six more rules:

- **Publish only from the export.** `pnpm export:raycast` writes the store copy
  (template scripts, npm `package-lock.json`, no `dist/`); `publish` in the
  monorepo package is a guard that exits. The store requires `license: "MIT"`
  and a real Raycast `author`, which `--license`/`--author` set on the copy
  only — both are decisions, not defaults. Then, by hand, with the monorepo
  committed: `npx @raycast/api@latest publish` in `packages/raycast/store`.
  No separate repository: `publish` (checked in `@raycast/api` 2.4.1) only
  requires a git work tree with a clean `git status`, which a gitignored
  folder of a committed monorepo is; it commits, tags and pushes in its own
  clone of the fork, and sends this repo's `origin` and commit as the source
  link. `pull-contributions` is different — it runs `git pull`/`git merge` in
  its working directory, so it never runs in the monorepo: run it in a
  throwaway `git init` copy of the export, and port the diff into
  `packages/raycast` by hand, anything under `src/vendor/` into core or
  shared. The steps are in `packages/raycast/PUBLISHING.md`,
  which the export does not copy: the README is the store page, and
  `export-store.mjs` refuses one that mentions pnpm, `packages/` or
  `src/vendor`.
- **`name` and `author` are permanent once published.** Raycast keys
  `LocalStorage` by them, so changing either orphans every install's token,
  offline queue and timer echo. The store also rejects a `description` or
  preference copy that promises more than the code does — the manifest and
  README claims (7-day resume, 14-day list, 180-day descriptions, what needs
  the network) are the numbers in `timer-data.ts`, `entries.tsx` and the
  server; change them together. `CHANGELOG.md` headings are
  `## [Title] - {PR_MERGE_DATE}`, and store CI fails a PR that does not touch
  it. Screenshots go in `metadata/` (2000×1250 PNG, at most six).
- **The export changes the copy in three places, and nothing else.**
  `src/lib/local-defaults.ts` flips to `false`, so a Store reviewer's
  `npm run dev` with empty preferences reaches the hosted service instead of
  `localhost` (the monorepo's `ray develop` keeps the dev ports above); the
  vendored headers, `.prettierignore` and the `eslint.config.js` comment stop
  naming `vendor-core.mjs`. It refuses a README or any user-visible string in
  `src/` (comments and `src/vendor/` excluded) that mentions pnpm, a worktree,
  `packages/` or `src/vendor`. `export-store.test.mjs` pins all of it.
- **`ray build` without `-o` writes into
  `~/.config/raycast/extensions/<name>`**, replacing whatever dev copy Raycast
  has installed under that name. `export:raycast --build` builds into a temp
  dir for that reason.
- **Prettier (120 columns) and `@raycast/eslint-config` apply to `src/`
  minus `src/vendor/`** (`pnpm --filter trackyourtime-raycast lint`); the store
  runs the same checks through `ray lint`.
- `lib` includes `DOM`, as in core's own tsconfig: the vendored `ids.ts`
  types `globalThis.crypto` as the DOM `Crypto`.

The rules below predate the store copy and apply to the extension itself.

- Auth: device flow, token in Raycast's encrypted `LocalStorage`, sent as
  `Authorization: Bearer <token>` with `x-trackyourtime-client: trackyourtime-raycast`.
- `raycast-env.d.ts` is generated from `package.json` by `ray build` and is
  committed, so `pnpm typecheck` works without Raycast installed.
- Adding a command is the change to argue about, not adding a feature to one.
  Raycast has no runtime visibility control — `updateCommandMetadata` reaches
  only the *running* command's own subtitle, and background launches are limited
  to `no-view` and menu bar modes — so a "Stop Timer" command is listed whether
  or not anything is running. `timer` therefore adapts on open (Stop is the
  primary action while a timer runs, the start form when none does) and carries
  `keywords` so "start" and "stop" still find it. Continuous state belongs in
  the menu bar, which is the one surface that can hold it.
- `toggle-timer` is the exception, and the mode is the reason: only `no-view`
  and menu bar commands can be launched in the background, so it is the one
  surface a **global hotkey** can drive without opening a window. It stops what
  is running, or continues the newest entry in the same `RECENT_DAYS` window
  the other surfaces call recent, and reports either in a HUD. With nothing to
  resume it launches `timer` rather than starting a nameless entry the user
  then has to fix. Folding it into `timer` costs the hotkey, which is the whole
  point of it — a view command opens a window before it can do anything.
- Pairing has no command: `components/signed-out.tsx` pushes `components/
  sign-in.tsx` from the empty state every view shows while signed out, and
  ⌘⇧A in `timer` reopens it to see the account or sign out. Keep the push —
  `SignIn` opens the approval page in a browser on mount, which is helpful when
  asked for and rude when a list merely failed to load.
- **The description autocomplete is a pushed list, because Raycast has no combo
  box.** A `Form.TextField` cannot offer completions and a `Form.Dropdown`
  cannot accept a name that is not already in it, so ⌘⇧D pushes a searchable
  list of what this person has described work as before — `entries.descriptions`,
  the sibling of `entries.recent`. The two are keyed differently on purpose:
  a recent is keyed on the whole (description, project, task, billable)
  combination and answers "resume this job", a suggestion is keyed on the
  case-folded description alone and answers "you have called work this before".
  One list cannot do both without either repeating a name once per project it
  was ever filed under, or hiding the project it usually belongs to. Searched
  server-side rather than through Raycast's own filtering, because the rows on
  screen are a page out of six months — filtering the page would answer "no
  match" for a description that is certainly there. ⏎ takes the name alone;
  ⌘⇧⏎ takes the project, task, tags and billable flag with it, and is the
  secondary action because overwriting a project the user already picked is the
  destructive reading of "autofill the description".
- **`entries.create` is reachable from Raycast** (⌘⇧N, "Log Past Time"), so the
  meeting you forgot to time no longer needs the web app. Unlike the web
  dialog it does NOT roll a backwards end forward past midnight: that dialog's
  end field holds a time of day with its date coming from a separate control,
  where 23:30 → 00:30 is an hour of work; Raycast's two `DateTime` pickers each
  carry their own date, so a backwards end is a date the user really typed.
- Catalog forms live in `src/components/catalog/` and are pushed from the timer
  and edit forms (⌘⇧P/⌘⇧T/⌘⇧G), each calling back with the created row so the
  picker that opened it can select it. Creating a row mid-timer stays; browsing
  and curating one does not. The color palette
  is `CATALOG_COLORS` in `@starter/shared` — the same list the server assigns
  from and the web picker renders, so a color picked in one client is a color
  the next one can name.
- Raycast unloads a menu bar command once its first render settles, so a
  `setInterval` in it fires once and stops. An unfinished load is the one thing
  that keeps the process alive: the item passes `isLoading` while a timer runs,
  which is what lets the clock tick `m:ss` every second, and drops it when the
  timer stops so an idle item costs nothing. `interval` (1m) and the dropdown
  opening cover the unloaded case. Staying loaded means owning freshness:
  `entries.current` every 4s while ticking, because a stop made elsewhere would
  leave a clock counting up on an ended entry, and the whole snapshot every
  20s; mutations call `refreshMenuBar()` rather than waiting for either. Idle
  and running are separate preferences: `idleTitle` (bare mark by default,
  "Start timer", or the total) and `titleMode` (how much of a running timer).
  A total shown idle is `36m`, never `0:36` — the running clock owns the
  colon, and a total that borrowed it was read as a timer still going. The `Timer` view
  command is the surface that can push forms, which a menu bar item cannot.
  Both read `lib/timer-data.ts`, so the two surfaces cannot disagree about what
  is running.
- **`refreshMenuBar()` is a nudge, never the mechanism.** It is a background
  `launchCommand`, and Raycast may decline it — and a menu bar command that is
  still *loaded*, which is exactly what a running timer keeps it, is not
  remounted by one. On its own it left the item ticking an entry the user had
  just stopped from the `timer` command one process over. Four things carry the
  truth instead, in descending order of how quickly they notice and ascending
  order of how much they cost:
  - **The timer echo** (`timer-echo.ts` in `@starter/core`, `lib/storage.ts`
    here) — every timer mutation records `{ runningId, at }` in Raycast's
    `LocalStorage` the instant the server confirms it, written centrally in
    `api.ts` so a new command cannot forget. Any surface re-reads it once a
    second — a local read, no network — and `reconcileRunning` lets it outrank
    a snapshot *fetched before it*. This is the one that closes the gap
    between Raycast's separate command processes, and the only one that still
    works with the network down. It needs no TTL: the next successful fetch
    carries a later `fetchedAt`, so a stale record of a stop can never mask a
    timer started on another device.
  - **The sync socket** (`lib/sync.ts`) — held for as long as Raycast keeps a
    command alive, which is a view command while it is open and the menu bar
    item while it ticks. That is what makes a stop from the web app or another
    machine land at once rather than on a poll. It deliberately does NOT
    filter this install's own `originId`: every Raycast command shares one, so
    filtering would drop the event the menu bar needs most.
  - **`useWatchRunning`** — `entries.current` every 4s, but only while the
    socket is NOT connected. An open socket has already reported every stop,
    so polling underneath it asks a question that has been answered.
  - **`usePoll`** — the whole snapshot every 20s, which is also what picks up
    a renamed project or a new favorite.
- `entries.stop` is **idempotent when given an id**: an entry that is already
  stopped is returned rather than refused. Two devices racing to stop one timer
  is the normal case, and the loser asked for a state the world is already in.
  Without an id there is nothing to be idempotent about, so "nothing running"
  stays a 404 — which the clients read via `isAlreadyStopped` and report as
  success, because the user got what they wanted.
- Server origin and web origin come from extension preferences. Empty follows
  the build, the same convention as the browser extension's build targets:
  `ray build` → the deployed hosts, `ray develop` → `localhost:5159` /
  `localhost:3392`, the ports `pnpm run dev` pins. Neither preference
  carries a `default` in `package.json`, because a default there is stored as a
  real value and "untouched" would be indistinguishable from "typed the
  production URL". A worktree runs on random ports — set both by hand there.

### Raycast works offline

The launcher is the surface people reach for without thinking — a hotkey, a
menu bar item — which makes it the surface used on a train, on a plane and in a
basement. It queues the same rows, under the same op contract, as the web app
and the browser extension (`@starter/core/offline-ops`), so a start queued in
Raycast is a row any of them could describe.

Three stores, and they answer different questions. `lib/offline.ts` is the
durable FIFO of mutations — what still has to be sent. `lib/overlay.ts` is
their visible consequence — what the menu bar should be showing right now;
without it a timer started with no signal is a row in storage and nothing on
screen. `lib/local-cache.ts` is the last good answer to every read, which is
what lets a `no-view` hotkey (with no rendered cache at all) work offline, and
what gives `buildOptimisticEntry` the project rate and workspace currency it
needs to guess the money snapshot the server is about to write.

Everything host-free lives in core and is tested there:
`offline-overlay.ts` (the overlay algebra), `offline-replay.ts` (the temp-id
rename and the stale-stop refusal, moved out of the web client), `entry-shape.ts`
(the optimistic shapes, moved out of `client/lib/entry-shape.ts`, which is now a
shim that injects `source`). Raycast's own files are the storage bindings.

What fails quietly if it is changed:

- **`api.ts` is the only choke point.** Every surface already goes through
  `TrackYourTime`, so the offline path is inside the wrappers rather than in each
  command. Writes go through `writing()` — drain first, and queue if anything
  is still waiting, because sending a new mutation ahead of older queued ones
  lands it out of order and `entries.stop` in particular resolves against
  whatever is running at the moment it arrives. Reads go through `reading()`,
  which falls back to the cache on a transport failure only: a 401 is a real
  answer and has to reach the sign-in handling.
- **`entries.continue` takes an optional `QuickStart`.** The server resolves a
  continue from the entry it names, and offline there is nobody to ask. Every
  caller has the row on screen, so it hands the fields over — without that the
  hotkey is dead on a train, which is where it is most wanted.
- **A stop for a locally started timer carries NO id.** The server has never
  seen the temp one. It rides on the same `tempId` as its start, which is what
  lets the replay target the entry that start produces.
- **Editing a temp entry is refused** (`StillSyncingError`), like the browser
  extension. An `entries.update` naming a temp id is refused permanently on
  replay, and the queue drops a permanent refusal — so the edit would vanish
  with no error anywhere.
- **Discarding or deleting a temp entry drops its queued rows** rather than
  sending anything, or the create would resurrect the row a minute later.
- **Every row is stamped with the account that queued it**, and the queue
  survives sign-out — unlike the browser extension's, which clears its own.
  These rows are this Mac's only copy of time tracked with no signal. The
  cached reads and the overlay ARE cleared on sign-out, so the next person to
  pair sees nothing of the last one's workspace; the timer surfaces only say
  how many rows are waiting and that they are not theirs — and offer the same
  way out the web app does, a discard that NAMES the work rather than counting
  it (`describeQueuedMutation` in core is shared with Settings → Devices, so
  the two clients cannot ask a person to approve two different deletions).
- **`isTransportFailure` is a type test, not a string test.** `createApiClient`
  throws `ApiError` for everything the server answered, so "not an ApiError" is
  exactly "no answer came back" — which matters on Node, where every transport
  failure is the same bare "fetch failed".
- **The queue drains from the reads, not from a background loop.** Raycast has
  no long-lived process to own one. `loadTimerSnapshot` drains before it reads
  (so the snapshot comes back already carrying the replayed work), the menu
  bar's own `interval` therefore drains once a minute, and `useSyncRevalidate`
  revalidates the instant the sync socket connects — the earliest and clearest
  proof available that the network is back.

### Client/server version handshake

Self-hosted servers lag, store clients lead, desktop builds and open tabs trail.
`docs/versioning.md` → "Client and server compatibility" is the contract; the
names other code depends on are `API_LEVEL`, `API_LEVEL_CHANGES`,
`MIN_CLIENT_API_LEVEL`, `CLIENT_TOO_OLD` / `SERVER_TOO_OLD` (`@starter/shared`),
`MIN_SERVER_API_LEVEL` (`@starter/core`), the headers
`x-trackyourtime-client-version` / `x-trackyourtime-api-level`, and `apiLevel`
on `/api/health`. Rules that fail quietly if broken:

- **Bump `API_LEVEL` whenever a tRPC procedure, input field, enum value or sync
  event kind is added**, with a row in `API_LEVEL_CHANGES`.
- **No header is legacy, never level 0.** The floor refuses only a request that
  declares a lower level, as 412 (`data.versionRefusal` / `problems/client-too-old`)
  — never a status the offline queue drops. `health.*` is never refused.
- **`x-trackyourtime-client` is untouched** by the handshake: it drives device
  labels and session windows.
- **Never add the handshake headers to `/api/health`**: a custom header forces a
  preflight that an untrusted origin fails, which reads as "unreachable".
- **The root `package.json` version is the one version.** The web export and the
  extension read it at build time; the other copies are checked by
  `scripts/lib/version-sync.test.mjs`.
- **The tRPC contract is a committed snapshot.** `pnpm run contract:emit` writes
  `packages/server/contract/trpc-contract.json` (every procedure's type and
  input JSON Schema, every sync event kind, both levels);
  `tests/trpc-contract.test.ts` fails when it is stale and says whether the
  change is breaking (raise `MIN_CLIENT_API_LEVEL` and `API_LEVEL`), additive
  (bump `API_LEVEL`) or neither. A sync kind is added in three places:
  `SyncEvent`, `SYNC_EVENT_KIND_SET` in `protocol.ts`, and
  `contract/sync-events.ts` — `tsc` enforces the last two.
- **An unknown sync kind or scope means "refetch", never "ignore".** The web app
  calls `utils.invalidate()`, the extension drops its workspace caches and the
  running timer, Raycast revalidates; from another workspace an unknown kind
  reaches the timer (`syncEventReach`). Keep the `never` defaults — they fail
  the build — but let them fall through to the refetch at runtime.

### Held queue rows and the queue format

A queued row that this build or this server cannot handle is **held**: kept,
counted, listed with a reason and a deliberate discard, and never deleted on
its own. The web app counts it as `held` in the tracker bar and lists it in
Settings → Devices. The extension lists it in the popup's held list, and
Raycast lists it under "Not synced". `HoldReason` in `offline-queue.ts` is a
union that will grow. Rules that fail quietly if broken:

- **One classifier.** `classifyReplayOutcome` in `offline-replay.ts` turns a
  failed replay into `retry-later` / `hold` / `drop` for all three clients. A
  client supplies only its transport test and its membership re-check.
  `holdRefusal` is the seam for a hold that depends on the row, such as a 400
  from a server older than the row's API level.
- **`unknown-procedure` is tRPC's message, not the status.** tRPC answers an
  unknown path with NOT_FOUND/404 and `No procedure found on path "…"`. An
  application NOT_FOUND, such as "entry gone" or a stop with nothing running,
  has the same code and still drops. It is checked before the permanent set,
  or a newer client's `entries.discard` against an older self-hosted server
  is deleted.
- **`unknown-op` is never written onto a row.** Every read computes it again
  (`holdReasonOf`), so a newer build that can decode the row releases it.
  `unknown-procedure` is written with `at` and asked again after
  `HELD_RETRY_MS` (one hour). The web app also asks again on the first flush
  of a document.
- **`server-too-old` is decided by the server's level, not the clock.** Every
  row is stamped `apiLevel` (the writing build's `API_LEVEL`) by core's
  `enqueue`. A flush holds a row before sending it when the server's known
  level is lower (`serverLevelHold`), and a 400 on such a row is a hold, not a
  drop. `holdBlocksReplay` releases the hold the moment the level cache
  reports enough. A row with no stamp, or a server of unknown level, is sent as
  before. docs/versioning.md → "Gating a feature on the server".
- **Holds follow the temp-id chain** (`chainOf: tempIdOf` on `flush`,
  `heldReasons` for counts). A stop that is replayed without its held start
  ends whatever runs on the server.
- **Held rows are not pending.** They are left out of every "is something
  ahead of a new mutation" count, the same way left-workspace rows are.
- **The stored queue is `{ v: 1, data: rows }`** (docs/versioning.md, rule 4). A bare array is still read as v1.
  An unreadable value is copied to `trackyourtime.offline-queue.corrupt.<ms>`
  before the reset. A `v` newer than `QUEUE_FORMAT_VERSION` locks the queue:
  its rows are held `unknown-op`, `enqueue`/`remove` throw
  `OfflineQueueLockedError`, and `clear` and adoption do nothing. A build from
  before the envelope reads `{ v, data }` as empty, so a client rollback past
  this change strands the queue until the next enqueue overwrites it.

### Deployment (two Coolify apps, two hosts)

Production is two apps on **two hosts of one zone**: `trackyourtime-client` on
`https://trackyourtime.dev` and `trackyourtime-server` on
`https://api.trackyourtime.dev`, from `docker-compose.client.yml` and
`docker-compose.server.yml`. The service name inside each file (`client` /
`server`) is load-bearing — Coolify keys `docker_compose_domains` by it, and a
mismatch yields 503 for the site with a 200 from Coolify's own API.
`docker-compose.yml` is the legacy single-app layout, kept for reference.

Two apps rather than one so a client deploy cannot restart the server and drop
every connected device's socket.

**Why the domain moved.** The previous layout put both apps on
`tracktime.trebeljahr.com` and split them by path (`/api` to the server),
because `api.tracktime.trebeljahr.com` could not get a certificate: Cloudflare
Universal SSL for that zone covers `trebeljahr.com` and `*.trebeljahr.com` —
**one** label — and that host is two. That constraint is real and still applies
to anything under `trebeljahr.com`.

The path split then failed for a second, independent reason: this Coolify
instance proxies with **caddy-docker-proxy**, not Traefik. Coolify writes
`traefik.*` labels onto every app and they are inert here; what routes is
`caddy_0=https://<host>` plus `caddy_0.handle_path`. Both apps wrote the same
`caddy_0` site for the same host, caddy-docker-proxy merged them, and the
client's `/*` won — so `https://tracktime.trebeljahr.com/api/health` was
answered by the client's 404 page. And `handle_path` **strips** its prefix, so
even ordered correctly the server (which mounts its routes AT `/api`) would
have received `/health`.

A fresh apex zone fixes both at once. `api.trackyourtime.dev` is one label
under `trackyourtime.dev`, so the wildcard covers it, and each app gets
`handle_path=/*` on a host of its own — no label collision, no prefix strip.

**Consequence: the API is a separate origin from the web app again.** CORS and
cookie handling are load-bearing, not decorative. `FRONTEND_URL` and
`TRUSTED_ORIGINS` on the server are what let the browser client and the
extension sign in at all; do not "simplify" them away.

The server still mounts everything it owns at `/api`, the socket included:
`resolveSyncUrl` derives `wss://api.trackyourtime.dev/api/ws`.
`NEXT_PUBLIC_API_URL` is an **origin** with no path — the clients append
`/api/trpc`, `/api/auth` and `/api/ws` themselves — so real requests carry a
doubled-looking `api.trackyourtime.dev/api/...`. That is the mount, not a
mistake in the value. Stripping the mount would touch server, core, extension
and Raycast; it buys cosmetics only.

Four places must agree on the DEFAULT API origin (every store client can be
pointed elsewhere at runtime): the server's `BETTER_AUTH_URL`
(set in Coolify's env fields — `packages/server/.env.production` is NOT tracked
in this repo, a global gitignore rule excludes it), the client image's
`NEXT_PUBLIC_API_URL` build arg in `.github/workflows/build-and-deploy.yml`
(Next inlines it at image build time, so a wrong value builds green and points
at a dead API), `packages/extension/manifest.config.ts`, and
`packages/raycast/src/lib/preferences.ts`. See `docs/deploy.md`.

The client image serves the static export: `output: "export"` leaves no
`.next/standalone`, so the image is `out/` plus `packages/client/serve.mjs`.
The E2E suite runs that same file, so the deployed and tested servers cannot
drift apart.

**An open tab outlives a deploy, and its chunks do not.** Each image replaces
every hashed chunk, so a tab opened before a deploy 404s the first time it
lazy-loads a route. Two web-only answers, both started after mount in
`components/deploy-recovery.tsx` and skipped in `next dev` and every shell:

- `/version.json` (`scripts/write-version-json.mjs`: `commit`, `version`,
  `apiUrl`) is served `no-cache` by `serve.mjs` and the self-host Caddyfile.
  On focus or visibility, at most every five minutes, the tab compares its
  `commit` with `NEXT_PUBLIC_BUILD_COMMIT` (both Dockerfiles set it from
  `COMMIT_SHA`; empty disables the check) and shows a Reload toast. The reload
  is never automatic, and waits for writes in flight (`reloadWhenIdle`), since
  `lib/offline.ts` does not queue a write that fails during unload.
- A failed chunk or dynamic import (`lib/chunk-reload.ts`, from window events
  and from `app/global-error.tsx` / `app/app/error.tsx`) reloads ONCE per 60s,
  guarded in `sessionStorage`; after that the error screen's button is the way
  out. Keep that guard: without it a broken server is a reload loop.

**The docs site is served from the client image, at
`https://trackyourtime.dev/docs/`.** `packages/client/Dockerfile` runs
`scripts/docs/build-into-client.mjs` after the client build: it builds
`docs-site` (`url` `https://trackyourtime.dev`, `baseUrl` `/docs/`,
`trailingSlash: true` like the web app) and copies it to `out/docs/`.
`pnpm build:web` is the same two steps locally. A folder of the apex rather
than a `docs.` host keeps one domain for search, and rather than a third
Coolify app or a proxy path it needs no routing at all — caddy-docker-proxy
merges same-host `caddy_0` sites and `handle_path` strips its prefix, the two
reasons above. Four rules that fail quietly if broken:

- **Never add the docs to `@starter/client`'s own `build` script.** `out/` is
  also written by Playwright, and the phones and the desktop app
  use `out-mobile` / `out-desktop`; only the web image should carry the docs.
- **The docs address is a literal, and indexing is always on.** The config
  used to read `DOCS_SITE_URL` and fall back to a placeholder that set
  `noIndex` — a forgotten variable would ship an unindexable site that looks
  fine. The copy step fails on any `noindex`, a canonical link or sitemap entry
  outside `https://trackyourtime.dev/docs/`, or a robots.txt under `/docs/`.
  CI's `verify` job runs it too, so a broken docs link fails a pull request
  rather than the image build after merge.
- **The domain has one robots.txt, the web app's** (`app/robots.ts`), which
  lists `/docs/sitemap.xml` beside its own sitemap. The docs sitemap has no
  `lastmod`: Docusaurus reads it from git, and the image's build context has no
  `.git` (a git binary with no repository fails the build outright).
- **Marketing pages link the docs absolutely** (`DOCS_URL` in
  `lib/site-links.ts`), with plain `<a>`: the self-host image renders the same
  pages on another domain, where no `/docs/` exists, and `/docs/` is not a Next
  route for `<Link>` to navigate to. `serve.mjs` answers unknown `/docs/*`
  paths with the docs' own 404 page and caches `/docs/assets/` (hashed) forever.
  Every docs page also has a Markdown copy beside it (`/docs/mcp.md`,
  `/docs/index.md`), which the root `llms.txt` links.

### Web command palette and description autocomplete

Cmd/Ctrl+K opens `components/command-palette/` on every protected screen; the
phone reaches it from the Search entry at the top of the More drawer. The
tracker bar's description field is `components/tracker/description-combobox.tsx`
over `entries.descriptions`. Four rules, each of which fails quietly if broken:

- **The palette writes only through `useEntryMutations`.** A stop from the
  palette offline must be the same optimistic, queued row a stop from the bar
  is; a tRPC call of its own would skip `OFFLINE_QUEUED_MUTATION` and the
  queue. What it offers is plain data (`palette-model.ts`) and what a row does
  is `palette-actions.ts`, so both are tested without cmdk.
- **`NAV_SECTIONS` stays in `app-shell.tsx` and is passed in as a prop.** The
  shell renders the palette, so importing it would be a cycle, and a second
  list of destinations would drift. Catalog rows appear only once something is
  typed, so an empty palette is Timer and Go to, not two rows per project.
- **Cmd/Ctrl+K is the only binding the shell adds.** The calendar's single-key
  shortcuts return early on any modifier and on typing targets, which is what
  keeps d/w/m/y/t working with the palette mounted.
- **The combobox keeps Enter.** Nothing is highlighted until an arrow press, so
  Enter still starts or stops; Tab completes the name only; Cmd/Ctrl+Enter on a
  highlighted row fills project, task, tags and billable and is kept from the
  bar's page-wide Cmd/Ctrl+Enter toggle (`stopPropagation`, and the toggle
  skips a `defaultPrevented` event). Escape reverts without the blur it causes
  saving the abandoned text, and a Tab-take followed by its blur writes once.
  The list opens on typing, a click or ArrowDown — never on focus, because the
  field is focused on every visit to /app/track. Suggestion failures are silent.

### Browser extension

Five things the 380px popup does that are easy to break:

- **Descriptions autocomplete from `entries.descriptions`, searched
  server-side.** The rows are a page out of six months, so filtering a cached
  list locally answers "no match" for a description that is certainly there.
  The query rides on `descriptions:search`, which is answered with a whole
  snapshot like every other message and carries `descriptionsFor` beside the
  rows — typing outruns the round trip, and without the query the list would
  spend most of its life describing a prefix already moved past. It fails
  silently by design: a typeahead that raises the error banner because the
  network blinked is worse than one that offers nothing.
- **Tab completes, Enter does not.** Nothing is highlighted until a deliberate
  arrow press, so Enter still belongs to the surrounding form and starts the
  timer. A row's `＋` (or ⌘⏎) takes the project, task, tags and billable flag
  the newest entry with that name carried; the plain row takes the name alone,
  because overwriting a project the user already picked is the destructive
  reading of "autofill the description".
- **One `DescriptionField` for all three surfaces**, and one `ProjectPicker`.
  Commit-on-blur, Escape-reverts-without-the-blur-saving-it and the
  name-then-file-under-a-client panel are each fiddly enough that a second copy
  drifts. `DescriptionField` is controlled: each caller already owns when its
  text may be replaced, and a second copy of that rule could disagree.
- **Creating a catalog row selects it** (`useSelectWhenCreated`). The worker
  answers a create with a snapshot rather than the row, so there is no id at
  the call site and reading the list straight after the await races the
  render — waiting for the row to appear in props is the version that cannot.
  Before this, creating a tag mid-timer added it to the list and not to the
  entry.
- **The theme is a synced user preference**, applied from `<html data-theme>`
  before React's first render out of a `localStorage` copy. The popup is
  rebuilt on every open, so learning the theme from the worker's answer would
  flash the wrong one several times a day. The media query is guarded on the
  attribute being absent, so it cannot fight an explicit choice.

### Browser activity capture

The extension can record which site has the person's attention and turn the
untracked stretches into suggested entries. Off by default; Settings → Activity
requests the optional `tabs` permission from the click that enables it.

The arithmetic is `@starter/core/activity` — pure, epoch-ms, zone-free, so the
desktop and Android capturers can feed the same `mergeSegments` /
`buildSuggestions`. The extension half is `background/activity/`
(capture, IndexedDB store, retention prune, suggestion composition) plus the
Suggestions screen and the Activity settings section.

Rules that fail quietly if broken:

- **`background/activity/*` imports no runtime, API client or network code**,
  and imports core only through the `@starter/core/activity/index` subpath —
  the barrel would pull in the API client. `import-graph.test.ts` walks the
  real graph. Tracked intervals are fetched in `background/entries.ts` and
  handed in; an accepted suggestion leaves through `createEntry`, so it gets
  `source: "extension"` and the offline queue for free.
- **Accept recomputes first.** The popup's snapshot can be seconds old, and
  the span may have been tracked on another device since. A plain accept is
  clipped to what is still untracked; an edited one keeps the person's times
  but is refused when nothing untracked overlaps them any more.
- **A dismissal is subtracted exactly like an entry**, never matched by
  range. A block that grows after being dismissed would otherwise reappear
  whole; this way only the new activity surfaces.
- **The open segment is persisted and heartbeated once a minute**, and one
  whose `lastSeen` is over three minutes old is closed AT `lastSeen`. The
  heartbeat never opens a segment — only an event says attention is somewhere.
- **Everything is scoped `<userId>:<workspaceId>`** (from resolved settings).
  A new scope deletes every other ACCOUNT's rows but keeps the same person's
  other workspaces, so a workspace switch and back does not lose their rules;
  `forgetSession()` deletes all of it and forgets the scope, so nothing
  records until someone signs in.
- **"Never record" applies to the past too.** A segment is written under the
  settings current when it CLOSES (so excluding the host on screen does not
  store it), and adding an exclusion purges stored segments it matches.
  No server changes and no sync events: nothing leaves the device until an
  entry is accepted.

### Browser extension build modes

`packages/extension` bakes its DEFAULT API URL in at build time, so a build is
a target. Both are declared in `packages/extension/manifest.config.ts` — not in
`.env.*`, which is gitignored and would yield a URL-less bundle silently.

```bash
pnpm run build:extension        # dist/      -> http://localhost:5159
pnpm run build:extension:prod   # dist-prod/ -> https://api.trackyourtime.dev
pnpm run extension:id [dev|prod]  # the chrome-extension:// origin to trust
```

Each target carries its own name and its own `externally_connectable`, so both
can be installed at once. **Neither has `host_permissions`,
`optional_host_permissions` or `cookies`**: the permissions are exactly
`storage`, `alarms` and `idle`, plus the optional `tabs` for activity capture.
That is a Web Store review decision, and `manifest.test.ts` asserts the keys
are absent and the list is exact — a permission added "just for one fetch" is
an install warning on every store user's machine. `chrome.tabs.create` (the
device-flow page, "Open Track Your Time") needs no permission.

`externally_connectable.matches` comes from `extensionBridgeMatchPatterns(target)`
in `@starter/shared/extension-bridge`, never written out by hand: production
is `https://trackyourtime.dev/*`, development `http://localhost/*` and
`http://127.0.0.1/*` (a Chrome match pattern ignores the port, which a worktree's
random client port needs). There is no `ids` key, so no other extension can
connect. The target is baked in by vite (`VITE_BRIDGE_TARGET`), never read from
storage, because it is what the worker checks every sender against.

The popup's server picker (`src/popup/switch-server.ts`) has **no permission
step**: normalise, then `config:set-server`. The worker validates with
`checkServer`, and refuses a server whose `/api/health` reports
`originTrusted: false` with `ORIGIN_NOT_TRUSTED`, naming `TRUST_STORE_APPS=true`
or the `chrome-extension://<id>` entry for `TRUSTED_ORIGINS` (`null`, an older
server, is let through). It refuses to switch past unsent queue rows without a
confirmation (`UNSENT_CHANGES`), revokes the extension's own session on the
old server whatever its source, clears the pending device authorization and
the sign-out marker, and clears its queue, per the extension's sign-out rule.

**An untrusted origin looks exactly like being offline.** Without host
permissions every request is CORS, and a refused CORS request reaches `fetch`
as a `TypeError`, which `isTransportFailure` reads as "no answer came back".
Left alone, the offline queue would wait forever behind a connection that is
fine. So a transport failure makes the worker re-run `checkServer` (at most
once a minute; `/api/health` answers `Access-Control-Allow-Origin: *`, so it
still gets through), `originTrusted: false` in the snapshot makes the
popup show `origin-not-trusted-notice.tsx`, and the queue keeps every row. Never "fix" this by treating a TypeError as a refusal: a real outage
would then drop time.

**Store releases** are `.github/workflows/extension-release.yml` on every `v*`
tag (setup: `docs/releasing.md` → "Chrome Web Store"). Three rules: the
manifest `version` is the root `package.json` version (a prerelease becomes
`version` + `version_name`), and the job fails before uploading when it is not
the tag; the zipped manifest has no `key`, and the key is checked to pin
`STORE_EXTENSION_ID` before it is removed, so a build with a fork's
`EXTENSION_KEY` is never uploaded over the listing; with neither
`CWS_SERVICE_ACCOUNT_JSON` nor `CWS_PUBLISHER_ID` set the tag run only uploads
an artifact, and one without the other is an error.

As unpacked extensions the two have different ids, and **each id's origin must
be trusted by that server**. The dev id is derived and trusted by `pnpm run
dev` (`scripts/lib/extension-id.mjs`, shared with `extension:id` so the two
can never disagree). The production build pins `STORE_EXTENSION_KEY` from
`@starter/shared` unless `EXTENSION_KEY` overrides it, so its id is the store
id that `TRUST_STORE_APPS=true` trusts. On the hosted deploy that switch (or the
id in `TRUSTED_ORIGINS`) is set in Coolify by hand — deliberately: a production
trust list that a script can extend is a trust list nobody reviews. It is a
**release prerequisite**, not a sign-in detail: without it the store extension
cannot make a single request. `pnpm run dev` trusts the store id too, so an
unpacked `dist-prod` pointed at a local API works (its bridge still accepts
only `https://trackyourtime.dev`, so it does not link to a local web app).

### Web app ↔ extension bridge

The extension used to read the web app's session cookie and act as that
session. With no `cookies` or host permission it cannot, so the web app and the
extension keep sign-in in step through Chrome's `externally_connectable`
messaging instead. The protocol is `@starter/shared/extension-bridge` (envelope
`{ channel, v, kind }`, the decoders, the allowlists), tested in
`packages/server/src/tests/extension-bridge.test.ts`. The web half is
`components/extension-bridge.tsx` over `lib/extension-bridge.ts`,
`lib/extension-bridge-transport.ts` and `lib/device-approve.ts`; the extension
half is `background/bridge.ts`, `background/device-sign-in.ts`,
`lib/device-auth-store.ts` and `lib/sign-out-marker.ts`.

What it does. The page sends `sync` (its API origin, its user id, its session's
`createdAt`) on mount, on every change of signed-in user, and on focus or
visibility at most every `EXTENSION_BRIDGE_SYNC_MIN_INTERVAL_MS`. The extension
answers with what the page should do:

- **Web signed in, extension signed out:** the extension starts a device
  authorization for `trackyourtime-extension` and replies `approve-device` with
  the user code. The page approves it with its own cookie session (the same
  claim-then-approve as `/app/device`, never rendered), then sends
  `device-approved`; that message wakes the worker, which exchanges the device
  code once for its **own** bearer token. A 2FA account links this way too.
- **Web signed out:** a `web`-sourced extension session is revoked and
  forgotten; the queue, activity data and workspace choice stay.
- **Web switched account:** a `web`-sourced session is revoked, and the
  extension links to the new account as above.
- **Extension signed out in the popup:** it writes a sign-out marker to
  `chrome.storage.local`, and the page's next `sync` gets `sign-out-web` back.
  The web tab signs out on its next mount, focus or visibility change, not
  instantly — the extension has no content script and cannot reach a page.

Rules that fail quietly if broken:

- **The page drives; the extension never initiates.** Every exchange is one
  request from the page and one reply. `onMessageExternal` is the only entry;
  bridge kinds are never accepted on `onMessage`, and popup messages never on
  `onMessageExternal`.
- **Web only, after mount, after the session resolved.** Never under
  `isAppShell()` (Capacitor and Electron have no `chrome.runtime`, and the
  prerendered HTML must not differ). A pending or failed session lookup is
  never sent as `userId: null`, or an offline page would sign the extension
  out. The target ids are `NEXT_PUBLIC_EXTENSION_IDS` (comma-separated, each
  `^[a-p]{32}$`), defaulting to `STORE_EXTENSION_ID`; `pnpm run dev` sets the
  derived dev id plus the store id. A missing extension is a rejected
  `sendMessage` or a 5 s timeout, and costs nothing.
- **No credential crosses the bridge.** Not the token, not the device code, not
  an email. The only secret-shaped value is the user code, and only a session
  of the user the flow was started for can approve it. The page takes a user
  code from a pinned id's reply and from nowhere else — not the URL, not
  `postMessage`, not storage — because `/device?user_code=` does not reveal
  which client the code belongs to; the reply's sender is the trust anchor.
- **The token is adopted only after `get-session` names the expected user.**
  `/device/token` returns no user. A web-link token whose user is not the
  `forUserId` that started it is revoked and discarded.
- **Every sender is checked three ways.** `isAllowedExtensionBridgeOrigin`
  against the build's target; `sender.id` absent, `sender.tab` present, not
  incognito, and `sender.frameId === 0`; and the origin equal to the current server's `webUrl` (development tolerates
  `localhost` ↔ `127.0.0.1` on the same port). Then `apiOrigin` must be the
  server the extension already points at — otherwise `other-server`. **A
  message never changes the server**, the workspace, the queue or a setting.
  **Frames never talk to the extension**, on either end: any site can frame
  the web app, a cross-site frame gets no SameSite=Lax cookie, and its honest
  "nobody is signed in" would sign a linked extension out. The page also
  checks `isTopLevelDocument`, and `serve.mjs` sends `frame-ancestors 'none'`
  and `X-Frame-Options: DENY`.
  A self-hosted web app is not in `externally_connectable`, so Chrome gives
  its page no `chrome.runtime` for our id and nothing happens; those users
  sign in with a password or "Sign in with the web app".
- **An explicit session is never displaced.** `SessionSource` is
  `"web" | "password" | "device"`, stored in the session record (a record
  without it reads as `"password"`). A password or device-flow session ignores
  web sign-in, web sign-out and web account switches (`explicit-session`),
  exactly as a password session ignored the web cookie before.
- **Every extension sign-out revokes the extension's own row.** A borrowed
  cookie was the web app's session and was left alone; a device-flow session is
  a separate row, and leaving it would park a 30-day session in Settings →
  Devices.
- **The marker only signs out the same person on the same server, once.** It
  is `{ userId, apiOrigin, at }`; `sign-out-web` is answered only when the web
  user matches, the API origin matches, `at` is later than the web session's
  `createdAt`, and the marker is younger than `EXTENSION_SIGN_OUT_MARKER_TTL_MS`.
  The `createdAt` check is what lets someone sign back in on the web after
  signing out in the extension; the page re-checks it before calling
  `signOut()`. A web sign-out deletes the marker. Before, the extension deleted
  the cookie whoever it belonged to; this is narrower on purpose.
- **An explicit sign-out is never undone by an older web session.** Beside the
  marker, every popup sign-out writes a link block `{ apiOrigin, at }`
  (`trackyourtime.web-link-not-before`), even when the user id is unknown. A
  web session whose `createdAt` is at or before `at` is answered
  `explicit-sign-out` and never linked, whoever it belongs to. It has no TTL;
  only a sign-in of any kind clears it.
- **A 401 on a `web` session keeps the queue** (`forgetRejectedSession`). That
  session is a row of its own, so the web app's "Sign out other devices" or a
  password change revokes it, and the bridge relinks at once; dropping the
  owner-stamped rows there would lose tracked time. Any other session's 401
  still goes through `forgetSession()`. The popup's own "Sign out other
  devices" signs out the web app in this browser, and with it a linked
  extension; its confirm text says so.
- **A reused web-link code is handed over again without a poll.** The page
  approves it (an already approved code counts) and its `device-approved`
  makes the exchange; a poll just before would put that exchange inside
  better-auth's 5 s interval, whose `slow_down` answers read as pending.
- **Queue rows carry an owner.** The extension stamps `owner` from the session
  user and flushes through core's ownership filter, so a web account switch
  (which keeps the queue) cannot replay one account's rows into another; they
  are held with the other foreign rows. An explicit popup sign-out still clears
  the queue in `forgetSession()`, as before.
- **Nothing long-polls in the worker.** Chrome stops an idle MV3 worker after
  about 30 s. The pending authorization lives in `chrome.storage.session`
  (`trackyourtime.pending-device-auth`, never the device code in a snapshot);
  `device-approved`, the alarm, a popup open or any later message makes one
  exchange attempt. One authorization at a time, handled serially, with
  `EXTENSION_BRIDGE_DEVICE_RETRY_MS` of back-off after a failure, which caps
  what a misbehaving page can make the extension ask the server for.
- **The token stays in `chrome.storage.session`**, so a browser restart signs
  the extension out until a web tab loads and relinks it. That is the price of
  the storage rule in `lib/session.ts`; the signed-out popup's "Open Track Your
  Time" button is the mitigation. Do not move the token to `storage.local` to
  "fix" it without deciding that rule again.
- **The bridge has its own version.** `EXTENSION_BRIDGE_VERSION` is separate
  from `API_LEVEL`; an unknown `v` is answered `unsupported`, never guessed at,
  because a web deploy and a store update land on different days.

### Internationalisation (i18n)

The web app, the native shells, the browser extension, invoices and email ship
in English and German. Raycast does not (below). Everything lives in
`packages/client/src/i18n/` unless noted.

```ts
const t = useT("tracker");            // client components
t("timer.start");                     // key typed against the English catalog
t("entries.count", { count });        // ICU arguments typed too
translate("common")("errors.generic") // non-component code, at call time
const f = useFormat();                // f.money / f.date / f.duration / …
```

**Library: `use-intl/core`, and nothing from its React half.** `useT` is
`createTranslator` bound to the locale store, so there is no provider to mount
and every existing component test renders unchanged, in English. No
`next-intl`: its routing needs middleware, which a static export cannot have.

**Catalogs.** One file per namespace per locale — `messages/en/<ns>.ts` is the
source (`as const`, whose literal types are what type-check keys AND ICU
arguments), `messages/de/<ns>.ts` is annotated `Translation<typeof source>`
(`@starter/shared`), so a missing, misspelled or extra German key fails `tsc`.
`messages/index.ts` is the only file that lists namespaces: `common`,
`tracker`, `calendar`, `reports`, `catalog`, `settings`, `shell`, `marketing`.
`common` is shared vocabulary and is edited deliberately, never in passing.
`catalog-parity.test.ts` checks what the types cannot see: identical ICU
placeholder and tag names per message (`{project}` renamed to `{projekt}`
type-checks and renders raw), valid ICU in both locales, and whole English
sentences left untranslated. Terms and voice: `i18n/GLOSSARY.de.md` (du,
„Kunde“, „Tätigkeit“, „Schlagwort“ — never „Tag“, which means *day* on every
screen of a time tracker).

**The preference is synced, the language is resolved per device.**
`UserPreferences.locale` is `"system" | "en" | "de"`, stored beside `theme`
and written through `settings.update`; `<LocaleSync>` (app shell) carries it
both ways like `<ThemeSync>`. The server never resolves "system" — it has no
device to ask — so one account reads German on a German phone and English on
an English laptop. `matchLocaleList` in `@starter/shared/locale` is the one
resolver (primary subtag, first supported entry of `navigator.languages`).

**The first paint is the hard part, and it fails silently in two directions.**
Every HTML file outside `/de/` is prerendered in English, and hydration must
match it. So:

- `useLocale()` answers "en" during hydration by construction
  (`useSyncExternalStore`'s server snapshot), and the store's `current` only
  becomes the reader's language in `<LocaleRoot>`'s layout effect, after
  hydration. Rendering German during hydration is a text mismatch React
  reports once in the console and then "fixes" by throwing the served DOM away.
- `LOCALE_SCRIPT` (`app/pre-paint.ts`) resolves the same answer before paint,
  writes `<html lang>`/`data-locale`, and sets `data-locale-pending` when it is
  not English. `globals.css` hides `[data-locale-gate]` — the app subtree, NOT
  `<body>` — until `<LocaleRoot>` removes the attribute in the same pre-paint
  flush as the German render. The script and `locale-store.ts` must resolve
  identically (`pre-paint.test.ts` runs both over the same inputs): if they
  disagree the gate lifts on the wrong language or waits for a switch that
  never comes. A 4 s failsafe lifts it anyway, because an English page beats an
  invisible one when a chunk fails to load. `locale-root.test.tsx` hydrates real
  prerendered HTML and fails on any console error.
- Native shells need nothing extra: they load the same export and the same
  script; `navigator.languages` is the device language. The preference mirror
  is `localStorage` (like the theme) — iOS evicting it costs one gated frame,
  not data.

**Formatting goes through `i18n/format.ts`, never `toLocale*(undefined)` and
never into anything a machine reads.** Intl with the rendered language and the
device's region (en-GB keeps "21 Aug", de-AT keeps „Jänner“).
`useFormatSettings()` now formats in the active locale. `formatDuration` /
`formatDurationShort` in shared take an optional locale: without one the
output is byte-identical to before — Raycast, CSV export and the server rely on
that — and `formatDurationFor` keeps English identical too. German prints
„1,50 h“ / „1 h 30 min“ with no-break spaces and no grouping, and
`parseDurationInput` and the importer accept comma and dot alike
(`duration.test.ts`, `import-values.test.ts`). CSV headers and values, the
importer, REST/tRPC error codes and `problem+json` types, webhook payloads and
OpenAPI docs are never localised. `weekStartsOn` stays a workspace setting
seeded to Monday: every member's "this week" must be the same seven days, so
`defaultWeekStart(locale)` applies only where no stored value exists.

**Public pages are built once per language.** English at `/`, German under
`/de/`: `app/de/**/page.tsx` are one-line re-exports of
`components/marketing/pages/*-page.tsx` with `locale="de"`, rendered at build
time with `marketingT(locale)` so the HTML crawlers fetch is already German.
`marketingMetadata` adds canonical, `hreflang` alternates (`x-default` =
English) and `og:locale`; `localizedPath` keeps internal links in the
language; `<MarketingShell locale path>` wraps the page in `<FixedLocale>`,
which pins it (it never follows the preference) and exempts it from the gate.
Not a `[locale]` segment: at the root it would compete with `/app/` and turn
unknown paths into marketing pages instead of the 404. The one thing `/de/`
cannot get is `lang="de"` on the served `<html>` (a second root layout means
moving every route into groups); the content wrapper carries `lang="de"` and
the script sets `<html lang>` before paint. Never put a date into an ICU
argument on a prerendered page: the build machine's zone would be baked in.

**Pseudo-locale:** `?locale=pseudo` (persisted; `?locale=off` clears) or the
Settings picker, in non-production builds only — `LOCALE_SCRIPT` for a
production build contains no trace of it. Accented, ~35 % longer, bracketed,
derived from English at runtime: unaccented text was never extracted, clipped
text will clip in German.

**Invoices are localised per document.** `Client.invoiceLocale` (optional)
and `createInvoiceSchema.locale` (override) feed `resolveInvoiceLocale`
(override → client → issuer's explicit preference → English), and the result
is snapshotted onto `Invoice.locale` like every figure on it: a re-render must
never change the language of a document a customer holds. The model field has
no default on purpose — an invoice without one predates localisation and is
English forever. Server strings: `packages/server/src/i18n/` (`serverT(locale,
"invoice" | "email" | "report")`), parity-tested in `tests/i18n-catalog.test.ts`.
A report PDF is written in the language the exporting device renders in
(`exportPdfSchema.locale`), else the exporter's explicit preference, else
English. Email goes out in the recipient's explicit preference, then — for an
invitation to an address with no account — the inviter's, then English; the
newsletter confirmation takes the subscribe form's page language.

**Browser extension:** its own catalog in `packages/extension/src/i18n/`,
resolved from the synced `settings.locale` with a synchronous `localStorage`
mirror, like its theme. Not `chrome.i18n`, which follows the browser's UI
language and cannot honour the account preference; `public/_locales` holds
only the manifest name and description (`__MSG_*__`, `default_locale: "en"`).

**Raycast stays English.** The Raycast Store accepts extensions in US English
only, and Raycast itself has no locale API to follow — a German Raycast would
be unpublishable. Never pass a locale to the shared duration helpers from
`packages/raycast`.

### Public pages and the app under `/app/`

The public pages (landing, `/extension/`, `/raycast/`, `/mobile/`, `/privacy/`,
`/support/`, `/de/…`) sit at the root; every signed-in screen is under `/app/`
(`packages/client/src/app/app/`, gated by its `layout.tsx`). Auth pages
(`/login`, `/signup`, `/forgot-password`, `/reset-password`, `/invite`) stay at
the root, because mailed links point at them. Three rules:

- **A public page never redirects a signed-in visitor on the web.** The header's
  `AccountLinks` swaps "Log in" / "Create an account" for "Open the app" after
  mount (never during hydration). `ShellEntryRedirect` on the landing page
  moves only Capacitor and Electron on to `/app/track`, since both
  load `index.html`, and it does not wait for a session.
- **Old root addresses answer 308 in `serve.mjs`** (`/track` →
  `/app/track`, query kept) for bookmarks, sent emails and installed extension
  and Raycast builds. `next dev` has no such redirect; the self-host Caddy
  proxies to the same `serve.mjs`. Never add a Next route named after one of
  `LEGACY_APP_SEGMENTS` at the root.
- **The API server links into `/app/`** — the device-flow `verificationUri`
  and the runaway reminder's link. Deploy the client first when changing a
  path, or those links point at a page the running client does not have.

### Static export caveats

- `NEXT_PUBLIC_API_URL` is baked at build time — desktop binaries are locked
  to whichever API URL they were built against; rebuild to retarget. The phone
  apps treat it as the default and let the person choose another server.
- No `rewrites()`, no `middleware.ts`, no server components with runtime
  data. Dynamic routes need `generateStaticParams`.
- `/docs/` belongs to the docs site copied into `out/` after the build. A Next
  route under `app/docs/` would be overwritten by it in the web image.
- Next `<Image>` uses the default loader only because `images.unoptimized`
  is set in `next.config.ts`.

## Environment & Secrets (dotenvx)

The server reads env through **[dotenvx](https://dotenvx.com)** — a drop-in
`dotenv` replacement that also decrypts values marked `encrypted:...`.
`packages/server/src/config/env.ts` loads `.env.production` when
`NODE_ENV=production` and `.env.development` otherwise, **if the file exists**.

```
packages/server/
  .env.example        plaintext, committed (reference, no real secrets)
  .env.development    plaintext, local-dev defaults (localhost). NOT in the
                      repo and not committable on a machine whose global
                      gitignore lists `.env.development` — copy it from
                      .env.example. Anything a fresh checkout must have
                      belongs in .env.example or in scripts/dev.mjs.
  .env.production     NOT tracked in this repo — a global gitignore rule
                      (~/.config/git/ignore) excludes .env.production, and
                      there is no such file on disk. Purely a local
                      convenience if you make one.
  .env.keys           DOTENV_PRIVATE_KEY_PRODUCTION, gitignored.
```

**Production env lives in Coolify's env fields, not in a file.** This is the
part that catches people out, because the starter this repo grew from shipped
a committed encrypted `.env.production` and dotenvx exists to decrypt exactly
that. Here there is nothing to decrypt: the file is untracked, and
`packages/server/Dockerfile`'s runtime stage copies only `dist`,
`package.json` and `node_modules`, so even an untracked local copy never
reaches the image. `DOTENV_PRIVATE_KEY_PRODUCTION` on its own therefore does
nothing in production. The compose files take every value as a `${VAR}`
substitution and Coolify fills them — that is the whole mechanism. See
`docs/deploy.md`.

Concretely: changing `BETTER_AUTH_URL`, `FRONTEND_URL` or `TRUSTED_ORIGINS`
means editing the **server app's env fields in Coolify** and redeploying. A
`dotenvx set ... -f .env.production` writes into a file production never
reads, deploys green, and leaves the server holding the old values with
nothing in the diff to point at.

### Running locally against production-shaped values

If you keep a local `packages/server/.env.production`, `.env.keys` is read
automatically — no extra step:

```bash
NODE_ENV=production pnpm --filter @starter/server start
```

That is the only thing that file is for. It is yours, it is not shared, and
nothing deploys from it.

### Encrypting a value in a local file

```bash
pnpm --filter @starter/server exec dotenvx set STRIPE_SECRET_KEY sk_live_... -f .env.production
pnpm --filter @starter/server exec dotenvx rotate -f .env.production
```

Both act on the local untracked file only. Keep `.env.keys` out of commits —
`.gitignore` enforces this.

## Code Style

- TypeScript strict mode everywhere. No `any` — use `unknown` and narrow.
- Prefer `const` over `let`. Never use `var`.
- Named exports only (no default exports except Next.js pages which require them).
- Explicit return types on all public/exported functions.
- Use `@starter/shared` for types shared between client and server.
- Use `@/` path alias for client-side imports within the client package.

## File Organization

```
packages/server/src/
  config/       — environment variables, app config
  db/           — database connections (mongoose, redis)
  models/       — Mongoose schemas and models
  auth/         — better-auth instance and config
  trpc/         — tRPC router, context, procedures
    routers/    — individual tRPC routers (one per domain)
  ws/           — WebSocket handler, room manager, auth
  services/     — external service integrations (Stripe, email)
  middleware/   — Express middleware (error handler, etc.)
  tests/        — server unit tests

packages/client/src/
  app/          — Next.js App Router pages
  lib/          — tRPC client, auth client, utilities
  providers/    — React context providers
  hooks/        — custom React hooks
  components/   — React components
    ui/         — shadcn/ui components
  styles/       — global CSS

packages/shared/src/
  protocol.ts   — WebSocket message types (discriminated unions)
  types.ts      — shared domain types
  schemas.ts    — Zod validation schemas
```

## Critical Middleware Ordering (Express)

The order in `app.ts` is load-bearing. Do not rearrange:

1. `better-auth` handler at `/api/auth/*` — BEFORE express.json (it handles its own body parsing)
2. Stripe webhook at `/api/stripe/webhook` with `express.raw()` — needs raw body for signature verification
3. `express.json()` + `express.urlencoded()` — JSON parsing for everything else
4. `helmet()` — security headers
5. `cors()` — CORS with credentials
6. `morgan()` — HTTP logging
7. tRPC middleware at `/api/trpc`
8. Health endpoint at `/api/health`
9. Error handlers (404 + 500) — must be last

## Environment Variables

- Always add new env vars to `.env.example` with a comment explaining the value
- Add sensible dev defaults to `.env.development` AND document them in
  `.env.example` — `.env.development` is a local file, not a committed one,
  so a value only there does not reach CI or another checkout. A value the
  dev stack must have is better set in `scripts/dev.mjs`, which passes it on
  the server's command line (and therefore wins over dotenvx, which does not
  overwrite an already-set key)
- Never commit `.env` or `.env.local` (these are gitignored)
- Server env vars: plain `process.env.X` via `config/env.ts`
- Client env vars: must be prefixed with `NEXT_PUBLIC_` to be available in the browser

## Testing Conventions

- **Server unit tests:** `node:test` module + `assert/strict`. Files in `packages/server/src/tests/*.test.ts`.
- **Client unit tests:** Vitest + @testing-library/react. Files colocated as `*.test.tsx`.
- **E2E tests:** Playwright. Files in `e2e/*.spec.ts`. Helpers in `e2e/helpers.ts`.
- Use `data-testid` attributes for E2E selectors, not CSS classes or text content.

## Commit Messages

Use conventional style: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.
Keep the first line under 72 characters. Add a blank line before any body text.

## Branch Naming

`feat/description`, `fix/description`, `refactor/description`.
