# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing is tagged yet. Everything below will be `v0.1.0`, the first tagged
release, and [`docs/releasing.md`](docs/releasing.md) renames this heading
when the tag is cut.

That release publishes the web app and API as self-host images. The Raycast
extension, the browser extension and the iOS and Android projects are in the
repository and build from source.

Not part of it: no desktop app, no mobile app and no store listing.
`desktop-release.yml`, `mobile-release.yml` and `tauri-release.yml` run on
manual dispatch only, so the `v0.1.0` tag builds none of them. Their output is
unsigned.

### Added

#### Tracking

- A timer that starts and stops with one click, and a separate dialog for
  time you forgot to track.
- Quick start from favorites and recent work, on its own line above the
  composer.
- Idle detection. When you stop working, the app asks what to do with the
  idle time. A workspace can choose ask, pause-and-resume, keep-running or
  stop, and a project can override that choice.
- A maximum entry duration for the timer left running over a weekend. The
  server asks, caps or stops the entry the next time anything reads the
  running timer.
- A server job checks running timers every 5 minutes, so a capped or stopped
  timer no longer waits for a device to open. `SCHEDULER_ENABLED=false` turns
  the job off.
- One reminder email per timer left running too long: past the maximum when
  the workspace is set to ask, or past 8 hours when there is no maximum.
- The web tracker completes a description from earlier entries. Tab takes the
  name, and Cmd/Ctrl+Enter also takes the project, task, tags and billable
  flag.
- A Cmd/Ctrl+K command palette in the web app for timer actions, every page,
  and clients, projects, tasks and tags. On a phone it opens from the More
  drawer.
- An offer to discard an entry shorter than a minute.
- A notice when the device clock is behind the running timer, instead of a
  clock frozen at 0:00.
- An entry can cross midnight. An end time earlier than the start moves to
  the next day, and the row shows "+1d".
- Every entry records the time zone it was tracked in and the client that
  created it.
- Amounts follow a workspace currency. Each entry keeps the hourly rate it
  was tracked at, so a later rate change does not reprice past work.
- The theme is a user preference and follows you to every device.

#### Timesheet and calendar

- A weekly timesheet grid you can fill in from the keyboard.
- A calendar with day, week, month and year views. Overlapping entries stay
  readable, the grid zooms, and dense runs of short entries collapse into one
  block.
- Undo for calendar drags and edits.

#### Reports

- One reports page, `/app/reports`, with a Totals view and an Entries view. Days
  are bucketed in your time zone, and an entry that crosses midnight is split
  between the two days.
- The export menu on the reports page exports the view that is open.
- Group a report by client, project, task, tag, day, week or month. An entry
  with two tags counts its full duration under each tag, and the table says
  that the rows overlap.
- "All time" and "Last 5 years" range presets. Long ranges show the timeline
  by week or month.
- CSV and PDF export for reports.
- Create and edit clients, projects, tasks and tags from the report filters.
- The report API filters by member (`memberIds`) and groups by member. A
  member filter never shows entries the caller may not see.
- A member who may see colleagues' time but not their money gets reports
  without amounts. The CSV and PDF exports drop the money columns.

#### Invoices

- Invoices built from tracked entries, with draft, sent and paid status.
- PDF export of an invoice, rendered on the server.
- A business profile per workspace in Settings → Billing: legal name,
  address, tax id, contact details, payment details, payment terms and an
  invoice footer.
- Billing details per client, in the client dialog: legal name, address, tax
  id, email and a reference.
- The invoice PDF prints both parties, the payment details with their line
  breaks, the payment terms and the footer.
- An invoice keeps a copy of both parties from the day it was created. A
  later edit to the profile or the client does not change it.
- The new invoice dialog warns when either address is missing, and suggests
  a due date from the payment terms.
- An invoice also downloads as a ZUGFeRD PDF (PDF/A-3b with the EN 16931 XML
  embedded) or as an XRechnung 3.0 XML file.
- The business profile and client billing details take the e-invoice fields:
  VAT ID, tax number, electronic address, bank details, a default VAT category
  and small-business status.
- Each invoice line has a VAT category. A 0 % rate is never guessed as exempt,
  reverse charge or zero rated.
