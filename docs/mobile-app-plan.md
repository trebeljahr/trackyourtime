# Track Your Time mobile app — implementation plan

Produced by a 13-agent design workflow: 4 codebase surveys, 3 rival designs, 3 judges (unanimous winner: **Thin Shell**), 1 synthesis, 2 adversarial critics.

## Implementation notes (added during Stage 1)

**Where the work runs.** In the git worktree
`.claude/worktrees/raycast-extension-commands-85460e`, where `pnpm run dev`
picks random ports. A mobile bundle bakes `NEXT_PUBLIC_API_URL` in at build
time and cannot follow a port that changes per run, so the dev stack is pinned
by hand to ports that cannot collide with the main checkout's 5159/3392:

```bash
API_PORT=51590 PORT=33920 pnpm run dev
NEXT_PUBLIC_API_URL=http://localhost:51590 pnpm build:mobile ios
```

**Corrections to the stage text**, made while implementing and carried forward:

- The flag is `RELATIVE_ASSET_PREFIX=1`, not `ELECTRON_BUILD=1` (see the
  critics' naming argument), and `NATIVE_BUILD` is gone entirely.
- `cap add` on Capacitor **8.3.4 applies neither `appId` nor `appName`** to the
  native projects — the critic finding is correct, and an earlier note here
  claiming the opposite was wrong. `@capacitor/cli/dist/ios/add.js` is a bare
  `extractTemplate()` call with no substitution step, and the shipped
  `assets/ios-spm-template.tar.gz` carries `PRODUCT_BUNDLE_IDENTIFIER =
  com.getcapacitor.App` in both configurations plus `CFBundleDisplayName = My
  App`. `assets/android-template.tar.gz` is the same story with `namespace =
  "com.getcapacitor.myapp"` and `applicationId "com.getcapacitor.app"`. So the
  identifiers are hand-edits in both trees, and `scripts/build-mobile.mjs`
  asserts them — for **iOS and Android alike** — so a placeholder cannot ship.
- The mobile export lives in `packages/client/out-mobile`, not the shared
  `out/`. With `output: "export"` a custom `distDir` **is** the out dir
  (`next/dist/export/utils.js hasCustomExportOutput`), which is what makes this
  a one-line change — and it is also why the internal build dir is always
  `.next`, so a live dev server for the checkout blocks a mobile build.
- `scripts/verify-native-export.mjs` was not created as a separate file; its
  three assertions are steps 5a-5c inside `scripts/build-mobile.mjs`, because
  the whole point of the critics' finding is that verification must run on the
  bytes that are about to be synced.
- The `CLIENT_STATIC_DIR` knob on `packages/client/serve.mjs` was dropped, per
  the critic finding that it had no caller.
- The API-reachability preflight warns rather than fails, because the dev-lock
  rule above means the API generally cannot be up during a build in this
  worktree. `--require-api` makes it fatal.

**Corrections found while implementing stage 1 (b) — bearer auth:**

- The Keychain plugin question is answered: `@aparajita/capacitor-secure-storage`
  8.0.0 ships a `Package.swift` against `capacitor-swift-pm` 8, links into the
  SPM app, and works. No fallback to `@capacitor/preferences` was needed, and
  the plan's "record it as debt" branch is closed.
- `NativeSessionGate.tsx` was **not** created. Per the critics' hydration
  finding, readiness is published as a store (`lib/native-session.ts` +
  `hooks/use-native-session.ts`) and the consumers gate behaviour; nothing gates
  the tree. Hydration is kicked off by `MobileBridgeLoader`, which the root
  layout already renders first.
- `resolveAuthBaseUrl` does **not** throw on native, per the critics: a
  module-scope throw stops React mounting, so `hideSplash()` never runs and the
  launch screen freezes with no console. `build-mobile.mjs` is the enforcement
  point.
- The `(protected)/layout.tsx` verdict is extracted to `lib/session-verdict.ts`
  so all three `getSession()` shapes — session, clean `{data:null,error:null}`,
  and a resolved HTTP error — are unit-tested. Only the clean one signs out.
- `createSyncClient` takes `token` as a value **or a getter**; `useSync` keys its
  effect on the token and on hydration having settled.
- The offline flush now rethrows on `isAuthError`, so a dead session stops it
  instead of deleting the queue one 401 at a time.
- Session lifetime set explicitly in its own `auth/session-lifetime.ts` —
  because the plan only argued it from phone behaviour, while
  `session.expiresIn` is one global number. It is now **scoped per client**:
  thirty days for a stored-token client, seven (better-auth's own default) for
  a browser cookie session, enforced by `databaseHooks.session.create.before`
  and `.update.before` together. The update hook is the half that is easy to
  miss — better-auth re-expires a refreshed session to the global value, so a
  create-only fix reverts itself the first time the session is used.
  `updateAge` stays at one day. The server also prints its resolved
  trusted-origin list at boot.
- **Two device-only traps cost real time and are written up in CLAUDE.md**:
  a simulator build with `CODE_SIGNING_ALLOWED=NO` gets
  `errSecMissingEntitlement (-34018)` from the Keychain and silently falls back
  to cookies; and returning a Capacitor plugin handle from an `async` function
  makes the promise machinery treat the Proxy as a thenable, which hangs the
  launch forever behind a splash that never auto-hides. `hydrateNativeSession`
  now also has a 5s deadline so no future plugin can freeze the app.

**Corrections found while implementing stage 2 — native chrome:**

- The pre-paint `html.cap` script goes at the **top of `<body>`**, not into the
  existing `THEME_SCRIPT` in `<head>`: `document.body` does not exist yet while
  the head is being parsed. `<body>` also carries `suppressHydrationWarning`,
  since React would otherwise complain about the class it did not render.
  Proven on device by disabling `bridge.ts`'s own two writes, rebuilding, and
  confirming the safe-area layout was still applied — so the class really does
  come from the pre-paint script and not from the bridge.
- The dialog's native anchoring zeroes **`--tw-translate-y`**, not `transform`.
  Tailwind v4's `translate-*` utilities compile to the `translate` PROPERTY
  (`.translate-x-[-50%]{--tw-translate-x:-50%;translate:var(--tw-translate-x)
  var(--tw-translate-y)}`), so a `transform: translateX(-50%)` would have
  applied *on top of* the untouched `translate` and pushed the panel a further
  half-width off the left edge.
- No `!important` on the 16px rule. `native.css` is unlayered while Tailwind's
  utilities are in `@layer utilities`, and an unlayered rule beats every layer
  regardless of specificity.
- The header needed a `data-testid="app-header"` and `DialogContent` a
  `data-slot="dialog-content"`; neither had a stable hook, and matching
  `[role="dialog"]` would also have caught the nav drawer.
- `entry-list.tsx`'s `STICKY_TOP` had to move to
  `var(--app-header-offset, 3.5rem)`, because it hardcoded the header's 3.5rem
  and the tracker bar's `top-14` and the header's height both change under the
  status-bar inset. The variable is set only under `html.cap`, so the fallback
  makes the web string identical to what it was.
- The Playwright phone project is **`devices["Pixel 5"]` (chromium)**, per the
  critics, and both projects are scoped (`testMatch` / `testIgnore`) so the
  suite is not run twice.
- Stage 2's own spec had to be rewritten once: `getComputedStyle().top` returns
  a used px value not `"50%"`, and the tracker composer's description carries
  an explicit `text-base`, so it is 16px on web too and the naive font-size
  assertion passed whether or not the rule leaked. Rewriting `html.cap` to
  `body` in native.css now fails 4 of the 7.
- **`@capacitor/keyboard` needed `resize: "native"`.** `"body"` leaves every
  `position: fixed` element — the sticky header, the tracker bar, stage 3's tab
  bar — behind the keyboard, and `"none"` leaves the focused field there.

**Stage 3 corrections**, likewise carried forward:

- `initMobile` no longer takes handlers that matter. The critics' finding was
  right and the fix is a module-level handler table plus an exported
  `setMobileHandlers(next)` returning its own teardown; the `backButton` and
  `appStateChange` listeners are now registered unconditionally on the first
  init and read *through* that table. The plan's "pass an `onBackButton`
  handler from AppShell down through `MobileBridgeLoader` into `initMobile`"
  would have registered nothing.
- **The back button's exit contract had to change with it.** The plan calls
  `handled === false && event.canGoBack === false → App.exitApp()` "the right
  contract", and it is not: adding a `backButton` listener overrides
  Capacitor's default, and a single-page app accumulates history entries just
  by moving between tabs, so `canGoBack` is nearly always true and the button
  became a silent no-op at the root — the one place it must exit. Now: if a
  handler is registered it is the whole authority (`false` means exit); if none
  is (the sign-in screen, which is outside `AppShell`), fall back to
  `history.back()` / `exitApp()` on `canGoBack`.
- The decision itself lives in `mobile/back-button.ts`, not inline in
  `AppShell`, so it is unit-testable without mounting the shell. Step 2 is a
  navigation to `/track`, not `router.back()`: history here is whatever the
  user browsed, so `back()` from three screens deep walks through them one at a
  time instead of returning to the root tab.
- Overlays register in `ui/dialog.tsx`'s `Dialog` wrapper — once, in the
  primitive — rather than in each of the app's eleven dialogs. Only a
  *controlled* dialog registers: an uncontrolled one has no `onOpenChange` to
  close it with, and an entry that back can pop but not close swallows the
  press and does nothing.
- `isActiveRoute` (and the `NavItem` type) moved to `lib/nav.ts`. The plan says
  to reuse the one exported from `app-shell.tsx`, but the shell renders the tab
  bar, so importing it back would be a cycle whose resolution depends on which
  module the bundler reaches first — and `isActiveRoute` is a `const`, so the
  losing order is a TDZ error, not a warning. `app-shell.tsx` re-exports both.
- The bar is hidden with Tailwind's `hidden` utility and revealed by a single
  `html.cap` rule, so `native.css` stays entirely `html.cap`-scoped — the file's
  one rule. `--app-tab-bar-offset` (3.5rem + the bottom inset) is the single
  number the bar's height and `app-main`'s padding both read.
- Exactly one tab is ever lit: while the drawer is open it is More, even
  standing on `/track`. More is also lit on any route no tab owns (`/settings`,
  `/calendar`), because a bar with nothing lit reads as broken.
- Stage 9 still owns the real Android verification. The back button cannot be
  pressed on iOS, so the contract above is covered by a unit test against
  faked Capacitor plugins (`mobile/bridge-handlers.test.ts`, which fails 7/7
  against the pre-stage-3 bridge) rather than by a device.

**Stage 4 corrections**, likewise carried forward:

- `getOfflineQueue()`'s memoisation needs no ordering point after all. The plan
  names `NativeSessionGate`'s boot as the moment the native branch has to be
  decided by; the branch is `isNative()`, a synchronous read of
  `window.Capacitor`, which the native bridge injects before any application
  code runs. So it is decidable on the very first call and there is no window
  to get wrong. The Preferences adapter is therefore built synchronously and
  loads the plugin lazily inside its own methods.
- The plan's `resolveStorage()` swap is not enough on its own: the one-time
  hand-over of whatever a previous build left in `localStorage` is what makes
  the change of address safe. It lives in the adapter, behind a
  `trackyourtime.preferences-migrated` marker in Preferences, and removes the
  `localStorage` copy so a rollback cannot replay rows this build has flushed.
- **The queueing mutations had to move to `networkMode: "always"`.** Nothing
  in the plan mentions this and it is not optional. React Query *pauses* a
  mutation while `onlineManager` reports offline: `mutationFn` never runs and
  `onError` never fires — and `onError` is exactly where
  `use-entry-mutations.ts` queues. The moment `@capacitor/network` gives
  `onlineManager` the truth about a dead radio, start/stop in airplane mode
  would have silently done nothing at all. The offline queue *is* this app's
  pause mechanism, and it needs the failure to happen. It was first set as a
  global `defaultOptions.mutations` and that was wrong: it applied to every
  non-queueing mutation in the web app as well, replacing pause-and-resume
  with an immediate rollback and an error toast. It is now
  `OFFLINE_QUEUED_MUTATION`, spread into the three families that catch the
  failure. Queries keep the default, where pausing is right.
- The resume order is the critics': reconnect → tick → flush, and refetch
  `entries.current` *only* when nothing was queued. It is a pure function
  (`runResume`) so the ordering is tested without a bridge, a socket or a tree.
- `createSyncClient` gained a `reconnect()` rather than the caller doing
  `close()` then `connect()`. Doing it by hand has a trap: the old socket's
  close event arrives *after* the new socket exists, and every handler was
  unconditional — so it nulled the reference to the live socket, reported
  "closed", and scheduled a reconnect that opened a third. Handlers now check
  they still speak for the current socket.
- The queued `entries.stop` is targeted wherever possible instead of only being
  age-limited. A stop for a timer that already had a real id is now queued
  *with* it; a stop for a timer started offline carries the temp id and the
  replay threads in the real id its start was given moments earlier in the same
  flush. Only what is left over — no id, no resolvable temp id, queued more
  than 24h ago — is refused, and said out loud rather than binned.
- `mobile/durable.ts` deleted, as planned. It was the only code that could have
  mirrored the queue across, which is why the migration above had to exist
  first.
- **No `NativeSessionGate` is involved anywhere**, since stage 1 did not build
  one. The boot seed runs from `MobileBridgeLoader`, which the root layout
  renders first.
- **Moving the queue mount above the route needed one more fix than the plan
  says**, and it is a web fix. Draining on every route surfaced a hazard that
  the old mount had been hiding: a full page navigation aborts the requests in
  flight, an aborted fetch is indistinguishable from a failed one, so the
  mutation was queued — and the *next document* replayed it, duplicating an
  entry the server already had. Previously the replay only happened if the
  user came back to `/track`. The guess is wrong on its own terms: the request
  was fully written before the document died, so the server has almost always
  processed it and only the response was lost. A mutation that fails while the
  page is being torn down is therefore not queued. Web only — the native
  shells never tear their document down, and `pagehide` fires there for
  backgrounding, so a latched flag on a phone would silently stop queueing
  offline work. Verified on device: a background/foreground cycle with the API
  down still queues.
- The critics' `[low]` clock-skew finding is closed with the cheap half they
  suggested: `clockLooksWrong()` in `use-sync.ts` and a badge in the tracker
  bar. No server clock offset — a timer frozen at 0:00 is now labelled rather
  than silently wrong, which is what turns it from an unexplainable bug into a
  settings change.

**Stage 9 corrections**, from actually running it:

- **`cap add` DOES write the identifiers, and this document has been wrong
  about it three times.** The critic finding at the bottom of this file reads
  `@capacitor/cli/dist/android/add.js` (and the iOS one), sees a bare
  `extractTemplate()`, and concludes the template's `com.getcapacitor`
  placeholders survive. They do not: `dist/tasks/add.js` calls
  `editProjectSettingsIOS` / `editProjectSettingsAndroid` immediately after,
  which rewrite `applicationId`, `namespace`, `res/values/strings.xml`,
  `PRODUCT_BUNDLE_IDENTIFIER` and `CFBundleDisplayName`. `pnpm cap:add:android`
  produced `com.trebeljahr.trackyourtime` / "TrackYourTime" with no hand-editing at
  all. The assertions in `scripts/build-mobile.mjs` stay, because those edits
  happen exactly once and `cap sync` never revisits them — the drift they catch
  is a later `appId` change, not the initial add. What DID need hand-editing:
  `versionName`, which `cap add` leaves at the template's `1.0`.
- **The Android WebView needs a cleartext exception, and `server.cleartext`
  does not provide one.** Android blocks cleartext for `targetSdk` 28+, and
  Capacitor 8's Android runtime contains no reference to the `cleartext` config
  key at all — so a dev build against a local API dies with
  `ERR_CLEARTEXT_NOT_PERMITTED`, which reads like a wrong port. The fix is
  `app/src/debug/res/xml/network_security_config.xml` plus a one-attribute
  debug manifest overlay; release builds get no exception, which is stricter
  than the iOS `Info.plist`.
- **A bundled Android build cannot reach the host at `10.0.2.2` over http.**
  Its document origin is `https://localhost`, and an https document fetching a
  plain-http URL is blocked as mixed content unless the target is a loopback
  address. `adb reverse tcp:<port> tcp:<port>` plus a baked
  `http://localhost:<port>` is the way in, and it works on a physical device
  over USB too. `10.0.2.2` remains right for `dev:android`, where the document
  is itself http.
- **`pnpm dev:android` did not work at all, for two more reasons than the plan
  names.** Next 16 blocks cross-origin `/_next` dev resources, so the WebView
  got the document and none of the chunks and hung on a splash that
  `launchAutoHide: false` never hides; and the dev server's origin is what the
  API sees under live reload, so every request failed CORS. Both are now
  handled by the script (`NEXT_DEV_ORIGINS`) and by `scripts/dev.mjs` (the
  live-reload origin joins the trusted list).
- **`build:mobile` now picks platforms by toolchain, not by directory.** With
  both trees committed, "the platform exists" stopped meaning "this machine can
  build it". An explicitly named platform still fails loudly.
- **The signing block the stage text asks for was NOT added**, on instruction:
  release signing is its own stage. `mobile-release.yml` says out loud that the
  AAB it produces is unsigned and that the three keystore secrets it passes are
  read by nothing, so a green build cannot be mistaken for an uploadable one.
- **The hardware back button behaves as designed**, verified on an emulator for
  all three rules. The press contract is not one press, though, and the
  acceptance criterion in stage 9 said it was; it now says this instead. With
  the IME showing — or a field focused while a hardware keyboard is attached,
  which is the emulator's default and is what cost an hour of misdiagnosis —
  Android gives the *first* press to the input method, which dismisses the
  keyboard. The WebView never receives that press, so `handleBackPress` is not
  called and the dialog is still open, exactly as it should be: back dismissing
  the keyboard before anything else is what a phone user expects. The second
  press reaches the app and closes the dialog. With nothing focused, one press.
  `dumpsys input_method | grep mInputShown` settles which case you are in.
- **Do not "fix" that by hiding the keyboard from the back handler.** Calling
  `Keyboard.hide()` so the dialog can close on the first press spends the press
  Android had already spent, and takes away the only button that dismisses an
  IME. `mobile/back-button.ts` therefore imports nothing from
  `@capacitor/keyboard`, and a test asserts it stays that way — the correction
  here is to the criterion, not to the code.

**Phone-UI review corrections** (post-implementation, from the adversarial
review). Each of these contradicts something written above; the code is right
and the earlier note is the record of what was believed at the time.

- **The pre-paint marker moved to `<html>`, and the script with it into
  `<head>`.** The stage-2 note above says it must be at the top of `<body>`
  because `document.body` does not exist during head parsing. True, and beside
  the point: `document.documentElement` does, and marking <html> instead is
  strictly better. Writing to `<body>` before hydration is what forced
  `suppressHydrationWarning` onto `<body>` — an attribute that does not scope
  itself to the one mismatch that needed it and silences every body-level
  mismatch the web app will ever have. `<html>` already carried the attribute
  for the theme script. Every `html.cap` selector in `native.css` is now
  `html.cap`. The scripts moved to `app/pre-paint.ts` so a test can reach them:
  a layout module may only export what Next recognises.
- **`viewport-fit=cover` reaches every host, and the installed PWA is the one
  that suffers.** The `viewport` export is static and one static export serves
  browser, PWA and both shells, so there is no build to withhold it from.
  A normal mobile browser applies no insets, but `manifest.json` declares
  `"display": "standalone"`, so an installed PWA gets the real insets and none
  of `native.css`. `styles/standalone.css` is the answer — `@media
  (display-mode: standalone)` copies of the header / tracker-bar / main /
  drawer / dialog rules, every selector under `html:not(.cap)` so they cannot
  stack with the native ones. Deliberately a separate file: `native.css` earns
  its safety from being inert by construction, and these rules are not.
  Chromium cannot be put into standalone display mode from a test
  (`Emulation.setEmulatedMedia` ignores a `display-mode` feature — measured),
  so the phone project asserts the shipped `@media` block out of
  `document.styleSheets` instead of measuring the layout.
- **A popover is not a dialog and CSS cannot anchor one.** `native.css`
  anchored `[data-slot="dialog-content"]` under the inset and left popovers to
  Radix's `collisionPadding`, which Floating UI measures against the layout
  viewport — under `viewport-fit=cover`, the one that runs under the Dynamic
  Island. No stylesheet can fix it: the popper wrapper's `transform` is inline
  and computed from those measurements. `native.css` therefore publishes the
  four insets as custom properties, `lib/safe-area.ts` reads them, and
  `ui/popover.tsx` widens `collisionPadding` for every popover in the app.
  `collisionBoundary` is not the alternative it looks like — passing one sets
  `altBoundary: true` in @radix-ui/react-popper, which flips detectOverflow to
  measure the reference element instead of the floating one.
- **WebKit refuses author `box-sizing` on a date input.** Measured on iOS 26 at
  402pt: `<Input type="date">` computed `box-sizing: content-box` with the `*`
  reset losing, so `width: 100%` became a used width 26px larger once `px-3`
  and the border were added outside it — 25px past the dialog's padding, 5px
  off the screen. `appearance: none` is the only fix; `box-sizing: border-box
  !important`, `max-width: 100%` and `min-width: 0` were each measured on the
  device and each changed nothing. The rule is in `globals.css`, not
  `native.css`: it is a WebKit behaviour, so desktop Safari does it too, and it
  is a measured no-op in Blink. `time` and `datetime-local` behave identically
  and are covered by the same rule.

## Summary

Ship the phone app as the existing Next.js client inside a Capacitor shell — one composition, not a second UI. Everything mobile is either scoped to `html.cap` (a class `packages/client/src/mobile/bridge.ts:30` already sets and nothing styles), behind the synchronous `isNative()` check in that same file, or a correctness fix the web build also wants. No new screens for reports, timesheet, invoices or catalog; they stay honestly cramped one level down. Cookie auth is abandoned for native (a `capacitor://localhost` document is cross-site to the API and loses to WKWebView ITP regardless of SameSite) in favour of the bearer path `packages/core/src/session-auth.ts` was written for — which needs zero server code, only `TRUSTED_ORIGINS`. Stage 1 ends with a signed-in app on the iOS Simulator starting and stopping a real timer against `pnpm run dev`, verified against a real `pnpm build:mobile` bundle rather than live reload, because under live reload the document origin is `http://localhost:7130`, which is same-site with a localhost API and would make cookie auth misleadingly appear to work. Later stages add native chrome, a three-tab bar, resume/offline durability, calendar touch de-hostility, and two zero-custom-native wins (haptics, a runaway-timer local notification). No Swift, no Kotlin, no widget extension, no second HTTP client — the judges called all of that the fatal path.

## Decisions

### One UI, gated by `html.cap` and `isNative()` — no second mobile composition, no build-time shell split, no mobile-only routes.

**Why:** `bridge.ts:30-31` already writes `document.body.classList.add("cap")` and `data-platform`, and a repo-wide grep shows nothing styles either — a native-only CSS seam is installed and unused. `isNative()` (bridge.ts:78-82) is a synchronous `window.Capacitor` read, so it needs no async state and produces no flash. Unbuilt UI cannot drift, cannot regress, and costs nothing to maintain in a repo where one person already keeps a web app, a browser extension, Raycast and Electron in step over `@starter/core`.

**Rejected:** A second export driven by `NEXT_PUBLIC_APP_SHELL` plus a `@/shell` webpack/turbopack alias, with MobileTimerScreen / MobileLogScreen / MobileEntryCard / MobileEntrySheet built in parallel. Stronger non-regression guarantee, but it permanently doubles client CI, hides which component renders behind an alias tsc and the IDE never see, and forks the product's three core verbs — its own author conceded the two timer surfaces would drift.

### Bearer token in Keychain (`@aparajita/capacitor-secure-storage`), not `@capacitor/preferences`.

**Why:** `packages/core/src/session-auth.ts:19-21` states the requirement in the file the token comes from: it "deserves the platform's real secret storage (Keychain, `chrome.storage.session`, the Raycast password store) — never a plain config file." `@capacitor/preferences` is plain UserDefaults. Preferences stays correct for the offline queue and the running-entry mirror — data, not a credential.

**Rejected:** Preferences for everything (simpler, one dependency fewer). All three judges flagged it as the one thing in the favoured design they would not merge as written.

### `signIn.email` through the existing `/login` page and the existing `authClient`, capturing the `set-auth-token` response header — not the RFC 8628 device flow.

**Why:** The device flow assumes a second, already-signed-in browser; on a phone that browser is often the thing being replaced. `packages/client/src/app/login/page.tsx:22` already calls `signIn.email` through `authClient`, so adding a `fetchOptions.onSuccess` hook there is one code path, not two. `"trackyourtime-mobile"` is already in `ClientId` (session-auth.ts:29) and already labelled "Mobile app" by `packages/server/src/auth/client-label.ts:17`, so the session names itself in Settings → Devices with no server change.

**Rejected:** `startDeviceAuthorization` + `pollForDeviceSession` from `@starter/core`, as CLAUDE.md prescribes for Raycast. Correct there, absurd here.

### Split the native asset prefix: `assetPrefix: "./"` becomes conditional on a new `ELECTRON_BUILD=1`, set by `build:desktop`, `electron:build`, `electron:preview` and `build:tauri`. The Capacitor build gets root-absolute `/_next/...`.

**Why:** Verified in `node_modules/@capacitor/ios/Capacitor/Capacitor/Router.swift`: `CapacitorRouter.route(for:)` returns `basePath + "/index.html"` when `pathUrl.pathExtension.isEmpty` and `basePath + path` otherwise — i.e. every asset is resolved absolutely from the public root. With `trailingSlash: true`, a chunk requested as `./_next/…` after a client-side navigation to `/track/` resolves to `/track/_next/…`, which has an extension, so the handler looks for a file that does not exist and the screen goes blank behind a splash that `launchAutoHide: false` never hides. It survives today only because the WebView always boots at `/`. The comment at `packages/client/next.config.ts:5-11` documents this bug for the web build and asserts native needs the prefix — that half is wrong for Capacitor.

**Rejected:** Leaving `NATIVE_BUILD=1` as the single gate. Also rejected: dropping the prefix for Tauri at the same time — `tauri://localhost` is likely root-absolute too, but nothing in this session can test it, so Tauri keeps byte-identical behaviour by getting `ELECTRON_BUILD=1` as well.

### Commit the generated `ios/` (and later `android/`) trees; remove lines 35-36 of `.gitignore`.

**Why:** Every hand-edit a shipping app needs — Info.plist keys (ATS for a localhost dev API, `NSFaceIDUsageDescription`, URL types), entitlements, the Gradle signing config — lives in those trees. `.github/workflows/mobile-release.yml` already assumes they exist in a fresh CI checkout while never running `cap add`, so the workflow cannot work at all until this changes. The ignore block's own comment invites it.

**Rejected:** Generate in CI plus a patch mechanism. Cheaper to reverse, but it means native config lives in a script nobody reads and CI is the only place the real project exists.

### On native, treat a failed `getSession()` in `packages/client/src/app/(protected)/layout.tsx` as "stay in" when a token is stored, instead of `setRecheck("out")` → `router.replace("/login")`.

**Why:** That `.catch()` (lines 43-47) is the single line that decides whether the app works offline. Its own comment says a network failure is not proof of being signed out — and then redirects anyway. On a phone, cold-launch-without-network is the normal case, and today it lands a validly-signed-in user on a login screen they cannot complete. Every downstream offline feature is unreachable behind it.

**Rejected:** Leaving it and relying on the running-entry mirror alone. The mirror renders behind the redirect; the two are complementary halves, and only both together produce an app that opens on the subway.

### Keep `@starter/core` unchanged. The Capacitor Preferences adapter lives in `packages/client/src/mobile/`, behind the existing `KeyValueStorage` interface.

**Why:** `packages/core/src/storage.ts:6-10` is already the right async 3-method contract and its doc comment already names Capacitor Preferences as a target host. Core is shared with Raycast and the extension; adding a Capacitor import there would pull a native dependency into two clients that must never have one.

**Rejected:** A `capacitorStorage()` export in core next to `webStorage()`.

### Delete `packages/client/src/mobile/durable.ts` rather than wiring it.

**Why:** It is imported by nothing. Its localStorage-mirror model also cannot guarantee ordering: `getOfflineQueue()` memoizes `queue` on first call (`packages/client/src/lib/offline.ts:57-64`), so a mirror that hydrates asynchronously can lose to the first read. A Preferences-backed `KeyValueStorage` makes Preferences the queue's actual store, which has no hydration race.

**Rejected:** Keeping both. Two persistence stories that can disagree about which holds the truth.

### Three tabs — Track, Reports (→ `/reports`), More — and Calendar is deliberately not one.

**Why:** Same argument the Raycast extension already makes for its four commands: a tab is a permanent claim on thumb space, and adding a surface is the change to argue about. Calendar and the wide reports are the screens that read worst on a phone; promoting them advertises the app's weakest surface. `/reports` opens on Totals, the report view that genuinely works narrow — `kpi-row.tsx:28` is already `sm:grid-cols-2 xl:grid-cols-4` and the charts use recharts `ResponsiveContainer`.

**Rejected:** Five tabs including Calendar and Reports; and a Timer FAB, which would be a second start affordance that can disagree with the sticky tracker bar.

### Fix the calendar only where it is destructive on touch — never build a phone gesture model.

**Why:** `packages/client/src/components/calendar/time-grid.tsx:640`, `entry-block.tsx:130/144/153` and `density-cluster.tsx:106` hardcode `touchAction: "none"`, which makes the grid body unscrollable with a finger while turning every stray drag into a new entry. That is data corruption, not ugliness. A coarse-pointer guard fixes both without touching the mouse path, so every existing calendar e2e spec exercises the same branch.

**Rejected:** Long-press-to-drag, pinch-to-zoom, a phone-only day-list view. All better; all gesture work, which is where mobile projects lose their schedule, and none of it is start/stop/edit.

### Add `.cap-touch` (44pt minimum, scoped under `html.cap`) to the six controls the phone's core loop touches. Do not change `packages/client/src/components/ui/button.tsx` or `input.tsx`.

**Why:** Those primitives back every desktop screen; raising `h-9` to `h-11` re-lays-out the whole web app to fix a phone. A class with no rule outside `html.cap` is inert on web by construction rather than by test.

**Rejected:** Raising the base sizes; and a global `[data-shell="mobile"] button { min-height: 44px }` sweep, which silently relayouts the calendar toolbar, the catalog tables and the timesheet unpin button with a screenshot test as the only detector.

### 16px `font-size` on inputs under `html.cap`, not `maximumScale: 1` / `userScalable: false`.

**Why:** iOS auto-zooms on focus for any field under 16px, and every `Input` is `text-sm` (ui/input.tsx:15). Pinning maximum-scale fixes it and is an accessibility regression that would apply to the web build too.

**Rejected:** `maximumScale` in the `viewport` export.

### No Live Activity, no Dynamic Island, no custom Kotlin notification plugin, no Quick Settings tile, no Siri/App Intents, no Swift API client. Take only the zero-custom-native half: haptics, and a runaway-timer local notification scheduled at `start + maxHours`.

**Why:** The lock-screen design's own keystone insight is right and worth recording — because `packages/core/src/timer-store.ts` derives elapsed from `entry.start` against the wall clock and never accumulates, and both OS surfaces tick from a timestamp inside the system process, nothing needs to run while suspended. But its payload was a hand-created Xcode Widget Extension target (a GUI operation that survives no review and no `cap sync`), two Kotlin files, and eventually a second implementation of `entries.start` in Swift with no offline queue and no compile-time coupling to tRPC. The runaway notification, by contrast, is pure arithmetic plus one plugin, works with the app killed and the radio off, and fills a real hole: `enforceMaxEntryDuration` has no scheduler — it fires only on `entries.current` reads, on `entries.start`, and on ws reconnect (`packages/server/src/ws/handler.ts:95-104`).

**Rejected:** The full lock-screen-first plan. Also rejected: BGTaskScheduler, an Android foreground service, silent push, and `@capacitor/push-notifications` — all unnecessary given the derived-elapsed timer, and all of them battery/review liabilities.

### Verify Stage 1 against a real `pnpm build:mobile` bundle, never `pnpm dev:ios`.

**Why:** When `CAP_DEV_URL` is set, `capacitor.config.ts:29-33` points the WebView at the Next dev server, so the document origin in live reload is `http://localhost:7130` — the same *site* as an API on `http://localhost:5159`, since port is not part of a site. A SameSite=Lax cookie is therefore sent, cookie auth appears to work, and the identical code fails from `capacitor://localhost` in the release bundle.

**Rejected:** Using the existing live-reload loop as the acceptance environment.

## Stages

### Stage 1 — iOS project on disk, correct native export, bearer auth — a timer you can start on the Simulator

- depends on: nothing · parallel-safe: False
- files: `/Users/rico/projects/tracktime/capacitor.config.ts`, `/Users/rico/projects/tracktime/.gitignore`, `/Users/rico/projects/tracktime/package.json`, `/Users/rico/projects/tracktime/scripts/build-mobile.mjs`, `/Users/rico/projects/tracktime/scripts/verify-native-export.mjs`, `/Users/rico/projects/tracktime/packages/client/next.config.ts`, `/Users/rico/projects/tracktime/packages/client/serve.mjs`, `/Users/rico/projects/tracktime/packages/client/src/lib/native-session.ts`, `/Users/rico/projects/tracktime/packages/client/src/lib/auth-client.ts`, `/Users/rico/projects/tracktime/packages/client/src/lib/trpc.ts`, `/Users/rico/projects/tracktime/packages/client/src/hooks/use-sync.ts`, `/Users/rico/projects/tracktime/packages/client/src/mobile/NativeSessionGate.tsx`, `/Users/rico/projects/tracktime/packages/client/src/app/layout.tsx`, `/Users/rico/projects/tracktime/packages/client/src/app/(protected)/layout.tsx`, `/Users/rico/projects/tracktime/packages/client/src/lib/entry-source.ts`, `/Users/rico/projects/tracktime/packages/client/src/components/tracker/use-entry-mutations.ts`, `/Users/rico/projects/tracktime/packages/client/src/components/calendar/use-calendar-entries.ts`, `/Users/rico/projects/tracktime/packages/client/src/components/timesheet/use-timesheet-mutations.ts`, `/Users/rico/projects/tracktime/packages/server/.env.development`, `/Users/rico/projects/tracktime/ios/App/App/Info.plist`, `/Users/rico/projects/tracktime/ios/`

**Work**

BLOCKED until open question 1 (bundle identifier) is answered — `cap add ios` stamps `appId` into `ios/App/App.xcodeproj/project.pbxproj` as PRODUCT_BUNDLE_IDENTIFIER and later edits to capacitor.config.ts do not rewrite it.

(a) Build correctness. In next.config.ts replace `isNativeBuild && !isDev` on the `assetPrefix` line with a new `isElectronBuild = process.env.ELECTRON_BUILD === "1"`, and set `ELECTRON_BUILD=1` alongside the existing `NATIVE_BUILD=1` in `build:desktop`, `electron:build`, `electron:preview` and `build:tauri` so those three targets are byte-identical to today. Rewrite the comment block at next.config.ts:5-11, which currently asserts the Capacitor bundle needs relative paths — it does not (see Decisions). Add `scripts/build-mobile.mjs`: refuse to run when `NEXT_PUBLIC_API_URL` is unset, `delete` any inherited `NEXT_DIST_DIR` from the child env (scripts/dev.mjs:237 sets it per-worktree, and inheriting it puts the export in `.next-*` so `cap sync` fails naming a missing webDir rather than the cause), then run the client build and `cap sync`. Point `build:mobile` and `cap:add:*` at it. Add `scripts/verify-native-export.mjs`: build the native export, assert no emitted HTML contains `"./_next`, assert `packages/client/out/index.html` exists, and assert the configured `NEXT_PUBLIC_API_URL` literal actually appears in an emitted chunk (an unset GitHub secret otherwise ships a store binary bound to `capacitor://localhost` with a green build). Give `packages/client/serve.mjs` a `CLIENT_STATIC_DIR` override on its `ROOT` constant (default unchanged) so the native artifact can be served by the same server production runs.

(b) Native project. Set the real `appId` in capacitor.config.ts and mirror it into the electron-builder `build.appId` in package.json (both are `com.example.trackyourtime` today). Drop `backgroundColor: "#ffffff"` and the white SplashScreen `backgroundColor` in favour of the app's own theme values — `app/layout.tsx:27` applies a real dark theme pre-paint, so a dark-mode user currently gets a white flash and white rubber-band gutters. Remove `ios/` from .gitignore (line 35). `pnpm add @aparajita/capacitor-secure-storage` at the repo root — check its peer range against `@capacitor/core` 8.3.4 first; if it does not support Capacitor 8, keep `@capacitor/preferences` behind the same `native-session.ts` seam and record it as debt rather than blocking. Run `pnpm cap:add:ios`, then `pnpm mobile:assets` (resources/icon.png and resources/splash.png already exist and are real, generated by scripts/icons-brand.mjs). Add an `NSAppTransportSecurity` dict with `NSAllowsLocalNetworking: true` to `ios/App/App/Info.plist` — the SPM template ships no ATS keys and iOS blocks cleartext by default, so an `http://localhost:5159` dev API is otherwise unreachable from the Simulator. Commit the whole `ios/` tree.

(c) Bearer auth, additive and native-gated. New `packages/client/src/lib/native-session.ts`: module-level token with a synchronous `getNativeToken()`, plus async `hydrateNativeSession()` / `setNativeToken()` / `clearNativeToken()` over secure storage; every function is an inert null-returning no-op when `!isNative()`. In auth-client.ts add `fetchOptions.auth = { type: "Bearer", token: () => getNativeToken() ?? undefined }` (verified: `@better-fetch/fetch@1.1.21` dist/index.d.ts:638-640 types `token` as `typeOrTypeReturning<string | undefined | Promise<string | undefined>>`, and undefined omits the header), an `onSuccess` that reads the `set-auth-token` response header into storage, `x-trackyourtime-client: isNative() ? "trackyourtime-mobile" : "web"`, and a `clearNativeToken()` on signOut; also make `resolveAuthBaseUrl` throw loudly on native when `NEXT_PUBLIC_API_URL` is unset instead of silently returning `capacitor://localhost/api/auth`. In trpc.ts, when a native token exists add `authorization: Bearer <token>` in the `headers` callback and set `credentials: "omit"` in the `fetch` wrapper; with no token both stay exactly as they are. In use-sync.ts pass `token: getNativeToken() ?? undefined` into `createSyncClient` — both ends already implement it (`packages/core/src/sync-client.ts:33-41` offers `bearer.<token>` as a subprotocol, `ws/handler.ts:25-29` selects it, `ws/auth.ts:27-38` reads it).

(d) Ordering and offline tolerance. New `packages/client/src/mobile/NativeSessionGate.tsx`, wrapping `AuthProvider` in app/layout.tsx: renders nothing until `hydrateNativeSession()` resolves on native, and returns children on the first pass on web because `isNative()` is synchronous. Without it the root `useSession()` fires tokenless on every cold launch, resolves null, and ProtectedLayout redirects a signed-in user to /login. In `(protected)/layout.tsx`, change the `getSession()` `.catch()` (lines 43-47) so that on native with a stored token it resolves `"in"` rather than `"out"`.

(e) Attribution. New `packages/client/src/lib/entry-source.ts` exporting a platform-derived `entrySource()`; replace the hardcoded `source: "web"` at use-entry-mutations.ts:592 and :701, use-calendar-entries.ts:250, and use-timesheet-mutations.ts:223. `EntrySource` already includes `"mobile"` (packages/shared/src/types.ts:99-106) and the field is not backfillable, so it must land before the first phone-tracked entry.

(f) Server config, dev only. Add `TRUSTED_ORIGINS=capacitor://localhost,https://localhost` to `packages/server/.env.development` (the file is absent in a fresh worktree; `packages/server/.env.example:18` documents the exact value). Production is stage 8 and is the user's own dotenvx + redeploy.

**Verification**

Non-regression, run first and last: `pnpm typecheck`, `pnpm test:client`, and `pnpm test:e2e` (needs `pnpm dev:infra`) all green with zero spec edits. Add one client unit test asserting that with no native token the tRPC headers contain no `authorization` key and `credentials` is still `"include"` — the web request path proved identical rather than assumed. Confirm the web export is untouched: `pnpm build:client && grep -c '"/_next/' packages/client/out/track/index.html` is non-zero and no `"./_next` appears.

Build correctness: `node scripts/verify-native-export.mjs` passes; assert it FAILS first by temporarily restoring the `./` prefix. `CLIENT_STATIC_DIR=packages/client/out PORT=49790 node packages/client/serve.mjs`, then load `/`, hard-load `/track/` and `/reports/` in a browser and confirm no request 404s in DevTools. `pnpm build:mobile` with `NEXT_PUBLIC_API_URL` unset exits non-zero naming the cause.

Acceptance (the point of this stage): with `pnpm run dev` up (API on 5159), run `NEXT_PUBLIC_API_URL=http://localhost:5159 pnpm build:mobile` then `pnpm cap:run:ios` — NOT `pnpm dev:ios`, whose `http://localhost:7130` origin is same-site with the API and would make cookie auth misleadingly appear to work. In the Simulator: sign in with a real account, confirm the entries list loads, start a timer, confirm the clock ticks, stop it, and confirm the stopped entry appears in the list. In a desktop browser on the same dev server, confirm the new session shows as "Mobile app" in Settings → Devices, that the phone-started entry is present with `source: "mobile"` (check via the API or the DB), and that starting a timer on the web appears on the phone within a second (proves the bearer subprotocol reached `ws/auth.ts`). Then sign that device row out from the web and confirm both HTTP and the socket drop on the phone. If sign-in returns 403 INVALID_ORIGIN, `TRUSTED_ORIGINS` did not take; if the sync dot never opens, check the server log for `[ws] upgrade refused: untrusted origin`.

### Stage 2 — Native chrome — safe areas, keyboard, 16px fields, tap targets, and a phone-viewport regression net

- depends on: [1] · parallel-safe: False
- files: `/Users/rico/projects/tracktime/packages/client/src/app/layout.tsx`, `/Users/rico/projects/tracktime/packages/client/src/styles/native.css`, `/Users/rico/projects/tracktime/packages/client/src/styles/globals.css`, `/Users/rico/projects/tracktime/packages/client/src/mobile/bridge.ts`, `/Users/rico/projects/tracktime/packages/client/src/components/tracker/tracker-bar.tsx`, `/Users/rico/projects/tracktime/packages/client/src/components/tracker/entry-row.tsx`, `/Users/rico/projects/tracktime/capacitor.config.ts`, `/Users/rico/projects/tracktime/package.json`, `/Users/rico/projects/tracktime/playwright.config.ts`, `/Users/rico/projects/tracktime/e2e/mobile-shell.spec.ts`

**Work**

Add `viewportFit: "cover"` and `interactiveWidget: "resizes-content"` to the `viewport` export in app/layout.tsx (currently only `themeColor`). `viewport-fit=cover` is the gating change for everything else here — without it `env(safe-area-inset-*)` resolves to 0 in WKWebView and no inset CSS can work at all. In the same file, extend the existing pre-paint THEME_SCRIPT to add `cap` and `data-platform` to `document.body` when `window.Capacitor` is present: `bridge.ts` sets them only after `Promise.all([import("@capacitor/core"), …])` resolves (line 30, after the await), so today every `html.cap` rule would apply a frame or two late and produce a visible reflow under the notch on every launch. Keep the bridge's own writes — they are idempotent.

New `packages/client/src/styles/native.css`, imported by one line from globals.css, every rule scoped under `html.cap`: safe-area padding on the sticky header (`app-shell.tsx:357`) and the sticky tracker bar (`tracker-bar.tsx:201`); `input, textarea, select { font-size: 16px }`; `-webkit-tap-highlight-color: transparent`; `-webkit-text-size-adjust: 100%`; `overscroll-behavior-y: none`; `.cap-touch { min-height: 2.75rem; min-width: 2.75rem }`; a two-row tracker composer keyed off a new `data-testid="tracker-composer"` on the wrapping flex row at tracker-bar.tsx:217 (`[data-testid="tracker-description"] { flex-basis: 100% }` plus a taller, wider Start); and a rule anchoring `DialogContent` to the top under the safe area instead of `translate(-50%,-50%)`, so the keyboard shrinks the visual viewport and the panel's existing `overflow-y-auto` scrolls the focused field into view.

`autoFocus` at tracker-bar.tsx:220 becomes `autoFocus={!isNative()}` — today the software keyboard fights to open every time /track mounts, covering half the phone before the user has done anything. Add `cap-touch` to the four `size-8` action buttons in entry-row.tsx (billable, stop, continue, overflow — lines 298/398/410/425) and to the billable and manual-entry icon buttons in tracker-bar.tsx. Leave the `--tracker-bar-height` ResizeObserver (tracker-bar.tsx:70-85) and its consumer `entry-list.tsx:36` untouched — that mechanism already makes the sticky day headings follow the bar's wrap.

In bridge.ts, make the status-bar style follow the app's theme rather than firing `Style.Default` once at line 34, and add `setOverlaysWebView(true)`. Add `@capacitor/keyboard` and a `Keyboard` plugin block (`resize: "native"`, accessory bar on) to capacitor.config.ts, then `cap sync`.

Add a second Playwright project pinned to a phone viewport (`devices["iPhone 14"]`, webkit) running against the SAME existing webServer — no second build — plus `e2e/mobile-shell.spec.ts` asserting at 390pt that the drawer is present, that no `cap` class is on `body`, and therefore that every rule in native.css is inert on web.

**Verification**

Web non-regression: the existing `chromium` Playwright project green unchanged; `pnpm test:client` and `pnpm typecheck` green. The new phone-viewport project asserts `document.body.classList.contains("cap")` is false and `[data-testid="sidebar-toggle"]` is visible — i.e. a narrow browser window still gets the drawer, not the native treatment.

Device: rebuild and run on a notched Simulator device. Screenshot the header clearing the Dynamic Island and the bottom of `[data-testid="app-main"]` clearing the home indicator. Tap a `TimeField` inside EntryEditDialog — the page must not zoom-and-pan and the field must stay above the keyboard. Navigate to /track and confirm the keyboard does not open unbidden. Toggle dark mode and confirm no white flash on relaunch and no white overscroll gutters.

### Stage 3 — Bottom tab bar, hardware back button, and a More list derived from the web nav

- depends on: [1, 2] · parallel-safe: False
- files: `/Users/rico/projects/tracktime/packages/client/src/components/mobile-tab-bar.tsx`, `/Users/rico/projects/tracktime/packages/client/src/components/app-shell.tsx`, `/Users/rico/projects/tracktime/packages/client/src/styles/native.css`, `/Users/rico/projects/tracktime/packages/client/src/mobile/MobileBridgeLoader.tsx`, `/Users/rico/projects/tracktime/packages/client/src/mobile/overlay-stack.ts`, `/Users/rico/projects/tracktime/e2e/mobile-shell.spec.ts`

**Work**

New `components/mobile-tab-bar.tsx`: fixed bottom bar, three 56px cells — Track (`/track`), Reports (`/reports`), More. Active state reuses the already-exported `isActiveRoute` from app-shell.tsx:97. More calls the shell's existing `setMobileOpen(true)`, which renders the existing `SidebarNav` in the existing drawer, so no new navigation logic and no second nav data source; `NAV_SECTIONS` (app-shell.tsx:66-94) is untouched and a new web screen appears on the phone for free. Render the bar unconditionally from `AppShell` and reveal it with a `html.cap`-scoped CSS rule rather than returning null on `!isNative()` — under `output: "export"` the markup is prerendered in Node where `window.Capacitor` cannot exist, so a runtime branch that changes the tree disagrees with the served HTML on native. Add `padding-bottom: calc(4rem + env(safe-area-inset-bottom))` on `[data-testid="app-main"]` in native.css so the last entry row is never trapped behind the bar. AppShell's existing route-change effect (lines 291-295) already closes the drawer on navigation, so the tab bar inherits that.

New `packages/client/src/mobile/overlay-stack.ts`: a tiny push/pop registry of open sheets/dialogs. Pass an `onBackButton` handler from AppShell down through `MobileBridgeLoader` into `initMobile` — `bridge.ts:37-45` has supported it since the file was written and has never been given one, and it already implements the right contract (`handled === false && event.canGoBack === false` → `App.exitApp()`). Without this, Android's hardware back exits the app from any screen and does not close an open dialog; wire it now so the behaviour exists before Android ships. Sheets stay out of the URL: a WebView reload always lands at `/` (Router.swift), so a modal in history would restore over nothing.

**Verification**

Web non-regression: chromium project green unchanged; `e2e/mobile-shell.spec.ts` asserts at 390pt that the tab bar element is present in the DOM but `display: none` without `html.cap`, so the web layout is provably unaffected. `pnpm test:client`, `pnpm typecheck` green.

Device: all three tabs navigate; active state tracks the route; the drawer still auto-closes on navigation; scrolling the entries list reaches the last row fully above the tab bar. Open EntryEditDialog and confirm the overlay stack registers it (log or a test hook) — full back-button behaviour is verified on Android in stage 9.

### Stage 4 — Resume lifecycle, durable offline queue, real network truth, and a running-timer that survives a cold offline launch

- depends on: [1, 3] · parallel-safe: False
- files: `/Users/rico/projects/tracktime/packages/client/src/hooks/use-native-lifecycle.ts`, `/Users/rico/projects/tracktime/packages/client/src/hooks/use-sync.ts`, `/Users/rico/projects/tracktime/packages/client/src/lib/offline.ts`, `/Users/rico/projects/tracktime/packages/client/src/mobile/preferences-storage.ts`, `/Users/rico/projects/tracktime/packages/client/src/lib/running-mirror.ts`, `/Users/rico/projects/tracktime/packages/client/src/components/app-shell.tsx`, `/Users/rico/projects/tracktime/packages/client/src/components/tracker/tracker-bar.tsx`, `/Users/rico/projects/tracktime/packages/client/src/providers/offline-queue-provider.tsx`, `/Users/rico/projects/tracktime/packages/client/src/mobile/durable.ts`, `/Users/rico/projects/tracktime/packages/client/src/mobile/MobileBridgeLoader.tsx`, `/Users/rico/projects/tracktime/package.json`

**Work**

Durable queue. New `mobile/preferences-storage.ts` implementing `KeyValueStorage` (packages/core/src/storage.ts:6-10) over `@capacitor/preferences`; branch `resolveStorage()` in lib/offline.ts:54 onto it when native. Under WKWebView `localStorage` is non-critical web data — evictable after low storage or ~7 days of inactivity — and `webStorage()` swallows every throw (storage.ts:38-59), so queued start/stops vanish silently today. `getOfflineQueue()` memoizes on first call (offline.ts:57-64), so the branch must be decided before the first call; `NativeSessionGate`'s boot from stage 1 is the ordering point. Delete `mobile/durable.ts` (imported by nothing).

Network truth. Add `@capacitor/network`; drive `isOnline()` (offline.ts:158-161) and React Query's `onlineManager` from it on native. `navigator.onLine` routinely reports true on a dead radio in WKWebView, and `isNetworkError()` (offline.ts:209-218) short-circuits on `!isOnline()` — so a lying value makes a genuine server rejection look like a transport failure and queue forever.

Flush above the route. `useOfflineQueue()` is mounted only in tracker-bar.tsx:36, which renders only on `/track` — reconnect while on Reports or Settings and nothing ever flushes. Move the hook into `AppShell` (beside the single `useSync()` mount at line 286), publish its `{ pending, online, … }` through a new `providers/offline-queue-provider.tsx`, and have TrackerBar consume the context instead of calling the hook. This is a web bug fix, covered by the existing offline e2e specs.

Resume wiring. In use-sync.ts export a module-level `reconnect()` that closes and reopens the client — `packages/core/src/sync-client.ts:74-88` reconnects only from `onclose`, which a socket the OS froze may never deliver, leaving status stuck at "open" and suppressing the flush. New `hooks/use-native-lifecycle.ts`, mounted once in AppShell, passing `onResume`/`onPause` through MobileBridgeLoader into `initMobile` (which has never been given handlers). On resume, in order: force reconnect; `utils.entries.current.invalidate()`; `timerStore.getState().tick()`; flush the queue. The server pings every 10s and terminates on the first missed pong (`ws/handler.ts:107-120`), so the socket is dead server-side within ~20s of every backgrounding — reconnect-on-resume is the normal path. Reconnecting also re-fires `enforceMaxEntryDuration` (`ws/handler.ts:95-104`), so a timer left running overnight is caught for free.

Running-entry mirror. New `lib/running-mirror.ts`: persist `{id, start, description, projectId, taskId, billable}` to Preferences on every resolution of `trpc.entries.current`, and seed `timerStore.setRunning()` from it at boot before the query fires, marked provisional until the server answers. `useRunningEntry` (use-sync.ts:189-204) currently does `timerStore.getState().setRunning(query.data ?? null)`, so with no persisted React Query cache a cold offline launch actively sets the store to null and the phone shows no timer at all. Paired with stage 1's ProtectedLayout tolerance — which is what makes this reachable — this is the difference between an app and a website that fails on the subway. Export `timerStore` from use-sync.ts so the lifecycle hook can seed and tick it.

**Verification**

Web non-regression: full `pnpm test:e2e` green, especially the existing offline specs, which now exercise the queue through the provider rather than the direct hook call — that is the assertion the mount move is behaviour-preserving. Add a client unit test for `preferences-storage.ts` against a fake plugin. `pnpm test:client`, `pnpm typecheck` green.

Device: (1) start a timer, background the app 90 seconds (well past the ~20s pong timeout), foreground — the clock is correct on the first frame and the sync dot returns to open within a second; a change made in the web app meanwhile is visible. (2) Airplane mode: navigate to Reports, start and stop a timer from there via the header indicator, confirm the pending badge, restore the network, confirm the flush lands without ever visiting /track (this would not have flushed before). (3) Force-quit from the app switcher with a queued mutation, relaunch — still queued, which proves Preferences and not localStorage is holding it. (4) Airplane mode, start a timer, force-quit, relaunch still offline — the app stays signed in and shows the running timer with correct elapsed immediately, instead of the login screen.

### Stage 5 — Calendar: stop manufacturing accidental entries on touch

- depends on: [1] · parallel-safe: True
- files: `/Users/rico/projects/tracktime/packages/client/src/components/calendar/time-grid.tsx`, `/Users/rico/projects/tracktime/packages/client/src/components/calendar/entry-block.tsx`, `/Users/rico/projects/tracktime/packages/client/src/components/calendar/density-cluster.tsx`, `/Users/rico/projects/tracktime/packages/client/src/components/calendar/calendar-screen.tsx`

**Work**

Compute a coarse-pointer flag once (`matchMedia("(pointer: coarse)")`). When coarse: `touchAction: "pan-y"` instead of `"none"` on the day columns (time-grid.tsx:640), on the entry block and its two 7px resize handles (entry-block.tsx:130/144/153) and on the density cluster (density-cluster.tsx:106); and return early from `onPointerDown` when `event.pointerType === "touch"` so a finger drag never arms create-a-new-entry, move or resize. A tap opens the editor instead. Today the calendar body cannot be scrolled with a finger AND every stray drag creates a time entry — that is data corruption, not ugliness, and it is the one thing outside /track worth fixing now. Also default the initial view to "day" under a coarse pointer in calendar-screen.tsx (7 columns after a 3.5rem gutter leaves ~44px per day at 390pt); initial default only, a persisted user choice still wins. Mouse and pen paths are untouched, so 7px handles and drag-to-resize keep working exactly as they do on desktop.

**Verification**

Web non-regression by construction: Playwright drives a fine pointer, so every existing calendar spec (`e2e/`, plus `time-grid.test.tsx` and `calendar-history.test.ts`) exercises the unchanged branch — all must pass with zero spec edits. Add a client unit test asserting `touchAction` is `"pan-y"` and `onPointerDown` is a no-op when the coarse flag is set.

Device: the calendar body scrolls with a finger; ten deliberate drags across empty grid create zero entries (each creates one today); tapping an entry block opens the editor; the initial view is Day.

### Stage 6 — Extract the entry save rules so they can never exist twice

- depends on: [1] · parallel-safe: True
- files: `/Users/rico/projects/tracktime/packages/client/src/components/tracker/use-entry-editor.ts`, `/Users/rico/projects/tracktime/packages/client/src/components/tracker/entry-edit-dialog.tsx`, `/Users/rico/projects/tracktime/packages/client/src/components/tracker/use-entry-editor.test.ts`

**Work**

Extract the save logic out of `entry-edit-dialog.tsx` into `use-entry-editor.ts`, verbatim, and have the dialog consume it with no behaviour change: the `useEntryFields` seeding, the `withDayInZone` re-anchoring (the file's own comment at lines 37-40 flags this as a trap — moving "23:30 Berlin" to another day must keep it at 23:30 Berlin), `rollEndAfterStart` for a midnight-crossing end, and the running-entry `end: null` case. This is a pure web refactor with no mobile dependency, done now because these are the subtlest correctness rules in the app, they are currently only reachable through a DOM, and any future phone edit sheet must inherit them rather than reimplement them.

**Verification**

New unit tests in `use-entry-editor.test.ts` covering the two rules that would break silently: re-anchoring a date in the ENTRY's zone rather than the editor's, and rolling a midnight-crossing end forward. `e2e/timer.spec.ts` and every other existing spec green with zero edits — that is the proof the dialog still behaves. `pnpm test:client`, `pnpm typecheck` green. Nothing in this stage touches a native file, so there is no mobile verification and no way for it to regress mobile.

### Stage 7 — Two native wins with no custom native code: haptics and a runaway-timer notification

- depends on: [4] · parallel-safe: False
- files: `/Users/rico/projects/tracktime/packages/client/src/mobile/haptics.ts`, `/Users/rico/projects/tracktime/packages/client/src/mobile/runaway-notification.ts`, `/Users/rico/projects/tracktime/packages/client/src/mobile/runaway-notification.test.ts`, `/Users/rico/projects/tracktime/packages/client/src/components/tracker/use-entry-mutations.ts`, `/Users/rico/projects/tracktime/packages/client/src/hooks/use-native-lifecycle.ts`, `/Users/rico/projects/tracktime/capacitor.config.ts`, `/Users/rico/projects/tracktime/package.json`

**Work**

Add `@capacitor/haptics` and `@capacitor/local-notifications`. New `mobile/haptics.ts`: `ImpactStyle.Medium` on start/stop, fired from `use-entry-mutations.ts`'s start/stop `onMutate` behind an `isNative()` guard so the web bundle is untouched. New `mobile/runaway-notification.ts`: on every start, schedule one local notification at `start + maxHours` using `MaxDurationSettings` from `trpc.settings` (defaults 12h / `ask`, `packages/shared/src/runaway.ts`); cancel it on stop; reschedule from the running-entry mirror at launch and on resume. Tapping it deep-links to /track, where the existing `components/tracker/runaway-prompt.tsx` takes over. This is the first thing in the system that can surface a runaway timer with the app killed and the radio off: `enforceMaxEntryDuration` has no scheduler — it runs only on `entries.current` reads, on `entries.start`, and on ws upgrade (`ws/handler.ts:95-104`). Request the notification permission lazily, at the first start, and degrade silently: a denied permission must not affect the timer. Deliberately excluded: any Live Activity, widget extension, ongoing/chronometer notification, App Intent, or Swift/Kotlin code.

**Verification**

Web non-regression: haptics and notifications are behind `isNative()` and dynamic-imported, so `pnpm build:client` adds no Capacitor bytes to the web bundle — assert with `grep -rl "@capacitor/local-notifications" packages/client/out/_next` returning nothing. Full `pnpm test:e2e`, `pnpm test:client`, `pnpm typecheck` green.

Unit: `runaway-notification.test.ts` covers the arithmetic as a pure function — settings + start instant → fire date, and the cancel-on-stop pairing — so it is verifiable without waiting hours. Device: set maxHours to 1 (the floor, `MIN_MAX_DURATION_HOURS`), start a timer, force-quit, enable airplane mode, wait — the notification fires with no app and no network, and tapping it opens the runaway prompt. Then deny the notification permission entirely and confirm start/stop still works and nothing throws.

### Stage 8 — Production config, docs, and the assets a dark-mode phone needs

- depends on: [4] · parallel-safe: True
- files: `/Users/rico/projects/tracktime/docs/deploy.md`, `/Users/rico/projects/tracktime/CLAUDE.md`, `/Users/rico/projects/tracktime/scripts/icons-brand.mjs`, `/Users/rico/projects/tracktime/packages/server/.env.production`, `/Users/rico/projects/tracktime/resources/splash-dark.png`

**Work**

USER ACTION REQUIRED for the production half: add `capacitor://localhost,https://localhost` to the production `TRUSTED_ORIGINS` via `pnpm --filter @starter/server exec dotenvx set TRUSTED_ORIGINS … -f .env.production`, then redeploy. `getTrustedOrigins()` (config/env.ts:141-150) skips localhost aliasing in production, so the match is verbatim — a trailing slash or the wrong scheme fails silently as a 403 before the password is checked, and separately gets the socket refused at ws/handler.ts:44-59. Nothing in the repo can verify this; it must be checked against the live server.

Docs: `docs/deploy.md`'s list of places that must agree on the API origin (lines ~125-133) names four — `.env.production`, `build-and-deploy.yml`, `packages/extension/manifest.config.ts`, `packages/raycast/src/lib/preferences.ts`. The mobile build is a fifth, and unlike the others it is baked into a store binary at build time, so retargeting means a new binary and a new review. Add it, and document the `TRUSTED_ORIGINS` addition in that file's existing TRUSTED_ORIGINS section. In CLAUDE.md, correct the "Clients without a cookie jar" section: it says such clients need no origin, which is true for Raycast and false for the WebView — a WebView fetch sends `Origin` and `Sec-Fetch-*`, which force-validates the origin check, so the mobile shell is in the browser extension's category. Add a short mobile section mirroring the Raycast one, and record the standing constraint that no background execution is ever needed: `packages/core/src/timer-store.ts` derives elapsed from `entry.start` against the wall clock and never accumulates, so BGTaskScheduler, an Android foreground service, and push are all wrong answers.

Assets: have `scripts/icons-brand.mjs` also emit `resources/splash-dark.png` and an `icon-foreground`/`icon-background` pair. The icon pipeline is real, not placeholder, but a dark-mode phone gets the flat white splash on OLED and Android's adaptive icon is derived from the flat logo.

**Verification**

After the user's dotenvx set and redeploy: `curl -i -X POST https://tracktime.trebeljahr.com/api/auth/sign-in/email -H 'Origin: capacitor://localhost' -H 'Sec-Fetch-Mode: cors' -H 'content-type: application/json' -d '{}'` returns a validation error rather than `403 INVALID_ORIGIN` — the origin gate passed. Then build a production-pointed bundle (`NEXT_PUBLIC_API_URL=https://tracktime.trebeljahr.com pnpm build:mobile`), install it, sign in, and confirm the sync dot opens. `pnpm icons:brand` regenerates without error and `resources/splash-dark.png` exists. Docs changes touch no code; `pnpm test:e2e` unaffected.

### Stage 9 — Android platform — GATED on open question 3

- depends on: [4] · parallel-safe: False
- files: `/Users/rico/projects/tracktime/.gitignore`, `/Users/rico/projects/tracktime/android/`, `/Users/rico/projects/tracktime/android/app/build.gradle`, `/Users/rico/projects/tracktime/scripts/android-dev.sh`, `/Users/rico/projects/tracktime/scripts/ios-dev.sh`

**Work**

Only if the user says Android ships in round one. Un-ignore `android/` (.gitignore:36), `pnpm cap:add:android`, `pnpm mobile:assets`, commit the tree. Note the origin is `https://localhost` (Capacitor's `androidScheme` defaults to `https`, not `http` — verified in @capacitor/cli/dist/declarations.d.ts:556), which stage 1 already put in `TRUSTED_ORIGINS`. Do NOT set a custom `iosScheme`/`androidScheme`: the scheme IS the document origin, so changing it later orphans every stored Preference and silently invalidates the trust list.

Fix both dev scripts while here. Neither exports `NEXT_PUBLIC_API_URL` nor starts an API (`ios-dev.sh:76` and `android-dev.sh:151` start only `next dev`), so `lib/trpc.ts` posts to the Next dev server's nonexistent `/api/trpc` and sign-in is impossible under live reload; export it pointing at `pnpm run dev`'s API (10.0.2.2 for the Android emulator's host alias). Stop colliding with `dev:desktop`, which pins the same port 7130 (package.json:38), and fix the header comments that still claim a default of 3000. Remove the machine-wide kills — `ios-dev.sh:32` does `lsof -ti:$NEXT_PORT | xargs kill -9` on a port it may not own, and `android-dev.sh:72-73` does `pkill -9 -f 'adb fork-server'` and `pkill -9 -x adb`, which takes down the user's or another agent's adb session and violates this repo's own scoped-kill rule. Also add a `signingConfigs.release` block to `android/app/build.gradle` reading `KEYSTORE_PASSWORD`/`KEY_ALIAS`/`KEY_PASSWORD` from the environment — the stock Capacitor 8 template has no `signingConfigs` at all, so the keystore env `mobile-release.yml:51-55` already supplies is read by nothing and the AAB ships unsigned.

**Verification**

Emulator: build and launch, sign in, start and stop a timer, confirm the entry on the web app. Press the hardware back button with a dialog open and **nothing focused** — one press closes the dialog (stage 3's overlay stack). With a field in that dialog focused it takes **two**: Android gives the first press to the IME, which dismisses the keyboard, and the WebView is never told about it. Both are correct; a criterion of "one press" is only right for the unfocused case, and reading it as universal sends you looking for a bug in the overlay stack that is not there. Press it on the Track tab with no history — the app exits rather than blanking. `bash scripts/android-dev.sh` reaches a login form that returns a real 4xx from the API rather than a 404 from the Next dev server, and running it does not kill an unrelated `adb` or a `pnpm dev:desktop` session started beforehand. `./gradlew bundleRelease` with the keystore env set produces a signed AAB (`jarsigner -verify`). Web untouched: no client file changes in this stage.

### Stage 10 — Store release pipeline — DEFERRABLE, gated on open questions 2 and 4

- depends on: [9] · parallel-safe: False
- files: `/Users/rico/projects/tracktime/.github/workflows/mobile-release.yml`, `/Users/rico/projects/tracktime/ios/App/ExportOptions.plist`

**Work**

Not needed to use the app: from stage 1 onward `pnpm build:ios:release` opens Xcode for a manual archive to the user's own device. When the user wants store builds: replace `pod install` (mobile-release.yml:97-98) and `-workspace App.xcworkspace` (line 120) with `-project App.xcodeproj -scheme App` — Capacitor CLI 8.3.4 defaults iOS to Swift Package Manager (verified at node_modules/@capacitor/cli/dist/config.js:141: `const iosPlatformTemplateArchive = 'ios-spm-template.tar.gz'`), and the SPM template ships neither a Podfile nor a workspace, so the iOS job fails before it reaches signing. CocoaPods is not installed on this machine either. Author the referenced-but-nonexistent `ExportOptions.plist` (method, teamID, profile mapping). Give `NEXT_PUBLIC_API_URL` a literal fallback instead of a bare secret — `build-and-deploy.yml:139-154` documents this exact trap already having shipped empty client images once, and here an unset secret ships a store binary permanently bound to a broken API origin with a green build.

**Verification**

A tagged dry run producing a signed IPA (and, if Android shipped, a signed AAB) as workflow artifacts, plus one TestFlight upload. Until then, `pnpm build:ios:release` → Xcode archive → device install is the shipping path and is verified from stage 1.

## Critic findings to fold in

### Lens: BUILD AND TOOLCHAIN — do these exact commands, configs and paths work?

- **[critical] stage 1** — Stage 1's acceptance test assumes `pnpm run dev` serves the API on 5159, and bakes `NEXT_PUBLIC_API_URL=http://localhost:5159` into the mobile bundle. This work is happening in a git worktree, where `pnpm run dev` behaves like `--auto` and picks a RANDOM high port every run.
  - failure: Verified by running `node scripts/dev.mjs --dry-run` in this worktree: it prints `Mode: auto ports (worktree)` / `Server: http://localhost:64235` (a different port each invocation; scripts/dev.mjs:99-101, 136-146, 178-182). Running `NEXT_PUBLIC_API_URL=http://localhost:5159 pnpm build:mobile && pnpm cap:run:ios` therefore installs a Simulator app whose every tRPC/auth/WS request goes to a port nothing is listening on. Sign-in fails with a generic fetch error, the entries list never loads, the sync dot never opens. The plan's own troubleshooting list only mentions 403 INVALID_ORIGIN and untrusted-origin ws refusals, so this will be misdiagnosed as the bearer-auth work being wrong.
  - fix: Decide and write down which checkout the mobile work runs in. In a worktree, either use `pnpm dev:fixed` (pins 3392/5159/4000 and exits rather than falling back — but then it collides with the main checkout's dev server) or `API_PORT=5159 PORT=3392 pnpm run dev`, which scripts/dev.mjs:171 honours ahead of the auto-port mode. Then make `scripts/build-mobile.mjs` fail fast when the host:port in NEXT_PUBLIC_API_URL is not accepting connections, so a wrong port is a build error rather than a silent broken binary.
- **[critical] stage 1** — Stage 1(f) adds `TRUSTED_ORIGINS=capacitor://localhost,https://localhost` to `packages/server/.env.development`. That value is ignored whenever the server is started by `pnpm run dev`, and the file is not committable on this machine.
  - failure: scripts/dev.mjs:293-298 builds `trustedOrigins = [...process.env.TRUSTED_ORIGINS, devExtensionOrigin]` and line 340 passes `TRUSTED_ORIGINS=<that>` on the server's command line — confirmed by the dry-run output line `Trusts: chrome-extension://iikecnjmijpbcmagnjmiecjcbifmifki`. packages/server/src/config/env.ts:20-21 then calls `dotenvxConfig({ path })`, which does not overwrite an already-set process.env key (the file's own MONGODB_URI comment at scripts/dev.mjs:263-265 states exactly this rule). So `getTrustedOrigins()` never sees the Capacitor origins. Result on the Simulator: `POST /api/auth/sign-in/email` returns 403 INVALID_ORIGIN before the password is checked, and the socket is separately refused with `[ws] upgrade refused: untrusted origin` (ws/handler.ts:44-59). The plan's debugging hint is 'check TRUSTED_ORIGINS took' — pointing at the file it just edited, which is the wrong place. Separately: `packages/server/.env.development` does not exist in this worktree (only `.env.example`) and matches `.env.development` in the user's global ignore at ~/.config/git/ignore:52-53, so it cannot be committed and CI/other worktrees would never get it. CLAUDE.md's claim that this file is committed is false.
  - fix: Add `"capacitor://localhost", "https://localhost"` to the `trustedOrigins` array literal in scripts/dev.mjs:293 (next to `devExtensionOrigin`), which is the same mechanism that already handles the dev extension and is the only place `pnpm run dev` reads. Document `TRUSTED_ORIGINS=capacitor://localhost,https://localhost pnpm run dev` as the manual override — dev.mjs merges the inherited value. Also correct the CLAUDE.md claim about .env.development being committed.
- **[critical] stage 1** — `cap add ios` and `cap add android` do NOT apply `appId` or `appName` to the native projects. The plan's #1 blocking open question rests on a false premise, and the actual work item (hand-editing the native identifiers) is nowhere in the plan.
  - failure: node_modules/@capacitor/cli/dist/ios/add.js is four lines and does only `extractTemplate(...)` — nothing else. Extracting node_modules/@capacitor/cli/assets/ios-spm-template.tar.gz shows `PRODUCT_BUNDLE_IDENTIFIER = com.getcapacitor.App` hardcoded at project.pbxproj lines 308 and 329, `CFBundleDisplayName` = the literal string `My App`, and `PRODUCT_NAME = "$(TARGET_NAME)"` (= `App`). The android template hardcodes `namespace = "com.getcapacitor.myapp"` and `applicationId "com.getcapacitor.app"`. A grep of the entire CLI dist for PRODUCT_BUNDLE_IDENTIFIER / CFBundleDisplayName / applicationId finds no writer. So: set the real appId in capacitor.config.ts, run `pnpm cap:add:ios`, build — and you ship an app with bundle id `com.getcapacitor.App` named 'App' on the home screen. Nothing errors, it gets committed, and it surfaces at App Store Connect ('com.getcapacitor.App is not available') or when a second Capacitor app collides on the same device.
  - fix: Add an explicit post-`cap add` native-edit step to stage 1: set PRODUCT_BUNDLE_IDENTIFIER in BOTH Debug and Release build configurations of ios/App/App.xcodeproj/project.pbxproj, set CFBundleDisplayName in ios/App/App/Info.plist, and set `namespace` + `applicationId` in android/app/build.gradle. Add an assertion to scripts/verify-native-export.mjs that neither `com.getcapacitor` nor `com.example` appears in the committed native trees. The bundle-id answer is still worth getting up front (to avoid doing this twice), but reframe the question — it is not a blocker for `cap add`.
- **[critical] stage 1** — The web build, the E2E build and the native build all write to the same `packages/client/out`, and `cap run` syncs by default — so an unrelated build can silently be shipped into the app.
  - failure: `output: "export"` with no distDir override lands every build in packages/client/out (next.config.ts:23,31); capacitor.config.ts:22 pins `webDir: "packages/client/out"`; playwright.config.ts:53-62 runs `pnpm run build:client` with `NEXT_PUBLIC_API_URL=http://127.0.0.1:49761`; node_modules/@capacitor/cli/dist/tasks/run.js:63-64 shows `cap run` calls `sync()` unless told otherwise. Concrete sequence: `pnpm test:e2e` (which the plan runs as its non-regression gate) rewrites out/ with the E2E bundle, then `pnpm cap:run:ios` copies that into ios/App/App/public and installs an app permanently pointed at the dead E2E port. Symptom on device is identical to the P1 failure — everything just fails to load, no build error. The plan's scripts/verify-native-export.mjs cannot catch it: it validates a build it performs itself, not the bytes cap sync later copies. I confirmed the hazard is live — packages/client/out currently on disk has `./_next` prefixes even in out/track/index.html, i.e. it is a leftover NATIVE_BUILD artifact from an earlier session.
  - fix: Make build+verify+sync one atomic operation in scripts/build-mobile.mjs (build → assert the expected NEXT_PUBLIC_API_URL literal is in an emitted chunk → `cap sync`), and change `cap:run:ios` / `build:ios:release` to go through it and then run `cap run ios --no-sync` (run.js gates on `options.sync`). Never invoke bare `cap run ios` / `cap sync`. Optionally stamp a marker file (e.g. out/.build-target.json with the baked API URL and build mode) and have the wrapper refuse to sync when it is absent or stale.
- **[high] stage 1** — The assetPrefix fix is verified with `packages/client/serve.mjs`, whose route resolution does not match Capacitor's, so the test proves less than the plan claims and the deep-link claim is wrong.
  - failure: serve.mjs:76-83 resolves `/track/` to out/track/index.html (`const asIndex = join(candidate, "index.html")`). node_modules/@capacitor/ios/Capacitor/Capacitor/Router.swift:19-27 returns `basePath + "/index.html"` for ANY path whose `pathExtension.isEmpty` — i.e. the ROOT index.html for every extensionless path, never out/track/index.html. So the plan's test ('hard-load /track/ and /reports/summary/ in a browser, confirm no 404s in DevTools') passes against a server that behaves differently from the one on the device, and the plan's stated benefit — a hard document load of a nested route working — is only half delivered: assets will resolve (the important half), but a WebView reload at /track/ renders the exported `/` page while the URL still reads /track/.
  - fix: Keep the serve.mjs check as a cheap regression net but stop claiming it validates native routing. State the property actually being fixed: assets resolve from any path depth, which is what matters because CapacitorRouter always serves root index.html. Verify natively — reload the WebView on a nested route in the Simulator and confirm chunks load and the app recovers — and drop the deep-link/route-restore claim, or add an explicit route-restore mechanism if that behaviour is wanted.
- **[high] stage 2** — The new phone-viewport Playwright project is specified as `devices["iPhone 14"]` + webkit, but CI installs only chromium.
  - failure: .github/workflows/build-and-deploy.yml:84 is `npx playwright install --with-deps chromium`. As soon as stage 2 lands, `npx playwright test` in CI fails at startup with `Executable doesn't exist at .../webkit-XXXX ... Run npx playwright install`, taking down the E2E job for every PR, mobile-related or not. Locally it fails the same way unless the developer has webkit installed. Additionally, playwright.config.ts sets `workers: 1, fullyParallel: false`, so a second project without a `testMatch` re-runs the ENTIRE existing suite serially in a second browser — roughly doubling E2E wall time on top of the 300s client build.
  - fix: Either add webkit to the install line in build-and-deploy.yml (and accept the runtime cost), or use a chromium-based phone descriptor (`devices["Pixel 5"]`, chromium) which needs no new browser download. Either way, scope the new project with `testMatch: /mobile-shell\.spec\.ts/` so it runs only the phone-layout assertions rather than the whole suite a second time.
- **[high] stage 1** — After the assetPrefix move, `NATIVE_BUILD` becomes a dead flag that still reads as meaningful, and `build:tauri` ends up setting a variable literally named `ELECTRON_BUILD`.
  - failure: `grep -rn NATIVE_BUILD` finds it only at package.json:39,49,53,54,55 and next.config.ts:13. Once next.config.ts keys assetPrefix off ELECTRON_BUILD instead, `NATIVE_BUILD=1` in build:mobile / cap:add:ios / cap:add:android does nothing at all while continuing to signal 'this is the native build'. Meanwhile package.json:49 would read `"build:tauri": "NATIVE_BUILD=1 ELECTRON_BUILD=1 tauri build"` — Tauri is not Electron, so the next person to tidy the scripts deletes the ELECTRON_BUILD there as an obvious copy-paste error and silently reintroduces the blank-window bug in the Tauri bundle (Tauri's beforeBuildCommand `pnpm build:client`, src-tauri/tauri.conf.json:9, inherits the parent env, which is the only reason it works).
  - fix: Name the flag for what it does, not for one of its consumers: `RELATIVE_ASSET_PREFIX=1` (or `FILE_PROTOCOL_BUILD=1`) set by build:desktop, electron:build, electron:preview and build:tauri, with a comment in next.config.ts naming all four and saying why Capacitor is excluded. Delete `NATIVE_BUILD=1` from build:mobile / cap:add:ios / cap:add:android in the same commit so no dead flag survives.
- **[high] stage 1** — `scripts/build-mobile.mjs` deletes NEXT_DIST_DIR so the export lands in out/ — which forces the mobile build into `.next`, the same build directory the worktree's running dev server owns.
  - failure: The dry-run prints `Next dir: packages/client/.next` for this worktree (scripts/dev.mjs:236-238: distDir defaults to `.next` unless INSTANCE_ID is set). The plan's stage-1 acceptance explicitly says 'with `pnpm run dev` up ... run `pnpm build:mobile`'. `next build` and a live `next dev` then share packages/client/.next: at best the dev cache is discarded and the next HMR round is a cold rebuild; at worst it collides with Next 16's detached dev server and its `packages/client/.next/dev/lock`, which scripts/dev.mjs:242-250 already has dedicated recovery code for — meaning this is a known-painful failure in this repo.
  - fix: Have scripts/build-mobile.mjs refuse to run when `packages/client/<distDir>/dev/lock` exists, printing the same guidance dev.mjs does. If a concurrent mobile build is genuinely wanted, verify first whether NEXT_DIST_DIR relocates the export directory (the survey observed the export landing in packages/client/.next-survey/, i.e. it does) — if so, a dedicated NEXT_DIST_DIR also requires pointing capacitor.config.ts's webDir at the matching out path, which is a second change the plan does not mention. Do not just delete the variable and hope.
- **[high] stage 1** — A third-party Capacitor plugin without SPM support is silently dropped by `cap sync` — the secure-storage dependency can 'install' and still not exist on device.
  - failure: node_modules/@capacitor/cli/dist/util/spm.js:45-56 (`checkPluginsForPackageSwift`) filters plugins to those that ship a Package.swift; when some do not it emits only `logger.warn('Some installed Capacitor plugins are not compatible with SPM')` and returns the filtered list to `generatePackageFile`. `cap sync` still exits 0. So `pnpm add @aparajita/capacitor-secure-storage && pnpm build:mobile` can produce a green build in which SecureStorage is not linked at all, and `SecureStorage.get()` throws 'not implemented on ios' the first time the app tries to read the session token — on device only, after everything else looked fine. The first-party plugins are safe (node_modules/@capacitor/preferences/Package.swift and @capacitor/app/Package.swift both exist).
  - fix: Before adopting the plugin, check `node_modules/@aparajita/capacitor-secure-storage/Package.swift` exists and that its peer range admits @capacitor/core 8.3.4. Add a preflight to scripts/build-mobile.mjs that enumerates installed @capacitor-plugin packages and hard-fails if any lacks Package.swift, so a dropped plugin is a build error rather than a device-only runtime error.
- **[high] stage 1** — .github/workflows/mobile-release.yml is triggered by `push: tags: v*` and is broken in three ways; the plan defers fixing it to stage 10, but stage 1 makes it start reaching further into the failure.
  - failure: The workflow's iOS job runs `pod install` in ios/App (lines 96-98) and archives `-workspace App.xcworkspace` (line 120), but Capacitor CLI 8.3.4 defaults iOS to SPM (dist/config.js:141 `ios-spm-template.tar.gz`) and the SPM template contains neither a Podfile nor a workspace — I listed the tarball. `ExportOptions.plist` (line 133) does not exist in the repo. The Android job's `working-directory: android` is a directory that stage 1 leaves gitignored. So the first `git tag v0.2.0 && git push --tags` after stage 1 lands fails the iOS job at 'CocoaPods install' and the Android job at './gradlew: no such directory' — and because ios/ is now committed, the run gets far enough to look like a genuine build attempt rather than obviously-unconfigured CI.
  - fix: Do the 3-line iOS fix in stage 1, not stage 10: delete the `pod install` step and change the archive to `-project App.xcodeproj -scheme App`. Guard the android job with `if: hashFiles('android/**') != ''`. Or, if the pipeline is genuinely out of scope for now, remove the `push: tags` trigger and leave only `workflow_dispatch` so a routine tag cannot produce a red CI run.
- **[medium] stage 1** — The `CLIENT_STATIC_DIR` override the plan adds to packages/client/serve.mjs is inert as specified.
  - failure: serve.mjs:27 is `const ROOT = resolve(HERE, "out")` — packages/client/out. The plan's own verification command is `CLIENT_STATIC_DIR=packages/client/out PORT=49790 node packages/client/serve.mjs`, which passes exactly the default. And because the native export goes to that same directory (see the shared-out problem), there is no second directory for the knob to point at. It adds a config surface with no caller, in a file whose header comment specifically argues for one implementation and no divergence.
  - fix: Drop the CLIENT_STATIC_DIR change, or make it earn its place by first giving the native export its own output directory — in which case webDir in capacitor.config.ts must move too, and the knob becomes the thing that lets serve.mjs inspect the native artifact.
- **[medium] stage 9** — The two dev-script fixes (missing NEXT_PUBLIC_API_URL, port 7130 collision, unscoped kills) are gated behind the Android decision, but the iOS script is on the stage-1 path and `build-mobile.mjs` will break it.
  - failure: scripts/ios-dev.sh:67-70 runs `pnpm build:mobile` as its 'fallback bundle' step with no NEXT_PUBLIC_API_URL exported — so stage 1's new refuse-when-unset guard turns the very first `pnpm dev:ios` on a clean checkout into a hard failure, and the plan schedules the fix for a stage that may never run. Separately ios-dev.sh:20 defaults NEXT_PORT=7130, the exact port package.json:38 pins for `dev:desktop`, and lines 32 and 39-41 do `lsof -ti:7130 | xargs kill -9` on a port the script may not own — violating this repo's own scoped-kill rule. The header comment at ios-dev.sh:9 still claims the default is 3000.
  - fix: Move the ios-dev.sh fixes into stage 1: export NEXT_PUBLIC_API_URL pointing at the actual running API port, pick a non-colliding NEXT_PORT (or fail loudly when 7130 is taken rather than killing it), kill only the PID the script spawned ($NEXT_PID), and correct the stale header comment. Leave only the android-dev.sh half (including its `pkill -9 -x adb`) in the Android-gated stage.
- **[medium] stage 1** — `capacitor.config.ts` is typechecked by nothing, so the plan's edits to it are unverified until `cap sync` runs.
  - failure: package.json:36-37 runs the per-package `tsc --noEmit` scripts plus `tsc -p electron`; packages/client/tsconfig.json's include is scoped to that package, and no tsconfig covers the repo-root capacitor.config.ts. A misnamed plugin key or a wrong-shaped `ios`/`plugins` block passes `pnpm typecheck` cleanly and surfaces only when someone runs a native command — which, on the plan's schedule, is after the whole stage has been written.
  - fix: Add `npx cap ls` (which loads and validates the config) as a preflight inside scripts/build-mobile.mjs, and/or add capacitor.config.ts to a tsconfig covered by `pnpm typecheck`.
- **[medium] stage 1** — Committing ios/ means every `pnpm build:mobile` leaves the working tree dirty, which collides with this repo's commit → rebase → ff-merge close-out.
  - failure: The template's own ios/.gitignore correctly excludes App/App/public, App/App/capacitor.config.json, App/Pods, App/build and DerivedData. But ios/App/CapApp-SPM/Package.swift is regenerated on every sync by `generatePackageFile` (dist/ios/update.js:47), and it IS tracked. So after any `pnpm build:mobile` (including the one ios-dev.sh runs on first launch), `git status` shows a modified Package.swift — meaning the standard 'clean tree before ff-merge' check never passes cleanly and agents will keep committing regenerated churn or, worse, stash it away.
  - fix: Expected Capacitor behaviour, but say so explicitly in the plan and in CLAUDE.md: Package.swift is generated and should be committed deliberately whenever the plugin set changes, and a diff there after a build is normal rather than a bug. Consider having build-mobile.mjs print a one-line notice when it changes.
- **[medium] stage 1** — The iOS template's Info.plist ships `UIRequiredDeviceCapabilities = armv7` and full landscape support, and the plan only edits it to add ATS.
  - failure: Confirmed by extracting ios-spm-template.tar.gz: UIRequiredDeviceCapabilities is `<array><string>armv7</string></array>`, and UISupportedInterfaceOrientations lists Portrait, LandscapeLeft and LandscapeRight. armv7 is a stale artifact on an arm64-only app and is a known App Store validation nuisance. Landscape is enabled with zero landscape layout work behind it — the calendar week grid (7 columns after a 3.5rem gutter) and the ~980px reports tables are exactly the screens a user will rotate, and they were never designed for it.
  - fix: While editing Info.plist for NSAppTransportSecurity in stage 1(b), also remove the armv7 entry and restrict UISupportedInterfaceOrientations to Portrait for iPhone (leave iPad alone or drop the iPad target). One edit, one commit, done before the tree is committed rather than after.
- **[medium] stage 1** — `pnpm build:mobile` runs `cap sync` for ALL installed platforms, which becomes a cross-platform toolchain requirement the moment android/ exists.
  - failure: package.json:53 is `NATIVE_BUILD=1 pnpm build:client && cap sync` with no platform argument. Today only iOS would exist so it is harmless. Once stage 9 adds android/, every `pnpm build:mobile` — including the one inside scripts/ios-dev.sh:70 and the one `build:ios:release` calls — also syncs Android, which requires a working Android SDK/JDK on the machine doing pure-iOS work. A macOS box without ANDROID_HOME gets an opaque sync failure in the middle of an iOS-only task.
  - fix: Make scripts/build-mobile.mjs take an optional platform argument and default to syncing only the platforms whose directories exist AND whose toolchain is present, or split into `build:ios` / `build:android` scripts each calling `cap sync ios` / `cap sync android`. Do this in stage 1 while there is only one platform, so stage 9 is additive.
- **[low] stage 1** — `pnpm mobile:assets` generates no dark splash and no Android adaptive-icon pair, and the plan defers that to stage 8 — after the app is already installed on a device.
  - failure: node_modules/@capacitor/assets/dist/project.js:40-56 loads splash-dark, icon-foreground and icon-background as optional inputs; `ls resources/` shows only icon.png and splash.png. The generator falls back to the legacy logo path (project.js:59-65 loads resources/icon.png as kind Logo), so `pnpm mobile:assets` will succeed — but the dark splash and adaptive icon simply are not produced. Combined with capacitor.config.ts's hardcoded white `backgroundColor` and white SplashScreen backgroundColor, a dark-mode user gets a white flash on every launch from stage 1 through stage 8.
  - fix: Move the scripts/icons-brand.mjs additions (resources/splash-dark.png, icon-foreground/icon-background) into stage 1(b), immediately before the first `pnpm mobile:assets` run, and pass `--splashBackgroundColor` / `--splashBackgroundColorDark` (both are real flags — dist/index.js:44-45) rather than only `--iconBackgroundColor`. It is the same amount of work either way and avoids regenerating and re-committing ~50 PNGs later.
- **[low] stage 1** — Nothing in the plan preflights the Xcode toolchain state that `cap run ios` depends on.
  - failure: `pnpm cap:run:ios` shells out to xcodebuild (dist/ios/run.js:20-31, which correctly uses `-project`/`-scheme` for SPM). If `xcode-select -p` points at CommandLineTools rather than Xcode.app, or the Simulator runtime for the chosen device is not downloaded, the failure is an xcodebuild error several hundred lines deep — indistinguishable from a Capacitor problem to anyone following the plan step by step.
  - fix: Add a one-line preflight to scripts/build-mobile.mjs (or a short 'before you start' note in stage 1): assert `xcode-select -p` ends in Xcode.app and that `xcrun simctl list devices available` lists at least one iPhone.

**Omitted work**

- No step that writes the real bundle identifier and display name into the native projects. `cap add` does not do it (dist/ios/add.js is a bare template extraction), so PRODUCT_BUNDLE_IDENTIFIER stays `com.getcapacitor.App`, applicationId stays `com.getcapacitor.app`, namespace stays `com.getcapacitor.myapp` and CFBundleDisplayName stays the literal string `My App`. The plan treats capacitor.config.ts's appId as sufficient; it is inert.
- No version wiring. MARKETING_VERSION and CURRENT_PROJECT_VERSION live in project.pbxproj and are not derived from package.json's `version: 0.1.0`. Every archive will be build 1, and App Store Connect / TestFlight reject a duplicate build number — so the second upload fails after a successful 20-minute archive.
- No step adding the Capacitor origins to scripts/dev.mjs:293, which is the only place `pnpm run dev` actually reads TRUSTED_ORIGINS from.
- No decision recorded about which checkout the mobile work happens in. Stage 1 needs a live API on a known port plus a Simulator; a worktree gives random ports and the main checkout gives 5159. The whole stage-1 acceptance depends on this and it is never stated.
- No handling of the shared `packages/client/out` directory across the web, E2E and native builds, and no guard against `cap run`'s implicit sync copying the wrong bundle into the app.
- Nothing decides whether the ~50 PNGs `capacitor-assets` writes into ios/App/App/Assets.xcassets get committed, and nothing verifies that @capacitor/assets 3.0.5 (which rewrites AppIcon.appiconset/Contents.json at platforms/ios/index.js:193-206) produces a set Xcode 26 accepts — the Capacitor 8 template ships a single 1024x1024 universal entry, while assets 3.0.5 predates that layout.
- No fix for mobile-release.yml in stage 1 despite the `push: tags: v*` trigger being live and the workflow being broken in three independent ways (pod install against an SPM project, App.xcworkspace that does not exist, missing ExportOptions.plist).
- No mention that `capacitor.config.ts` supports `android.buildOptions.{keystorePath,keystorePassword,keystoreAlias,keystoreAliasPassword,signingType,releaseType}` (verified at dist/config.js:187-194), consumed by `cap build android`. That is a lighter alternative to hand-patching a generated app/build.gradle for release signing, and the plan considers only the Gradle route.
- No preflight that every installed Capacitor plugin ships a Package.swift. Under SPM the CLI silently drops non-conforming plugins with a warning and still exits 0 (util/spm.js:45-56), so a missing plugin is a device-only runtime error after a green build.
- No note that scripts/ios-dev.sh:67-70 calls `pnpm build:mobile` without NEXT_PUBLIC_API_URL, which stage 1's new refuse-when-unset guard converts into a hard failure of `pnpm dev:ios` — while the fix for that script is parked in the Android-gated stage 9.

### Lens: RUNTIME AND AUTH: will the app actually stay signed in and keep correct time?

- **[critical] stage 1** — Stage 1(f) adds `TRUSTED_ORIGINS=capacitor://localhost,https://localhost` to `packages/server/.env.development`, but `pnpm run dev` sets TRUSTED_ORIGINS in the server child's environment and dotenvx will not overwrite it. The plan's own acceptance environment therefore never trusts the Capacitor origins.
  - failure: `scripts/dev.mjs:293-299` builds `trustedOrigins` from the *shell's* `process.env.TRUSTED_ORIGINS` (empty) plus `devExtensionOrigin`, then `scripts/dev.mjs:340` passes `TRUSTED_ORIGINS=chrome-extension://<id>` into the server process. `packages/server/src/config/env.ts:21` calls `dotenvxConfig({ path: envPath })` with no `overload`, and dotenvx logs `KEY pre-exists (protip: use --overload to override)` and skips it (`@dotenvx/dotenvx/src/lib/main.js:34,108`). So `getTrustedOrigins()` returns `[http://localhost:3392, chrome-extension://…]` — no `capacitor://localhost`. Running the stage-1 acceptance test (`pnpm run dev` + `pnpm cap:run:ios`) and tapping Sign in returns `403 INVALID_ORIGIN` before the password is checked, because better-auth force-validates origin whenever `Sec-Fetch-*` is present (`origin-check.mjs:122-144`) and a WKWebView fetch always sends them. The plan's own troubleshooting note ("if sign-in returns 403 INVALID_ORIGIN, TRUSTED_ORIGINS did not take") sends you to a .env file that looks correct.
  - fix: Add the Capacitor origins to `scripts/dev.mjs`'s `trustedOrigins` array alongside `devExtensionOrigin` (line 293-299) — that is the only place that wins under `pnpm run dev`. Keep the `.env.development` entry for `dev:fixed`/standalone server runs, but do not rely on it. Add a startup log in `packages/server/src/app.ts` printing the resolved `getTrustedOrigins()` so the effective list is visible rather than inferred.
- **[critical] stage 1, 4** — The offline queue silently DELETES any mutation the server refuses, and an expired or revoked bearer token is a server refusal. Stage 1(d) (stay signed in when the session check fails) and stage 4 (durable queue across OS kills) together turn this from a rare web edge case into routine mobile data loss.
  - failure: `packages/client/src/hooks/use-offline-queue.ts:147-150`: `if (isNetworkError(error)) throw error; rejected += 1;` — swallowing the error means `createOfflineQueue.flush`'s runner resolves, so `packages/core/src/offline-queue.ts:118-121` counts it flushed and `write()` drops the row permanently. `packages/client/src/lib/offline.ts:171-176` (`hasServerCode`) classifies a tRPC `UNAUTHORIZED` (thrown at `packages/server/src/trpc/trpc.ts:18-20`) as a server error, not a network error. Concrete: user signs the phone out from Settings → Devices on the web (which the plan's own stage-1 acceptance asks them to do), phone spends the day offline tracking 8 entries into Preferences, reconnects — all 8 replay as 401, all 8 are deleted one at a time, `entries.invalidate()` runs, and the UI shows an empty day with no error toast. Stage 1(d) is what keeps the user inside the app long enough to accumulate the queue instead of being bounced to /login on the first failed check.
  - fix: Treat `UNAUTHORIZED`/`FORBIDDEN` as a stop-the-flush condition, not a drop: in the runner, `if (isNetworkError(error) || isAuthError(error)) throw error;` so the row and everything after it keep their place. Add an `isAuthError(error)` helper next to `isNetworkError` in `packages/client/src/lib/offline.ts` reading `error.data.code`. On that stop, clear the native token, surface a blocking "signed out — sign in to sync N pending entries" state, and only route to /login once the queue is safe. Separately, surface `rejected > 0` to the user for genuine validation refusals — silently deleting a user's tracked time is never acceptable.
- **[critical] stage 4** — The stage-4 running-entry mirror is overwritten with `null` on the first render, so the cold-offline-launch case it exists for still shows no timer.
  - failure: `packages/client/src/hooks/use-sync.ts:206-210` does `const entry = query.data ?? null;` then `React.useEffect(() => { timerStore.getState().setRunning(entry) }, [entry])`. On a cold offline launch `trpc.entries.current` has no persisted cache, so `query.data` is `undefined` → `entry` is `null` → the effect fires and calls `setRunning(null)`, wiping whatever the mirror seeded microseconds earlier. The plan's stage-4 work text says only "seed `timerStore.setRunning()` from it at boot before the query fires" and never edits this effect. Reproduction: airplane mode, timer running, force-quit, relaunch → the seed lands, first render runs the effect, timer disappears. This is verification step (4) of stage 4 and it fails.
  - fix: Gate the effect on the query having actually answered: `if (query.isPending || query.isError) return;` before `setRunning(entry)`, or better `if (!query.isSuccess) return;`. Add a client unit test that mounts `useRunningEntry` with a seeded store and a pending/errored query and asserts `state.running` is still the seeded entry. Also mark the seeded entry provisional (a flag on the store) so nothing writes it back to the server as authoritative.
- **[high] stage 4** — The stage-4 resume sequence is in the wrong order: invalidating `entries.current` before flushing the queue lets the server (which has not yet seen the queued start) blank the running timer.
  - failure: Stage 4 specifies "On resume, in order: force reconnect; `utils.entries.current.invalidate()`; `timerStore.getState().tick()`; flush the queue." Scenario: user starts a timer on a train with no signal (queued `entries.start`, optimistic temp entry in `entries.current` — `use-entry-mutations.ts:344` sets it, and `onSettled` skips the invalidate because `context.queued`). Train reaches a station, user foregrounds the app. Step 2 refetches `entries.current`, the server has no running entry for this user (`packages/server/src/trpc/routers/entries.ts:702-706` returns null), `use-sync.ts:209` calls `setRunning(null)`, and the clock vanishes. It reappears seconds later when the flush lands — a visible "my timer disappeared" event on exactly the recovery path the stage exists to fix.
  - fix: Reorder: force reconnect → `tick()` → flush the queue → THEN `entries.current.invalidate()` (the flush already calls `utils.entries.invalidate()` at `use-offline-queue.ts:155-158`, so the explicit invalidate can be dropped entirely when `pending > 0`). Guard the invalidate with `if ((await refreshPendingCount()) > 0) { await flush(); } else { await utils.entries.current.invalidate(); }`. Note the reconnect in step 1 independently fires a flush via the `syncStatus === "open"` effect (`use-offline-queue.ts:191-194`), so this race exists even without an explicit flush call — the invalidate must be sequenced after, not merely reordered in the handler.
- **[high] stage 1** — Stage 1's acceptance criterion "sign that device row out from the web and confirm both HTTP and the socket drop on the phone" cannot pass. The WebSocket authenticates only at upgrade and is never re-checked.
  - failure: `packages/server/src/ws/handler.ts:63-77` calls `authenticateUpgrade(req)` once and stamps `ws.userId` on the socket. Nothing thereafter re-reads the session — the only liveness mechanism is the ping/pong at lines 107-120, and `roomManager` broadcasts to whatever sockets are joined. So after revoking the mobile session in Settings → Devices, the phone's HTTP calls 401 but its socket stays open and keeps receiving every sync event for that user (descriptions, project names, entry ids) until the app is backgrounded. Writing this as a pass/fail acceptance step means either the step is silently marked pass on a stale observation, or stage 1 is blocked on unplanned server work.
  - fix: Either (a) drop the socket half of that criterion and record it as known behaviour, or (b) add revocation propagation: on `session.delete`/`revoke`, publish a `session.revoked` event and have `roomManager` close every socket whose `userId` matches and whose token is the revoked one (store the token hash on the socket at upgrade), plus a periodic re-validation on the existing ping tick (e.g. re-run `authenticateUpgrade`'s session lookup every 60th ping). Also have `createSyncClient` stop reconnecting on a 401-caused close (see the next finding) so a revoked phone goes quiet rather than hammering.
- **[high] stage 1, 4** — `useSync`'s effect has empty deps and captures the token once, and `createSyncClient` reconnects forever on any close including a 401. A token that hydrates after mount, or one that goes stale, produces a permanently "offline" app with a valid session — and permanently suppresses the queue flush.
  - failure: Stage 1(c) adds `token: getNativeToken() ?? undefined` to `createSyncClient` in `packages/client/src/hooks/use-sync.ts:133-138`, whose effect deps are `[]` (line 157). `getNativeToken()` is the synchronous read of a module variable filled by async secure storage. If `NativeSessionGate` fails to block (see the hydration finding below), or on any route not under it, the socket opens with `token: undefined` → `authenticateUpgrade` finds no session → `handler.ts:66-68` writes 401 → `sync-client.ts:130-134` `onclose` calls `scheduleReconnect()` unconditionally → retries every 1s→30s forever, and the effect never re-runs to pick up the now-hydrated token. Downstream: `syncStatus` never reaches `"open"`, so `use-offline-queue.ts:191-194`'s flush trigger never fires and the queue never drains on any route. Stage 4's `reconnect()` also reopens the *same* client instance, which closed over the old `token` (`sync-client.ts:53`), so a sign-out/sign-in within one launch keeps using the dead token.
  - fix: Key the `useSync` effect on the token (`}, [token])` and read it from React state populated by `hydrateNativeSession()`, so the socket is rebuilt when the token arrives or changes. In `createSyncClient`, accept `token` as a getter (`token?: () => string | undefined`) evaluated in `open()` rather than captured, and stop the retry loop on an auth-shaped close: WebSocket close after a 401 upgrade gives `code 1006` with no useful reason, so add an `onAuthFailure` callback invoked after N consecutive connects that never reached `onopen`, and have the app clear the token and prompt for sign-in instead of retrying. Add a `maxAttempts` so a dead token cannot burn the radio indefinitely.
- **[high] stage 1** — `NativeSessionGate` as specified causes a hydration mismatch on native — the same failure mode the plan itself identifies and avoids for the tab bar in stage 3.
  - failure: Stage 1(d): "renders nothing until `hydrateNativeSession()` resolves on native, and returns children on the first pass on web because `isNative()` is synchronous." Under `output: "export"` every page is prerendered in Node, where `isNative()` returns false (`packages/client/src/mobile/bridge.ts:79`: `typeof window === "undefined"` → false), so the served HTML contains the full app. On native, hydration evaluates `isNative()` as true and returns `null` — a different tree than the served markup. React 19 responds by discarding the server HTML and client-rendering the whole subtree, which is at best a visible flash under a splash configured with `launchAutoHide: false` and at worst throws in `TRPCProvider`/`AuthProvider` mounting order. Stage 3 states this rule explicitly ("a runtime branch that changes the tree disagrees with the served HTML on native") and then stage 1 violates it.
  - fix: Apply stage 3's own remedy: always render the children, and gate *behaviour* rather than the tree. Hold the hydration result in state initialised to `false` on both server and client, and have the auth-dependent consumers (`ProtectedLayout`'s recheck effect, `useSync`'s token) wait on that flag — the DOM shape stays identical between prerender and hydration. Alternatively move hydration into a `useSyncExternalStore` with matching server/client snapshots. Verify by loading the built export in a desktop browser with `window.Capacitor` stubbed and confirming zero hydration warnings in the console.
- **[high] stage 1** — Stage 1(d)'s offline tolerance is attached only to the `.catch()` branch, which does not fire for HTTP-level failures. A 502 from the proxy while the phone is online signs the user out.
  - failure: `@better-fetch/fetch@1.1.21` only rejects when the underlying `fetch` itself throws (`dist/index.js:569`, unwrapped `await fetch(...)`). For any HTTP error response it *resolves* with `{ data: null, error: { status } }` (`dist/index.js:671-679`). So in `packages/client/src/app/(protected)/layout.tsx:41-47`, a 502/503/504 from Coolify mid-redeploy, or a captive-portal interception, takes the `.then()` branch: `result?.data?.session` is undefined → `setRecheck("out")` → `router.replace("/login")`. The plan's fix only touches `.catch()`, so the phone still lands on a login screen during any brief server outage — with a perfectly valid Keychain token — and the running timer is unmounted with it.
  - fix: Branch on the resolved shape too: `.then((result) => { if (result?.data?.session) return setRecheck("in"); if (isNative() && getNativeToken() && result?.error) return setRecheck("in"); setRecheck("out"); })`. Only a clean `{ data: null, error: null }` (server reachable, session genuinely absent) should sign the user out. Add a client unit test covering all three shapes: session present, `{data:null,error:null}`, `{data:null,error:{status:502}}`.
- **[high] stage 3, 4** — `initMobile` has a one-shot `initialized` latch and will already have been called with no handlers by the time AppShell tries to register `onResume`/`onBackButton`. The resume wiring silently never registers.
  - failure: `packages/client/src/mobile/bridge.ts:16-19`: `let initialized = false; export async function initMobile(handlers = {}) { if (initialized) return; initialized = true; ... }`, and the listeners are registered only `if (handlers.onPause || handlers.onResume)` (line 47). `MobileBridgeLoader` (mounted at `app/layout.tsx:60`) already calls `initMobile()` with no arguments today. Stages 3 and 4 pass handlers "through `MobileBridgeLoader` into `initMobile`" from `AppShell`, but `AppShell` lives inside `(protected)/layout.tsx` while `MobileBridgeLoader` is at the root — and even in a single-call design, any code path (a `/login` visit, a stray import, a HMR remount) that reaches `initMobile()` first permanently latches the no-handler version. Result: `App.addListener("appStateChange")` is never registered, no resume reconnect, no resume flush, no clock tick, and Android's hardware back exits the app from every screen — with no error anywhere.
  - fix: Make handler registration independent of the init latch: keep a module-level mutable `handlers` object that `initMobile` reads through (`App.addListener("appStateChange", ({isActive}) => isActive ? handlers.onResume?.() : handlers.onPause?.())`), register the listeners unconditionally on the first init, and export `setMobileHandlers(next)` that AppShell calls in an effect. Add a dev-mode `console.warn` when `initMobile` is called a second time with handlers after the latch, so this cannot regress silently.
- **[medium] stage 4** — Switching the offline queue's backing store from localStorage to Capacitor Preferences with no migration orphans anything already queued.
  - failure: `packages/client/src/lib/offline.ts:54-62` currently resolves `webStorage(window.localStorage)` and `getOfflineQueue()` memoizes it (lines 64-72). Stage 4 branches `resolveStorage()` onto a Preferences adapter on native. A user running a pre-stage-4 build who queued three entries into WKWebView localStorage, then installs the stage-4 build, gets an empty Preferences-backed queue: `OFFLINE_QUEUE_STORAGE_KEY` still holds their three mutations in localStorage where nothing will ever read them. They are simply gone. The plan also deletes `mobile/durable.ts`, which was the only code that could have mirrored them across.
  - fix: In the Preferences adapter's first initialisation, do a one-time migration: read `OFFLINE_QUEUE_STORAGE_KEY` from `window.localStorage`, and if Preferences has no value for that key, write it across and then remove the localStorage copy. Guard with a `trackyourtime.queue-migrated` marker so it runs once. Same treatment for any other durable key you move. Verify by seeding localStorage in the Simulator via Safari Web Inspector, installing the new build, and confirming the pending badge shows the pre-existing count.
- **[medium] stage 1** — iOS Keychain items survive app deletion and reinstall by default, so a reinstalled app silently resumes a previous session — including a previous *user's* session on a shared/handed-down device.
  - failure: Stage 1 stores the bearer token in `@aparajita/capacitor-secure-storage` (Keychain). Delete the app, reinstall from TestFlight/App Store, launch: `hydrateNativeSession()` finds the old token, `ProtectedLayout` resolves "in", and the user is inside someone's account without ever signing in. If the token was still valid this is a genuine auth boundary failure; if it was revoked it's the silent-queue-deletion failure above. Neither is what a user expects from "I deleted the app".
  - fix: On boot, check a Capacitor Preferences marker (`trackyourtime.installed`) — Preferences *is* wiped on delete. If the marker is absent, call `clearNativeToken()` before hydration and write the marker. Ten lines, and it makes delete-and-reinstall mean what the user thinks it means. Add this to `native-session.ts` alongside `hydrateNativeSession()`.
- **[medium] stage 4** — Stage 4 makes the queue durable across OS kills without addressing that the queued `entries.stop` payload deliberately carries no `id`. A stop replayed days later can end a live timer on another device at a stale timestamp.
  - failure: `packages/core/src/offline-ops.ts:55-58` documents `id` as "omitted on purpose during replay — stop whatever is running server-side", and `packages/server/src/trpc/routers/entries.ts:751-756` honours that: with no `id` it does `TimeEntry.findOne({ authorId, end: null })`. Today the queue lives in localStorage and evaporates; stage 4 makes it survive a force-quit indefinitely. Concrete: phone queues start+stop offline on Monday, is left in a drawer. The queued `entries.start` is refused for any non-network reason (a workspace the user left → `workspaceProcedure` NOT_FOUND at `trpc.ts:56`) and silently dropped per the flush bug above. Friday the phone reconnects while a desktop timer started Thursday night is still running: the surviving id-less stop ends the *desktop's* runaway entry at Monday's timestamp, or trips `end <= start` (`entries.ts:763-765`) and is silently dropped too.
  - fix: Once the queue is durable, make stale rows explicit rather than eternal: stamp each queued mutation with `createdAt` (already present at `offline-queue.ts:95`) and refuse to replay an `entries.stop` older than a threshold (e.g. 24h) without an `id` — surface it to the user as "an entry from Monday could not be closed" instead of guessing. Better still, once `entries.start` replays successfully you hold the real id (`replay-offline-mutation.ts:41-42` already captures it for the idle watcher) — thread that id into the following queued stop for the same `tempId` before dispatching it, so the stop is targeted rather than positional.
- **[medium] stage 1** — Making `resolveAuthBaseUrl` "throw loudly on native" converts a misconfiguration into an unrecoverable hung splash with no diagnostics.
  - failure: `packages/client/src/lib/auth-client.ts:33-35` calls `resolveAuthBaseUrl()` at module scope. A throw there on native aborts module evaluation of `auth-client`, which `AuthProvider` imports, which `app/layout.tsx:63` renders — so React never mounts, `MobileBridgeLoader`'s `hideSplash()` never runs, and `capacitor.config.ts:38` `launchAutoHide: false` means the splash stays up forever. The user sees a permanently frozen launch screen; there is no console to read on a TestFlight build. Exactly the failure the survey flags as "worse and harder to diagnose than blank".
  - fix: Do not throw at runtime. Catch it at build time — `scripts/verify-native-export.mjs` already asserts the configured `NEXT_PUBLIC_API_URL` literal appears in an emitted chunk, and `scripts/build-mobile.mjs` already refuses to run when it is unset; that is the correct enforcement point. At runtime, log and render a visible "API URL not configured" screen after calling `hideSplash()`, so a broken build is legible on a device.
- **[medium] stage 1, 8** — Nothing configures or accounts for session lifetime. better-auth's default is 7 days, and there is no story for a phone that is not opened for eight.
  - failure: `packages/server/src/auth/auth.ts:79-97` sets `session.cookieCache` and `additionalFields` but no `expiresIn`/`updateAge`, so better-auth's defaults apply (7 days / 1 day). Refresh happens only when `getSession` runs (`better-auth/dist/api/routes/session.mjs:234-244`, which extends `expiresAt` on the same token — verified, the token does *not* rotate, so capturing `set-auth-token` at sign-in only is correct). A phone left untouched for eight days has a session row that is deleted on the next lookup (`session.mjs:192-201`). Combined with stage 1(d) the user opens the app offline, is kept "signed in" by the stored token, tracks a day of work, and loses all of it to the 401 flush drop. A desktop-only user hits this every vacation.
  - fix: Set `session: { expiresIn: 60*60*24*30, updateAge: 60*60*24 }` explicitly in `auth.ts` so the value is a decision rather than a default, and document it. Independently, make expiry visible on device: when a `getSession` cleanly returns `{data:null,error:null}` on native, clear the token, keep the queue, and show "session expired — sign in to sync N pending entries" rather than an empty app.
- **[low] stage 1** — A global `fetchOptions.onSuccess` that writes `set-auth-token` must not clobber a good token when the header is absent.
  - failure: Stage 1(c) adds "an `onSuccess` that reads the `set-auth-token` response header into storage" to the auth client's global `fetchOptions`, so it fires for every auth call, not just sign-in. The bearer plugin only emits the header when the response carries a session `set-cookie` with a non-zero max-age (`better-auth/dist/plugins/bearer/index.mjs:59-72`), so a plain `/get-session` that needs no refresh emits nothing. If the handler writes `response.headers.get("set-auth-token")` unconditionally it stores `null` and signs the user out on the next launch.
  - fix: `const t = ctx.response.headers.get("set-auth-token"); if (t) await setNativeToken(t);` — never write a falsy value. Add a unit test with a mocked response lacking the header asserting the stored token is unchanged.
- **[low] stage 4** — Device clock skew freezes the timer at 0:00 with no explanation, and the plan has no clock-trust story.
  - failure: `packages/core/src/timer-store.ts:16-17` derives elapsed via `entryDurationSec(entry, Date.now())`, and `packages/shared/src/duration.ts:21-23` clamps with `Math.max(0, ...)`. An online start is stamped by the caller and validated against the server's clock; if the phone's clock is behind (manual change, a device coming back from a dead battery before NTP resyncs), `nowMs - startMs` is negative and the clock sits at 0:00 while the entry genuinely runs. The clamp prevents a negative display but produces a frozen one that reads as a broken app.
  - fix: Capture the server/device clock offset once per connection — the sync socket or any tRPC response `Date` header gives it — and pass `Date.now() + offset` into `tick()`. Failing that, detect `nowMs < startMs` in `useRunningEntry` and show an explicit "device clock looks wrong" hint rather than a stopped-looking clock. Cheap, and it turns an unexplainable bug report into a self-service fix.

**Omitted work**

- No 401 handling anywhere in the client. There is no interceptor on the tRPC link or the auth client that reacts to UNAUTHORIZED by clearing the native token and routing to sign-in. With stage 1(d) removing the redirect-on-failure, an app with a dead token has no exit: every query 401s, every mutation is dropped by the flush, and the user sees a working-looking app that persists nothing. Needed: a single auth-failure handler shared by trpc.ts, auth-client.ts and use-sync.ts.
- No sign-in-while-offline story. `packages/client/src/app/login/page.tsx` calls `signIn.email` and shows whatever error comes back. On a phone that is offline, or one whose token was cleared, the login form simply fails with a network error and there is no cached-credential or retry path. Stage 1 verifies sign-in on a working dev server only.
- No React Query configuration for native. `providers/trpc-provider.tsx` uses defaults, so every screen retries 3 times with exponential backoff while offline and `refetchOnWindowFocus` fires on every app resume — a burst of doomed requests each time the phone wakes. Stage 4 adds `@capacitor/network` for `onlineManager` but never sets `retry`, `networkMode`, or `refetchOnReconnect`, and stage 1 has no such config at all even though stage 1 is where the app first runs on device.
- No persisted React Query cache. Stage 4's running-entry mirror covers exactly one query. Everything else — the entries list, projects, tasks, tags, settings — is empty on a cold offline launch, so the app opens to a running clock floating above blank lists and unresolvable project pickers. Either persist the query cache (`@tanstack/query-persist-client`) or state explicitly that offline launch is timer-only.
- No verification that the bearer token actually reaches the WebSocket. Stage 1's acceptance leans on "starting a timer on the web appears on the phone within a second" as proof the subprotocol worked, but that only proves the socket opened — and it opens fine with a cookie under live reload. Needed: assert in the server log that the session came from `bearer.` (`packages/server/src/ws/auth.ts:27-38`), or add an `authMethod` field to a ws hello frame.
- No plan for `getTrustedOrigins()` being read once at boot (`packages/server/src/app.ts:29` and `auth.ts:36`). Stage 8's production change requires a full server restart, not just an env update — worth stating so a Coolify env edit without a redeploy isn't mistaken for a broken origin list.
- No test coverage for any of the auth or offline paths added. Stage 1 adds exactly one client unit test (headers contain no `authorization` without a token). Nothing tests: token hydration ordering, the ProtectedLayout verdict matrix, flush behaviour under 401, the running-mirror seed surviving a pending query, or queue durability across a storage-backend switch. These are the paths where a regression is invisible until a user loses a day of tracked time.
- No decision about DST in the entry editor. Stage 6 extracts `withDayInZone` and tests re-anchoring and midnight-crossing, but not the case that actually fails silently: moving an entry onto a spring-forward day where the target local time does not exist (e.g. 02:30 in Europe/Berlin). On a phone, date-moving via the native picker is the common edit. Add a test and decide the behaviour (shift forward vs. refuse) rather than inheriting whatever the date library does.
- Nothing covers what happens when the phone's timezone changes mid-timer. `entry.timeZone` is stamped once at start (`use-entry-mutations.ts:593`) and reports resolve day boundaries in `resolveTimeZone(filters.timeZone)` (`reports.ts:656`), so a user who flies mid-entry gets a day-boundary disagreement between phone and desktop. The behaviour is defensible; it is undocumented and untested, and mobile is the only client where it happens routinely.
- No answer for the plan's own acceptance question at the top of stage 1 if the Keychain plugin does not support Capacitor 8. The plan says "record it as debt" and fall back to `@capacitor/preferences` — i.e. plaintext UserDefaults for a session credential, which contradicts `packages/core/src/session-auth.ts:19-21`. That fallback needs an explicit decision from the user before stage 1 starts, not a note in the work text.

## Open questions

- BUNDLE IDENTIFIER — blocks stage 1, cannot be deferred. `capacitor.config.ts:20` and the electron-builder block at package.json:96 both carry `com.example.trackyourtime`. The first `cap add ios` stamps this into `ios/App/App.xcodeproj/project.pbxproj` as PRODUCT_BUNDLE_IDENTIFIER (and into `android/app/build.gradle` as applicationId), and editing capacitor.config.ts afterwards does NOT rewrite them — it would mean hand-editing both trees and, on iOS, re-provisioning. `com.example.*` is also rejected outright by App Store Connect and Play. Suggested by convention from your other config: `com.trebeljahr.trackyourtime` — confirm or give the one you want. Also confirm the display name (`appName` is currently the lowercase `trackyourtime`) and whether the Electron appId should be changed to match at the same time.

- APPLE DEVELOPER ACCOUNT — needed for anything beyond the Simulator. The Simulator needs nothing, so stage 1 lands without it. Installing on your own iPhone needs a signing team in Xcode (a free personal team works, with a 7-day expiry). TestFlight/App Store needs a paid account plus a Team ID for the `ExportOptions.plist` in stage 10. Which of these do you want, and by when?

- DOES ANDROID SHIP IN ROUND ONE? Stage 9 is written but gated. Adding it now doubles the native surface (a second committed tree, a second `cap sync` diff on every Capacitor bump, a second store) for a platform you may not use. iOS-only for round one is a perfectly good answer and costs nothing later — `cap add android` works whenever. Note the two dev scripts have unscoped `pkill`/`lsof kill -9` calls that violate this repo's own scoped-kill rule; I have folded fixing those into stage 9, so tell me if you want them fixed independently of the Android decision.

- ANDROID RELEASE SIGNING — only if Android ships. `mobile-release.yml` decodes `ANDROID_KEYSTORE_BASE64` and passes `KEYSTORE_PASSWORD`/`KEY_ALIAS`/`KEY_PASSWORD`, but the stock Capacitor template has no `signingConfigs` block, so nothing reads them. Do you already have a keystore, or should stage 9 generate one? Where does it live, and are those four GitHub secrets set?

- PRODUCTION TRUSTED_ORIGINS — a live-infrastructure mutation only you can run. `capacitor://localhost` and `https://localhost` must be added to the production `TRUSTED_ORIGINS` via `pnpm --filter @starter/server exec dotenvx set` plus a redeploy, or a production-pointed device build gets `403 INVALID_ORIGIN` before the password is checked, and the socket is separately refused. Nothing in the repo can verify the current value — `.env.production` is not in this worktree. When do you want to do this, and would you rather I prepare the exact command for you to run than touch it myself?

- LOCAL NOTIFICATIONS (stage 7) — the runaway-timer notification triggers an OS permission prompt on first timer start. Do you want that prompt at all? If you would rather the app never ask, drop stage 7's notification half and keep only haptics; the runaway guard still works exactly as it does today whenever the app talks to the server.

- KEYCHAIN PLUGIN — stage 1 uses `@aparajita/capacitor-secure-storage` for the session token because `packages/core/src/session-auth.ts:19-21` requires real secret storage and `@capacitor/preferences` is plain UserDefaults. It is third-party and single-maintainer-ish, though the escape hatch is small (~60 lines of `LAContext`/`androidx.security`). Are you happy taking that dependency, or would you rather ship round one with Preferences and a recorded TODO?

## Deliberately out of scope

- Phone-specific compositions for the wide tables. `reports/detailed-table.tsx:130-165` is ~980px of fixed-width columns inside a ~366px viewport — roughly 2.7 screens of sideways scroll per row, with the row-select checkbox scrolling away from the row it selects. Same shape for summary-table, weekly-grid (since removed, see the note below), invoice-list and the three catalog tables. They all scroll via the shadcn `Table` wrapper's `overflow-auto` (ui/table.tsx:9), which is degradation, not failure, and matches the codebase's own established answer (`settings/page.tsx:58` already scrolls its tab strip). None of them is a tab; all are one level down in More. If daily phone use turns out to include reading Detailed, a card composition for that ONE table is the first thing to add.

- Month view at phone width. `month-view.tsx:127-181` is an unconditional `grid-cols-7 gap-2` of `h-24 p-2` cells — about 26px of content width per cell at 390pt, so the day number and the day total cannot share a line and will clip. This is the one place degradation crosses into breakage and I am shipping it: it is a browse surface two taps deep, and fixing it properly means a phone-only list-of-days, i.e. a second UI.

- Hover-only affordances. Quick-start pin/unpin/edit are `opacity-0 group-hover:opacity-100` (quick-start-menu.tsx:118/131/158) and are unreachable on touch, and roughly fifty `title=` attributes carry information touch can never surface (the `+1d` day-boundary badge, the recorded time zone, undo/redo labels, zoom reset). Quick starts can still be USED on a phone, only curated. The fix is a long-press menu — gesture work.

- A phone gesture model for the calendar. Long-press-to-drag, pinch-to-zoom, a day-list view. Stage 5 fixes only what is destructive.

- A bottom-sheet primitive replacing `ui/dialog.tsx`. Six call sites (EntryEditDialog, ManualEntryDialog, EntryCreateDialog, three catalog forms), every one shared with the web app — the largest web-regression surface in the port, for one screen the phone visits occasionally. `interactiveWidget: "resizes-content"` plus a top-anchoring `html.cap` rule gets the cheap 90%. If that measurably fails on device, a `ui/sheet.tsx` is the right v2.

- Raising the shared `ui/button.tsx` / `ui/input.tsx` sizes to 44pt/16px globally. Screens outside the core loop keep 32-36px targets on a phone; that is genuinely worse than the alternative and is a deliberate trade against a guaranteed absence of web regression.

- CSV/PDF export on mobile. `reports/export-menu.tsx:54`'s `canDownloadFiles()` already returns false on native and says so honestly. `@capacitor/filesystem` + `@capacitor/share` closes it and that detection point is already the right seam — small, well-scoped, and the obvious v2 item. Not something anyone does on a phone in round one.

- Everything lock-screen: Live Activities, Dynamic Island, an Android ongoing/chronometer notification, home-screen widgets, Quick Settings tiles, Siri/App Intents, a Control Center toggle. Also biometric app lock, deep links / `trackyourtime://`, an iOS Share Extension, and any custom Swift or Kotlin whatsoever.

- Persisting the idle watcher (`lib/idle-watcher.ts:19` is in-memory, so an OS kill drops ownership claims). Deliberately left: `use-idle-signal.ts:52-63` pins `lastInputMs` to now whenever the document is not visible and focused, so a backgrounded phone reports `active` forever. That is conservative-correct — it is what stops a phone in a pocket from pausing work the desktop is tracking — and the ownership rule in `packages/core/src/idle.ts:11-39` is what mobile must keep honouring.

- Any change to `@starter/core` or `@starter/shared`. Both are shared with Raycast and the browser extension; the plan adds no export and changes no contract there.

- Tauri. `build:tauri` keeps `ELECTRON_BUILD=1` so its asset prefix is byte-identical to today. `tauri://localhost` is probably root-absolute like Capacitor and probably wants the same fix, but nothing in this session can test it, so it is left alone deliberately rather than changed on a hunch.

## Note (2026-09-14): reports merged into one page

The three web report routes became one page at `/reports`, with a Totals / Entries switch over the same URL-backed filters. Totals is the former Summary content and Entries the former Detailed content. The Weekly report and `weekly-grid.tsx` are gone from the web UI; Timesheet is the week grid, and Totals grouped by day covers weekly totals. `/reports/summary`, `/reports/detailed` and `/reports/weekly` still exist as client-side redirects to `/reports`. The Reports tab now points at `/reports`. Paths in the review notes above that name the old routes or `weekly-grid` describe the code as it was when they were written.
