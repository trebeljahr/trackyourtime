# Architecture

A map of the codebase, written so that someone who has never opened it can find
the file they need to change in a couple of minutes.

For what the product does, see [README.md](README.md). For how to run and test
it, see [CONTRIBUTING.md](CONTRIBUTING.md). This file is about where things
live and why.

---

## Orientation

Track Your Time is time tracking with clients, projects, tasks, tags, billable rates,
reports and invoices, used from a web app, a browser extension, a Raycast
extension and (as wrappers around the same web client) desktop and mobile
shells. It is a pnpm workspace: one Express server, one Next.js client, and
the `shared`, `core`, `extension` and `raycast` packages between them.

The single most important structural fact: **one Express process serves
everything the server owns** — better-auth at `/api/auth/*`, the tRPC API at
`/api/trpc`, and the WebSocket at `/api/ws` — off one `http.Server`
(`packages/server/src/index.ts` builds the app, then hands the same server to
`setupWebSocket`). There is no gateway, no second service, no message broker.

The second: **types flow end to end without codegen.** The client imports
`AppRouter` as a *type* from `@starter/server/trpc` (`packages/server/package.json`
maps that export to `./src/trpc/router.ts` under `"types"` only), and everything
that crosses the boundary — wire shapes, zod input schemas, the WebSocket
protocol — is declared once in `@starter/shared`. A type defined twice drifts,
so it is declared once.

```
browser / extension / Raycast
        │  HTTP  (tRPC, better-auth)
        │  WSS   (sync events)
        ▼
  one Express process ──▶ MongoDB (Mongoose)
                      └─▶ Redis, S3 (optional services)
```

---

## Repository map

### Workspace packages (`pnpm-workspace.yaml`: `packages/*` and `docs-site`)

| Package | What it is | When you touch it |
|---|---|---|
| `packages/server` | Express 5 + tRPC + better-auth + Mongoose + `ws`. `app.ts` (middleware chain), `trpc/` (context, procedures, 14 routers), `models/` (11 Mongoose models), `ws/`, `auth/`, `services/`, `config/`, `db/`, `tests/` | Any API change: a procedure, an authorization rule, a model field, the middleware chain, the socket fan-out |
| `packages/client` | Next.js App Router web app, **static export** (`output: "export"`, `trailingSlash: true`). `src/app/` (routes), `src/components/` (`ui/` is shadcn), `src/hooks/`, `src/lib/`, `src/providers/` | Web UI, a new route, a react-query cache rule, the client half of offline/sync |
| `packages/shared` | Types, zod schemas, and pure domain rules that both sides need: `types.ts`, `schemas.ts`, `protocol.ts`, plus `rates`, `budgets`, `duration`, `idle`, `import`, `quick-start`, `reports`, `runaway`, `timesheet`, `timezone`, `catalog-colors` | Whenever a type or rule must be identical on client and server, or is pure enough to unit-test without a database |
| `packages/core` | Framework-free runtime shared by web, extension and Raycast — no React, no DOM, no tRPC of its own: `api-client`, `session-auth` (password + RFC 8628 device flow), `sync-client`, `sync-url`, `offline-queue`, `offline-ops`, `entry-fields`, `timer-store`, `idle`, `ids`, `storage` | Behaviour more than one client needs. Putting it in a client package instead is how the surfaces drift |
| `packages/extension` | Chrome MV3 extension, popup only. `src/background/` (holds the sync client), `src/popup/`, `src/lib/`. `manifest.config.ts` bakes in the DEFAULT API URL; no host or `cookies` permission, so every request is CORS. The popup's server picker switches to any server with no permission prompt. `externally_connectable` lets the first-party web app link its sign-in through `background/bridge.ts` (device flow; protocol in `@starter/shared/extension-bridge`) | Extension UI or background behaviour. Its `chrome-extension://` origin must be trusted by the server for every request, not only sign-in — `TRUST_STORE_APPS=true` covers the store id |
| `packages/raycast` | Raycast (macOS) extension: `menu-bar.tsx`, `timer.tsx`, `entries.tsx`, `components/` (incl. catalog forms), `lib/` | Raycast commands and forms only — domain logic belongs in `core`/`shared` |
| `packages/mcp` | MCP server on stdio over the public REST API (`/api/v1`) with an API token: `api-client`, `tools` (input schemas from `shared`), `server` (scope probe), `index` (the `trackyourtime-mcp` binary) | A new tool, or a REST change a tool depends on. It never calls tRPC |
| `docs-site` | Docusaurus site served at `trackyourtime.dev/docs/` from the client image (`scripts/docs/build-into-client.mjs`): intro, choosing a tracker, self-hosting (generated from `docs/self-hosting.md` by `pnpm docs:sync`), MCP, REST API. `plugins/llms-markdown.ts` emits a `.md` copy of every page plus `llms.txt` at build | API or MCP changes, and after editing `docs/self-hosting.md` |

