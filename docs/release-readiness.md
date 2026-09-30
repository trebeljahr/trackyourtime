# Release readiness

Checked 30 September 2026 (Australia/Sydney). This is a dated audit, not a live dashboard. Run `pnpm release:status v0.1.2` to refresh workflow results.

## Published and built

| Surface | Verified state | Evidence |
| --- | --- | --- |
| Hosted web/API | Both serve `c879975f`; API, database, API origin, session route and CORS checks pass. | `scripts/coolify-deploy.mjs verify`; [main deployment](https://github.com/trebeljahr/trackyourtime/actions/runs/36623447711) |
| Self-host | v0.1.2 images passed unauthenticated smoke tests on amd64 and arm64. `0.1` and `latest` were promoted. | [Release workflow](https://github.com/trebeljahr/trackyourtime/actions/runs/36388919246) |
| Chrome | Version 0.1.0 is public. Automatic v0.1.2 upload skipped for missing store credentials. | [Chrome listing](https://chromewebstore.google.com/detail/track-your-time/opibnndhibnigcfgfbgbipakadhnbjfi), [extension workflow](https://github.com/trebeljahr/trackyourtime/actions/runs/36388919365) |
| Firefox | Package built; AMO submission skipped. No public listing configured. | Extension workflow; `STORES.firefox` |
| macOS | Signed and notarized dmg/zip, plus signed Mac App Store package, built successfully. Direct downloads remain in a draft. | [Desktop workflow](https://github.com/trebeljahr/trackyourtime/actions/runs/36388919353) |
| Windows | Unsigned NSIS installer built as an Actions artifact. Draft releases exclude unsigned installers. Store build skipped for missing identity. | Desktop workflow; `scripts/lib/desktop-release.mjs` |
| Linux | v0.1.2 packages exist in the draft, but ARM64 package QA fails. Do not publish those bytes. | Package QA below |
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

The rebuilt ARM64 AppImage and deb both install and reach `app://-/login/` with no console or page errors. The corrected RPM remains unverified locally: this Mac lacks `rpmbuild`; isolated Linux rebuilds reached file processing, then `rpmbuild` exited without an exit status. No replacement RPM was produced. The native Linux release CI must build and smoke-test it before publication. These are local builds from current source, not replacements for the tagged release artifacts.

Release CI now runs `pnpm test:desktop:packages` on both native Linux architectures before the draft release job. It uploads screenshots and diagnostic logs even on failure. A new release must pass these checks; the old v0.1.2 run did not contain them.

Limits: startup QA does not prove login, offline replay, updates, tray behavior, FUSE mounting or a real Wayland desktop. Those remain platform QA steps. This Mac verified ARM64 only; x64 runs in CI after a push.

## Local validation

- Donation-link and return-marker tests: 18 passed. Covers query/hash preservation, navigation after mount, keyboard focus, pointer and auxiliary clicks, context menus, server render and native-shell hiding.
- Deployment, release planning/status, Linux package rules and generated documentation: 175 tests passed.
- Full workspace typecheck and production build (`pnpm build`) passed. The build needed an unsandboxed retry because Turbopack could not bind its local CSS worker port inside the sandbox.
- `actionlint .github/workflows/desktop-release.yml` and `git diff --check` passed.
- Desktop static export and Electron bundling succeeded. macOS cannot package rpm without `rpmbuild`, so RPM packaging uses a disposable Linux container.
- Read-only production deployment gate passed. Required per-app webhook secret names exist in GitHub; no Coolify API token is present. Secret values and webhook execution were not tested.

## Before publishing

- [ ] Deploy the project donation route on ricos.site first. `https://ricos.site/donate/track-your-time` returned 404 during this audit. Its local source is in the separate ricos.site checkout. Track Your Time's prepared links use that route and carry `returnTo`.
- [ ] Push the integrated local main and confirm its CI and hosted deployment. The deployed commit above predates the per-app webhook deployment changes.
- [ ] Prepare a new patch release containing the Linux fixes. Do not replace or retag v0.1.2. Keep its draft unpublished.
- [ ] Verify both Linux architectures with the new CI package checks. Finish interactive macOS/Linux/Windows QA and test an update between published versions before claiming that path verified.
- [ ] Choose Windows signing and configure it before offering a direct Windows download. Configure Partner Center identity before building a Microsoft Store package.
- [ ] Publish a verified desktop draft, then set only the available `DESKTOP_DOWNLOADS` links and run the package-manager workflow. Do not enable Windows links without a published signed installer.
- [ ] Complete mobile device QA and store review information, then submit production listings. Keep the outstanding contact/trader information in the human-task notes.
- [ ] Configure Chrome/AMO submission credentials if automatic extension updates are wanted. Chrome's existing listing already satisfies the first-store-listing launch gate.
- [ ] Resolve the Raycast licensing decision before its store submission. No license change was made here.
- [ ] Verify real password-reset/invitation delivery and a clean-VPS self-host install before making those launch claims. This audit sent no mail and provisioned no servers.

The unrelated Dependabot PR currently fails typecheck because the newer two-factor enable response may be OTP-only. Main's pinned dependencies pass. That update needs a response-shape guard and its own validation before merge.

Long-form launch and manual QA tasks live in the project vault's `trackyourtime` folder, in `tracktime-launch-checklist.md`, `tracktime-human-tasks.md` and `1-tracktime-manual-notes.md`.
