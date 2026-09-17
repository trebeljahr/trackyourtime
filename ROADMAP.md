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

## Next

Things the code is already shaped for, where the gap is a defined piece of
work rather than a design question.

### The first tagged release

**Exists.** `.github/workflows/release.yml` builds and publishes the server and
self-host client images for linux/amd64 and linux/arm64 on a `v*` tag, with
provenance and an SBOM. `docker-compose.selfhost.yml` already pulls
`TRACKYOURTIME_VERSION`, [`docs/releasing.md`](docs/releasing.md) is the
checklist, and [`docs/release-notes/v0.1.0.md`](docs/release-notes/v0.1.0.md)
is drafted.

**Missing.** The tag. No `v*` tag exists, so no image has been published and a
self-hosted first start still builds from source with about 4 GB of memory.

**Would have to be built.** Nothing in code — the release steps, run once.

### Store listings

**Exists.** The Chrome extension, the Raycast extension and the iOS and Android
Capacitor projects all work from source. The production extension build pins
the store id (`STORE_EXTENSION_KEY`), `TRUST_STORE_APPS=true` trusts the store
clients on a self-hosted server, `.github/workflows/mobile-release.yml` builds
and verifies a signed Android bundle, and `docs/store-assets/` holds listing
material for the Chrome Web Store and Google Play.

**Missing.** None of the four is in its store. The desktop app's store
channels are under "Shipping the desktop app" above.

**Would have to be built.** Store listings, review, signing for iOS, and a
release process per store. Blocked more by paperwork than by code.

### Shipping the desktop app

**Exists.** The Electron app works from source on macOS: `app://-`, bearer
sign-in through `safeStorage` and browser sign-in, the menu bar or tray timer,
rebindable global shortcuts, open at login, notifications for prompts while
hidden, and the offline queue. `desktop-release.yml` builds the Developer ID
dmg and zip, the Mac App Store pkg, the NSIS installer, the AppX and the Linux
packages, signs each channel only with its complete secret set, and on a `v*`
tag uploads the signed downloads and their update feeds to a draft release.
The dmg, the Windows installer and the AppImage update themselves from
published releases and never restart on their own. `/download` and
[`docs-site/docs/desktop.md`](docs-site/docs/desktop.md) describe it.
[`docs/desktop-app-plan.md`](docs/desktop-app-plan.md) records each stage.

**Missing.** A published release. There are no signing certificates yet, and
the Windows route (Azure Trusted Signing or a certificate) is undecided. The
workflow has never run, so nothing has been built or launched on Windows or
Linux. No store lists the app. An update from one published release to the next
has not been observed, because it needs two signed releases.

**Would have to be built.** Nothing large in code: the certificates, one
dispatch per channel to fix what the first run finds, and the store
submissions. Desktop activity capture (plan Stage 8) is a separate, later
piece of work.

### Two-factor sign-in in the phone apps and the extension's password form

**Exists.** better-auth's `twoFactor` plugin with TOTP and backup codes, and a
second step on `/login` in the web app. The extension signs a two-factor
account in through the device flow: "Sign in with the web app" in the popup,
or automatically when the person is signed in on trackyourtime.dev.

**Missing.** The second step is a signed cookie, and a WKWebView or extension
`fetch` can neither read `set-cookie` nor send `Cookie`. So `/login` in the
native shells shows `NATIVE_TWO_FACTOR_UNSUPPORTED`, and `signInWithPassword`
in `@starter/core` throws `TWO_FACTOR_UNSUPPORTED`. An account with two-factor
on cannot sign in on the phone, or through the extension's password form.

**Would have to be built.** A header that carries the challenge — an after-hook
that copies it out of the cookie and a before-hook that turns it back into
one — plus the second-step UI in both clients. Or, for the phone, the device
flow the extension already uses. The test in
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

### Avatar upload

**Exists.** `avatarUrl` is a field on the `Profile` model, on the shared
`User` type, in the profile zod schema, and the `profile` tRPC router already
reads and writes it as a string.

**Missing.** Any file storage. The server has no object-storage client and no
S3 configuration — an unused storage module was removed. So `avatarUrl` is a
URL you can only set by handing the API one you hosted yourself.

**Would have to be built.** A storage module and its optional configuration, a
tRPC procedure that returns a presigned upload URL scoped to the caller, the
client-side upload, and a picker in the profile screen. Self-hosted instances
run without a bucket, so the feature has to degrade cleanly when storage is not
configured.

---

## Later

Wanted or plausibly wanted, but larger, or dependent on the items above, or
genuinely undecided. Items marked **undecided** are ones where the honest
answer is that nobody has ruled either way — do not read them as planned.

### Rates per person **(undecided)**

**Exists.** An entry snapshots its rate from the project, else the workspace
default (`snapshotRate` in `services/entry-stop.ts`). `WorkspaceMember` has an
`hourlyRate` field, but no rate resolution reads it.

**Missing / undecided.** Whether a member's own rate should win over the
project's, lose to it, or apply per project. Each answer changes what an
invoice line means, so this needs a decision before code.

### Timesheet approval **(undecided)**

**Exists.** Workspaces with owners, admins and members, and two visibility
flags per member. The timesheet is an editing grid. Invoice status (draft /
sent / paid) is invoice lifecycle, not time approval.

**Missing / undecided.** No submitted/approved state, no approver role, no
lock-after-approval. Now that a workspace can have members, approval is a
reasonable thing to want — but it touches editing rules on every screen, the
offline queue and invoices, so the shape needs agreeing first.

### Sharing reports with clients **(undecided)**

**Exists.** Reports export to CSV and PDF, and invoices to PDF, ZUGFeRD and
XRechnung.

**Missing / undecided.** No client login and no shared link. A read-only link
is the smaller answer; a client portal is the larger one. Both need a decision
about which money a client may see.

### A Firefox extension

**Exists.** The Chrome MV3 extension, whose logic lives mostly in
`packages/core` and the extension's background worker.

**Missing.** A Firefox build and its manifest differences (background scripts,
`browser_specific_settings`, permission prompts).

**Would have to be built.** A second build target in
`packages/extension/manifest.config.ts`, a check of every `chrome.*` call the
worker makes, and an origin entry for the server trust list.

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

### Searching entries from the command palette

**Exists.** The Cmd/Ctrl+K palette (`components/command-palette/`) covers timer
actions, every page, and clients, projects, tasks and tags. The Entries view in
Reports, `entries.descriptions` and `GET /api/v1/entries` all search entry
descriptions.

**Missing.** The palette does not search entries.

**Would have to be built.** An entry group in `palette-model.ts` over the
existing description search, and a decision about what selecting an entry
does.

### Email digests **(undecided)**

**Exists.** A scheduler (`services/scheduler/`) that runs recurring jobs once
per interval across replicas, and one job on it: `runaway-reminder`, which
enforces the maximum entry duration and sends one reminder email per timer.
There is no web push.

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
newsletter integration are opt-in and off by default, and that is the ceiling.
Product analytics, event tracking and phone-home version checks are out of
scope.

### Screenshot or keystroke monitoring

Activity capture in the Chrome extension records which site had your
attention, on your own device, and nothing leaves it until you accept a
suggested entry. Recording what a person types or sees, or sending activity to
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