- Before an e-invoice download, the invoice lists what is missing and links to
  the field that fixes it. Missing party details on an older invoice can be
  filled from today's profile and client, after you confirm the list.
- The first e-invoice XML of an invoice that is no longer a draft is stored
  and served unchanged from then on.
- CI checks every sample file with the Mustang and KoSIT validators.
  `docs-site/docs/e-invoices.md` covers the setup.

#### Teams

- Invite people to a workspace by email from `/app/members`. Without a mail
  server, copy the invitation link instead. The `/invite` page accepts it
  before or after sign-in.
- Roles: owner, admin and member. Owners and admins invite, remove members
  and cancel invitations, and an admin manages only members. Only an owner
  changes roles. Ownership moves by transfer, and a workspace always keeps an
  owner.
- Two switches per member: whether they see colleagues' time, and whether they
  see colleagues' money. A new member sees only their own.
- Leave a workspace, and switch between workspaces from the app shell. The
  browser extension and Raycast keep their own workspace choice.
- The tracker, calendar and runaway prompt show only your own entries.
  Colleagues' time appears in Reports.
- Starting a timer in one workspace stops a timer running in another. One
  person has one running timer.

#### Clients, projects, tasks and tags

- Clients and projects form one two-level hierarchy. Tasks are workspace-wide
  and do not belong to a project. An entry can carry a project, a task, both
  or neither.
- Many tags per entry.
- Create clients, projects, tasks and tags from the tracker and from an
  entry row. Pick any colour, rename in place, and open a list of the entries
  that use a row.
- A lifetime hours estimate and a lifetime money budget per project. The
  projects screen and the summary report show progress against both.
- Edit a project's billable default and rate in the projects table. A
  project with no rate of its own shows the workspace default rate there.
- A billing change can also update the entries already on the project.
  Invoiced entries and other members' entries stay as they are.
- Deleting a client, project, task or tag detaches the entries and projects
  that refer to it. No tracked time is deleted. Clients, projects and tasks
  can be archived instead.

#### Import and export

- Import a tracked history from a delimited text file (comma, semicolon, tab
  or pipe). Columns are recognised by their headers and values, not by the
  product that wrote the file.
- The import preview states the day/month order it detected, and asks when
  the file does not settle it.
- Files with a date and a number of hours, but no clock time, import too.
  The preview says that the times of day are placed by the importer.
- Undo an import as one batch.
- Export a workspace as JSON, which imports into a different or empty
  workspace, or as CSV in the column shape the importer reads back.
- Money is removed from an export for a member who may not see it, and the
  file says so.
- The JSON export carries the business profile and client billing details,
  and an import writes them back.
- An import from a JSON export can also restore workspace settings and
  pinned quick starts.
- An export leaves out invoices for a member who may not use invoices.
- Settings → Data → Move to another server copies a workspace to another
  server, for example from the hosted app to your own. It copies directly
  when the target trusts the app, and through downloaded files otherwise.
- A move changes nothing on the old server, and shows the counts that
  arrived on the new one.

#### Public API and webhooks

- A REST API at `/api/v1` for entries, clients, projects, tasks, tags,
  reports and the current user. Entries can also be started and stopped.
- An OpenAPI document at `/api/v1/openapi.json`, and an API reference on the
  docs site.
- Scoped API tokens, managed in Settings: `entries:read`, `entries:write`,
  `catalog:read`, `catalog:write` and `reports:read`. A token is shown once.
- A per-token rate limit, 600 requests a minute by default
  (`API_RATE_LIMIT_PER_MINUTE`).
- Errors in the RFC 9457 problem format, and cursor pagination on lists.
- Signed webhooks for `entry.started`, `entry.stopped`, `entry.created`,
  `entry.updated`, `entry.deleted`, `invoice.created` and
  `invoice.status_changed`, with a delivery log in Settings.
- REST clients carry `billing`, which can be set on create and update.
- Invoice webhook payloads carry `issuer` and `recipient`, as copied when
  the invoice was created.

#### MCP server

- `packages/mcp` connects an MCP client, such as Claude Desktop or Claude
  Code, to the REST API with a personal API token. It works with the hosted
  API and with a self-hosted server.