`shared` vs `core` is the boundary worth internalising: **`shared` is data and
pure functions** (a type, a zod schema, a rule with no I/O); **`core` is runtime
behaviour with no framework** (fetching, sockets, queues, stores). Both must
build before anything resolves them — hence the ordering in `pnpm run build`.

### Everything else at the root

| Path | What it is |
|---|---|
| `e2e/` | Playwright suite: 10 specs, `helpers.ts`, `db-utils.ts`, `serve-static.mjs`, `start-server.sh` (starts its own Mongo/Redis outside CI) |
| `docs/` | `deploy.md` (the production topology) and `dev-setup.md` (a Tailscale/Caddy dev-URL guide that needs a private CLI) |
| `scripts/` | Root tooling: `dev.mjs` (port resolution for `dev` / `dev:auto` / `dev:fixed`), `extension-id.mjs` + `lib/`, icon scripts, `newsletter-*.ts`, mobile dev shells |
| `electron/` | `src/` — main process split by concern (`protocol.ts` serves the export on `app://-`, `window.ts`, `ipc.ts` with sender checks, `security.ts`, `secure-store.ts` for the session token, `desktop.ts` wiring the tray, shortcuts, settings and notifications, `distribution.ts` for which channel installed the app, `updater-model.ts` and `updater.ts` for electron-updater) and `preload.ts`; pure modules have `*.test.ts` beside them. Bundled by `scripts/build-desktop.mjs` into `dist/`, packaged by `electron-builder.config.mjs`, released by `.github/workflows/desktop-release.yml` |
| `packaging/` | Templates for the Homebrew cask, winget and Flathub manifests, filled from a published release by `scripts/desktop-manifests.mjs` |
| `emails/` | `welcome.html` and `digest-sample.html`, used by the `newsletter:*` scripts |
| `resources/`, `build/` | Source images for mobile asset generation, and electron-builder's `buildResources` (`build/icon.png`) |
| `docker-compose.dev.yml` | Local infra only — Mongo 27017, Redis 6379. No app containers |
| `docker-compose.server.yml` / `.client.yml` | Production. One service each, named `server` and `client` — **the service names are load-bearing** (see `docs/deploy.md`) |
| `docker-compose.yml` | The legacy single-app layout. Kept for reference; don't build on it |
| `playwright.config.ts` | Chromium, `workers: 1`, high default ports (49761/49762), builds the static export instead of running `next dev` |
| `.github/workflows/` | `build-and-deploy.yml` plus three release workflows |

---

## Request lifecycle

From a click in the web app to a MongoDB write and back.

**1. Page → component → hook.** A route such as
`packages/client/src/app/app/track/page.tsx` is a thin `"use client"`
default export around components in `packages/client/src/components/tracker/`.
Those call `trpc.<router>.<procedure>.useQuery()` / `.useMutation()`.

**2. tRPC client.** `packages/client/src/lib/trpc.ts` — one `httpBatchLink` to
`` `${process.env.NEXT_PUBLIC_API_URL || ""}/api/trpc` ``, with
`credentials: "include"` and an `x-trackyourtime-client: web` header (that header is
what names the session in Settings → Devices). Mounted by
`packages/client/src/providers/trpc-provider.tsx`. `NEXT_PUBLIC_API_URL` is
inlined at build time — a static export cannot follow a moved origin. On the
phone apps it is only the default: `lib/api-origin.ts` holds the server chosen
on the login screen, and the link's `fetch` rebases each request onto it.

