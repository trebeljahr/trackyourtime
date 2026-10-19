# Release readiness

Checked 19 October 2026 (Australia/Sydney). This is a dated audit, not a live dashboard. It replaces the 30 September audit, which described v0.1.2; that text is `git show 8d66ae10:docs/release-readiness.md`. Run `pnpm release:status v0.3.0` to refresh workflow results. Event dates and times are UTC.

This file records evidence. Every open step has one owner in the project vault's `trackyourtime` folder: `tracktime-human-tasks.md` for steps only the owner can do, and `1-tracktime-manual-notes.md` for agent work. The vault's `tracktime-launch-checklist.md` lists the gates with links to those items.

## Summary

v0.2.2 is the only published GitHub release. v0.3.0 is built for every channel except the Microsoft Store and runs on the hosted service, but its GitHub release is still a draft. Chrome serves 0.3.0. Apple rejected iOS and macOS 0.3.0 with a Guideline 2.1 information request; both review submissions are still `UNRESOLVED_ISSUES`, and the reply task is open. Firefox 0.3.0 is in review. Android is on Play's internal track only. The download page still says "Not released yet" for every desktop channel.

## Releases

| Tag | State | Date |
| --- | --- | --- |
| v0.3.0 | Draft. All desktop, mobile, extension and image workflows passed. | Built 8 October |
| v0.2.2 | Published, marked Latest. | Published 1 October 23:47 UTC |
| v0.2.1, v0.2.0 | Draft | Created 1 October |
| v0.1.0–v0.1.2 | Draft. The v0.1.2 Linux packages failed QA and stay unpublished. | Created 26–28 September |

