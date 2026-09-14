# Contributing to Track Your Time

Thanks for taking the time to look at this. Track Your Time is time tracking with
clients, projects, tasks, tags and billable rates — a web app plus a browser
extension and a Raycast extension that share one backend.

Contributions are welcome in three shapes:

- **Bug reports.** Open an issue with the
  [bug report form](.github/ISSUE_TEMPLATE/bug_report.yml). Reproduction steps
  and which client surface you saw it on (web, extension, Raycast, server) are
  what make a report actionable.
- **Features.** Open a
  [feature request](.github/ISSUE_TEMPLATE/feature_request.yml) *before* writing
  code for anything non-trivial. This is a small project with an opinionated
  scope, and it is better to hear "out of scope" in an issue than in a pull
  request you already wrote.
- **Documentation.** Corrections to the README, this file, `docs/`, or
  `docs-site/` are welcome without a preceding issue.

Everyone participating is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

---

## Your first contribution

### Finding something to work on

Three places, in the order worth trying them:

1. **[ROADMAP.md](ROADMAP.md).** It splits the known gaps into *Next*
   (the code is already shaped for it, the work is defined), *Later* (larger,
   or genuinely undecided) and *Not planned* (out of scope, and why). Each item
   says what already exists and what would have to be built, so you can judge
   the size before you start. Items under **Next** are the closest thing this
   project has to a good-first-issue list.
2. **The open issues.** Anything already filed is, by definition, something
   somebody wanted.
3. **The README's [Not there yet](README.md#not-there-yet) section.** It is an
   honest list of what does not exist. Read it together with the roadmap: not
   everything missing is wanted, and the roadmap is where that distinction is
   recorded.

If none of that fits, the most valuable contributions to a project this size
are often the unglamorous ones — a documentation statement that turned out to
be wrong, a missing `data-testid` that made a spec brittle, a test for a rule
that only has one.

### Open an issue before large work

For a bug fix or a documentation correction, go straight to a pull request.

For anything bigger, **open an issue first** — a
[feature request](.github/ISSUE_TEMPLATE/feature_request.yml) is the right
form. This is a single-maintainer project with an opinionated scope
(see [GOVERNANCE.md](GOVERNANCE.md)), and the cost of hearing "out of scope"
in an issue is a few minutes; the cost of hearing it on a finished pull
request is your evening. It also stops two people building the same thing.
GitHub Discussions are not enabled on this repository, so open-ended
questions go in the issue tracker too — there is a
[question form](.github/ISSUE_TEMPLATE/question.yml) for them.

### What a good first pull request looks like here

- **One concern.** A refactor bundled with a behaviour change is hard to
  review and hard to revert. Split them.