**3. Express middleware.** `packages/server/src/app.ts`, `createApp()`. **The
order is load-bearing** — the file documents each step in place; do not
rearrange it.

| # | Step | Why it is there |
|---|---|---|
| 0 | `cors()` over `getTrustedOrigins()`, `credentials: true`, `exposedHeaders: ["set-auth-token"]` | Before all routes so preflight works. The bearer plugin returns a non-cookie client's token on `set-auth-token`, which is unreadable cross-origin unless exposed |
| 1 | better-auth via `app.all("/api/auth/{*any}", toNodeHandler(getAuth()))` | **Before** `express.json()` — it parses its own body |
| 2 | *(Stripe webhook slot — empty)* | This project was scaffolded without Stripe. If it is added, it mounts here, pre-json, because signature verification needs the raw body |
| 3 | A scoped `express.json({ limit: IMPORT_BODY_LIMIT })` for `/api/trpc` paths containing `data.analyze` / `data.commit`, **then** global `express.json({ limit: "100kb" })` + `urlencoded` | Whichever json parser runs first consumes the body, so the import ceiling is mounted first and scoped — no other route relaxes its limit |
| 4 | `helmet()`, `morgan()` | |
| 5 | `createExpressMiddleware({ router: appRouter, createContext })` at `/api/trpc` | Double-cast: tRPC v11's adapter is typed against `@types/express` v4 while this runs Express 5 |
| 5b | `registerNewsletterRoutes(app)` | |
| 6 | `GET /api/health` → `{ status, db, webUrl, timestamp }` | `webUrl` is there so the extension needs only one configured URL |
| 7 | `notFoundHandler`, `errorHandler` | Must be last |

