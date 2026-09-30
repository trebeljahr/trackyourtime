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

Read-only local inventory found no UTM VMs and no connected iOS or Android devices. iOS 26.5 simulators and Android AVDs exist but are stopped. No simulator was booted while swap use was high. Phone-width browser tests are not native-device QA.

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
| Mac App Store | Version **1.0**, `PREPARE_FOR_SUBMISSION`, no selected build. English description, keywords, support URL and screenshots are absent; review details are absent. No Mac build appeared in the app's returned build list. | Prepare matching-version metadata, screenshots and review details; upload the signed pkg after QA and authorization. |
| macOS direct | CI verified signatures, hardened runtime, notarization and stapling for v0.1.2. Signing secrets are configured. | Complete installed-app QA and publish only a verified new desktop release. |
| Windows | No certificate/Azure signing secrets or Partner Center identity variables are configured. | Choose or supply the existing signing setup and Store identity. No account was purchased or configured. |
| Google Play | v0.1.2 CI signed and uploaded to testing. Current Console review/production state was not rechecked. | Complete device QA and inspect the Console's remaining review tasks before production submission. |

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
- Follow-up validation: 98 package/release unit tests passed. Both Linux QA/release workflows pass `actionlint`; electron-builder accepts the updated configuration schema. Native CI then passed all six packages with gzip RPM compression. Physical-device tests remain unrun; no device was connected and local emulators stayed stopped because swap use was high.

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