- **The checks pass locally** — `pnpm run typecheck`, `pnpm run build`,
  `pnpm run test:unit`, `pnpm run test:client`. Those four are what CI's
  `verify` job runs. CI also runs `e2e` and `dco` on your pull request, which
  you are not expected to run locally — see
  [Tests and checks](#tests-and-checks), including why an E2E failure may not
  be yours.
- **A test when there is a rule to pin.** Pure logic lives in
  `packages/shared` and `packages/server/src/services/` precisely so it can be
  unit-tested without a database — if your change is a rule, it can almost
  certainly be tested cheaply.
- **Shared behaviour in the shared packages.** If more than one client needs
  it, it belongs in `packages/shared` or `packages/core`, not in the web app
  with a copy pasted into the extension later.
- **Documentation corrected in the same pull request** if your change makes an
  existing statement false.
- **Commits signed off** — `git commit -s`. CI checks every one of them.

A first pull request that touches one file, fixes one thing and explains why
is more welcome than a large one that arrives unannounced.

### Getting oriented in the code

[ARCHITECTURE.md](ARCHITECTURE.md) is the map: what each package is for, what
a request does from a React hook to MongoDB and back, and how a change made on
one device reaches another over the WebSocket. Read it before the first change
that spans more than one package — the boundary between `packages/shared` and
`packages/core` in particular is a rule rather than a habit, and it is the
thing that keeps four clients able to share code.

---

## Development setup

### Prerequisites

| Requirement | Version | Where it is pinned |
|---|---|---|
| Node.js | 24 | `.nvmrc`; `engines.node` in `package.json` is `>=24` |
| pnpm | 11.1.2 | `packageManager` in `package.json` |
| Docker | any recent | runs MongoDB and Redis for local dev |

If you would rather not install those locally,
[`.devcontainer/devcontainer.json`](.devcontainer/devcontainer.json) describes
a ready-made environment — open the repository in a devcontainer-aware editor
or in GitHub Codespaces and you get Node, pnpm and the tooling already set up.
The web app, the unit tests and the typecheck all work there. Be aware that the
browser extension, Raycast and any native build bake their API URL in and
cannot follow a forwarded or remapped port, so those surfaces are still easiest
to work on locally. The rest of this section assumes a local setup.

Enable pnpm through corepack rather than installing it globally, so the pinned
version in `packageManager` is the one you get:

```bash
corepack enable
nvm install && nvm use     # or your Node version manager of choice
```

### First run

```bash
git clone https://github.com/trebeljahr/trackyourtime.git
cd trackyourtime
pnpm install
```

The server reads `packages/server/.env.development`, which is **not** in the
repository — only `.env.example` is. Copy it:

```bash
cp packages/server/.env.example packages/server/.env.development
```

Then set `BETTER_AUTH_SECRET` in that file to any random string of 32+
characters. `packages/server/src/config/env.ts` only throws on missing required
values when `NODE_ENV=production`, so in development an empty signing secret
fails later and less clearly — set it now.

You can leave `FRONTEND_URL`, `BETTER_AUTH_URL`, `MONGODB_URI`, `PORT` and
`TRUSTED_ORIGINS` alone: `scripts/dev.mjs` passes all five to the server as real
process environment, which takes precedence over the file.

### Start the services and the app

```bash
pnpm run dev:infra    # docker compose -f docker-compose.dev.yml up -d
                      # mongo:7 on 27017, redis:7-alpine on 6379
pnpm run dev          # client 3392, API 5159
```

Open <http://localhost:3392>.

Variants of the dev command, all in `scripts/dev.mjs`:

| Command | Ports |
|---|---|
| `pnpm run dev` | pinned: client 3392, API 5159 — falls back to a random port if one is busy |
| `pnpm run dev:auto` | every port auto-picked in 49152–65535; use this for a second instance |
| `pnpm run dev:fixed` | the pinned ports or exit — never a fallback |
| `pnpm run dev:docs` | as above, plus the Docusaurus site on 4000 |
| `node scripts/dev.mjs --dry-run` | prints the resolved ports and starts nothing |

One gotcha worth knowing up front: **inside a git worktree, `pnpm run dev`
behaves like `dev:auto`** so several checkouts can run side by side. Anything
with a baked-in API URL — the browser extension, the Raycast preference
defaults — will not find the server there. Use `pnpm run dev:fixed` in a
worktree when that matters.

Stop the containers with `pnpm run dev:infra:stop`, or wipe their volumes with
`pnpm run dev:infra:reset`.

---

## Repository layout

```
packages/
  server/      Express 5 + tRPC + better-auth + Mongoose + ws
    src/config/      environment and app config
    src/models/      Mongoose schemas
    src/auth/        better-auth instance, workspace resolution
    src/trpc/        router, context, procedures
      routers/       one router per domain
    src/ws/          WebSocket handler, rooms, sync fan-out
    src/services/    imports, PDF, CSV, newsletter, storage
    src/tests/       node:test unit tests
  client/      Next.js App Router (static export) + Tailwind + shadcn/ui
    src/app/         routes
    src/components/  React components (ui/ is shadcn)
    src/hooks/       custom hooks
    src/lib/         tRPC client, auth client, utilities
  shared/      types, zod schemas, WS protocol, and pure domain logic
               (durations, timezones, timesheet rules, budgets, imports)
  core/        client-agnostic runtime shared by web, extension and Raycast
               (api client, device-flow auth, offline queue, idle, sync)
  extension/   Chrome MV3 browser extension (popup only)
  raycast/     Raycast extension — menu bar timer, commands, catalog CRUD

e2e/           Playwright specs and their harness
docs/          deploy.md, dev-setup.md
docs-site/     Docusaurus site, served at trackyourtime.dev/docs/
scripts/       dev orchestration, extension id, icon and newsletter scripts
electron/      Electron main + preload for the desktop wrapper
```

Domain logic that more than one client needs belongs in `packages/shared` (types
and pure rules) or `packages/core` (runtime behaviour). Only UI belongs in the
extension and Raycast packages.

That is the layout. For what the pieces actually *do* — the request lifecycle,
the workspace-scoping rule that every domain query goes through, and the
WebSocket sync path — see [ARCHITECTURE.md](ARCHITECTURE.md).

[`CLAUDE.md`](CLAUDE.md) at the repository root is worth knowing about but is
not contributor documentation: it is instructions written for AI coding agents
working in this repository, so expect agent workflow, provisioning commands for
a private CLI and deployment details mixed in with the architecture. It is
nonetheless the fullest and most current record of the invariants that fail
quietly if broken, so read it for the deep detail once ARCHITECTURE.md has
given you the shape.

---

## Tests and checks

| Command | What it covers |
|---|---|
| `pnpm run test:unit` | Server unit tests — `node:test` over `packages/server/src/tests/*.test.ts`. Pure logic: budgets, CSV, PDF, import parsing, invoicing guards, timesheet rules, runaway timers, workspace scoping, schemas. No MongoDB, Redis or Docker needed. |
| `pnpm run test:client` | Client unit tests — Vitest + `@testing-library/react` over colocated `*.test.ts(x)` files under `packages/client/src`. jsdom; no services needed. |
| `pnpm run test:e2e` | Playwright, chromium, serial. Specs in `e2e/`. **Needs Docker** — `e2e/start-server.sh` starts its own Mongo and Redis containers on separate ports, and the suite runs against the client's static export, so the first run includes a full build. |
| `pnpm run build` | Full production build in dependency order: shared → core → server → client. |
| `pnpm run typecheck` | Builds shared + core (they resolve through `package.json` exports to `dist/`), then `tsc --noEmit` across every other package, plus the Electron main process. |
| `pnpm --filter @starter/client run lint` | ESLint over the client package. There is no root `lint` script. |
| `pnpm test` | All three test commands in sequence. |

**A pull request should pass `pnpm run typecheck`, `pnpm run build`,
`pnpm run test:unit` and `pnpm run test:client`** — those four, in that order,
are exactly what CI's `verify` job runs. Two more jobs run on your pull request
that you do not run locally: `e2e` (below) and `dco`, which checks that every
commit carries a `Signed-off-by` trailer. Do not skip the typecheck
because the build passes: `pnpm run build` compiles shared → core → server →
client and never touches `packages/extension`, `packages/raycast` or
`electron/`, so a change that breaks one of those is invisible to the build.

E2E is the awkward one. CI does run it on pull requests, but you are not
expected to run it locally: it needs Docker, it takes minutes because of the
client build, and its ports and database are not isolated by default — if you
run it while another checkout is running, pass your own `E2E_SERVER_PORT`,
`E2E_CLIENT_PORT` and `MONGODB_URI` or you will be testing the other checkout's
build. The suite also needs its browser downloaded once, which no other command
does for you:

```bash
npx playwright install chromium    # once per machine, before the first run
pnpm run test:e2e
```

Note that CI's E2E job is not currently green on `main` either; see
[PR process](#pull-request-process) for what that means for your pull request.

---

## Code style

These are the rules the existing code follows. They are not negotiable style
preferences so much as the things that keep the four clients able to share code.

- **TypeScript strict mode everywhere.** No `any` — take `unknown` and narrow it.
- **`const` over `let`.** Never `var`.
- **Named exports only**, except Next.js pages, which require a default export.
- **Explicit return types on all exported functions.**
- **`@starter/shared` for types that cross the client/server boundary.** A type
  defined twice drifts.
- **`@/` path alias** for client-side imports within `packages/client`.

Two things that fail quietly if you get them wrong:

- **The Express middleware order in `packages/server/src/app.ts` is
  load-bearing. Do not rearrange it.** better-auth must be mounted before
  `express.json()` because it parses its own body; the Stripe webhook slot needs
  the raw body for signature verification; the error handlers must be last. The
  file documents the order — read the comments before touching it.
- **E2E selectors use `data-testid` attributes**, not CSS classes or visible
  text. If you add UI that a spec needs to reach, add the test id.

Testing conventions by package: `node:test` + `assert/strict` for the server
(`packages/server/src/tests/*.test.ts`), Vitest + testing-library colocated
alongside the component for the client, Playwright in `e2e/*.spec.ts` with
helpers in `e2e/helpers.ts`.

### Editor setup

[`.editorconfig`](.editorconfig) at the repository root carries the whitespace
conventions — indentation, line endings, final newlines. Most editors honour it
natively; some need a plugin. Install it if yours does, because there is no
repository-wide formatter to clean up after you: `packages/client` is the only
package with an ESLint config, and there is no Prettier anywhere in the tree.
Whitespace-only churn in a diff makes review harder for everyone, so match the
file you are editing.

---

## Translations

The interface ships in English and German. The full design, and what breaks
quietly if it is changed, is in [CLAUDE.md](CLAUDE.md) → "Internationalisation
(i18n)". What a contributor needs:

- **Text goes in a catalog, never in JSX.** `const t = useT("<namespace>")`
  from `@/i18n/use-t`, then `t("group.key")`. Add the key to
  `packages/client/src/i18n/messages/en/<namespace>.ts` first, then the same key
  to `messages/de/<namespace>.ts` — `pnpm run typecheck` fails until both match.
- **Numbers, money, dates and durations** come from `useFormat()` /
  `useFormatSettings()`, never from `toLocaleString()` or string concatenation.
- **Plurals use ICU**, even where English and German agree:
  `{count, plural, one {# entry} other {# entries}}`.
- **German follows the glossary** in
  [`packages/client/src/i18n/GLOSSARY.de.md`](packages/client/src/i18n/GLOSSARY.de.md):
  informal „du“, one German word per concept.
- **Check your layout in the pseudo-locale:** open any page with
  `?locale=pseudo` in a development build (`?locale=off` to leave). Text that is
  not accented was not extracted; text that clips will clip in German too.

### Adding a language

1. Add the code to `SUPPORTED_LOCALES` in `packages/shared/src/locale.ts`. The
   zod schemas, the Mongoose enums and the Settings preference all derive from
   it.
2. Copy every file in `packages/client/src/i18n/messages/de/` to
   `messages/<code>/`, translate, and add the namespace objects to
   `messages/index.ts` (typed `Translation<Messages>`, like `de`).
3. Return the new catalog from `getMessages` in `i18n/translator.ts`, and add
   the language to the Settings picker (`components/settings/language-picker.tsx`,
   with its name written in its own language) and to `settings.language` in
   every catalog.
4. Teach `LOCALE_SCRIPT` in `packages/client/src/app/pre-paint.ts` the new code
   — its supported list is inlined — and extend `pre-paint.test.ts`.
5. Public pages: add `app/<code>/**/page.tsx` re-exports mirroring `app/de/`,
   an `OG_LOCALE` entry in `i18n/marketing.ts`, and the `<code>/` prefix to the
   path check in `LOCALE_SCRIPT` and `locale-store.ts`.
6. Server and extension: add `messages/<code>/` beside the German ones in
   `packages/server/src/i18n/` and `packages/extension/src/i18n/`, plus
   `packages/extension/public/_locales/<code>/messages.json`.
7. Write a glossary, `GLOSSARY.<code>.md`, before translating — term choices
   made string by string drift.
8. Run `pnpm run typecheck`, `pnpm run test:client` (the parity test compares
   ICU placeholders across every locale) and `pnpm run test:unit`.

**Never localise:** CSV export headers and values, the importer, REST and tRPC
error codes and `problem+json` types, webhook payloads, the OpenAPI document,
log lines, and the Raycast extension (the Raycast Store accepts US English
only). These are read by machines or by people who match exact strings.

---

## Commit messages and branches

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: import history from a file
fix: keep tag ids when an offline start replays
refactor: move duration formatting into shared
test: cover the midnight-crossing timesheet cell
docs: document the device flow for tokenless clients
chore: bump playwright
```

- Prefixes in use: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.
- Keep the first line under 72 characters.
- Blank line before any body text. Use the body for *why*, not *what* — the
  diff already says what.

Branch names: `feat/short-description`, `fix/short-description`,
`refactor/short-description`.

---

## Developer Certificate of Origin (DCO)

**This project uses the DCO, not a CLA.** You keep the copyright in everything
you contribute. There is no agreement assigning your work to anyone, and no
form to sign. What the DCO asks is a statement, attached to each commit, that
you have the right to submit the code under the project's licence — see
[LICENSE](LICENSE) — and that you are happy for it to be distributed under that
licence.

The statement is the full text of
[Developer Certificate of Origin 1.1](https://developercertificate.org/), and
you make it by adding a `Signed-off-by` trailer to the commit message:

```
Signed-off-by: Jane Doe <jane@example.com>
```

The name and email must match the commit author. Git will add the trailer from
your configured `user.name` and `user.email` when you pass `-s`:

```bash
git commit -s -m "fix: keep tag ids when an offline start replays"
```

Set those once if you have not:

```bash
git config user.name "Jane Doe"
git config user.email "jane@example.com"
```

### Fixing commits you already made

Forgot the sign-off on your last commit:

```bash
git commit --amend -s --no-edit
```

Forgot it across a whole branch:

```bash
git rebase --signoff main
```

Both rewrite history, so force-push the branch afterwards
(`git push --force-with-lease`). If your pull request is already open, that is
fine — the DCO check re-runs on the updated commits.

CI verifies that every non-merge commit in a pull request carries a
`Signed-off-by` trailer. A trailer under a different identity than the commit
author (a work address, GitHub's noreply form) is accepted — the log notes it,
the job does not fail. A missing trailer does fail the job, and the pull request
will not merge until it is fixed.

---

## Pull request process

1. **Fork the repository** and branch off `main` using the naming above.
2. **Keep the pull request focused.** One concern per PR. A refactor bundled
   with a behaviour change is much harder to review, and much harder to revert
   if it turns out to be wrong. Split them.
3. **Discuss features in an issue first.** Bug fixes and doc corrections can go
   straight to a PR. See [Your first contribution](#your-first-contribution).
4. **Run the checks locally** — `pnpm run typecheck`, `pnpm run build`,
   `pnpm run test:unit`, `pnpm run test:client`. These are the same four CI
   runs on your pull request.
5. **Update the docs when behaviour changes.** If your change makes a statement
   in `README.md`, [ARCHITECTURE.md](ARCHITECTURE.md) or `CLAUDE.md` wrong, fix
   that statement in the same PR. `CLAUDE.md` is instructions for AI coding
   agents rather than contributor documentation, but it is the most accurate
   running description of how the system actually works, and it is kept
   current — so it counts.
6. **Sign off your commits** (see above).
7. **Fill in the pull request template** — what changed, why, how you tested it.

### What CI runs

Everything is in one workflow file,
[`.github/workflows/build-and-deploy.yml`](.github/workflows/build-and-deploy.yml),
which runs on pushes to `main` and on pull requests. A pull request gets the
checks and none of the publishing.

**On a pull request**, three jobs run:

| Job | What it does |
|---|---|
| `verify` | `pnpm install --frozen-lockfile`, then `pnpm run typecheck`, `pnpm run build`, `pnpm run test:unit`, `pnpm run test:client`. |
| `e2e` | Playwright, after `verify` passes. Mongo and Redis as service containers, then the full suite against the client's static export. This is the slow one. |
| `dco` | Checks that every non-merge commit in the pull request carries a `Signed-off-by` trailer. |

Every credential those jobs need is a throwaway literal in the workflow file
itself — none of them reads a repository secret — so they work unchanged from a
fork, and each pins `permissions: contents: read` so pull request code never
runs with a token that can publish anything.

**On a push to `main`**, `verify` and `e2e` run the same way, and then three
more jobs follow that a pull request can never reach: `build-server` and
`build-client` publish the two Docker images to `ghcr.io`, and `deploy` calls
the Coolify deploy API. Each of those three is gated on
`if: github.event_name == 'push'` in its own right, not merely through the
`needs:` chain — so a green pull request cannot push an image or trigger a
deploy no matter what.

Two honest caveats about the state of CI, so nothing surprises you:

- **The E2E job is not currently passing on `main`.** If your pull request is
  otherwise sound, an E2E failure that also reproduces on `main` is not yours
  to fix — say so in the pull request and it will be sorted out separately.
  Check the workflow's recent runs on `main` before assuming a failure is
  something you caused.
- **The Docker image build and deploy jobs are gated behind E2E and have
  therefore never actually run**, which is why the README calls the deploy path
  unverified. Nothing you do in a pull request can reach them either way.

---

## Security

Please do not open a public issue for a security problem. Email it to
<ricotrebeljahr@gmail.com> — GitHub private advisories are not enabled on this
repository, so email is the reporting channel. [SECURITY.md](SECURITY.md) has
the full policy, including what to put in a report and the expected timelines.

## Questions

Open a [question issue](https://github.com/trebeljahr/trackyourtime/issues/new?template=question.yml)
— GitHub Discussions are not enabled on this repository, so the issue tracker
is where questions go — or email <ricotrebeljahr@gmail.com>.
[SUPPORT.md](SUPPORT.md) says which to use and what to expect. The hosted app is at <https://trackyourtime.dev>, with the
API on its own host at <https://api.trackyourtime.dev>.

## Who decides

One maintainer, Rico Trebeljahr ([@trebeljahr](https://github.com/trebeljahr)),
has final say on scope, design and what merges.
[GOVERNANCE.md](GOVERNANCE.md) sets out how decisions get made, how a
disagreement ends, what gets a pull request merged, and why a declined change
is usually about maintenance cost rather than about your work.
