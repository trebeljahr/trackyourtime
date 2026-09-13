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

### The `/invite/<id>` page

**Exists.** better-auth's `organization` plugin is mounted in
`packages/server/src/auth/auth.ts`, and its `sendInvitationEmail` hook is
implemented: it composes a real email linking to
`${FRONTEND_URL}/invite/${invitation.id}` (auth.ts:146). The invitation itself
is created, stored and emailable today.

**Missing.** That route does not exist under `packages/client/src/app/` — there
is no `invite/` directory. An invitation sent today lands on a 404, so the one
part of the team flow that is wired end to end on the server has no landing
place on the client.

**Would have to be built.** One public (unauthenticated-tolerant) route that
reads the invitation id, shows who invited you to what, and calls better-auth's
accept/reject endpoints — plus the signed-out case, where accepting has to run
after sign-up. Small and self-contained. Note that accepting it lands you in a
workspace that the rest of the app cannot yet show you (see *Teams* under
Later), so this is worth doing as the first brick, not as a finished feature.

### Avatar upload

**Exists.** `packages/server/src/services/storage.ts` exports
`getPresignedUploadUrl`, `getPublicUrl` and `deleteObject`. `avatarUrl` is a
field on the `Profile` model, on the shared `User` type, in the profile zod
schema, and the `profile` tRPC router already reads and writes it as a string.

**Missing.** Nothing in the server imports `services/storage.ts` — a grep for
it across `packages/server/src` returns no consumers. So the S3 module is
complete and unreachable, and `avatarUrl` is a URL you can only set by handing
the API one you hosted yourself.

**Would have to be built.** A tRPC procedure that returns a presigned upload
URL scoped to the caller, the client-side upload, and a picker in the profile
screen. The S3 env block (`S3_*` / `AWS_*`) is already optional and already
documented in the README's self-hosting section, so the feature has to degrade
cleanly when it is unset.

### Per-recipient sync payloads

**Exists.** `packages/server/src/ws/sync.ts` resolves a workspace to its
members and calls `publishToUser` for each, so the fan-out is per person
already. `packages/server/src/models/WorkspaceMember.ts` carries the role
enum (`owner` / `admin` / `member`) and a `visibilityOf` helper, and the
reports path already restricts by `authorId` when a member may not see others'
time.

**Missing.** The file says so itself in a comment: every member currently
receives the identical payload, which is only correct while a workspace has
one member. A second member would receive hourly rates over the socket that
the reports correctly hide from them.

**Would have to be built.** A projection applied per recipient inside the
fan-out loop, stripping the money fields a given member's visibility does not
permit, plus unit tests. This is a correctness prerequisite for anything
multi-person — worth landing before the UI that would expose the bug, not
after.

---

## Later

Wanted or plausibly wanted, but larger, or dependent on the items above, or
genuinely undecided. Items marked **undecided** are ones where the honest
answer is that nobody has ruled either way — do not read them as planned.

### Teams: member list, roles, workspace switcher

**Exists.** More substrate than you would expect. Every user gets a personal
workspace; `WorkspaceMember` models roles and a money-visibility flag; a
single middleware (`workspaceProcedure`) scopes every domain query, so the
data layer is already multi-tenant rather than single-user with a filter
bolted on. better-auth's organization endpoints — create, invite, list
members, set role — are callable under `/api/auth/*` today.

**Missing.** Everything above the substrate. There is no workspace or members
tRPC router (`packages/server/src/trpc/routers/` has eighteen files and none
of them is one), no member list, no role editing UI, and no workspace
switcher. Treat the app as single-user until these exist.

**Would have to be built.** A workspace/members router over the plugin's
endpoints, a members screen, a role editor that respects the owner/admin/member
enum, a switcher in the app shell that sets the session's active organization,
and a decision about what a member who cannot see others' time is shown on
every screen that currently assumes one person. Large. Discuss it in an issue
before writing any of it.

### A CLI

**Exists.** `tracktime-cli` is already an allowlisted device-flow client id in
`packages/server/src/auth/client-label.ts`, and `packages/core` is the
framework-free runtime (API client, device-flow sign-in, offline queue, timer
store) that a CLI would be built on — the same package Raycast uses.

**Missing.** The CLI itself. The README states plainly that it does not exist.

**Would have to be built.** A new package with argument parsing and terminal
output, storing its session token in the OS keychain rather than a config
file. The interesting part is small, because auth and the API client are done;
the tedious part is deciding the command surface. Worth an issue first, purely
to agree on the verbs.

### An offline queue for Raycast

**Exists.** The offline queue lives in `packages/core` and is used by the web
app and the browser extension.

**Missing.** Raycast does not use it. A mutation made without connectivity
there is lost, which is the one place the three clients meaningfully disagree
about behaviour.

**Would have to be built.** Wiring the existing queue to Raycast's
`LocalStorage`, plus a replay trigger — Raycast commands are short-lived
processes, so "on reconnect" has to become "on next command run", which is a
real design question rather than a port.

### Search and a command palette

**Exists.** The shadcn `command` primitive (`components/ui/command.tsx`, built
on `cmdk`) is in the tree, used by the combobox and the reports multi-select.

