# Track Your Time

A self-hostable time tracker: clients, projects, tasks, tags, billable rates, reports and invoices, with a web app, a browser extension and a Raycast extension sharing one backend.

The product was called tracktime until September 2026. The repository, package names, bundle ids and storage keys keep that name, so existing installs, sessions and queued data carry over.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![build-and-deploy](https://github.com/trebeljahr/tracktime/actions/workflows/build-and-deploy.yml/badge.svg?branch=main)](https://github.com/trebeljahr/tracktime/actions/workflows/build-and-deploy.yml?query=branch%3Amain)

Hosted instance: <https://trackyourtime.dev>, with the API on its own host at <https://api.trackyourtime.dev> — [`docs/deploy.md`](docs/deploy.md) explains the topology and why the domain moved.

> The build badge is pinned to `main` and reports the real state of the pipeline. It is not green — see [Not there yet](#not-there-yet).

<!-- Screenshot placeholder: add a capture of the /track screen at docs/screenshots/app.png,
     then replace this comment with:
     ![The Track Your Time web app tracking time against a project](docs/screenshots/app.png) -->

## What it is

Time tracking for freelance and consulting work: start a timer, tag it with a client, project and task, and get the hours back as a report, a CSV, a PDF or an invoice. Rates are per project, snapshotted onto each entry when it is written, so changing a project's rate never rewrites what you already billed.

It is a pnpm monorepo — one Express + tRPC API, one Next.js web client, and shared packages the other clients reuse. Two Docker images and a MongoDB is the whole production footprint; Redis is optional. There is no SaaS tier gate and no telemetry you have not configured yourself.

Everything is scoped to a workspace, but today that is effectively one workspace per person — see [Not there yet](#not-there-yet) before assuming team features.

## Where things live

| If you want to | Go to |
| --- | --- |
| Understand how the system fits together | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Run it locally and open a pull request | [`CONTRIBUTING.md`](CONTRIBUTING.md), or [Development](#development) below for the short version |
| Run your own instance | [`docs/self-hosting.md`](docs/self-hosting.md) — one VPS, one domain, one `docker compose up` |
| Deploy it | [`docs/deploy.md`](docs/deploy.md) — the two-app, two-host Coolify topology and the four places that must agree on the API origin |

[Project](#project) below indexes the rest — roadmap, governance, support, security, and what `CLAUDE.md` and `docs-site/` are.

## Features

### Tracking

- **Timer with start / stop / continue / discard**, plus manual entry creation and editing. Entries carry a description, project, task, tags, a billable flag, a snapshotted hourly rate and currency, a source (web/desktop/mobile/extension/api/import) and the time zone they were recorded in.
- **Favorites and quick-start recents.** Favorites are reorderable one-tap job templates; quick-start collapses your recent entries into distinct combinations. Quick starts deliberately open untagged, so the same job tagged differently one day does not fragment the list.
- **Idle detection**, configurable per user (threshold, behaviour, whether a screen lock counts immediately), with a per-project behaviour override on the project itself.
- **Runaway-timer guard.** A maximum entry duration, evaluated lazily whenever something resolves what is running — asking what is current, starting another timer, joining the sync room. There is no cron: nothing pushes you a notification on Saturday about Friday's forgotten timer, it is caught the next time you look.

### Catalog

- **Clients → Projects → Tasks**, plus **Tags** as an orthogonal dimension (many per entry, across projects).
- Full CRUD. Clients, projects and tasks have an archive toggle and a delete that always deletes — never the tracked time, though: entries and favorites are detached and survive as project-less rows. Tags follow a different rule: a tag that still labels tracked time is archived instead of deleted, and only an unreferenced tag is removed outright (with a `$pull` sweep afterwards for anything written during the check).
- Projects carry colour, client, billable default, hourly rate, estimated hours, a budget amount and currency, and an idle-behaviour override.

### Views

- **Track** — the timer plus the day's entries.
- **Weekly timesheet grid** — rows of project + task, columns of weekday, editable cells. The edit rules are explicit and unit-tested: the running entry's cell is never writable, an empty cell creates exactly one entry, a single same-day entry has its end moved (typing 0 deletes it), and a midnight-crossing or multi-entry cell is refused read-only with a breakdown and a link through rather than guessing.
- **Calendar** — a time grid positioned by clock time, with drag editing, zoom, clustering for dense bursts of short entries, and an undo stack.

### Reports and money

- **One Reports screen with two views** over the same URL-backed filters: Totals (grouped breakdown by project/client/task/tag/day/week/month, zero-filled timeline, budgets; each group drills down into its entries) and Entries (paginated, sortable, bulk-editable entry log whose totals span the whole range). Switching views keeps every filter. The old `/reports/summary`, `/reports/detailed` and `/reports/weekly` addresses redirect to it; the REST API still serves summary, detailed and weekly reports.
- **CSV and PDF export** for both views, paginating the full range so an export is never a page of what you were looking at.
- **Invoices** built from un-invoiced billable time. Preview rolls up line items without writing; creating an invoice re-gathers server-side rather than trusting the client's line items, assigns a per-year sequential number, and stamps the invoice onto every entry it billed. Draft/sent/paid status, PDF export, and a guard that refuses edits to entries already on an invoice.
- **Project budgets and estimates** — a lifetime roll-up of hours and earnings against estimated hours and budget, computed from each entry's own snapshotted rate.

> Reporting grouped by tag gives each of an entry's tags that entry's **full** duration, so tag rows sum to more than the range total on purpose. The alternative — splitting a duration across tags — would invent time nobody spent. The screen says so where it happens; the report's own totals stay single-counted.

### Data in and out

- **Import from a delimited file.** Headers are matched to roles by an alias table and the values decide the granularity, so it is column shapes rather than vendor-specific formats. Day/month order is decided per file and stated on screen when nothing in the data settles it.
- **Preview then commit.** The commit re-parses the same input rather than trusting the preview it handed back, so a tampered preview cannot write something you never approved.
- **Every import is one undoable batch**, deleted by an indexed id — and refused if any of its entries have since landed on an invoice.
- **Workspace export**: JSON (lossless — colours, archived rows, project rates, catalog referenced by name so it restores into an empty or different workspace) and CSV (written in the exact column shape the importer reads back).

### Platform

- **Realtime multi-device sync** over WebSocket on the same Express process. The upgrade is authenticated and refused with a real 401/403; mutations carry a per-tab origin id echoed back, so a client ignores its own echo.
- **Offline queue** in the web app and browser extension: entry mutations made offline are queued and replayed on reconnect, with optimistic temporary ids until the server answers.
- **Sign-in for clients without a cookie jar** without minting API tokens. Every client signs in normally and sends the resulting session token as `Authorization: Bearer <token>`; clients that cannot show a form (Raycast, a CLI) use the RFC 8628 device flow, approved in an already signed-in browser. Sessions are named by their client under Settings → Devices, where any of them can be revoked — killing HTTP and WebSocket at once.
- **Split settings**: money and calendar conventions per workspace (default rate, currency, week start), rendering per user (12h/24h, h:m:s vs decimal, idle, limits).
- Optional Google sign-in, optional Sentry/GlitchTip error reporting, optional Listmonk + SES newsletter double-opt-in.

## Clients

| Client | State |
| --- | --- |
| **Web app** (Next.js static export) | Shipped, and the reference implementation. 12 signed-in routes: track, timesheet, calendar, reports, clients, projects, tasks, tags, invoices, settings, profile, device. |
| **Browser extension** (Chrome MV3) | Working and genuinely useful — popup only, no content scripts. Timer, badge, catalog, favorites, idle and the offline queue. Version 0.1.0, not published to any store; you load it unpacked. |
| **Raycast extension** (macOS) | Working and broad — 4 commands (menu bar timer, a live one-second timer view, an entries browser and an open-dashboard action), with full catalog CRUD reached through pushed forms rather than commands of its own. Not published to the Raycast store, and it has **no offline queue**: a mutation made without connectivity is lost, unlike the same action from the web app or extension. |
| **Desktop** (Electron) | Real but thin. Window lifecycle, persisted fullscreen preference, external-link handling and `powerMonitor`-backed idle reporting over IPC. No tray icon, no global shortcuts, no auto-update, no signing setup. Never built or distributed. |
| **Desktop** (Tauri) | Scaffolding only — 24 lines of Rust with an empty setup and a Steamworks block inherited from the starter this repo was generated from. Do not count it as a desktop app. |
| **Mobile** (Capacitor) | Config and a small JS bridge only. No `ios/` or `android/` directory exists, the bundle id is still `com.example.tracktime`, and nothing has been run on a device — despite the `dev:ios` / `dev:android` / `build:mobile` scripts existing in `package.json`. |
| **CLI** | Does not exist. `tracktime-cli` appears only as an allowlisted device-flow client id. |
| **MCP server** (`packages/mcp`) | Working. Lets Claude Desktop, Claude Code or any MCP client start and stop timers, log time, list entries, manage the catalog and run the summary report, through the public REST API with an API token. stdio only, not published to npm — run it from a clone. See [MCP server](#mcp-server). |

## Not there yet

Stated plainly, because the code has more scaffolding than product in these areas:

- **Teams, invitations and workspace switching.** The substrate is real — every user gets a personal workspace, there is a member model with roles and visibility flags, and one middleware scopes every query — and better-auth's `organization` plugin is mounted, so its create-organization, invite-member, list-members and set-role endpoints are callable under `/api/auth/*`. What is missing is everything above them: **no tRPC router, no invite UI, no member list, no role editing and no workspace switcher**. The invitation email links to `/invite/<id>`, and that page does not exist, so an invitation sent today lands on a 404. The realtime layer is not ready either: every member currently receives the identical sync payload, which is only correct while a workspace has one member. Treat this as a single-user app.
- **Timesheet approvals.** Nothing. No submitted/approved state, no approver role, no lock-after-approval, no notifications. The timesheet is an editing grid, not a submittable document. Invoice status is invoice lifecycle, not time approval.
- **Time off, PTO, holidays, absence.** No model, no screen, no shared type. There is no non-working-day concept, so nothing computes capacity or utilization.
- **Notifications of any kind.** No web push, no email digests, no scheduler, no job runner. The runaway guard is lazy on purpose and says so in its own source.
- **SaaS subscription billing.** There is no Stripe service in the server at all — only a `billing.status` query that reports which `STRIPE_*` env vars are missing so the UI can show a developer notice. (Watch the word: "Billing" in the settings screen means *your clients' billable rates*, not a subscription.)
- **Avatar upload / object storage.** An S3 service module exists and nothing imports it. `avatarUrl` is a field with no upload path behind it.
- **Search, a command palette, and third-party integrations.** No global search, no palette, no calendar sync, no issue-tracker or commit import. Import is file-based only.
- **Email verification is off.** Password reset, verification and invitation mail goes out over SMTP once `SMTP_HOST` is set, and falls back to logging the URL to the server console when no transport is configured at all — which is the default local setup. `requireEmailVerification` is still `false`.
- **CI has never gone green.** The build-and-deploy workflow has two runs in its history — one failed at the build/test job, the other at E2E — so the Docker image builds and the deploy path have never actually executed. The self-host images are published by a separate tag-triggered workflow ([`.github/workflows/release.yml`](.github/workflows/release.yml)), which has not run either — no `v*` tag has been cut yet, so `docker compose` builds them locally until one is.

## Self-hosting

One VPS, one domain, one command. [`docker-compose.selfhost.yml`](docker-compose.selfhost.yml) brings up Caddy, the API, the static web app, Mongo and Redis, with Caddy terminating TLS and routing `/api` and `/ws` to the server and everything else to the client.

```bash
cp .env.selfhost.example .env
```

Set `APP_DOMAIN` and `APP_URL` to your domain, generate `BETTER_AUTH_SECRET`, then:

```bash
docker compose -f docker-compose.selfhost.yml up -d
```

[`docs/self-hosting.md`](docs/self-hosting.md) is the full manual: prerequisites, first run, SMTP, backup and restore, upgrades, and troubleshooting.

### Which compose file is which

| File | Purpose |
| --- | --- |
| `docker-compose.selfhost.yml` | **Self-hosting.** Everything on one domain behind Caddy, with Mongo and Redis included. The one you want. |
| `docker-compose.dev.yml` | Local dev infra only: Mongo, Redis, SeaweedFS S3. No app containers. |
| `docker-compose.server.yml` | The maintainer's production API. One service, `server`. Expects an externally managed Mongo/Redis. |
| `docker-compose.client.yml` | The maintainer's production web app. One service, `client`. |
| `docker-compose.yml` | Legacy single-app layout. Its own header documents that nothing routes `/api` to the server under it. |

The service names `server` and `client` are load-bearing under Coolify — it keys routing by them. Do not rename them.

Under the self-host layout the client image is built with an **empty** `NEXT_PUBLIC_API_URL`, so every call the browser makes is same-origin and the image works on anybody's domain. That is why it is published separately as `ghcr.io/trebeljahr/tracktime-client-selfhost` — the `:main` client image bakes in the maintainer's own API host.

### `TRUSTED_ORIGINS`

A single-domain self-host does not need this at all: the browser's origin *is* `FRONTEND_URL`. It matters when something other than that domain signs in.

better-auth validates the `Origin` header on sign-in whenever the request carries `Sec-Fetch-*` headers, which every real browser fetch does. A browser origin that is not `FRONTEND_URL` gets `403 INVALID_ORIGIN` **before the password is checked**. Add, comma-separated, whichever apply:

- `chrome-extension://<id>` — a browser extension you built yourself (`pnpm run extension:id prod` prints it)
- `capacitor://localhost,https://localhost` — Capacitor

Or set `TRUST_STORE_APPS=true`, which trusts the iOS and Android apps and the Chrome Web Store extension (its id is pinned in `packages/shared/src/store-clients.ts`) in one switch. `docker-compose.selfhost.yml` defaults it to `true`, so the store-installed clients can sign in to a self-hosted server with nothing to configure.
- `app://-` — Electron via a custom protocol (`file://` sends `Origin: null` and cannot be trusted with credentials)
- `tauri://localhost` and `http://tauri.localhost` — Tauri on macOS/Linux and Windows

Raycast and CLI clients need nothing here — their requests carry neither `Origin` nor `Sec-Fetch-*`. What guards them is the device flow plus the client-id allowlist in `packages/server/src/auth/client-label.ts`.

## MCP server

[`packages/mcp`](packages/mcp) is a [Model Context Protocol](https://modelcontextprotocol.io) server over the public REST API (`/api/v1`). An assistant can read the running timer, start and stop it, log past time, list and search entries, list and create clients, projects, tasks and tags, and run the summary report. There are no invoice tools, because v1 has no invoice routes.

It authenticates with a personal API token from **Settings → Integrations → API tokens**, and offers only the tools that token's scopes allow. It works against the hosted API or any self-hosted origin.

```bash
pnpm install && pnpm build:mcp
```

```bash
claude mcp add trackyourtime --env TRACKYOURTIME_API_TOKEN=tt_your_token --env TRACKYOURTIME_API_URL=https://api.trackyourtime.dev -- node "$PWD/packages/mcp/dist/index.js"
```

`TRACKYOURTIME_API_URL` defaults to `https://api.trackyourtime.dev`; set it to your own origin for a self-hosted instance. Claude Desktop and other clients, the tool list and the error table are in [`docs-site/docs/mcp.md`](docs-site/docs/mcp.md).

## Development

Requires Node 24 (`.nvmrc`), pnpm 11 via corepack, and Docker for the local infra.

```bash
corepack enable
nvm install && nvm use

git clone https://github.com/trebeljahr/tracktime.git && cd tracktime
pnpm install

# REQUIRED — .env.development is not tracked, so create it from the example
cp packages/server/.env.example packages/server/.env.development
# then set BETTER_AUTH_SECRET in it to any 32+ character string

pnpm run dev:infra     # Mongo 27017, Redis 6379, SeaweedFS S3 9000 (docker)
pnpm run dev           # client 3392, API 5159
```

Open <http://localhost:3392>.

`pnpm run dev` pins those ports on purpose: the browser extension, Raycast and any native build bake their API URL in and cannot follow a port that moves. Variants:

```bash
pnpm run dev:auto            # every port auto-picked — use this for a second instance
pnpm run dev:fixed           # the pinned ports, or exit
pnpm run dev:docs            # also runs the docs site on 4000
node scripts/dev.mjs --dry-run   # print the resolved ports, start nothing
```

**Inside a git worktree, `pnpm run dev` behaves like `dev:auto`** so parallel checkouts do not fight over the pinned ports — which also means the extension and Raycast will not find the server there unless you run `dev:fixed` or point them at the printed ports.

Other clients:

```bash
pnpm run dev:extension       # browser extension, dev target (localhost:5159)
pnpm run build:extension     # dist/       -> http://localhost:5159
pnpm run build:extension:prod # dist-prod/ -> https://api.trackyourtime.dev
pnpm run extension:id [dev|prod]  # the chrome-extension:// origin to trust

pnpm run dev:raycast         # ray develop
pnpm run dev:desktop         # Next dev + an Electron window
```

`pnpm run seed:assets`, `assets:push` and `assets:pull` shell out to a private CLI that is not installable from this repo. Nothing about running or testing the app depends on them — skip them.

## Testing

```bash
pnpm run test:unit      # 21 server suites (node:test) — pure logic, no services needed
pnpm run test:client    # 27 Vitest suites in the client — jsdom, no services needed
pnpm run test:e2e       # 10 Playwright specs — REQUIRES DOCKER
pnpm run test:mcp:integration  # MCP server over a real API — starts its own mongod
pnpm test               # all three in sequence

pnpm run typecheck      # builds shared + core, then tsc --noEmit everywhere else
pnpm run build          # shared -> core -> server -> client
```

The E2E suite starts its own Mongo, Redis and S3 containers on separate ports and runs against the **static export**, not the dev server, so the first run includes a full client build. It needs Docker and a one-off `npx playwright install chromium`. [CONTRIBUTING.md](CONTRIBUTING.md#tests-and-checks) has the details, including the port and database variables you must set if another checkout is running the suite at the same time.

## Project

| File | What it is for |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How the packages fit together, what a request does end to end, and how multi-device sync works. Start here to change code. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Setup, the checks a pull request should pass, code style, and the DCO sign-off mechanics. |
| [`ROADMAP.md`](ROADMAP.md) | What is wanted next, what is undecided, and what is deliberately out of scope — with what already exists for each. |
| [`GOVERNANCE.md`](GOVERNANCE.md) | Who decides (one maintainer), how disagreements end, and what gets a pull request merged. |
| [`SUPPORT.md`](SUPPORT.md) | Where to ask a question, and what to expect for an answer. |
| [`SECURITY.md`](SECURITY.md) | How to report a vulnerability privately. Do not open a public issue for one. |
| [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) | The behaviour expected of everyone taking part, and how to report a problem. |
| [`TRADEMARK.md`](TRADEMARK.md) | What the licence does *not* cover: the name, the logo and the domain — and how to fork cleanly. |
| [`CHANGELOG.md`](CHANGELOG.md) | What has changed. It starts at the point the project was opened up, not at the first commit. |
| [`CLAUDE.md`](CLAUDE.md) | Instructions for AI coding agents, not contributor documentation — but worth knowing about. [CONTRIBUTING.md](CONTRIBUTING.md#repository-layout) explains when to reach for it. |
| [`docs/deploy.md`](docs/deploy.md) | The production topology: two Coolify apps on two hosts — the web app on the apex, the API on `api.` — why the domain moved, and the four places that must agree on the API origin. |
| [`docs/self-hosting.md`](docs/self-hosting.md) | Running your own instance: `docker-compose.selfhost.yml`, one domain behind a reverse proxy, SMTP, backup, restore and upgrades. |
| [`docs/dev-setup.md`](docs/dev-setup.md) | The maintainer's own Tailscale/Caddy dev-URL setup. Needs a private CLI that is not installable from this repo — skip it. |
| `docs-site/` | A Docusaurus site: self-hosting, choosing a tracker, the MCP server and the REST API. **Not deployed anywhere**: with `DOCS_SITE_URL` unset it uses a placeholder URL, which switches on `noIndex` and a disallow-all robots.txt. Every build also writes a Markdown copy of each page and an `llms.txt`. `getting-started` and `architecture` are still starter boilerplate. Run it locally with `pnpm run dev:docs`. |

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the pull request process, and [ROADMAP.md](ROADMAP.md) if you are looking for something to pick up.

Commits must be signed off under the [Developer Certificate of Origin](https://developercertificate.org/) 1.1 — `git commit -s` adds the `Signed-off-by` trailer. There is no CLA.

## License

Licensed under the GNU Affero General Public License, version 3 or later (`AGPL-3.0-or-later`). See [LICENSE](LICENSE).

The code is AGPL; the Track Your Time name, logo and domain are not — see [TRADEMARK.md](TRADEMARK.md).
