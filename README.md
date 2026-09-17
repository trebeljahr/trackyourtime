# Track Your Time

Free, open-source time tracking for freelancers and small teams who bill by the hour.

Start a timer in the web app, the Chrome extension, Raycast on your Mac, or the iPhone and Android apps. Each one keeps counting without a connection and sends your changes when the connection comes back. Stop the timer on your phone, and your laptop shows it stopped.

At the end of the month, the hours become a report, a PDF invoice, or a ZUGFeRD or XRechnung e-invoice. Invite colleagues, and each person sees only their own time until you let them see more. Import a CSV from another tracker, take everything out as JSON or CSV, or connect other tools through the REST API.

There's no paid plan, now or later. Use the hosted version at <https://trackyourtime.dev>, or run the same app on your own server from one compose file. The extensions and the phone apps work with either, because each one asks for a server address.

The extensions, the phone apps and the desktop app aren't in their stores yet, and no release is tagged. Today you build them, and the self-host images, from source. [Not there yet](#not-there-yet) lists the other gaps.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![build-and-deploy](https://github.com/trebeljahr/trackyourtime/actions/workflows/build-and-deploy.yml/badge.svg?branch=main)](https://github.com/trebeljahr/trackyourtime/actions/workflows/build-and-deploy.yml?query=branch%3Amain)

The product was called tracktime until September 2026. The repository, images, bundle ids and every other identifier were renamed to `trackyourtime` before the first release.

The hosted web app is at <https://trackyourtime.dev>, with the API on its own host at <https://api.trackyourtime.dev>. [`docs/deploy.md`](docs/deploy.md) explains the topology and why the domain moved.

<!-- Screenshot placeholder: add a capture of the /app/track screen at docs/screenshots/app.png,
     then replace this comment with:
     ![The Track Your Time web app tracking time against a project](docs/screenshots/app.png) -->

## What it is

A pnpm monorepo: one Express + tRPC API, one Next.js web client exported as static files, and shared packages (`shared`, `core`) that the extension, Raycast, the phone apps and the MCP server reuse. Two Docker images and a MongoDB are the whole production footprint; Redis is optional. There is no feature gate between the hosted version and a self-hosted one, and no telemetry you have not configured yourself.