**Missing.** No global search of any kind, and no palette: `CommandDialog` has
no call site outside the primitive's own file. Nothing indexes entries,
descriptions or catalog rows.

**Would have to be built.** A search procedure (Mongo text index or a
regex-scoped-to-workspace query, and the choice matters at scale), plus a
palette bound to a shortcut in the app shell. The UI half is cheap because the
primitive is there; the server half is the actual work.

### Shipping the desktop and mobile shells

**Exists.** Electron is real but thin — window lifecycle, a persisted
fullscreen preference, external-link handling and `powerMonitor`-backed idle
over IPC. Capacitor has config and a small JS bridge.

**Missing.** For desktop: no tray, no global shortcuts, no auto-update, no
signing setup, and it has never been built or distributed. For mobile: no
`ios/` or `android/` directory, the bundle id is still `com.example.tracktime`,
and nothing has run on a device.

**Would have to be built.** Mostly release engineering rather than features:
signing, notarization, an update channel, store metadata. Note that both shells
bake `NEXT_PUBLIC_API_URL` in at build time, so a distributed binary is locked
to one API host — that constraint has to be designed around before anything
ships, not after.

### Publishing the browser and Raycast extensions

**Exists.** Both work. The browser extension is version 0.1.0 and loads
unpacked; the Raycast extension has four commands — menu bar, timer, entries
and open-dashboard — with catalog CRUD reached through pushed forms.

**Missing.** Neither is in a store. The browser extension's production id has
to be pinned with `EXTENSION_KEY` and its `chrome-extension://` origin added to
the server's `TRUSTED_ORIGINS` by hand — deliberately, so that a production
trust list is never extended by a script.

**Would have to be built.** Store listings, review, and a release process.
Blocked more by paperwork than by code.

### Email digests **(undecided)**

**Exists.** Nothing scheduled. There is no web push, no digest, no scheduler
and no job runner anywhere in the repo — a grep for the usual suspects
(`web-push`, `node-cron`, `bullmq`, `agenda`) across every `package.json`
returns nothing.

**Missing / undecided.** Whether this project should grow a job runner at all
is an open question, not a backlog item. The runaway-timer guard is lazy on
purpose and says so in its own source: nothing pushes you a notification on
Saturday about Friday's forgotten timer. Adding a scheduler would be the first
crack in that design, so it needs a decision before it needs code.

### Time off, PTO, holidays **(undecided)**

**Exists.** Nothing. No model, no screen, no shared type, and no concept of a
non-working day — so nothing can compute capacity or utilization.

**Missing / undecided.** This is mostly a team-scale feature and the app is
single-user today, so it sits behind *Teams* whichever way it is decided.
Raised here so nobody starts it assuming it is wanted.

---

## Not planned

Not "never" — this is a small project and the maintainer can be persuaded — but
the current answer is no, and a pull request implementing one of these without
a prior conversation is likely to be declined on scope. That is worth knowing
before you spend the evening.

### A public REST API

What is missing, and what the server does mount instead, is listed under
[Not there yet](README.md#not-there-yet) in the README — that section owns the
gap; this one only records the verdict.

The verdict: **not planned.** This is a design position rather than an
omission. The project deliberately
mints no API tokens: every client signs in normally and carries the resulting
better-auth session token, so there is exactly one auth path to reason about
and revocation in Settings → Devices kills HTTP and WebSocket at once. A public
API would need a second credential type with its own lifecycle, scopes and rate
limiting — a large permanent surface for a single-maintainer project to keep
secure.

tRPC is reachable with a bearer session token, but it is an internal contract
typed against this repo and it will change without notice. The `api` value in
the `EntrySource` enum is reserved for third-party callers and nothing produces
it today; read that as a placeholder, not a commitment.

### Timesheet approvals

No submitted/approved state, no approver role, no lock-after-approval, no
notifications — and none planned. The timesheet is an editing grid, not a
submittable document, and approvals only mean something when someone else is
doing the approving. Invoice status (draft / sent / paid) is invoice lifecycle,
not time approval, and is not the seed of one.

### SaaS subscription billing

There is no Stripe service in the server at all. What exists is a single
`billing.status` query that reports which `STRIPE_*` env vars are missing so
the UI can show a developer notice — inherited from the starter this repo was
generated from, not the beginning of a paid tier.

There is no plan to sell hosted seats or commercial licence exceptions; see
[GOVERNANCE.md](GOVERNANCE.md) for the licensing stance. Note the vocabulary
trap: "Billing" in the settings screen means *your clients' billable rates*,
not a subscription.

### Telemetry or usage analytics

The README's claim that there is no telemetry you have not configured yourself
is a property worth keeping. Error reporting (Sentry/GlitchTip) and the
newsletter integration are opt-in and off by default, and that is the ceiling.
Product analytics, event tracking and phone-home version checks are out of
scope.

### Tauri as a second desktop app

`src-tauri/` is scaffolding inherited from the starter — a near-empty Rust
entry point with a Steamworks feature block that has nothing to do with a time
tracker (see the Clients table in [README.md](README.md#clients)). Do not treat it as a shipping target or invest in it. Electron is
the desktop wrapper.

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