**4. Context.** `packages/server/src/trpc/context.ts` calls
`auth.api.getSession({ headers: fromNodeHeaders(req.headers) })`. By this point
better-auth's `bearer` plugin has already turned an `Authorization: Bearer
<session-token>` into the same session a cookie would produce, so cookie and
token clients converge on identical `session`/`user` shapes. `authMethod` is
kept for logging only. The session's `activeOrganizationId` is read into
`activeWorkspaceId`.

**5. Procedure.** `packages/server/src/trpc/trpc.ts` exposes three:
`publicProcedure`, `protectedProcedure` (throws `UNAUTHORIZED`), and
**`workspaceProcedure` — the one every domain router must use.** It calls
`resolveWorkspace()` in `packages/server/src/auth/workspace.ts` and sets
`ctx.workspaceId`, `ctx.membership`, `ctx.visibility`.

**6. Router.** `packages/server/src/trpc/router.ts` merges 14 routers from
`trpc/routers/`. Inputs are zod schemas imported from `@starter/shared`.

**7. Model.** `packages/server/src/models/*.ts`. Every query carries
`workspaceId`. Documents become wire shapes through the `toClient*` mapper
exported next to each model (`toClientTimeEntry`, `toClientProject`, …).

**8. Back.** The procedure returns the type from `packages/shared/src/types.ts`;
react-query caches it under the tRPC key.

Worked example — `packages/server/src/trpc/routers/tags.ts` `list`: one
`Tag.find({ workspaceId, … })` with an `en`/strength-2 collation matching the
unique index, run in parallel with `loadTagUsage()`, a single `TimeEntry`
aggregation that `$unwind`s `tagIds` rather than asking per tag.

---

## Realtime sync

**Where the socket is set up.** `packages/server/src/ws/handler.ts`.
`WebSocketServer({ noServer: true })` plus a hand-written `server.on("upgrade")`,
so path, origin and auth are all decided before a socket exists:

- the path must be `/ws` **or** `/api/ws` — both are accepted so clients built
  before the `/api` move still connect;
- in production, an `Origin` outside `getTrustedOrigins()` gets a written
  `403` and a log line naming the exact value to add (a silent `socket.destroy()`
  reaches a browser as an indistinguishable network failure);
- `authenticateUpgrade(req)` runs next, and no session means a written `401`;
- `handleProtocols` echoes any offered `bearer.*` subprotocol, because a browser
  closes a socket whose subprotocol is not echoed back.

**Upgrade auth.** `packages/server/src/ws/auth.ts` looks for a session token in
three places, in descending order of safety: `Authorization: Bearer` (native
clients), `Sec-WebSocket-Protocol: bearer.<token>` (the browser `WebSocket`
constructor cannot set headers but can set a subprotocol — the extension's
path), and `?token=` last, because a query string is where a token leaks into a
log or a referrer.

**Rooms and fan-out.** `ws/rooms.ts` holds an in-memory `RoomManager`. The room
name is `userRoomId(userId)` → `user:<id>`, defined in
`packages/shared/src/protocol.ts` and re-exported from `ws/sync.ts` so mutations
never hand-roll it. Topology is **one room per person**; the workspace fan-out is
resolved in code — `publishSync(workspaceId, event, originId)` loads the
`WorkspaceMember` documents and calls `publishToUser` for each, so a
per-recipient money-visibility projection has one testable home when it lands.
Both publishers swallow their own errors: realtime delivery is best-effort and
never fails the mutation.

**Client.** `packages/core/src/sync-client.ts` (`createSyncClient`, framework-free,
injectable `WebSocketImpl`, backoff, token carried as the `bearer.<token>`
subprotocol), with the URL derived by `packages/core/src/sync-url.ts`
(`resolveSyncUrl` → `wss://<origin>/api/ws`). Consumers:
`packages/client/src/hooks/use-sync.ts`, mounted once in
`components/app-shell.tsx`, and `packages/extension/src/background/runtime.ts`.

### What `originId` is for

`originId` is a **per-tab uuid** (`ORIGIN_ID = createId()` in `use-sync.ts`),
carried as an optional field on every mutating input (`originId` in
`packages/shared/src/schemas.ts`) and echoed back on the `tt:sync` envelope. The
originating client compares it and skips its own echo — its optimistic update
already landed, so invalidating would be a pointless refetch and a visible flicker.

An entry written in tab A reaching tab B:

1. A's mutation carries `input.originId`.
2. `trpc/routers/entries.ts` writes the `TimeEntry`, then
   `void publishSync(workspaceId, { kind: "entry.upserted", entry }, input.originId)`.
3. `ws/sync.ts` resolves the workspace's members →
   `roomManager.broadcast(userRoomId(id), { type: "tt:sync", event, originId })`.
4. B's `sync-client` hands it to `use-sync.ts` `onEvent`. If
   `originId === ORIGIN_ID`, return — own echo.
5. Otherwise `idleWatcher.noteRemoteActivity(Date.now())` fires (someone was at
   a keyboard *somewhere*, which is what stops an open laptop from pausing work
   done elsewhere), then `invalidateFor(utils, event)` invalidates the matching
   react-query caches.
6. react-query refetches over the HTTP path above and B renders the entry.

`invalidateFor`'s switch ends in `const unhandled: never = event`, so adding a
`SyncEvent` kind to `packages/shared/src/protocol.ts` without a matching case
**stops the build** instead of becoming a silent cross-device staleness bug.

Events are deliberately coarse in places: `data.imported` is one event for a
whole batch (thousands of `entry.upserted` events would make a client spend the
import re-rendering), and `invoice.changed` carries only an id, because an
invoice carries money and must never render from stale gossip.

---

## Auth

There is exactly **one credential**: a better-auth session. Everything else is
how that session travels.

| Client | How the session travels |
|---|---|
| Web app | Cookie. `packages/client/src/lib/auth-client.ts` |
| Desktop and phone apps, browser extension, Raycast, CLI | The same session token as `Authorization: Bearer <token>`, and as the `bearer.<token>` WebSocket subprotocol. The desktop app keeps it in `safeStorage`, the phones in the Keychain or Keystore |

The `bearer` plugin in `packages/server/src/auth/auth.ts` resolves the header
before `getSession()` runs, so by the time a request reaches `createContext` a
cookie client and a token client are indistinguishable — one auth path to reason
about, in both HTTP and the socket upgrade.

**Getting a token.** A client that can show a sign-in form uses
`signInWithPassword()`; one that cannot (Raycast, a CLI) uses the RFC 8628
**device flow** — `startDeviceAuthorization()` then `pollForDeviceSession()`,
with the user approving a short code at `/app/device` in an already-signed-in
browser. Both helpers live in `packages/core/src/session-auth.ts`; the server
side is the `deviceAuthorization` plugin, whose `validateClient` only accepts
client ids listed in `packages/server/src/auth/client-label.ts`
(`DEVICE_FLOW_CLIENT_IDS`). Tokens belong in real secret storage, never a config
file.

**`x-trackyourtime-client`** names a session in Settings → Devices, where any of
them can be revoked — killing the HTTP and WebSocket paths at once. It is
self-reported and **cosmetic**; `client-label.ts` says so at the top. Never
branch on it for authorization.

**`TRUSTED_ORIGINS`.** `getTrustedOrigins()` in
`packages/server/src/config/env.ts` returns `FRONTEND_URL` plus the
comma-separated `TRUSTED_ORIGINS` (plus the store clients' origins when
`TRUST_STORE_APPS=true`), adding localhost aliases outside production.
That one list feeds three things: the CORS middleware, better-auth's own
`trustedOrigins`, and the WebSocket origin check. A client that runs **in a
browser** must have its origin in it or sign-in answers `403 INVALID_ORIGIN`
before the password is even checked — better-auth force-validates `Origin`
whenever a request carries `Sec-Fetch-*` headers, which every real browser fetch
does and curl does not. Raycast and CLIs have no origin at all and are guarded
by the device flow and the client-id allowlist instead.

Workspaces are better-auth's `organization` plugin with `teams` deliberately
off. Every new user gets a personal workspace from the signup hook, and
`ensurePersonalWorkspace()` repairs the gap on first read if that hook ever
failed — which is what makes "every user has at least one workspace" an
invariant rather than an aspiration.

CLAUDE.md's *Clients without a cookie jar* section carries the longer account,
including the extension-id derivation.

---

## Data model

Eleven Mongoose models in `packages/server/src/models/`. Two axes.

**The hierarchy** — `Client.ts` → `Project.ts` → `Task.ts`. A client owns
projects, a project owns tasks (`Task.projectId` is required), and a
`TimeEntry` points at a project and optionally a task. An entry has **no client
field**: clients are shown everywhere and chosen nowhere, because a second
source of truth could disagree with the project's own client
(`packages/core/src/entry-fields.ts` explains this where the five settable
fields are declared).

**The orthogonal dimension** — `Tag.ts`. Entries carry `tagIds: string[]`, many
per entry, so "invoicing" or "deep work" can be reported across every project.
`reports.summary` with `groupBy: "tag"` gives an entry's *full* duration to each
of its tags, so those rows deliberately sum to more than the range total.

**Rate snapshotting.** `TimeEntry.hourlyRate` and `TimeEntry.currency` are
snapshots, not lookups, so past earnings never shift when a project's rate
changes later. The rule is `resolveHourlyRate()` in
`packages/shared/src/rates.ts` — project rate, else workspace default, and
`null` whenever the entry is not billable — applied by `snapshotRate()` in
`packages/server/src/services/entry-stop.ts`, which is shared between the
router's `stop` and the runaway guard so the two cannot diverge. Currency comes
from the **workspace's** settings, never the caller's.

**Workspace scoping.** Every domain document carries `workspaceId`, and
`workspaceProcedure` is the only sanctioned way to obtain one. Two rules in
`auth/workspace.ts` and `trpc/trpc.ts`:

- an explicit `workspaceId` on the input **wins** over the session's active
  organization, because a long-lived client (a Raycast menu bar open for three
  days) cannot be relied on to have re-read it;
- a workspace the caller is not a member of answers **`NOT_FOUND`, never
  `FORBIDDEN`** — the same rule applies to any id owned by someone else, because
  a `FORBIDDEN` confirms the thing exists.

Within a workspace, `visibilityOf()` / `authorScopeFilter()` in
`WorkspaceMember.ts` restrict a member without `canViewOthersTime` to their own
rows.

The rest: `TimeEntry.ts` (the big one — read its index comments before adding a
query), `Invoice.ts`, `ImportBatch.ts`, `Favorite.ts`, `Settings.ts`,
`Profile.ts`, `WorkspaceMember.ts`.

---

## Where do I add X

### A new tRPC procedure on an existing router

1. `packages/shared/src/schemas.ts` — add the zod input schema beside its
   siblings, export the inferred type, and include `originId` if it mutates.
2. `packages/shared/src/types.ts` — add or extend the wire return type if the
   shape is new.
3. `packages/server/src/trpc/routers/<domain>.ts` — build it on
   **`workspaceProcedure`** (from `../trpc.js`), scope every query with
   `ctx.workspaceId`, and throw `NOT_FOUND` for an id you do not own.
4. If it mutates, `void publishSync(ctx.workspaceId, event, input.originId)`
   from `../../ws/sync.js` before returning.
5. New event kind? Add it to `SyncEvent` in `packages/shared/src/protocol.ts`
   **and** a case to `invalidateFor` in `packages/client/src/hooks/use-sync.ts`
   — the `never` default fails the build until you do.
6. `trpc/router.ts` only changes if the *router* is new.
7. Call it as `trpc.<router>.<procedure>.useQuery/useMutation`. Types flow
   through the `@starter/server/trpc` type export; nothing is generated.
8. `pnpm run build` (shared/core must rebuild first) and `pnpm run typecheck`.

### A field that must reach every client

1. `packages/shared/src/types.ts` — add it to the wire type, with a comment
   saying what absent/`null` means on rows written before it existed.
2. `packages/shared/src/schemas.ts` — add it **optional** to the create/update
   schemas.
3. `packages/server/src/models/<Model>.ts` — add it to the `I<Model>` interface,
   to the `<Model>DocLike` structural type (as `field?: T | null` if older rows
   lack it), and to the schema. **Never `required: true`** — see the invariants
   below.
4. Same file: map it in `toClient<Model>()`, or it never reaches the wire no
   matter what the type says.
5. `packages/server/src/trpc/routers/<domain>.ts` — accept and persist it.
6. If every surface can set it: add it to `EntryFields` / `emptyEntryFields()`
   in `packages/core/src/entry-fields.ts` and to the offline payload types in
   `packages/core/src/offline-ops.ts` — **optional there**, so a row queued by
   an older build still decodes and replays.
7. Surface it per client: `packages/client/src/components/`,
   `packages/extension/src/popup/`, `packages/raycast/src/components/`.
8. Extend `packages/server/src/tests/time-entry-schema.test.ts` /
   `schemas.test.ts`, then `pnpm run build && pnpm run test:unit && pnpm run
   test:client && pnpm run typecheck`.

### A new page in the web client

1. Create `packages/client/src/app/app/<route>/page.tsx`: `"use client"`,
   a **default** export (Next requires it — everything else in the repo is
   named-exports-only), an explicit `React.JSX.Element` return type, and a
   `data-testid` on the root element.
2. Keep the page thin — a wrapper around components under
   `packages/client/src/components/<area>/`, the way `TrackPage` is just
   `<TrackerBar />` + `<EntryList />`.
3. Add it to `NAV_SECTIONS` in `packages/client/src/components/app-shell.tsx`
   (href, label, lucide icon). Child paths of `href` light the item on their
   own; `match` is only for extra prefixes that are not under `href`.
4. Auth needs nothing — `app/app/layout.tsx` already gates everything under `/app/` and
   re-confirms the session with the server before redirecting anyone.
5. Respect the static export (`next.config.ts`: `output: "export"`,
   `trailingSlash: true`): no server components with runtime data, no
   `middleware.ts`, no `rewrites()`, and `generateStaticParams` for dynamic
   routes. Because of `trailingSlash`, an E2E URL assertion must be a regex
   (`/\/route\/?$/`), not a plain string.
6. Colocate a Vitest test next to the *component*, not the page.

### A unit test

- **Server:** `packages/server/src/tests/<name>.test.ts`, `node:test` +
  `assert/strict`. Picked up automatically by
  `node --import tsx --test src/tests/*.test.ts`; run `pnpm run test:unit`.
  Keep it free of Mongo and Redis — that is why import parsing lives in
  `packages/server/src/services/import/` as pure functions.
- **Client:** colocate `<name>.test.ts(x)` beside the source under
  `packages/client/src` (see `src/lib/offline.test.ts`,
  `src/components/budget-meter.test.tsx`). Vitest + testing-library; run
  `pnpm run test:client`.

### An E2E test

1. Create `e2e/<name>.spec.ts` beside the existing specs. Import from
   `e2e/helpers.ts` — `signUpViaUI`, `signInViaUI`, `signOutViaUI`, and the
   `TRACK_URL` / `LOGIN_URL` regexes that exist because `trailingSlash` breaks
   exact string matching. DB helpers are in `e2e/db-utils.ts`.
2. Select **only** by `data-testid`. If the UI has none, add it in the same PR.
3. Before your first local run: `npx playwright install chromium` — nothing in
   the docs mentions it, and a fresh clone otherwise fails with a missing-browser
   error.
4. `pnpm run test:e2e`. It needs Docker (`e2e/start-server.sh` starts its own
   Mongo/Redis/S3) and builds the static export first, so the first run takes
   minutes.
5. If another checkout is running, pass your own `E2E_SERVER_PORT`,
   `E2E_CLIENT_PORT` and `MONGODB_URI` or you will be testing its build. See
   [CONTRIBUTING.md](CONTRIBUTING.md#tests-and-checks) for the full picture,
   including why E2E is not required from contributors.

---

## Conventions that will bite you

The style rules — strict TypeScript and no `any`, `const` over `let`, named
exports except Next.js pages, explicit return types on exported functions,
`@starter/shared` for anything crossing the boundary, `@/` inside the client,
`data-testid` for E2E selectors — are listed in
[CONTRIBUTING.md § Code style](CONTRIBUTING.md#code-style). They are load-bearing
for four clients sharing code, not taste.

Beyond those, four things that fail *quietly*:

1. **The Express middleware order in `app.ts` is load-bearing.** better-auth
   before `express.json()`; the import parser before the global one; the error
   handlers last. Read the comments in the file before rearranging anything.
2. **A string field with `default: ""` must never be `required: true`.**
   Mongoose's String `required` validator rejects `""`, so the pair makes every
   write that omits the field fail with "Path `x` is required" — and it fails at
   the *next save* of old documents, not at deploy. `TimeEntry.description` and
   `createdBy` on `Client`/`Project`/`Task`/`ImportBatch` all carry this comment.
   The same reasoning keeps `TimeEntry.tagIds` at `{ type: [String], default: [] }`
   with no `required`: entries written before tags existed have no such field.
3. **Deleting a tag `$pull`s it off every entry** — never `$set: []` and never
   `$unset`, either of which takes that entry's *other* tags with it. See
   `tags.remove` in `packages/server/src/trpc/routers/tags.ts`, where the
   `updateMany` deliberately runs *after* the delete so it also sweeps entries
   written during the check. A tag still on tracked time is archived, not
   deleted.
4. **Every import is a batch.** Entries carry `importId`, so undo is one indexed
   (partial) delete rather than a document that grows toward Mongo's 16MB
   ceiling; `ImportBatch` lists only the catalog rows the import created, and is
   marked `undoneAt` rather than deleted. Related: `TimeEntry.invoiceId` is the
   denormalized half of the double-billing guard — `Invoice.entryIds` is the
   source of truth, the two are written in the same code path, and you must
   never set one without the other.

---

## Further reading

- [README.md](README.md) — what the product does, the client surfaces,
  self-hosting, and an honest list of what is not built yet.
- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, the test/check commands and what a
  PR is expected to pass, code style, DCO sign-off.
- [`docs/deploy.md`](docs/deploy.md) — the production topology: two Coolify apps
  on one domain, why the API lives under `/api`, the load-bearing compose service
  names, and everything that must agree on the API origin. Nothing about
  deployment is repeated here.
- [`docs/dev-setup.md`](docs/dev-setup.md) — a Tailscale + Caddy guide for
  serving dev over a real hostname. It is not general local setup and its
  commands need a CLI that is not installable from this repo; README's
  Development section is the one to follow.
- [CLAUDE.md](CLAUDE.md) — invariants not repeated here: tags, import/export,
  the Raycast conventions, the dev-port rationale. See
  [CONTRIBUTING.md](CONTRIBUTING.md#repository-layout) for what it is and the
  caveats that come with reading it.
- `docs-site/` — the user-facing docs at
  [trackyourtime.dev/docs](https://trackyourtime.dev/docs/): self-hosting, the
  MCP server and the REST API. It does not describe the code; this document
  does. (Described in the repository map above and in
  [README.md](README.md#project).)