- Its tools read the running timer, start and stop it, log past time, list
  and search entries, list and create clients, projects, tasks and tags, and
  run the summary report.
- It offers only the tools the token's scopes allow. A read-only token gets
  no tool that writes.
- It runs over stdio from a clone of the repository, built with
  `pnpm build:mcp`. It is not published to npm, and it has no invoice tools.
- `docs-site/docs/mcp.md` covers the token, the build and the client
  configuration.

#### Sync and offline use

- A start or stop on one device shows on every other signed-in device
  without a reload.
- An offline queue in the web app, the browser extension and Raycast. Work
  done without a network replays in order when the connection returns.
- Queued work records the account that queued it. The next account to sign
  in on a device does not replay it. Settings → Devices lists that work by
  name and lets you discard it.
- Queued work also records the server it was queued for, and replays only
  there. Settings → Devices lists it per server.

#### Accounts and devices

- Sign in with email and password, and reset a password by email over SMTP.
- Two-factor authentication with an authenticator app and ten single-use
  backup codes, in Settings → Account. The phone apps and the extension's own
  sign-in form cannot complete the second step yet.
- Change your password or your email address in Settings → Account.
- New accounts verify their email address when the server can send mail.
- Google sign-in on the web app, when the server has Google credentials. It
  is disabled in the native shells.
- The browser extension signs in with its own form. Raycast signs in with a
  code you approve in a signed-in browser.
- Settings → Devices lists every signed-in session and signs any of them out.
  A signed-out device also loses its live connection within a minute.
- Browser sessions last 7 days. Sessions held by the extension, Raycast and
  the native shells last 30 days.
- Delete your account from Settings → Account. A workspace you are alone in
  is deleted with everything in it. In a shared workspace, your uninvoiced
  entries, favorites, tokens and webhooks go, and the workspace keeps an
  owner.
- Deleting an account deletes the business profile of a workspace you are
  alone in. A shared workspace keeps its profile.

#### Languages

- A language setting in Settings → General: System, English or Deutsch. It
  is stored with your account. "System" follows the language of each device.
- German covers the web app, the phone apps and the browser extension.
- Each public page also has a German version under `/de/`, with a language
  switch.
- An invoice is written in the language chosen for it, else the client's,
  else the issuer's, and keeps that language for good. Report PDFs follow the device's
  language, and email follows the recipient's.
- With German selected, dates, numbers, money and durations use German
  formatting, for example "1,50 h".
- Raycast stays in English.
- `CONTRIBUTING.md` explains how to add a language.

#### Raycast extension

Load it from source with `ray develop`. It is not in the Raycast Store.

- Five commands: Timer Menu Bar, Start / Stop Timer, Timer, Show All Time and
  Open Dashboard.
- The menu bar clock counts every second while a timer runs.
- Start / Stop Timer has no window, so a global hotkey can run it.
- Log past time, complete a description from earlier entries, and create
  clients, projects, tasks and tags from the forms.
- Works offline, as listed under "Sync and offline use".
- A change to the server preference does not send the old session to the
  new server, and does not replay work queued for the old one.

#### Browser extension

Load it unpacked in Chrome. It is not in the Chrome Web Store.

- A toolbar popup with the timer, a badge, idle detection, favorites, tags
  and the offline queue.
- Edit the running entry and past entries from the popup.
- Complete a description from earlier entries, and create clients, projects,
  tasks and tags from any entry form.
- Choose any server at sign-in. The extension asks Chrome for access to that
  one host only. Switching servers signs out of the old one.
- Entry suggestions from browser activity. It is off by default, and turning
  it on asks Chrome for the `tabs` permission.
- While it is on, the extension stores the active site's hostname on this
  device. Page titles have their own switch.
- Incognito tabs, excluded hosts and pages that are not `http(s)` are never
  recorded. Activity is kept for 14 days by default, 1 to 90.
- The Suggestions screen offers untracked stretches of a day to accept,
  edit, dismiss, or file under a project by a rule for that site.
- Nothing is sent to a server until you accept a suggestion. Signing out, or
  another account signing in, deletes activity, rules and dismissals.

#### iOS and Android projects

- The iOS and Android Capacitor projects are committed and build with
  `pnpm build:mobile`. No app is published.
