# Release readiness

Checked 30 September 2026 (Australia/Sydney). This is a dated audit, not a live dashboard. Run `pnpm release:status v0.1.2` to refresh workflow results.

## Published and built

| Surface | Verified state | Evidence |
| --- | --- | --- |
| Hosted web/API | Both serve `8c2ad037`; API, database, API origin, session route and CORS checks pass. | `scripts/coolify-deploy.mjs verify`; [main deployment](https://github.com/trebeljahr/trackyourtime/actions/runs/36652122609) |
| Self-host | v0.1.2 images passed unauthenticated smoke tests on amd64 and arm64. `0.1` and `latest` were promoted. | [Release workflow](https://github.com/trebeljahr/trackyourtime/actions/runs/36388919246) |
| Chrome | Version 0.1.0 is public. Automatic v0.1.2 upload skipped for missing store credentials. | [Chrome listing](https://chromewebstore.google.com/detail/track-your-time/opibnndhibnigcfgfbgbipakadhnbjfi), [extension workflow](https://github.com/trebeljahr/trackyourtime/actions/runs/36388919365) |
| Firefox | Package built; AMO submission skipped. No public listing configured. | Extension workflow; `STORES.firefox` |
| macOS | Signed and notarized dmg/zip, plus signed Mac App Store package, built successfully. Direct downloads remain in a draft. | [Desktop workflow](https://github.com/trebeljahr/trackyourtime/actions/runs/36388919353) |
| Windows | Unsigned NSIS installer built as an Actions artifact. Draft releases exclude unsigned installers. Store build skipped for missing identity. | Desktop workflow; `scripts/lib/desktop-release.mjs` |
| Linux | Rebuilt AppImage/deb/rpm pass native x64 and ARM64 QA at `a901eaa7`. Original v0.1.2 draft packages remain broken and unpublished. | [Native package QA](https://github.com/trebeljahr/trackyourtime/actions/runs/36651056513) |
| Mobile | Signed Android and iOS builds uploaded to Play testing and TestFlight. Public listing approval is not established by those uploads. | [Mobile workflow](https://github.com/trebeljahr/trackyourtime/actions/runs/36388919330) |
| Raycast/MCP | Source available; Raycast listing and npm publication remain pending. | Package metadata and configured store links |

A successful desktop workflow job can skip packaging. The status command now counts successful **Build and package** steps, reports skipped channels, and calls out unsigned Windows artifacts.

## Package QA

Downloaded the original v0.1.2 ARM64 AppImage, deb and rpm. All three matched the release's SHA256SUMS.txt. Tests install each artifact into a disposable container, without weak dependency assistance, and launch it under Xvfb.

| Original v0.1.2 artifact | Result | Resolution in current source |
| --- | --- | --- |
| AppImage | Fails before extraction: `libz.so` is missing. The old runtime expects a development-only symlink. | Select electron-builder's static AppImage runtime with `toolsets.appimage: "1.0.3"`. |
| deb | Fails to start with missing shared libraries. | Explicit `deb.depends`, including `libgbm1` and `libasound2`, already landed on main. |
| rpm | Fails to start with missing shared libraries. | Explicit `rpm.depends`, including `alsa-lib`, `mesa-libgbm` and `libsecret`, already landed on main. |

The rebuilt ARM64 AppImage and deb both install and reach `app://-/login/` with no console or page errors. These are local builds from current source, not replacements for the tagged release artifacts.

The rebuilt RPM now passes on both architectures. Colima's kernel log confirmed that its 2 GB VM killed the earlier local `rpmbuild` during payload compression. The builder selects `rpm.compression: "gzip"` instead of FPM's default multithreaded xz, trading archive size for lower compression memory use. Local heavy builds remained paused because host swap use was about 9 GB; the native GitHub runners completed verification.

[Linux Package QA run 36651056513](https://github.com/trebeljahr/trackyourtime/actions/runs/36651056513), at `a901eaa7`, passed all six packages:

| Native architecture | AppImage | deb | rpm |
| --- | --- | --- | --- |
| x64 | Passed | Passed | Passed |
| ARM64 | Passed | Passed | Passed |

Each package installed without weak dependency assistance, resolved its desktop entry and icon, and reached `app://-/login/`. All six result files contain no console or page errors. Screenshots and install logs were downloaded and reviewed; the x64 and ARM64 RPM screenshots are identical. Evidence is retained as `linux-package-qa-x64` and `linux-package-qa-arm64` Actions artifacts, with the tested packages stored separately. These artifacts use the current package version 0.1.2 for QA only. They did not replace the original tagged release assets.


Release CI now runs `pnpm test:desktop:packages` on both native Linux architectures before the draft release job. It uploads screenshots and diagnostic logs even on failure. A new release must pass these checks; the old v0.1.2 run did not contain them.

The separate [Linux Package QA workflow](../.github/workflows/linux-package-qa.yml) was pushed and dispatched after authorization. It builds and tests AppImage, deb and rpm on native x64 and ARM64 runners, one architecture at a time. Every expected package must exist. It saves packages, screenshots and logs as Actions artifacts and has no store credentials or release-writing steps.

Limits: package startup QA does not prove login, offline replay, updates, tray behavior, FUSE mounting or a real Wayland desktop. Those remain platform QA steps. Both native architectures passed package startup; no real Linux desktop session was tested.

## Desktop and device QA

The Linux x64 desktop harness passed **36 tests** in [main CI](https://github.com/trebeljahr/trackyourtime/actions/runs/36652122609), at `8c2ad037`. It covers the source app's authentication, session handling, offline/tray flows, shell and activity behavior. That source-app result complements the six native package startup tests; it does not establish interactive desktop/device QA.

Native simulator QA ran on 30 September against app source `c435dae6`: iPhone 17 / iOS 26.5 passed 9 checks; Android 15 / API 35 passed 10, including the software keyboard; iPad mini / iOS 26.5 passed 8, with landscape blocked because its windowing mode rejects programmatic rotation. The checks cover packaged WebViews, native plugins, fake credential persistence, lifecycle, auth navigation, local-server selection, bearer HTTP/WebSocket authentication, timer relaunch, offline replay and session revocation. A follow-up interactive check used Simulator’s Rotate toolbar and verified iPad landscape at 1133×744 with no horizontal overflow or captured errors; the headless programmatic-orientation check remains blocked. Native coordinate input initially failed with `noWindowsAvailable`; resetting the control session, reacquiring Simulator and fitting its window restored taps. Four interactive iPhone keyboard checks then passed: email/software-key entry, password focus/masked entry, dismissal and reopening. Viewport height changed 874→539→874 with visible focused fields, no overflow and no captured errors. A subsequent iPad keyboard check reproduced a rotation defect: the password field fell below the 316-point landscape viewport. The iOS bridge now reveals an occluded focused editor after focus or viewport changes. The patched build passed portrait password entry, landscape rotation, keyboard dismissal and reopening; the field stayed at 138–178 points in landscape. Twelve targeted unit tests, the mobile export/typecheck and all nine iPhone native checks passed against the updated dependencies and fix. On 1 October, native XCUITest passed both signed-in iPad scenarios: Tracker/Reports landscape navigation, timer persistence through relaunch, and window resizing from 1133×744 to 384×464 and then 375×744. Both timers were confirmed stopped and saved as mobile entries on the isolated API. Layout checks found no horizontal overflow or captured errors. The repeatable runner is `pnpm test:ios:ui`; evidence is under `test-results/release-qa/ipad-xcuitest-2026-10-01/run-5/`. Evidence is retained under `test-results/release-qa/native-2026-09-30/ipad-keyboard/` and `ios-rotation-fix-suite/` in the primary checkout.

These are isolated debug QA builds with the real credential-store plugins excluded, not the signed TestFlight/Play artifacts. Physical secure storage, actual radio changes, native sharing and signed-build acceptance remain open. No physical Apple or Android devices were detected in the latest check. The retained iPhoneOS IPA predates the keyboard fix; a new signed build is needed to validate that fix on hardware. Android normal relaunch first backgrounds the app; abrupt termination during an asynchronous Preferences write is a separate unresolved durability case. See [the native QA commands](cross-platform-testing.md#isolated-ios-simulator-qa). JSON results and screenshots are under `test-results/ios-simulator`, `test-results/ios-ipad` and `test-results/android-emulator` in the QA worktree.

Record the exact artifact version, OS/device and result for each remaining check:

| Environment | Remaining checks |
| --- | --- |
| Linux x64 and ARM64 | Native package QA passed. Test launcher integration, tray and FUSE on a real desktop. |
| macOS ARM64 and x64 | Install the signed/notarized artifact; check login, relaunch, tray, permission prompts and uninstall. |
| Windows x64 and ARM64 | Install the Actions NSIS artifact in an isolated test machine; check login, relaunch, tray and uninstall. Verify the signed installer again once signing exists. |
| Physical iPhone/iPad and Android | Install through TestFlight/Play testing; check login, background/resume, offline start/stop/reconnect, session expiry, keyboard/safe areas and native sharing. |
| Desktop updater | Observe an update between two published versions, preserving the session and queued work. No published desktop release exists yet. |

Use disposable QA accounts and profiles. Automated desktop tests must keep the headless mock keychain enabled; a separate user-data directory alone does not isolate the OS keychain.

## Signing and store audit

App Store Connect was queried with read-only GET requests on 30 September. Credential values, reviewer credentials and contact details were not printed or changed.

| Channel | Verified state | Next step |
| --- | --- | --- |
| iOS | 0.1.2 build **501** is `VALID`, unexpired and `READY_FOR_BETA_TESTING` internally. External testing is `READY_FOR_BETA_SUBMISSION`. | Complete device QA. Match the submission version to the chosen build, then select that build. |
| iOS listing | Version **0.1.1**, `PREPARE_FOR_SUBMISSION`, no selected build. Review contact/demo fields and notes are populated. English metadata exists; all eight screenshots are `COMPLETE`. | Resolve version/build mismatch and the outstanding trader/contact tasks from the vault before submitting. |
| Mac App Store | Version **1.0**, `PREPARE_FOR_SUBMISSION`, no selected build. English description, keywords, support and marketing URLs were saved and verified through the API on 30 September. Screenshots remain absent. Private reviewer contact, demo login and Mac-specific review notes are now saved and verified after explicit approval. No Mac build appeared in the returned build list. | Resolve the version/build choice, prepare Mac screenshots and review details, then upload the signed pkg after QA. |
| macOS direct | CI verified signatures, hardened runtime, notarization and stapling for v0.1.2. Signing secrets are configured. | Complete installed-app QA and publish only a verified new desktop release. |
| Windows | No certificate/Azure signing secrets or Partner Center identity variables are configured. | Choose or supply the existing signing setup and Store identity. No account was purchased or configured. |
| Google Play | Console rechecked on 30 September: draft app, internal testing, production inactive. Setup showed 10/11 tasks complete; listing descriptions were blank despite existing icon, feature graphic and four phone screenshots. Both descriptions are now saved as draft changes. | Finish listing review, complete device QA, then prepare production submission. |

### Store preparation follow-up (30 September 2026)

- GitHub secret names and repository variables were rechecked. No Windows certificate/Azure signing set or Microsoft Store identity exists in this repository's configuration. Existing code already supports either signing route and builds the Store package separately.
- Partner Center reached an email-verification challenge using the existing Microsoft session. Account enrollment and the reserved product identity could not be inspected beyond that challenge. Complete sign-in before configuring the three `WINDOWS_STORE_*` variables; do not infer identity from the app name.
- Microsoft Store signing does not require buying a certificate for this packaged-app route. [Microsoft's publishing guide](https://learn.microsoft.com/en-us/windows/apps/publish/get-started) distinguishes Store signing from direct distribution. Direct NSIS downloads still need a signing provider. [Azure Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart) (formerly Trusted Signing) fits the existing integration, subject to account eligibility, identity validation and an approved paid plan. No service was purchased or access role granted.
- Play app `4975592922038277338` belongs to an organization developer account. Saved English short description (71 characters) and full description (1,453 characters), adapted from the current vault copy and checked against product features. Console confirmed “Your changes have been saved” and “Draft changes.” No review submission or production release occurred.
- Mac localization `6a67aca9-c67d-412e-901b-b2fcd243ea50` now has desktop-specific English copy, keywords, `https://trackyourtime.dev/support/` and `https://trackyourtime.dev/`. Only empty fields were filled; a GET verified every saved value. No version number, selected build, release mode or legal declaration changed.
- Apple audit reconfirmed iOS 0.1.2 (501) and 0.1.1 (401) as valid builds, with iOS submission version 0.1.1 still unselected. Choosing the release candidate remains open. Device QA belongs to the separate **Check project status** chat.

The downloaded v0.1.2 mobile Actions artifacts were also checked locally. The iOS IPA passes `codesign --verify --deep --strict`, identifies team `4BHY8H2J25`, and contains version 0.1.2 build 501. The Android AAB passes `jarsigner -verify`; its self-signed upload certificate produces the expected JDK trust-chain warning. Both bundles contain the production API URL, the correct app ID, and no Capacitor development-server override. These checks do not establish device behavior or Play-generated APK signing.

| Artifact | SHA-256 |
| --- | --- |
| `App.ipa` | `14087e36a91bf8e7a306eaec6f5dbc8f974fb981b0e8ca22d36ae1c2937894a0` |
| `app-release.aab` | `68238061ad41a5a203d9554e836b4513c89cfb65a6e9278427ab8541ea1315ec` |

Chrome/AMO and Snap submission credentials remain unset. Homebrew's token and `trebeljahr/homebrew-tap` repository variable are configured. Their presence does not prove a package-manager submission ran.

## Local validation

- Donation-link and return-marker tests: 18 passed. Covers query/hash preservation, navigation after mount, keyboard focus, pointer and auxiliary clicks, context menus, server render and native-shell hiding.
- Deployment, release planning/status, Linux package rules and generated documentation: 175 tests passed.
- Full workspace typecheck and production build (`pnpm build`) passed. The build needed an unsandboxed retry because Turbopack could not bind its local CSS worker port inside the sandbox.
- `actionlint .github/workflows/desktop-release.yml` and `git diff --check` passed.
- Desktop static export and Electron bundling succeeded. macOS cannot package rpm without `rpmbuild`, so RPM packaging uses a disposable Linux container.
- Read-only production deployment gate passed. The per-app webhook deployment completed in CI and both live services passed the gate at `8c2ad037`. No Coolify API token was needed.
- Follow-up validation: 98 package/release unit tests passed. Both Linux QA/release workflows pass `actionlint`; electron-builder accepts the updated configuration schema. Native CI then passed all six packages with gzip RPM compression. Physical-device tests remain unrun. Native simulator results and their limits are recorded above.

## Before publishing

- [ ] Donation route/deployment: owned by the user's separate chat. The earlier audit found a 404 at `https://ricos.site/donate/track-your-time`; this follow-up did not recheck or change it.
- [x] Push and verify main. Run [36652122609](https://github.com/trebeljahr/trackyourtime/actions/runs/36652122609) passed typecheck, lint, build, unit/client tests, 106 browser tests, 36 desktop tests and deployment. Both live services independently passed the read-only gate at `8c2ad037`. This commit fixes the midnight-dependent timer assertion found in the first push; no application behavior changed for that fix.
- [ ] Prepare a new patch release containing the Linux fixes. Do not replace or retag v0.1.2. Keep its draft unpublished.
- [ ] Re-run the package gates on the next patch release artifacts. Current-source native x64/ARM64 package checks passed. Finish interactive macOS/Linux/Windows QA and test an update between published versions before claiming that path verified.
- [ ] Choose Windows signing and configure it before offering a direct Windows download. Configure Partner Center identity before building a Microsoft Store package.
- [ ] Publish a verified desktop draft, then set only the available `DESKTOP_DOWNLOADS` links and run the package-manager workflow. Do not enable Windows links without a published signed installer.
- [ ] Complete mobile device QA and store review information, then submit production listings. Keep the outstanding contact/trader information in the human-task notes.
- [ ] Configure Chrome/AMO submission credentials if automatic extension updates are wanted. Chrome's existing listing already satisfies the first-store-listing launch gate.
- [ ] Resolve the Raycast licensing decision before its store submission. No license change was made here.
- [ ] Verify real password-reset/invitation delivery and a clean-VPS self-host install before making those launch claims. This audit sent no mail and provisioned no servers.

An earlier dependency-update check failed typecheck because the newer two-factor enable response may be OTP-only. Main's pinned dependencies pass. That separate branch was not merged or validated by this QA work.

Long-form launch and manual QA tasks live in the project vault's `trackyourtime` folder, in `tracktime-launch-checklist.md`, `tracktime-human-tasks.md` and `1-tracktime-manual-notes.md`.

### Owner-only testing follow-up (30 September 2026)

The user selected only their own account for Play testing. Created the `Rico only` email list with one owner account, selected it for Track Your Time internal testing, and saved. Console now reports the track **Active**, latest release **0.1.2**. The opt-in URL is https://play.google.com/apps/internaltest/4701618739995568640. No production release was made.

Microsoft Partner Center sign-in now succeeds. Apple’s Free Apps Agreement is Active. The DSA contact form has the LLC address prefilled but still requires a calling code, contact phone and email. Existing LLC notes list the registered agent’s contact details, not a dedicated public developer contact. The form remains unsubmitted pending the user’s public contact choice. Notify the user when an actual agreement or identity-verification step needs their action.

### Shared signing account discovery (30 September 2026)

The separate **Check landing page status** chat found the existing Azure Basic `ricoslabs-signing` account in West Europe (`https://weu.codesigning.azure.net/`). Its recorded audit shows no identity validations or certificate profiles. A scoped Identity Verifier role assignment is staged for user approval there. Avoid creating a duplicate account; Track Your Time still needs its own CI configuration after the shared identity/profile setup succeeds. GitHub credential-name inspection reconfirmed no Windows signing set in this repository.

Partner Center sign-in works, but its Home page shows no app workspace. Enrollment remains unverified. Further navigation was blocked when the Chrome browser connection disappeared and native navigation stopped responding. Play listing review remains unfinished. Mac review-detail transfer was blocked by automatic approval review pending explicit user approval to reuse the existing iOS reviewer contact and demo credentials; no transfer occurred.

### Mac review details completed (30 September 2026)

After explicit user approval, copied the existing iOS reviewer contact and demo login into the same app’s private Mac App Store review form, with Mac-specific review notes. A follow-up GET verified all eight fields were present and all seven shared fields matched the iOS record. No sensitive values were logged. No build was selected and no review submission or public release occurred. This resolves the earlier automatic approval-review blocker for this transfer.
