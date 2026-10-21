# Roadmap

This is direction, not commitment.

Track Your Time is built and maintained by one person in their spare time — see
[GOVERNANCE.md](GOVERNANCE.md). There are no dates here on purpose: a date
would be a promise about someone's evenings, and it would be wrong. Nothing
below is scheduled, staffed, or guaranteed. Order within a section carries no
meaning either.

What this document is for: telling you which of the gaps in the README's
[Not there yet](README.md#not-there-yet) section are *wanted*, which are
*undecided*, and which are *deliberately out of scope* — so you can judge
whether an evening spent on one would end in a merged pull request or a
polite decline.

Every item says what already exists in the code and what would have to be
built. Both were checked against the source, not remembered.

---

## Delivered

- **Tagged self-host images:** v0.3.0 server and client images passed unauthenticated pulls and smoke checks on amd64 and arm64. The `0.3` and `latest` tags were promoted.
- **Chrome listing:** version 0.3.0 is available in the Chrome Web Store.
- **Desktop release:** version 0.2.2 is published on GitHub Releases, with a signed and notarized dmg and zip for macOS, a signed Windows installer, and AppImage, deb, rpm and tar.gz files for Linux x64 and ARM64. The dmg, the Windows installer and the AppImage update themselves from published releases.
- **Firefox build:** a separate MV3 target, device-flow sign-in, a sign-in relay for trackyourtime.dev and server-origin support exist. Version 0.3.0 is in review at Firefox Add-ons.
- **Rates per person:** an owner or admin who may see money can give each member an hourly rate. A new billable entry snapshots its project's rate first, then its author's member rate, then the workspace default (`resolveHourlyRate` in `packages/shared/src/rates.ts`).
- **Timesheet approval:** optional per workspace. A member submits a week, and an owner or admin with time visibility approves, rejects or reopens it. Submitted and approved weeks are locked, and an offline edit queued into one is held for a deliberate retry rather than dropped. An invoice can be limited to approved time. Activation needs MongoDB transactions; [`docs/timesheet-approvals.md`](docs/timesheet-approvals.md) has the rules and the setup.
- **Searching entries from the command palette:** typing in Cmd/Ctrl+K searches entry descriptions in the current workspace. Choosing an entry opens it for editing, or read-only when it belongs to a colleague.
- **Profile pictures:** upload, replace and remove pictures from Account or Profile. MongoDB stores the bytes; no separate bucket is required.
- **Teams and offline clients:** invitations, membership roles, personal and team workspaces, workspace switching and account-scoped offline queues are implemented, including Raycast.
- **Public integrations:** REST `/api/v1`, scoped API tokens, signed webhooks and the MCP server replace the earlier session-token-only direction. API tokens let integrations use explicit scopes without borrowing an interactive session.

See [release readiness](docs/release-readiness.md) for the checked distribution state.

## Next

Things the code is already shaped for, where the gap is a defined piece of
work rather than a design question.

### Store listings

**Exists.** Chrome version 0.3.0 is live. Firefox 0.3.0 is in review at Firefox Add-ons. The v0.3.0 workflow signed the mobile builds and uploaded them to Google Play's internal track and TestFlight. Apple answered the iOS and Mac App Store submissions with a request for more information (Guideline 2.1), not a reported defect. Chrome, Firefox and both phone apps can be submitted from CI once their store credentials are set.

**Missing.** Public App Store, Mac App Store and Google Play listings, Firefox approval, a Raycast Store listing and a Microsoft Store build. The Microsoft Store job skips until a Partner Center identity is configured. Raycast's licensing decision remains recorded in the launch notes.

**Next steps.** Answer Apple's request, finish device QA and listing information, then promote or submit through the store accounts. A successful test-channel upload does not mean a public listing is approved.

### Desktop distribution beyond GitHub Releases

**Exists.** Version 0.2.2 is published on GitHub Releases for macOS, Windows and Linux, signed on macOS and Windows. The Electron app serves the export from `app://-`, signs in with a bearer token kept by `safeStorage` or through the browser, and has the menu bar or tray timer, rebindable global shortcuts, open at login, notifications for prompts while hidden, the offline queue and optional activity suggestions. `desktop-release.yml` builds the Developer ID dmg and zip, the Mac App Store pkg, the NSIS installer, the AppX and the Linux packages, signs each channel only with its complete secret set, and on a `v*` tag uploads the signed downloads and their update feeds to a draft release. Publishing the draft is the release decision. The dmg, the Windows installer and the AppImage update themselves from published releases and never restart on their own. [`docs-site/docs/desktop.md`](docs-site/docs/desktop.md) describes it, and [`docs/desktop-app-plan.md`](docs/desktop-app-plan.md) records each stage.

**Missing.** Version 0.3.0 is built and still a draft. The `/download` page does not link the published release yet, the Homebrew tap has no cask, and Flathub, the Snap Store, the Mac App Store and the Microsoft Store do not list the app. No update from one published release to the next has been observed yet.

**Next steps.** Publish 0.3.0 after installed-app QA and watch a 0.2.2 install update to it. Set the download links, and run the Desktop Manifests workflow to fill the Homebrew cask. Supply the Microsoft Store identity if that channel will launch.

### Two-factor codes in the password forms of the native clients

**Exists.** better-auth's `twoFactor` plugin with TOTP and backup codes, and a
second step on `/login` in the web app. Every other client can sign a
two-factor account in through a browser: "Sign in with your browser" in the
phone and desktop apps, "Sign in with the web app" in the extension popup (or
the account the popup offers from trackyourtime.dev, once confirmed), and
Raycast's device-flow sign-in.

**Missing.** The second step is a signed cookie, and a WKWebView, the desktop
app or an extension `fetch` can neither read `set-cookie` nor send `Cookie`.
So the password form in the phone and desktop apps points a two-factor account
to the browser sign-in, and `signInWithPassword` in `@starter/core` throws
`TWO_FACTOR_UNSUPPORTED`. Nobody can type a two-factor code into those forms.

**Would have to be built.** A header that carries the challenge — an after-hook
that copies it out of the cookie and a before-hook that turns it back into
one — plus the second-step UI in each client. The test in
`tests/two-factor-integration.test.ts` already forwards the cookie by hand, so
the flow itself is proven.

### Closing sign-up

**Exists.** Nothing in the app. `emailAndPassword` is always enabled in
`packages/server/src/auth/auth.ts`, and the self-hosting guide shows how to
block `/api/auth/sign-up/*` in `Caddyfile` once the first account exists. The
admin CLI (`node dist/cli/admin.js create-user`) can create accounts while
sign-up is blocked.

**Missing.** A server setting, and a sign-up page that says registration is
closed rather than failing.

**Would have to be built.** An env switch read in `auth.ts`, a flag in
`/api/health` or `health.check` so the clients can hide the sign-up link, and
an answer for invitations to an address with no account.

---

## Later

Wanted or plausibly wanted, but larger, or dependent on the items above, or
genuinely undecided. Items marked **undecided** are ones where the honest
answer is that nobody has ruled either way — do not read them as planned.

### Sharing reports with clients **(undecided)**

**Exists.** Reports export to CSV and PDF, and invoices to PDF, ZUGFeRD and
XRechnung. Saved report views keep up to 50 named filter sets, stored in the
browser for one person and workspace, so nobody else can open them.

**Missing / undecided.** No client login and no shared link. A read-only link
is the smaller answer; a client portal is the larger one. Both need a decision
about which money a client may see.

### A CLI

**Exists.** `trackyourtime-cli` is already an allowlisted device-flow client id
in `packages/server/src/auth/client-label.ts`, and `packages/core` is the
framework-free runtime (API client, device-flow sign-in, offline queue, timer
store) that a CLI would be built on — the same package Raycast uses. The server
image ships an admin CLI for self-hosters, which is a different thing.

**Missing.** An end-user CLI.

**Would have to be built.** A new package with argument parsing and terminal
output, storing its session token in the OS keychain rather than a config
file. The interesting part is small, because auth and the API client are done;
the tedious part is deciding the command surface. Worth an issue first, purely
to agree on the verbs.

### Email digests **(undecided)**

**Exists.** A scheduler (`services/scheduler/`) that runs recurring jobs once
per interval across replicas, and two jobs on it: `runaway-reminder`, which
enforces the maximum entry duration and sends one reminder email per timer,
and `invoice-reminders`, which sends the opt-in payment reminders for overdue
invoices to clients. There is no web push.

**Missing / undecided.** Whether a weekly summary or a "you tracked nothing
yesterday" email is wanted. The scheduler makes it cheap to build; the question
is whether it is welcome in an inbox.

### Time off, PTO, holidays **(undecided)**

**Exists.** Nothing. No model, no screen, no shared type, and no concept of a
non-working day — so nothing can compute capacity or utilization.

**Missing / undecided.** Mostly a team-scale feature. Workspaces can have
members now, so it is no longer blocked, but nobody has decided it belongs in a
time tracker for freelancers and small teams. Raised here so nobody starts it
assuming it is wanted.

---

## Not planned

Not "never" — this is a small project and the maintainer can be persuaded — but
the current answer is no, and a pull request implementing one of these without
a prior conversation is likely to be declined on scope. That is worth knowing
before you spend the evening.

### A paid plan or subscription billing

Track Your Time is free, with every feature in every install, the hosted
version included. There is no plan to add a paid tier or sell hosted seats or
commercial licence exceptions; see [GOVERNANCE.md](GOVERNANCE.md) for the
licensing stance.

There is no Stripe service in the server. What exists is a single
`billing.status` query that reports which `STRIPE_*` env vars are missing —
inherited from the starter this repo was generated from, not the beginning of
a paid tier. Note the vocabulary trap: "Billing" in the settings screen means
*your business profile and your clients' billable rates*, not a subscription.

### Telemetry or usage analytics

The README's claim that there is no telemetry you have not configured yourself
is a property worth keeping. Error reporting (Sentry/GlitchTip) and the
newsletter integration are opt-in and off by default. The hosted website uses
self-hosted Plausible for aggregate visits; self-hosted installs leave it off
unless the operator configures it. Per-person analytics, account-linked events,
signup source tags and A/B tests are out of scope.

### Screenshot or keystroke monitoring

Activity capture in the browser extension and the desktop app records which
site or application had your attention, on your own device. The activity
itself never leaves it; the server sees only the entries made from it. Recording what a person types or sees, or sending activity to
a colleague, is out of scope.

---

## Picking something up

Anything on this page is open to a contributor, including the *Not planned*
section if you can make the case.

**Open an issue before you start**, so two people do not build the same thing
and so scope is agreed while it is still cheap to change — a
[feature request](.github/ISSUE_TEMPLATE/feature_request.yml) is the right
form. GitHub Discussions are not enabled on this repository; issues are the
place, and open-ended questions have a
[question form](.github/ISSUE_TEMPLATE/question.yml) of their own. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to get set up and
[ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit together.