Everything is scoped to a workspace. A person can belong to several, and a workspace can have many members — see [Teams](#teams).

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
- **Description autocomplete** from earlier entries, searched server-side. Tab takes the name; Cmd/Ctrl+Enter also takes the project, task, tags and billable flag.
- **Command palette** (Cmd/Ctrl+K) for timer actions, every page, and clients, projects, tasks and tags. On a phone it opens from the More drawer.
- **Idle detection** with ask, pause-and-resume, keep-running or stop, and a per-project override.
- **Runaway-timer guard.** A maximum entry duration that asks, caps or stops a forgotten timer. A scheduler job (`services/scheduler/`) checks running timers every 5 minutes and sends one reminder email per timer; the lazy check on every read of the running timer stays as the fallback. `SCHEDULER_ENABLED=false` turns the job off.

### Catalog

- **Clients → Projects**, one two-level hierarchy. **Tasks** are workspace-wide and sit beside it, so an entry carries a project and a task as two independent references. **Tags** are a third dimension, many per entry.
- Full CRUD. Clients, projects and tasks have an archive toggle and a delete that always deletes — never the tracked time, though: entries and favorites are detached and survive as project-less rows. Tags follow a different rule: a tag that still labels tracked time is archived instead of deleted, and only an unreferenced tag is removed outright.
- Projects carry colour, client, billable default, hourly rate, estimated hours, a budget amount and currency, and an idle-behaviour override. A billing change can also reprice the project's un-invoiced entries.

### Views

- **Track** — the timer plus the day's entries.
- **Weekly timesheet grid** — rows of project + task, columns of weekday, editable cells. The edit rules are explicit and unit-tested: the running entry's cell is never writable, an empty cell creates exactly one entry, a single same-day entry has its end moved (typing 0 deletes it), and a midnight-crossing or multi-entry cell is refused read-only with a breakdown and a link through rather than guessing.
- **Calendar** — day, week, month and year views positioned by clock time, with drag editing, zoom, clustering for dense bursts of short entries, and an undo stack.

### Reports and money

- **One Reports screen with two views** over the same URL-backed filters: Totals (grouped by client, project, task, tag, member, day, week or month, with a zero-filled timeline and budgets; each group drills down into its entries) and Entries (paginated, sortable, bulk-editable, with totals that span the whole range). The old `/app/reports/summary`, `/detailed` and `/weekly` addresses redirect to it; the REST API still serves summary, detailed and weekly reports.
- **CSV and PDF export** for both views, paginating the full range so an export is never a page of what you were looking at.
- **Invoices** built from un-invoiced billable time. Preview rolls up line items without writing; creating an invoice re-gathers server-side rather than trusting the client's line items, assigns a per-year sequential number, and stamps the invoice onto every entry it billed. Draft/sent/paid status, PDF export, and a guard that refuses edits to entries already on an invoice.
- **Business profile and client billing details.** The issuer and recipient are copied onto the invoice when it is created, so a later address change does not rewrite a document a customer holds.
- **E-invoices.** An invoice also downloads as a ZUGFeRD PDF (PDF/A-3b with the EN 16931 XML embedded) or an XRechnung 3.0 XML file. CI runs every sample through the Mustang and KoSIT validators. See [`docs-site/docs/e-invoices.md`](docs-site/docs/e-invoices.md).
- **Project budgets and estimates** — a lifetime roll-up of hours and earnings against estimated hours and budget, computed from each entry's own snapshotted rate.

> Reporting grouped by tag gives each of an entry's tags that entry's **full** duration, so tag rows sum to more than the range total on purpose. The alternative — splitting a duration across tags — would invent time nobody spent. The screen says so where it happens; the report's own totals stay single-counted.

### Teams

- **Workspaces, members and invitations** through the `workspaces`, `members` and `invitations` tRPC routers. Invite by email, or copy the invitation link when the server has no mail transport. The public `/invite/?id=` page accepts it, before or after sign-in.
- **Roles** `owner`, `admin` and `member`, with ownership transfer. A workspace always keeps an owner.
- **Two visibility flags per member**: colleagues' time, and colleagues' money. Every surface answers both server-side — reports, entry lists, exports, the REST API and the sync socket, which sends each member only what they may see.
- **A workspace switcher** in the app shell. Each client keeps its own choice and names the workspace on every request.
- Invoices are limited to owners and admins who may see both time and money.

### Data in and out

- **Import from a delimited file.** Headers are matched to roles by an alias table and the values decide the granularity, so it is column shapes rather than vendor-specific formats. Day/month order is decided per file and stated on screen when nothing in the data settles it.
- **Preview then commit.** The commit re-parses the same input rather than trusting the preview it handed back, so a tampered preview cannot write something you never approved.
- **Every import is one undoable batch**, deleted by an indexed id — and refused if any of its entries have since landed on an invoice.
- **Workspace export**: JSON (lossless — colours, archived rows, project rates, the business profile, catalog referenced by name so it restores into an empty or different workspace) and CSV (written in the exact column shape the importer reads back).
- **Move to another server** (Settings → Data): the same export and import, driven from one device, hosted → self-hosted and back.
- **REST API and webhooks.** `/api/v1` covers entries, clients, projects, tasks, tags, reports and the current user, with scoped API tokens, an OpenAPI document and RFC 9457 errors. Signed webhooks report entry and invoice events. See [`docs/api.md`](docs/api.md) and the [MCP server](#mcp-server).

### Platform

- **Realtime multi-device sync** over WebSocket on the same Express process. The upgrade is authenticated, a socket joins only its own account's room, and a revoked session closes its socket within a minute.
- **Offline queue** in the web app, the phone apps, the browser extension and Raycast: entry mutations made offline are queued and replayed in order on reconnect, with optimistic temporary ids until the server answers. Each queued row records the account, workspace and server it was queued for, and replays only there.
- **Sign-in for clients without a cookie jar.** Every first-party client signs in normally and sends the resulting session token as `Authorization: Bearer <token>`; clients that cannot show a form (Raycast, a CLI) use the RFC 8628 device flow, approved in an already signed-in browser. Sessions are named by their client under Settings → Devices, where any of them can be revoked. API tokens are a separate credential, for the REST API only.
- **Account security**: TOTP two-factor with backup codes, change password, change email, and account deletion from Settings → Account. Email verification is required whenever the server has a mail transport.
- **English and German** in the web app, the phone apps, the browser extension, invoices, report PDFs and email, plus German public pages under `/de/`. Raycast stays English.
- **Split settings**: money and calendar conventions per workspace (default rate, currency, week start), rendering per user (12h/24h, h:m:s vs decimal, theme, language).
- Optional Google sign-in (web app only), optional Sentry/GlitchTip error reporting, optional Listmonk + SES newsletter double-opt-in.

## Clients

| Client | State |
| --- | --- |
| **Web app** (Next.js static export) | Shipped, and the reference implementation. 13 signed-in screens under `/app/`: track, timesheet, calendar, reports, clients, projects, tasks, tags, invoices, members, settings, profile, device. |
| **Browser extension** (Chrome MV3) | Working. Popup only, no content scripts: timer, badge, catalog, favorites, idle, the offline queue, a server picker, and optional activity-based entry suggestions. English and German. Version 0.1.0, not in the Chrome Web Store; you load it unpacked. |
| **Raycast extension** (macOS) | Working. 5 commands — menu bar timer, Start / Stop Timer (hotkey-able, no window), a live timer view, Show All Time and Open Dashboard — with catalog CRUD through pushed forms and an offline queue (`packages/raycast/src/lib/offline.ts`). Not in the Raycast Store. |
| **iOS and Android** (Capacitor) | Working from source. `ios/` and `android/` are committed, the bundle id is `com.trebeljahr.trackyourtime`, and `pnpm build:mobile` builds and syncs both. Keychain/Keystore session token, offline queue and running timer that survive an OS kill, safe areas, a bottom tab bar, and a server picker on the login screen. Not in the App Store or Google Play. See [`docs/mobile-app-plan.md`](docs/mobile-app-plan.md). |
| **Desktop** (Electron: macOS, Windows, Linux) | Working from source, verified on macOS. Serves the export from `app://-` and signs in with a bearer token encrypted by `safeStorage`, by password or through the browser for two-factor and Google accounts. A menu bar or tray timer, four rebindable global shortcuts, open at login, notifications for idle and runaway prompts while the window is hidden, the offline queue and a server picker. The dmg, the Windows installer and the AppImage update themselves from GitHub Releases, installing on quit or on "Restart to update". Store and package-manager builds leave updates to their manager. `desktop-release.yml` builds every channel, signs when its secrets are set, and on a tag uploads to a draft release. No release is published and no store lists it, and the Windows and Linux builds have never run. See [`docs-site/docs/desktop.md`](docs-site/docs/desktop.md) and [`docs/desktop-app-plan.md`](docs/desktop-app-plan.md). |
| **CLI** | No end-user CLI. `trackyourtime-cli` appears only as an allowlisted device-flow client id. The server image does ship an admin CLI for self-hosters (`node dist/cli/admin.js`). |
| **MCP server** (`packages/mcp`) | Working. Lets Claude Desktop, Claude Code or any MCP client start and stop timers, log time, list entries, manage the catalog and run the summary report, through the public REST API with an API token. stdio only, not published to npm — run it from a clone. See [MCP server](#mcp-server). |

## Not there yet

- **No release.** No git tag exists, so no self-host image has been published. `docker-compose.selfhost.yml` only pulls, which means a first start today needs the build override in `docker-compose.selfhost.build.yml` and about 4 GB of memory. [`docs/releasing.md`](docs/releasing.md) is the release process.
- **No store listings.** The Chrome extension, the Raycast extension, the iPhone and Android apps and the desktop app all build from source.
- **Sign-up cannot be closed in the app.** Anyone who reaches a server can register. The self-hosting guide shows how to [block the sign-up endpoint at the proxy](docs/self-hosting.md#accounts-and-what-admin-means-here).
- **No timesheet approval.** No submitted/approved state, no approver role, no lock-after-approval. Invoice status is invoice lifecycle, not time approval.
- **Rates are per project, not per person.** An entry takes its project's rate, else the workspace default, so everyone on a project bills at the same rate.
- **No client portal or shared reports.** A client cannot sign in or open a link to follow a project. Send them a report or an invoice as a PDF.
- **No Firefox extension.** The extension is Chrome MV3 only.
- **Two-factor sign-in does not work in the phone apps or the extension's password form.** The second step needs a cookie those clients cannot send. The extension's "Sign in with the web app" button, the desktop app's "Sign in with your browser" and Raycast use the device flow instead, where you approve the sign-in in a browser. Google sign-in is web-only too, for the same reason.
- **Time off, PTO, holidays, absence.** No model and no screen, so nothing computes capacity or utilization.
- **Notifications** are one reminder email per runaway timer. No web push and no digests.
- **Avatar upload.** The server stores no files. `avatarUrl` is a field with no upload path behind it.

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
| `docker-compose.selfhost.yml` | **Self-hosting.** Everything on one domain behind Caddy, with Mongo and Redis included. Pulls the published images — none exist until the first release is tagged, so add the build override below for now. The one you want. |
| `docker-compose.selfhost.build.yml` | Opt-in override for `docker-compose.selfhost.yml` that builds both app images from the clone instead of pulling them. Needs about 4 GB of memory. |
| `docker-compose.dev.yml` | Local dev infra only: Mongo, Redis, SeaweedFS S3. No app containers. |
| `docker-compose.server.yml` | The maintainer's production API. One service, `server`. Expects an externally managed Mongo/Redis. |
| `docker-compose.client.yml` | The maintainer's production web app. One service, `client`. |
| `docker-compose.yml` | Legacy single-app layout. Its own header documents that nothing routes `/api` to the server under it. |

The service names `server` and `client` are load-bearing under Coolify — it keys routing by them. Do not rename them.

Under the self-host layout the client image is built with an **empty** `NEXT_PUBLIC_API_URL`, so every call the browser makes is same-origin and the image works on anybody's domain. That is why it is published separately as `ghcr.io/trebeljahr/trackyourtime-client-selfhost` — the `:main` client image bakes in the maintainer's own API host.

### `TRUSTED_ORIGINS`

A single-domain self-host does not need this at all: the browser's origin *is* `FRONTEND_URL`. It matters when something other than that domain signs in.

better-auth validates the `Origin` header on sign-in whenever the request carries `Sec-Fetch-*` headers, which every real browser fetch does. A browser origin that is not `FRONTEND_URL` gets `403 INVALID_ORIGIN` **before the password is checked**. Add, comma-separated, whichever apply:

- `chrome-extension://<id>` — a browser extension you built yourself (`pnpm run extension:id prod` prints it)
- `capacitor://localhost,https://localhost` — the iOS and Android apps
- `app://-` — the desktop app, which serves its bundle from that privileged scheme (`file://` would send `Origin: null`, which cannot be trusted with credentials)

Or set `TRUST_STORE_APPS=true`, which trusts the iOS and Android apps, the desktop app and the Chrome Web Store extension (its id is pinned in `packages/shared/src/store-clients.ts`) in one switch. `docker-compose.selfhost.yml` defaults it to `true`, so the store builds, once they exist, can sign in to a self-hosted server with nothing to configure. The extension asks Chrome for no access to any website, so every request it sends is a cross-origin request: without this trust it cannot sign in, sync or send an entry.

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

git clone https://github.com/trebeljahr/trackyourtime.git && cd trackyourtime
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
pnpm run dev:desktop         # Next dev + an Electron window (UI only; see the note below)
NEXT_PUBLIC_API_URL=http://localhost:5159 pnpm run electron:preview  # packaged app over app://-
```

## Testing

```bash
pnpm run test:unit      # core, server (node:test), MCP and extension suites — no services needed
pnpm run test:client    # Vitest suites in the client — jsdom, no services needed
pnpm run test:e2e       # Playwright specs — REQUIRES DOCKER
pnpm run test:mcp:integration  # MCP server over a real API — starts its own mongod
pnpm run test:e2e:desktop      # the Electron app over app://- — starts its own mongod and API
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
| `docs-site/` | The Docusaurus site served at [trackyourtime.dev/docs](https://trackyourtime.dev/docs/): self-hosting, choosing a tracker, the MCP server and the REST API. It is built into the web app's image ([`docs/deploy.md`](docs/deploy.md#the-docs-are-part-of-the-client-image)). Every build also writes a Markdown copy of each page and an `llms.txt`. Run it locally with `pnpm run dev:docs`. |

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the pull request process, and [ROADMAP.md](ROADMAP.md) if you are looking for something to pick up.

Commits must be signed off under the [Developer Certificate of Origin](https://developercertificate.org/) 1.1 — `git commit -s` adds the `Signed-off-by` trailer. There is no CLA.

## License

Licensed under the GNU Affero General Public License, version 3 or later (`AGPL-3.0-or-later`). See [LICENSE](LICENSE).

The code is AGPL; the Track Your Time name, logo and domain are not — see [TRADEMARK.md](TRADEMARK.md).