- The session token is kept in the device's secure storage. The offline
  queue and the running timer are kept where the OS does not clear them, so
  a timer survives a cold start with no network.
- Safe areas, a bottom tab bar and handling for the Android back button.
- Choose the server on the login and sign-up screens. The build's API URL is
  the default. Switching signs out of the old server and keeps queued work.
- An Android release bundle is signed when the keystore and its passwords
  are in the environment.

#### Self-hosting

- `docker-compose.selfhost.yml` runs Caddy, the API, the web app, MongoDB and
  Redis behind one domain, with healthchecks and named volumes.
- Images for linux/amd64 and linux/arm64:
  `ghcr.io/trebeljahr/trackyourtime-server` and
  `ghcr.io/trebeljahr/trackyourtime-client-selfhost`. `v0.1.0` is the exact tag.
  `0.1` and `latest` move to it after the release workflow has pulled and
  started both images anonymously on both architectures.
- The default compose file pulls those images and stops with the registry's
  error when one is missing. It does not build.
- To build from a clone instead, add `docker-compose.selfhost.build.yml`.
  A build needs 4 GB of memory.
- Each release image carries a provenance attestation and an SBOM.
- `/api/health` reports the commit the server image was built from.
- `/api/health` answers any origin. It names the service and release, and
  says whether the calling origin is trusted.
- `TRUST_STORE_APPS=true` trusts the iOS and Android apps and the Chrome Web
  Store extension id, with no edit to `TRUSTED_ORIGINS`. The self-host
  compose file sets it by default.
- An admin CLI in the server image, `node dist/cli/admin.js`: `create-user`,
  `reset-password`, `list-workspaces`, `doctor` and `migrate`.
- `reset-password` signs the account out on every device. Without
  `--password`, both account commands prompt and do not echo the password.
- `doctor` checks the database, Redis, mail, trusted origins, the auth URL,
  clock skew, the schema version and the indexes, and exits 1 when a check
  fails.
- The server applies database migrations at startup, before it accepts
  connections. It records each one in `schema_migrations`, and a lock keeps two
  server processes from running the same migration.
- A server refuses to start against a database that a newer release migrated
  in a way it cannot read. The log names that release.
- The server builds every index at startup and logs each failure. It refuses
  to start when a unique index that guards data integrity cannot be built.
- `migrate --status` and `migrate --dry-run` show the schema state and the
  pending migrations without changing anything.
- `docs/self-hosting.md` covers the admin CLI and moving between the hosted
  app and a self-hosted server.
- `docs/self-hosting.md` covers install, email, backup and restore, upgrades
  and troubleshooting.
- The install starts from a fresh Ubuntu server. Each step gives the exact
  command, the output to expect and the usual failures with their fix.
- The guide opens with a prompt to paste into an AI assistant that has shell
  access to the server, and lists the access the assistant needs.
- `scripts/selfhost-check.sh <domain>` checks an install and prints one PASS,
  FAIL or SKIP line per check: DNS, the containers, the certificate, port 80,
  `/api` routing, the WebSocket on `/ws` and, with `--token`, an API token.

#### Site and project

- A landing page, a page for each client (`/extension`, `/raycast`,
  `/mobile`), privacy and support pages, and a 404 page.
- `https://trackyourtime.dev/llms.txt` and `llms-full.txt` describe the
  product, its current limits and its docs for AI assistants.
  `pnpm llms:emit` writes them, and a test fails when they are out of date.
- `robots.txt` with a group for AI crawlers, and a sitemap.
- The docs site build writes a Markdown copy of every page and its own
  `llms.txt`.
- A docs page, "Choosing a self-hosted time tracker", on the trade-offs
  between kinds of time tracker.
- `LICENSE` — GNU Affero General Public License v3.0 or later, the project's
  license (SPDX: `AGPL-3.0-or-later`).
- `README.md` — project overview, setup, and self-hosting documentation.
- `CONTRIBUTING.md` — contribution workflow, including the Developer
  Certificate of Origin 1.1 sign-off requirement (`git commit -s`).
- `SECURITY.md` — security policy: supported versions, the private disclosure
  route, and scope.