Evidence: `gh release list`; v0.3.0 runs [release](https://github.com/trebeljahr/trackyourtime/actions/runs/37729218271), [Extension Release](https://github.com/trebeljahr/trackyourtime/actions/runs/37729218270), [Desktop Release](https://github.com/trebeljahr/trackyourtime/actions/runs/37729218359) and [Mobile Release](https://github.com/trebeljahr/trackyourtime/actions/runs/37729218392), all `success`.

## Surfaces

| Surface | State on 19 October | Evidence |
| --- | --- | --- |
| Hosted web app | Served by the Cloudflare Worker `trackyourtime-client` since 18 October. `/version.json` reports `d6b6877d` (= `origin/main`), version 0.3.0. | `curl https://trackyourtime.dev/version.json`; [build-and-deploy run 39179308404](https://github.com/trebeljahr/trackyourtime/actions/runs/39179308404) activated it and passed the gate at 00:21 UTC. |
| Hosted API | Coolify, `d6b6877d`. The deploy gate passed: API status ok, database up, client API URL, `get-session` 200, CORS. | Same run. The audit machine's network proxy blocks `api.trackyourtime.dev` (TLS interception, "Web Page Blocked"), so no direct read was possible. |
| Self-host images | v0.3.0 server and client images passed smoke tests on amd64 and arm64; `0.3`/`latest` promoted. | [Run 37729218271](https://github.com/trebeljahr/trackyourtime/actions/runs/37729218271) |
| Chrome | Version 0.3.0 is public; the listing shows "Updated October 17, 2026". The tag run skipped the upload (no store secrets then); a dispatch on 17 October uploaded and submitted it. | [Listing](https://chromewebstore.google.com/detail/track-your-time/opibnndhibnigcfgfbgbipakadhnbjfi); [run 38997891549](https://github.com/trebeljahr/trackyourtime/actions/runs/38997891549) logged `publish: PENDING_REVIEW` for 0.3.0. |
| Firefox | 0.3.0 submitted to AMO by hand on 19 October. Not public: AMO's public add-on API answers 401. `STORES.firefox` is `null`. `AMO_JWT_*` secrets exist since 18 October; the next stable tag is the first CI submission. | `curl https://addons.mozilla.org/api/v5/addons/addon/trackyourtime@ricoslabs.com/` |
| macOS direct | v0.2.2 dmg/zip (arm64, x64) are public, signed and notarized. v0.3.0 builds sit in the draft. | v0.2.2 release assets; [Desktop Release 36941084893](https://github.com/trebeljahr/trackyourtime/actions/runs/36941084893) |
| Windows direct | `TrackYourTime-Setup-0.2.2.exe` is public and signed with Azure Artifact Signing. The v0.3.0 installer is in the draft. | Run 36941084893 logged `Channel win: signed`; the draft job never attaches `-unsigned` files. |
| Microsoft Store | Not built. The `win-store` job skips: no `WINDOWS_STORE_*` identity. Partner Center account verification waits on a business phone number. | `pnpm release:status v0.3.0` |
| Linux | v0.2.2 AppImage, deb, rpm and tar.gz for x64 and ARM64 are public. They passed the native package gates in the release run. | Run 36941084893 (`linux-x64`, `linux-arm64` jobs) |
| Download page and package managers | `DESKTOP_DOWNLOADS` is all `null` on `origin/main`, so `/download/` shows "Not released yet" six times although v0.2.2 is public. The Homebrew tap's `Casks/` holds only `.gitkeep`; Desktop Manifests has not run. | `packages/client/src/lib/site-links.ts`; `gh api repos/trebeljahr/homebrew-tap/contents/Casks` |
| iOS | Build 0.3.0 (1001) `VALID`. Version 0.3.0 `REJECTED`. Review submission `15788d32` is `UNRESOLVED_ISSUES`, submitted 9 October. Cause: Guideline 2.1 Information Needed for a new developer account; no defect was reported. Not on the public App Store. | App Store Connect read-only GETs (app `6814737131`); iTunes lookup returns 0 results. |
| Mac App Store | Build 0.3.0 (1401) `VALID`. Version 0.3.0 `REJECTED`. Review submission `a38a64a2` is `UNRESOLVED_ISSUES`, submitted 9 October. | Same GETs |
| Google Play | 0.3.0 (1001) uploaded signed to the internal track, release status `completed`. The public listing answers 404. Play Console was not rechecked: the Play service account exists only as a CI secret, so the audit machine has no read-only path. | Mobile Release run 37729218392, `android` job |
| Raycast | Not submitted. `packages/raycast/package.json` is `private: true`, license AGPL-3.0-or-later; the license decision is open. | Package metadata |
| MCP server | Not published. `@starter/mcp` is `private: true`. | Package metadata |

## Configuration

- Repository variables: only `HOMEBREW_TAP_REPO`. `NEXT_PUBLIC_SENTRY_DSN` and `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` are unset, and the live HTML of `/` loads no analytics or error-reporting script.
- Store secrets present: `CWS_SERVICE_ACCOUNT_JSON`, `CWS_PUBLISHER_ID` (17 October), `AMO_JWT_ISSUER`, `AMO_JWT_SECRET` (18 October), the seven `AZURE_*` signing secrets, Apple, Android and Play secrets. Values were not read.
- `www.trackyourtime.dev` returns NXDOMAIN. `tracktime.trebeljahr.com` returns 503 "no available server".
- The donation route `https://ricos.site/donate/track-your-time` returns 200.
- Production account mail was not rechecked. The Coolify environment needs an API token that CI does not hold, and the network proxy blocks the API's `health.check`, which reports `authConfig.emailDeliveryConfigured`. Last recorded state: no mail transport, so password reset, verification and invitation mail are not delivered. SES production access for the shared AWS account was granted on 30 September, so the remaining step is the server environment and the backfill in `docs/deploy.md`.
- Local `main` was seven commits ahead of `origin/main`: six performance commits and `dd8fb954`, which corrects the privacy page's extension section (it denied the `cookies` permission and the Firefox content script that 0.3.0 has). None is pushed or deployed, so the live privacy page still shows the old text. The owning vault item, "Fix the extension section of the public privacy page", is ticked.

## Open gates

Each gate names the vault item that owns it.

| Gate | State | Owner |
| --- | --- | --- |
| Apple 2.1 reply, iOS and macOS | Rejected since 9 October; needs a recording and the drafted reply. | `tracktime-human-tasks.md` → "Answer Apple's 2.1 …"; draft in `trackyourtime-app-review-reply-2026-10-09.md` |
| Physical device and installed desktop QA | Not run on hardware. Simulator results from 30 September and 1 October still apply to their builds only. | `tracktime-human-tasks.md` → "Finish installed-app/device QA", "Desktop QA on the Mac pkg's app", "iOS device QA on the TestFlight build" |
| EU trader declaration | Reported done by the owner on 9 October, not verified. W-8BEN pending. | `tracktime-human-tasks.md` → "EU trader declaration" |
| Google Play production | Internal track only. | `tracktime-human-tasks.md` → "Complete Google Play production release after device QA" |
| Publish the v0.3.0 desktop draft | Draft. Publishing is the release decision, and it is also the first chance to observe an update between two published versions. | `tracktime-human-tasks.md` → "Finish desktop and mobile distribution" |
| Desktop download links and Homebrew cask | All `null`; tap empty. | `1-tracktime-manual-notes.md` → "Set desktop download links" |
| Firefox listing | In review; link not set; CI submission unproven. | `1-tracktime-manual-notes.md` → "Firefox Add-ons listing" (approval, screenshot, next-tag check) |
| Microsoft Store | Partner Center verification needs a business phone number. | `tracktime-human-tasks.md` → "Verify the code sent to support@ricoslabs.com" and "Get a phone number that is not your personal mobile" |
| Production account mail | Off at last record. | `1-tracktime-manual-notes.md` → "Turn on hosted account mail"; then `tracktime-human-tasks.md` → "Trigger a real password reset and invitation" |
| Clean-VPS self-host walkthrough | Not done. CI smoke does not prove public TLS or the manual install. | `tracktime-human-tasks.md` → "Walk docs/self-hosting.md on a clean VPS" |
| Raycast license | Undecided. | `tracktime-human-tasks.md` → "Decide the Raycast extension license" |
| Release claims in README and ROADMAP | README still says self-host images go "through v0.1.2" and desktop downloads are drafts. | `1-tracktime-manual-notes.md` → "Audit license, price, surfaces and store status statements" |

Not gates, recorded for completeness: analytics (`1-tracktime-manual-notes.md` → "Turn on Plausible"), the `www` record and the old-host redirect (same file, "Moved from human tasks"), and the MCP npm publication (`tracktime-human-tasks.md` → "Publish the MCP server").

## Still valid from the 30 September audit

- Native simulator QA at app source `c435dae6`, plus the iPad XCUITest scenarios of 1 October (`pnpm test:ios:ui`). These are isolated debug builds, not the signed store artifacts. Physical secure storage, radio changes, native sharing and signed-build behaviour remain untested.
- Linux package QA rules: release CI runs `pnpm test:desktop:packages` on native x64 and ARM64 before the draft job. Package startup tests do not prove login, offline replay, updates, tray behaviour, FUSE mounting or a real Wayland desktop.
- Automated desktop tests must keep the headless mock keychain enabled.

## Method

Read-only checks only: `gh release list`, `gh run view` logs, `gh variable list`, `gh secret list` (names), `curl` of public pages and APIs, `dig`, and App Store Connect GET requests with an ES256 API key. No store record, release, secret, environment variable or deployment was changed, and no credential values were printed.