- `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1.
- `TRADEMARK.md` — trademark policy covering the project name, logo, and
  domains, which the AGPL does not license.
- `ARCHITECTURE.md` — how the packages fit together, what a request does end
  to end, and how multi-device sync works.
- `ROADMAP.md` — what is wanted next, what is undecided, and what is
  deliberately out of scope.
- `GOVERNANCE.md` — who decides, how disagreements end, and what gets a pull
  request merged.
- `SUPPORT.md` — where to ask a question and what to expect for an answer.
- Issue templates (bug report, feature request, question) with a routing
  `config.yml`, and a pull request template, under `.github/`.
- `.github/CODEOWNERS` and `.github/dependabot.yml`.
- `.editorconfig` and `.gitattributes`.
- `.devcontainer/devcontainer.json` — a container definition for a
  ready-to-run development environment.

### Changed

The first three items matter to people who used the hosted app before the first
tag.

- The product is now called Track Your Time. The home-screen label is
  "Track Time". The repository, images, bundle id, headers, client ids,
  storage keys and database names changed from `tracktime` to
  `trackyourtime` too.
- The hosted app is at `https://trackyourtime.dev`, and its API at
  `https://api.trackyourtime.dev`.
- Tasks no longer belong to a project. Changing an entry's project keeps its
  task.
- The app's screens moved under `/app/` (`/app/track`, `/app/settings`, …).
  The old addresses redirect to the new ones.
- A signed-in visitor on the landing page or another public page stays there.
  The header shows "Open the app" instead of "Log in".
- CI (`.github/workflows/build-and-deploy.yml`) now runs on pull requests as
  well as pushes to `main`. Pull requests reach `verify` (typecheck, build,
  server unit tests, client unit tests), `e2e` and `dco`; the image-build and
  Coolify deploy jobs stay push-only, each gated on its own
  `if: github.event_name == 'push'`.
- `.github/workflows/selfhost-smoke.yml` runs on pull requests that change
  the self-host stack. It builds both images, waits for every healthcheck,
  requests `/api/health` through Caddy, runs `doctor`, and signs in with an
  account the CLI created, before and after a password reset.
- Summary, Detailed and Weekly reports are now one page. The old addresses
  redirect to it. `/reports/weekly` opens Totals for that week, grouped by
  day. The REST API is unchanged.
- A withheld amount in REST entries is now `null`. It was `0`, which reads
  as unbillable time.
- The browser extension's server address field is replaced by a server
  picker.
- Security reports are routed by email rather than through GitHub private
  security advisories, which are not enabled on the repository.

### Removed

- Pomodoro mode, from the web app and the browser extension.

### Fixed

- A queued offline stop could close the wrong entry.
- Some offline changes were dropped instead of queued.
- Leaving a page while a change was still saving could apply that change
  twice.
- Setting one end of a custom date range could reset the other end.
- A finger drag on the calendar could create an entry.
- Password reset links pointed at the API host instead of the web app.
- A pause-and-resume after idle time could lose the resumed entry.
- Opening an invoice or its PDF looked the invoice up by the caller's user
  id instead of the workspace. It failed only where the two differ.
- A timer capped by the maximum entry duration sent no `entry.stopped`
  webhook, and a flagged one sent no `entry.updated`.

### Security

- A revoked or expired session now closes its WebSocket within a minute.
  Before, a signed-out device kept receiving sync events.
- A member who may not see other members' money no longer gets it in an
  export. The import history and duplicate check show a member only their
  own entries.
- API tokens and webhook secrets are shown once. Tokens are stored as hashes.
- Every webhook delivery resolves its target again and refuses private
  addresses, unless `WEBHOOK_ALLOW_PRIVATE_TARGETS` is set for local testing.
- Deleting a password account requires the password.
- A signed-in user could join another user's WebSocket room and receive
  that person's sync events. A socket now joins only the room of the account
  it signed in with.
- Sync events went to every workspace member unchanged, with a colleague's
  timer, description and rate. Each member now gets only what they may see.
- The web app's entries, reports and project progress showed colleagues'
  rates and amounts to members who may not see money. The REST API already
  withheld them.
- Invoices, which combine colleagues' hours and money, are limited to owners
  and admins who may see both. An invoice id answers "not found" to anyone
  else.

[Unreleased]: https://github.com/trebeljahr/trackyourtime/commits/main
