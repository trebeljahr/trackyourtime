# Deploying Track Your Time

Two Coolify apps on **two hosts of one zone**:

| Coolify app | Routed at | Compose file | Serves |
|---|---|---|---|
| `trackyourtime-client` | `https://trackyourtime.dev` | `docker-compose.client.yml` | the Next web app |
| `trackyourtime-server` | `https://api.trackyourtime.dev` | `docker-compose.server.yml` | the Express API, tRPC and the `/api/ws` socket |

## Why a new domain — the history, because both halves still matter

This deployment has been through two failed shapes. Neither reason has gone
away; the new domain just stops both from applying at once.

### 1. `api.tracktime.trebeljahr.com` could not get a certificate

Cloudflare's Universal SSL certificate for the `trebeljahr.com` zone covers
`trebeljahr.com` and `*.trebeljahr.com` — **one** label.
`api.tracktime.trebeljahr.com` is two, so TLS failed before any HTTP happened:

```
$ curl https://api.tracktime.trebeljahr.com/api/health
curl: (35) error:1404B410:SSL routines:ST_CONNECT:sslv3 alert handshake failure
```

`api.playtiao.com` is one label under `playtiao.com`, which is why the sibling
deployment never hit this and why copying its shape under `trebeljahr.com` did
not work. **This constraint is still true** — anything moved back under
`trebeljahr.com` hits it again. The paid alternatives were Advanced
Certificate Manager, or turning the proxy off on that record so Coolify issues
its own certificate (which exposes the origin IP).

### 2. So the API went on a path — and this Coolify instance runs Caddy

The fix was to serve the API at `https://tracktime.trebeljahr.com/api`, one
domain, one certificate, browser client same-origin. That is unworkable here,
and the reason is the proxy.

This Coolify instance proxies with **caddy-docker-proxy**, not Traefik.
Confirmed at the origin: an unknown `Host` answers `503 no available server`
with an `alt-svc: h3` header, which is Caddy. Coolify writes `traefik.*`
labels onto every app regardless, and they are inert here. What actually routes
is:

```
client: caddy_0=https://tracktime.trebeljahr.com   caddy_0.handle_path=/*
server: caddy_0=https://tracktime.trebeljahr.com   caddy_0.handle_path=/api*
```

Two problems, either one fatal:

- Both containers write the **same label key for the same site**.
  caddy-docker-proxy merges them, and `/*` wins — so
  `https://tracktime.trebeljahr.com/api/health` was answered by the client's
  404 page. There is no "more specific rule first" here; that is Traefik
  behaviour, and Traefik is not what is running.
- `handle_path` **strips** its prefix. Even ordered correctly, the server —
  which mounts its routes *at* `/api` and expects `/api/trpc` — would have
  received `/trpc`, and answered 404 to everything.

### 3. A fresh apex zone: `trackyourtime.dev`

On a new apex, the API gets a **single-label** host that a wildcard covers, and
each app gets `handle_path=/*` on a site of its own. No certificate problem, no
label collision, no prefix strip, no path routing at all.

The cost is that the API is a **separate origin** from the web app again. That
is the thing most likely to be broken by a later "simplification":
`FRONTEND_URL` and `TRUSTED_ORIGINS` on the server are what make cross-origin
sign-in work, and every browser call is now preflighted. They are load-bearing.
(The two hosts share a registrable domain, so the session cookie is still
*same-site* — `SameSite=Lax` survives the move. Cross-**origin**, not
cross-site.)

## Why still two apps

Coolify's unit of deployment is the app. Two apps means the client and the
server restart independently, which matters because the server holds the
WebSocket sync connections — under a single app, every client-side deploy
would drop every connected device's socket for a change that never touched
the server. One zone, two hosts, two apps, two deploy triggers.

The app names are the ones `hatchkit sync` looks for (`<name>-client` /
`<name>-server`). The service names *inside* each compose file are equally
load-bearing: Coolify keys `docker_compose_domains` by service name, and a key
that doesn't match a service makes Coolify accept the PATCH, emit no proxy
labels, and serve 503. (Coolify writes `traefik.*` labels too, but this
instance routes on the `caddy_*` ones — either way the key is the service
name.)

## Everything the server owns is still mounted under `/api`

The dedicated `api.` host did **not** move the mount. The server still serves
`/api/trpc`, `/api/auth` and `/api/ws`, so the real endpoints are
`https://api.trackyourtime.dev/api/trpc` and
`wss://api.trackyourtime.dev/api/ws`. The doubled-looking segment is
deliberate: `NEXT_PUBLIC_API_URL` is an **origin** with no path, and the
clients append the `/api/...` themselves.

Keeping the mount was the cheap correct choice. Stripping it to get
`api.trackyourtime.dev/trpc` would mean changes in the server's route mounting,
`packages/core` (`sync-url.ts`, `api-client.ts`), the extension and Raycast —
and every client already deployed against the old paths would break on a
mismatch. The wart is cosmetic; the change is not.

One prefix also means one routing rule. The socket included — `resolveSyncUrl`
(`packages/core/src/sync-url.ts`) derives `/api/ws`, not `/ws`, so there is no
second path to remember at the proxy. A rule nobody remembers to add is a
client that reconnects forever while every HTTP request succeeds.

`packages/server/src/ws/handler.ts` accepts `/ws` as well, so a client built
before this change still connects wherever `/ws` is still routed.

## One-time setup in Coolify

1. **Databases.** `trackyourtime-mongo` already exists as a Coolify database.
   Add a Redis one if you want it; the server treats `REDIS_URL` as optional
   and logs "skipping Redis connection" when it is unset.
2. **Two applications**, both from this repo, build pack `dockercompose`:
   - `trackyourtime-server` → compose path `docker-compose.server.yml`,
     domain `https://api.trackyourtime.dev`
   - `trackyourtime-client` → compose path `docker-compose.client.yml`,
     domain `https://trackyourtime.dev`

   **Give each a bare host and no path.** A path in the domain field is what
   produced `handle_path=/api*`, and `handle_path` strips its prefix — the
   server expects to receive `/api/trpc`, not `/trpc`. With one host per app
   the generated rule is `handle_path=/*` on each, which strips nothing.

   Two apps must never carry the same host, either: caddy-docker-proxy merges
   same-site labels and one of them silently swallows the other's traffic.
3. **Env on the server app — all of it, in Coolify's env fields.**

   `packages/server/.env.production` is NOT tracked in git here (a global
   gitignore rule for `.env.production` excludes it), and
   `packages/server/Dockerfile`'s runtime stage copies only `dist`,
   `package.json` and `node_modules` — so the encrypted file never reaches
   the image either way, and `DOTENV_PRIVATE_KEY_PRODUCTION` on its own
   decrypts nothing.

   The compose files therefore take every value as a `${VAR}` substitution,
   which Coolify fills from its own env fields. Set at minimum:
   `MONGODB_URI`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `FRONTEND_URL`,
   `TRUSTED_ORIGINS`.

   These are now **different** values, which they were not under the
   one-domain layout:

   - `BETTER_AUTH_URL=https://api.trackyourtime.dev` — better-auth's own
     origin, where it mounts `/api/auth` and signs cookies for.
   - `FRONTEND_URL=https://trackyourtime.dev` — the web app, and the CORS
     allow-list entry. The browser client is cross-origin again, so this is
     what makes its calls pass preflight at all.
   - `TRUSTED_ORIGINS` — plus the extension's `chrome-extension://<id>`, or
     `TRUST_STORE_APPS=true`. The extension has no host permissions, so
     every request it makes is a CORS request. Without this entry the store
     extension cannot sign in, sync or send a single entry.

   `.env.production` is a local convenience only — it is what
   `NODE_ENV=production pnpm --filter @starter/server start` reads — and it is
   untracked here, so Coolify's env fields are the real source of truth.
4. **DNS**: two records on the `trackyourtime.dev` zone — the apex `@` and
   `api`, both proxied. The old `tracktime` record on `trebeljahr.com` (and
   any leftover `api.tracktime`) can go once the move is verified; nothing in
   the app points at them any more. `assets.tracktime.trebeljahr.com` was the
   custom domain of the unused R2 bucket `tracktime-assets`; it goes when that
   bucket is deleted.
5. **GitHub secrets** so CI can trigger both deploys:
   `COOLIFY_SERVER_RESOURCE_UUID` and `COOLIFY_CLIENT_RESOURCE_UUID`
   (alongside the existing `COOLIFY_BASE_URL` and `COOLIFY_API_TOKEN`). With
   neither set, the workflow falls back to the single `COOLIFY_RESOURCE_UUID`.
   All four are already set on this repo.

   The token needs the `deploy` and `write` permissions (to queue a deploy
   and to PATCH an env var) **and `read:sensitive`**: Coolify leaves `value`
   out of `GET /applications/<uuid>/envs` without it, and that value is what
   a failed deploy is rolled back to. Without it every deploy still runs,
   and every failed one ends with "nothing was rolled back" (see
   [Rollback](#rollback)).
6. **Two env vars, created once by hand**: `SERVER_IMAGE` on the server app
   and `CLIENT_IMAGE` on the client app, with any value (the compose file's
   `:main` default will do).
   The compose files read them, and the deploy job pins each to the image
   of the commit it just built. Coolify's env API only updates a variable
   that exists — a PATCH against a missing name is accepted and does
   nothing — so the job reads each one back after pinning and fails when it
   did not stick.

## Verifying a deploy

```bash
curl -sS https://api.trackyourtime.dev/api/health   # the server app
curl -sSI https://trackyourtime.dev/                # the client app
```

The first covers the whole server chain: the certificate on the `api.` host,
the route reaching the container with `/api` unstripped, and the server being
up.

Reading the failures:

- **404 from the API host** while the site works — the prefix was stripped.
  Check that the server app's Coolify domain is the bare host with no `/api`
  path on it.
- **The client's own 404 page from the API host** — the two apps are claiming
  the same Caddy site. Check that they carry different domains.
- **503 `no available server`** — Coolify emitted no usable proxy labels.
  Check the service names (`client` / `server`) against the compose files.
- **TLS handshake failure** — the host is more than one label under its zone
  and the wildcard does not cover it. That is the original bug; do not
  re-create it.

## Rollback

Every push to main deploys through `scripts/coolify-deploy.mjs`, run by the
`deploy` job of `.github/workflows/build-and-deploy.yml`. The pure parts
(what counts as healthy, what can be rolled back, the sequence) are in
`scripts/lib/coolify-deploy.mjs` and tested in
`scripts/lib/coolify-deploy.test.mjs` against a fake Coolify; the entry
script adds the network and git.

What one deploy does, in order:

1. **Reads the rollback target.** `GET /applications/<uuid>/envs` on both
   apps, and keeps the current `SERVER_IMAGE` and `CLIENT_IMAGE` values.
   Only a value pinned to a full commit sha counts: `:main` already points at
   the new build after the push, so "restoring" it would redeploy the image
   that just failed.
2. **Pins and deploys.** PATCHes both variables to
   `ghcr.io/trebeljahr/trackyourtime-{server,client}:<sha>`, reads them back,
   then queues a deploy of the server, then the client.
3. **Waits for the commit.** Polls `/api/health` (`commit`, or `version` on
   an older image) and `/version.json` (`commit`) every 15 s for up to ten
   minutes until both report the new sha. A Coolify deploy is queued, not
   done, when the API answers.
4. **Runs the gate.** `/api/health` says `status: ok` and `db: true`;
   `/version.json` names the API the client was built against
   (`apiUrl`, which is baked in at image build time); `GET
   /api/auth/get-session` answers 200, which proves the auth handler is
   mounted and reads its database; and the CORS preflight from the web origin
   is allowed, since the two apps are separate origins and nothing else in CI
   exercises that pairing. The gate is retried a few times, ten seconds
   apart, for a database still connecting — and no more.
5. **Rolls back when 3 or 4 fails.** The values from step 1 are pinned
   again, both apps are redeployed, and the same poll and gate run against
   the restored commit. The job then **fails** either way, with one
   `::error::` that names the failed check (`api-db`, `web-api-url`,
   `auth-session`, `cors`, `api-commit`, …), the new sha and the restored
   sha. A rollback is never a green run: the commit on main is still broken.

Two things stop before they start a loop:

- **No target.** A first deploy, a variable still on `:main`, or a token
  without `read:sensitive` leaves nothing to go back to. The job fails and
  says so; the new images stay pinned. Fix forward, or run the manual
  rollback below with a known-good sha.
- **The rollback fails its own gate**, or a Coolify call fails while
  restoring. The job fails and names it. Nothing tries a second time — a
  second automatic attempt against an unknown state is how an outage grows.
  The hosted apps need a person at that point.

### Migrations are forward-only, so the server may stay

The server migrates its database at boot, and a migration can raise
`minReaderSchema` above the previous build's `SCHEMA_VERSION`
(`docs/versioning.md` → Migration-bearing releases). The previous server then
refuses to start on that database, and nobody can tell from outside whether
the new server got far enough to run the migration before it failed the gate.

So before rolling the server back, the job compares the migration registry
(`packages/server/src/services/migrations/`) of the new commit with the
previous commit's, with `git show` — the checkout uses `fetch-depth: 0` for
this. When the new commit carries a migration the previous build cannot
read, or either registry cannot be read (a sha not in the checkout counts as
"unknown", and unknown is not safe), **only the client is rolled back**; the
server stays on the new build, and the error says why. That is the decision:
a client on the previous build against a server one commit ahead is the
combination the version handshake already supports, while a server that
refuses to boot is an outage. Going back past such a migration needs the
`mongodump` from before it, which is a person's decision, never the job's.

### Rolling back by hand

`.github/workflows/hosted-rollback.yml` pins the images of an earlier commit
and runs the same poll and gate:

```bash
gh workflow run hosted-rollback.yml -f sha=<commit> -f which=both
gh workflow run hosted-rollback.yml -f sha=<commit> -f which=client
sleep 5   # the run appears in the list a moment after the dispatch
gh run watch --exit-status "$(gh run list --workflow hosted-rollback.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

Watch the run rather than dispatching and walking away. Both workflows share
the `hosted-deploy` concurrency group (below), and GitHub keeps **one
pending run per group**: a rollback queued behind a running push deploy is
cancelled when another push to main arrives while it waits, because the
newer push takes the waiting slot. `gh run watch --exit-status` ends
non-zero on a cancelled run as on a failed one; check the Actions queue and
run `gh workflow run` again if the rollback was cancelled, since nothing
re-dispatches it.

- `sha` must be a commit on main: only those have images, because only
  `build-and-deploy.yml` pushes `:<sha>` tags. The run resolves an
  abbreviated sha and refuses anything not reachable from main.
- `which` is `both`, `client` or `server`. A one-app run gates the pair that
  is then live, expecting the given commit from the app it moved and no
  particular commit from the other.
- The run reads the migration registries before it touches anything, and
  refuses to move the server to a commit that cannot read the database the
  current one has migrated. Use `which=client`, or restore the dump from
  before that migration and run again with `force_server` checked.
- When the gate fails, the run fails and the images of `sha` stay pinned.
  The images pinned before the run are usually the build being escaped, so
  putting them back would re-pin it; the error names the failed check, and
  the next step is another run with a different sha or a fix forward.
  `restore_on_failure=true` puts the previous images back instead, exactly
  as after a failed push deploy — for a rollback that is a trial of an older
  build, not an escape from the current one.

Both workflows share the `hosted-deploy` concurrency group, so a push deploy
and a rollback never pin images at the same time, and a deploy is never
cancelled between pinning the new images and restoring the old ones.
`build-and-deploy.yml` therefore no longer cancels an in-progress run on a
new push to main; the newer push waits, and GitHub keeps only the newest
waiting run — of either workflow, which is why a queued manual rollback has
to be watched (above).

Without any Coolify secret the scripts print a `::notice::` and deploy
nothing; with some of them set and others missing, they fail, because half a
deploy is worse than none.

## Email verification and the one-time backfill

The server requires a verified email address before a password sign-in
whenever a mail transport is configured (`isEmailDeliveryConfigured()` in
`services/email.ts`). Accounts created before that were never verified, so the
first deploy that has mail configured AND this code must be followed by one
run of the backfill, or every existing user gets a verification link instead
of a session:

```bash
# in the running server container (Coolify → trackyourtime-server → Terminal)
node dist/scripts/backfill-email-verified.js --before <deploy time, ISO 8601>
# from a checkout, against the production MONGODB_URI
pnpm --filter @starter/server run backfill:email-verified -- --before <deploy time>
```

`--before` defaults to now. It only sets `emailVerified: true` on accounts that
are not verified and were created before the cutoff, so it is idempotent: a
second run prints 0. It never un-verifies anyone.

Google sign-in is live when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are
both set on the server app. Register
`https://api.trackyourtime.dev/api/auth/callback/google` as the redirect URI;
`health.check` then reports `authConfig.googleEnabled: true` and the button on
`/login` enables.

## What has to agree

- **Coolify's env fields on the server app** —
  `BETTER_AUTH_URL=https://api.trackyourtime.dev` and
  `FRONTEND_URL=https://trackyourtime.dev`. These are different values now.
  `FRONTEND_URL` is also the CORS allow-list entry, and the browser client is
  cross-origin again, so getting it wrong breaks sign-in for everyone rather
  than just for the extension. `packages/server/.env.production` is untracked
  in this repo, so there is no committed file to edit — Coolify is where the
  value lives.
- `.github/workflows/build-and-deploy.yml` — `NEXT_PUBLIC_API_URL` and
  `NEXT_PUBLIC_WS_URL` are baked into the browser bundle at image build time.
  Runtime env cannot change them; rebuilding the image is the only way. Both
  are **origins**, with no `/api` on the end — the client appends the path.
- `packages/extension/manifest.config.ts` — the extension's DEFAULT production
  server. The manifest has no `host_permissions`; its `externally_connectable`
  lists the web app's origin (`https://trackyourtime.dev/*`, from
  `EXTENSION_BRIDGE_PRODUCTION_WEB_ORIGINS` in `@starter/shared`), which is how
  a sign-in on the web app reaches the extension. Moving the web app's domain
  therefore needs a new extension release too. A person can pick another
  server in the popup, so this is where a fresh install starts, not the only
  host.
- `packages/raycast/src/lib/preferences.ts` — the Raycast extension's
  `apiUrl` / `webUrl` defaults (and the placeholders in its `package.json`).
- `.github/workflows/mobile-release.yml` — `NEXT_PUBLIC_API_URL` is baked into
  a store binary as the DEFAULT server. Moving the default means a new build
  and a new review; a person can still choose another server on the login
  screen of the build they have. That file also carries the Android signing secrets; see
  [Android release signing](#android-release-signing).

## TRUSTED_ORIGINS

better-auth force-validates the `Origin` header on sign-in whenever a request
carries `Sec-Fetch-*` headers, which every browser fetch does. Any origin that
is not `FRONTEND_URL` needs to be in `TRUSTED_ORIGINS` or sign-in returns
`403 INVALID_ORIGIN` before the password is checked.

The web app is **not** same-origin with the API any more, so `FRONTEND_URL`
carrying `https://trackyourtime.dev` is what admits it. The browser extension
and the phone apps need entries on top.

The production extension build pins the store key by default
(`STORE_EXTENSION_KEY` in `packages/shared/src/store-clients.ts`), so its id is
`opibnndhibnigcfgfbgbipakadhnbjfi` wherever it is loaded from — unpacked or
from the Web Store — provided the first Web Store upload preserves that key.
Confirm with:

```bash
pnpm run extension:id prod
```

Two ways to trust the store clients on this deployment, in the **server app's
env fields in Coolify**:

- `TRUST_STORE_APPS=true` — trusts `capacitor://localhost`, `https://localhost`,
  `chrome-extension://opibnndhibnigcfgfbgbipakadhnbjfi` and the desktop app's
  `app://-` together, from code. The self-host compose file sets this by default.
- or list them in `TRUSTED_ORIGINS`, comma-separated, if this deployment's
  trust list should stay spelled out by hand.

**This is a release prerequisite for the extension.** The extension has no
host permissions, so every request it makes (tRPC, REST, auth) is a CORS
request, and the server answers CORS only for trusted origins. Set the
trust before the first store release, then check it:

```bash
curl -s -H 'Origin: chrome-extension://opibnndhibnigcfgfbgbipakadhnbjfi' \
  https://api.trackyourtime.dev/api/health
```

The JSON must say `"originTrusted": true`. If the trust goes missing later,
the popup shows a notice that names `TRUST_STORE_APPS`, and the extension
keeps its unsent changes until the server trusts it again.

Either way, the variable goes into Coolify. Not into `packages/server/.env.production` — that file is
untracked here and never reaches the image (step 3), so a value written there
changes nothing in production.

Raycast and CLI clients need no origin at all — their `fetch` sends neither
`Origin` nor `Sec-Fetch-*`. The device flow guards them instead.

## TRUST_PROXY_HOPS

How many reverse proxies sit between the internet and the server process.
Express hands `req.ip` to the public API's failed-authentication meter, and
derives it as the (n+1)-th address from the *right* of `X-Forwarded-For`.

**This deployment has two.** Cloudflare proxies the record (that is why the
origin IP stays hidden, and why Universal SSL covers the host at all),
and Coolify's reverse proxy (caddy-docker-proxy here) sits behind it.
Cloudflare appends the caller to `X-Forwarded-For`, the proxy appends
Cloudflare's edge address, so the header
reaching the app reads `<caller>, <cf-edge>` and only `TRUST_PROXY_HOPS=2`
resolves `req.ip` to the caller. The server's own default is **1** — the safe
generic value, not the right one here — so `docker-compose.server.yml` names
the variable and defaults it to `2` for this deployment. It has to be named
there: Coolify's env fields are only interpolation variables for the compose
file, so a `TRUST_PROXY_HOPS` set in Coolify against a compose file that never
references it reaches no container. Setting the field now overrides the `2`,
which is what you want if a hop is ever added or removed.

Both directions fail silently:

- **Too high** — a directly-exposed container believes an `X-Forwarded-For`
  the caller wrote. A prober sends a fresh address per request, every request
  gets its own key, and the meter never accumulates. Verified: reached
  directly, a request carrying `X-Forwarded-For: 203.0.113.99` yields
  `req.ip === "203.0.113.99"`.
- **Too low** — left at 1 behind Cloudflare, `req.ip` collapses to the edge
  address and every caller in the world shares one key.

A wrong count is *not* a lockout risk for valid tokens: the meter is keyed on
the presented token prefix as well as the address, so even a fully collapsed
`req.ip` cannot make one caller's rejected credential refuse another's working
one. What a wrong count costs is the meter's usefulness — which is why nothing
raises when it is wrong, and why it has to be re-counted whenever a hop is
added or removed in front of the server.

## The client image serves a static export

`packages/client/next.config.ts` sets `output: "export"`, because the desktop
and mobile shells load the same bundle from `file://` and from the Capacitor
container. So there is no `.next/standalone` and no `server.js`: the image is
the exported `out/` tree plus `packages/client/serve.mjs`, a static file
server. The E2E suite runs that same file (`e2e/serve-static.mjs` delegates to
it), so the deployed server and the tested one cannot drift apart.

`docker-compose.yml` is the legacy single-app layout, kept for reference.

## The docs are part of the client image

The Docusaurus site in `docs-site/` is served at
**`https://trackyourtime.dev/docs/`** by the same `trackyourtime-client` app.
`packages/client/Dockerfile` runs `node scripts/docs/build-into-client.mjs`
after the client build, which builds the docs with `baseUrl: "/docs/"` and
copies them to `out/docs/`; `serve.mjs` serves them like any other file. There
is no DNS record, Coolify app or proxy label for the docs.

Why this shape and not the two obvious others:

- **Not `docs.trackyourtime.dev`.** A subdomain is a separate site to search
  engines, so the pages that answer "self-hosted time tracker" would build
  authority for a host the product does not live on. It would also be a third
  Coolify app to deploy and keep in step with the web app.
- **Not a proxy path to a separate docs container.** That is the shape that
  already failed here (section 2 above): caddy-docker-proxy merges two apps'
  `caddy_0` sites for the same host, and `handle_path=/docs*` strips the prefix
  a `baseUrl: "/docs/"` build needs.

The costs are small and deliberate: a docs-only change rebuilds and redeploys
the client image (which never restarts the server or drops a socket), and the
image build stage installs the docs site's dependencies. The copy step fails
the build if any page carries `noindex`, a canonical link or sitemap entry
outside `https://trackyourtime.dev/docs/`, or a robots.txt under `/docs/`. The
domain's one robots.txt (from `packages/client/src/app/robots.ts`) lists
`/docs/sitemap.xml` as a second sitemap.

To check a deploy:

```bash
curl -sI https://trackyourtime.dev/docs/self-hosting/ | head -1   # 200
curl -s https://trackyourtime.dev/robots.txt | grep Sitemap       # both sitemaps
curl -s https://trackyourtime.dev/docs/sitemap.xml | head -c 300
```

To build and serve the same tree locally:

```bash
NEXT_PUBLIC_API_URL=https://api.trackyourtime.dev pnpm build:web
PORT=<free port> HOST=127.0.0.1 node packages/client/serve.mjs
```

`Dockerfile.selfhost` does not include the docs: a self-hosted instance links
to them on trackyourtime.dev.

## Android release signing

Play will not accept an unsigned bundle, and `.github/workflows/
mobile-release.yml` builds one when it is dispatched by hand (a `v*` tag no
longer runs it; its `on:` block lists what must be true first). The wiring is
done —
`android/app/build.gradle` has a `signingConfigs.release` block that reads the
key material out of the environment, and the workflow passes it — but the key
itself does not exist yet. **Generating it is yours to do**: it is a private
key, it must never be committed, and it cannot be regenerated. The steps below
are the whole of it.

Losing this file is not a small problem. The upload key is how Play knows a new
build is from you; if it is gone the only remedy is a key-reset request to
Google, which takes days. Back it up somewhere that is not this repo and not
this machine only — a password manager attachment is the usual answer.

### 1. Generate the upload keystore

Anywhere outside the repo (`~/keys/` is fine — `*.keystore` and `*.jks` are
gitignored repo-wide, but a file that never enters the tree cannot be
committed by accident at all):

```bash
keytool -genkeypair -v \
  -keystore ~/keys/trackyourtime-upload.keystore \
  -storetype PKCS12 \
  -alias trackyourtime \
  -keyalg RSA -keysize 2048 \
  -validity 10000
```

It asks for a password and for a name/organisation (which end up in the
certificate and are not otherwise used). Answer the password prompt twice and
keep that value: `-storetype PKCS12` means the store password and the key
password are the same, so the two secrets below get the same string. `-validity
10000` is Play's own guidance — a key that expires before the app is retired
locks you out of your own listing.

### 2. Set the four GitHub secrets

The names on the left are what the workflow reads. `gh secret set NAME` with no
`--body` prompts for the value and does not echo it:

```bash
base64 -i ~/keys/trackyourtime-upload.keystore | gh secret set ANDROID_KEYSTORE_BASE64
gh secret set ANDROID_KEYSTORE_PASSWORD   # the password from step 1
gh secret set ANDROID_KEY_ALIAS --body trackyourtime
gh secret set ANDROID_KEY_PASSWORD        # the same password, for PKCS12
```

On Linux, `base64 -w0 ~/keys/trackyourtime-upload.keystore | gh secret set …` —
GNU `base64` wraps at 76 columns without `-w0` and macOS `base64` takes `-i`
instead. Either way the workflow's `base64 -d` accepts wrapped input, so a
newline in the secret is harmless; what matters is that the whole file is in
there.

`ANDROID_KEYSTORE_BASE64` is the switch: with it unset the workflow still
builds and still uploads an artifact, just an unsigned one. With it set and any
of the other three missing, the job now fails on the "Check the signing secrets
are complete" step rather than building an unsigned bundle and discovering it
at upload time.

Play uploads need a fifth and sixth secret — `PLAY_SERVICE_ACCOUNT_JSON` and
`ANDROID_PACKAGE_NAME` — and that step stays skipped until they exist. Signing
and uploading are independent: a signed AAB downloaded from the workflow's
artifacts can be uploaded to the Play Console by hand.

### 3. Building a signed bundle locally

The gradle block reads a keystore at `android/app/release.keystore` — the same
path the workflow decodes to — plus three environment variables:

```bash
cp ~/keys/trackyourtime-upload.keystore android/app/release.keystore
cd android
KEYSTORE_PASSWORD='…' KEY_ALIAS=trackyourtime KEY_PASSWORD='…' ./gradlew bundleRelease
jarsigner -verify -verbose:summary \
  app/build/outputs/bundle/release/app-release.aab
```

`jarsigner` prints `jar verified.` for a signed bundle. It also warns that the
certificate is self-signed — that is expected and correct for an upload key.

**Without any of that, `./gradlew bundleRelease` still works.** It logs
`trackyourtime: no release signing key …` and produces an unsigned bundle, which is
what you want for a build you are only going to `bundletool` onto a device. The
guard exists so that a fresh checkout is not a Gradle error; CI is where an
unsigned artifact must not pass silently, and there it does not.

## Desktop release

`.github/workflows/desktop-release.yml` builds every desktop artifact from one
manual dispatch (Actions → Desktop Release → Run workflow). It has one leg per
channel:

| Leg | Runner | Output | Signed by |
| --- | --- | --- | --- |
| `mac` | macos-latest | dmg + zip, arm64 and x64 | Developer ID, notarized |
| `mas` | macos-latest | pkg, universal | Apple Distribution + Mac Installer Distribution |
| `win` | windows-latest | one NSIS exe, x64 + arm64 | Azure Trusted Signing or a certificate file |
| `win-store` | windows-latest | appx, x64 and arm64 | Partner Center, on upload |
| `linux-x64`, `linux-arm64` | ubuntu-24.04(-arm) | AppImage, deb, rpm, tar.gz, snap | not signed |

Every leg follows the Android rule above:

- **No secrets for a channel:** the leg still builds. Every dmg, zip and exe
  has `-unsigned` in its file name. A `mas` leg without secrets packages the
  `.app` to check the config and uploads nothing, because no unsigned pkg can
  be submitted. A `win-store` leg with none of the three identity variables
  is skipped with a notice; with one or two of them it fails.
  An unsigned build also drops every certificate and notarization variable
  before electron-builder runs, so nothing named `-unsigned` is ever signed.
- **A complete set:** the leg signs, then verifies the signature. The checks
  are `codesign --verify --deep --strict`, `spctl --assess` and
  `stapler validate` for the Developer ID app, `pkgutil --check-signature` and
  the sandbox entitlements for the store pkg, and `signtool verify /pa` for
  Windows.
- **Part of a set:** the leg fails on "Check the signing secrets", before the
  export is built. The message lists what is set and what is missing.

The decision is `resolveSigning` in `scripts/lib/desktop-release.mjs`, and it
is unit-tested. The same function runs in `scripts/build-desktop.mjs`, so a
local `--channel` build refuses in the same way. The API key and team id are
shared with the iOS release, so they do not start signing on their own. Only
the certificate does.

An AppX is built only with `--channel win-store`, and that channel builds
nothing else. Outside it electron-builder fills the identity with `CN=ms` and
the package name, so `build-desktop.mjs` refuses before anything is built.

Artifacts go to the run's Actions artifacts, with a `SHA256SUMS-<leg>.txt`
file. Every store upload is manual.

### Tags, the draft release and updates

The workflow also runs on every `v*` tag. After every leg passes, the
`draft-release` job runs `scripts/desktop-release-draft.mjs` and creates or
updates a **draft** GitHub Release for the tag:

- It attaches the signed dmg, zip and blockmaps, the signed Windows installer,
  every Linux download except the snap, one `SHA256SUMS.txt`, and the update
  feeds `latest-mac.yml`, `latest.yml`, `latest-linux.yml` and
  `latest-linux-arm64.yml`.
- It never attaches a file named `-unsigned`, a pkg, an appx or a snap. An
  unsigned mac or win leg is a warning on the run, so the draft simply has no
  download for that platform.
- It fails when a leg that should have a feed has none, or when a feed names a
  file that is not attached or whose sha512 or size differs.
- It refuses a tag whose release is already published. Tag a new version.
- It writes `stagingPercentage` into every feed when the run has a staging
  percentage ("Staged rollout" below), and checks the rewritten feeds against
  the attached files the same way.

**Publish the draft by hand.** electron-updater reads the latest *published*
release, so nothing reaches installed apps until then. Prereleases are never
offered. `pnpm release:status vX.Y.Z` says whether the draft exists or is
published (docs/releasing.md → Steps, step 6).

Which builds update themselves is decided twice. At build time,
`updateFeedFor` in `scripts/lib/desktop-release.mjs` gives signed mac and win
builds and every Linux build a GitHub feed (`app-update.yml`), and everything
else `publish: null`. At run time, `updaterPolicy` in
`electron/src/updater-model.ts` turns the updater on only for the Developer ID
build, the NSIS install and the AppImage. The Mac App Store, the Microsoft
Store, Snap, Flatpak, deb, rpm and tar.gz leave updates to their manager. A
downloaded update installs on quit, or on "Restart to update" in Settings →
Desktop or the tray. The app never restarts by itself.
`TRACKYOURTIME_DISABLE_UPDATES=1` turns the updater off on a managed machine.

### Staged rollout

The update feeds can offer a release to part of the installed apps first.
electron-updater reads `stagingPercentage` from `latest.yml`,
`latest-mac.yml` and `latest-linux*.yml`. Each install has a random id,
created once in its profile (`<userData>/.updaterId`), and is offered the
release only when that id falls below the percentage. The id never changes,
so raising the percentage keeps everybody who was already in. It applies to
the three builds that update themselves; store and package-manager copies are
not affected.

**Release at 10 %.** Either set the repository variable
`DESKTOP_STAGING_PERCENTAGE` to `10` before pushing the tag, or run the
workflow by hand from the tag (Actions → Desktop Release → Run workflow → Use
workflow from: `v1.4.0`, staging percentage `10`). The input wins over the
variable. Both empty means every install, as before. The `staging percentage`
job validates the value at the start of the run and fails on anything that is
not a whole number from 0 to 100, before any build starts. The
`draft-release` job writes the value
into every feed and checks the rewritten feeds against the attached files
again. Then publish the draft as usual. The variable stays in effect for
every later tag until you change or delete it (`gh variable delete
DESKTOP_STAGING_PERCENTAGE`); a fix-forward release that should reach
everybody needs it cleared, or the dispatch input set to 100.

**Raise, halt or finish** on the published release, from a checkout with `gh`
signed in:

```bash
pnpm desktop:rollout v1.4.0 50 --dry-run   # show what would change
pnpm desktop:rollout v1.4.0 50             # half of all installs
pnpm desktop:rollout v1.4.0 0              # halt
pnpm desktop:rollout v1.4.0 100            # everybody (removes the key)
```

The script downloads the release's `latest*.yml`, changes that one line in
each, checks that nothing else changed, and uploads them again with
`--clobber`. It refuses a release that does not exist, a value outside 0 to
100, and a feed that does not parse, and then uploads nothing. `100` removes
the key instead of writing `100`: electron-updater compares with `<`, so an
explicit 100 would leave out the one id in 2^32 at the very top.
`--repo <owner>/<name>` targets a fork.

Four limits:

- **Nothing is rolled back.** `0` stops offering the release to installs that
  do not have it yet. An install that already updated stays on it, and one
  that already downloaded it still installs it on quit. To fix a bad release,
  publish a higher version.
- **Only the newest published release counts.** electron-updater reads the
  feeds of the latest published release. The script warns when the tag is not
  that release. A new release replaces the old rollout, so fix forward at
  whatever percentage the fix needs.
- Apps check at launch plus 30 seconds and every six hours, so a change takes
  up to six hours to reach running apps.
- `--clobber` deletes each feed before it uploads the new one. An app that
  checks in that second gets an error and tries again at the next check.

A headless run (tests, agents) never loads electron-updater, never writes
`.updaterId` and never reads a feed. A profile moved with
`TRACKYOURTIME_USER_DATA_DIR` gets its own id.

### Publishing a release to the downloads page

When a release is published, set the three direct entries of
`DESKTOP_DOWNLOADS` in `packages/client/src/lib/site-links.ts` to
`https://github.com/trebeljahr/trackyourtime/releases/latest`, and each store
entry to its listing once it is live. Until then `/download` says "not
released yet".

### Secrets and variables

Secrets (`gh secret set NAME`, which prompts and does not echo):

| Name | Leg | Value |
| --- | --- | --- |
| `MAC_CSC_LINK` | mac | base64 of the Developer ID Application `.p12` |
| `MAC_CSC_KEY_PASSWORD` | mac | its export password |
| `APPLE_API_KEY_BASE64` | mac | base64 of the App Store Connect API key `.p8` (the iOS release's secret) |
| `APPLE_API_KEY_ID` | mac | that key's id (shared with iOS) |
| `APPLE_API_ISSUER_ID` | mac | the issuer id (shared with iOS) |
| `MAS_CSC_LINK` | mas | base64 of one `.p12` holding Apple Distribution **and** Mac Installer Distribution |
| `MAS_CSC_KEY_PASSWORD` | mas | its export password |
| `MAS_PROVISIONING_PROFILE_BASE64` | mas | base64 of the Mac App Store Connect `.provisionprofile` |
| `APPLE_TEAM_ID` | mas | the ten-character team id |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | win | the app registration that may sign |
| `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT`, `AZURE_TRUSTED_SIGNING_PROFILE`, `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME` | win | the signing account, certificate profile and the publisher name on it |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | win | the alternative to Azure: base64 `.pfx` and its password. Set one Windows set, never both |
| `HOMEBREW_TAP_TOKEN` | manifests | fine-grained token, contents write on the tap repository only |

Repository variables (`gh variable set NAME`), which are not secret:

| Name | Used by | Value |
| --- | --- | --- |
| `WINDOWS_STORE_IDENTITY_NAME` | win-store | Partner Center → product → Product identity → Package/Identity/Name |
| `WINDOWS_STORE_PUBLISHER` | win-store | …/Identity/Publisher (`CN=…`) |
| `WINDOWS_STORE_PUBLISHER_DISPLAY_NAME` | win-store | …/Properties/PublisherDisplayName |
| `HOMEBREW_TAP_REPO` | manifests | `<owner>/homebrew-tap` |
| `NEXT_PUBLIC_API_URL` | all | optional; defaults to `https://api.trackyourtime.dev` |
| `DESKTOP_STAGING_PERCENTAGE` | draft release | optional; 0-100, the share of installs a new tag's feeds offer the update to. Empty means every install ("Staged rollout") |

The build derives nothing from these. The Store identity in particular is never
defaulted, because Partner Center refuses a package whose identity differs from
the reserved one.

### macOS, Developer ID (dmg, zip, Homebrew)

1. In the Apple Developer account (the Account Holder must do this), create a
   **Developer ID Application** certificate. Export it with its private key from
   Keychain Access as a `.p12` file, then set `MAC_CSC_LINK` and
   `MAC_CSC_KEY_PASSWORD`:
   `base64 -i DeveloperID.p12 | gh secret set MAC_CSC_LINK`.
2. Notarization uses the App Store Connect API key the iOS release already has.
   If it does not exist yet, create a Team key with the Developer role under
   Users and Access → Integrations and set the three `APPLE_API_*` secrets.
3. Dispatch the workflow. The `mac` leg is signed only when the certificate
   and all three key values are set.

Locally: `NEXT_PUBLIC_API_URL=… node scripts/build-desktop.mjs --channel mac
--package --mac dmg zip --arm64`. Without `CSC_LINK` in the environment, this
builds the `-unsigned` version.

### macOS, Mac App Store (pkg)

1. The App ID `com.ricoslabs.trackyourtime` already exists for iOS. **Decide
   before the first upload:** a Mac build under the same App Store Connect
   record ships as a Universal Purchase with the phone app, and a separate
   record would need a different bundle id. That id is a contract (CLAUDE.md),
   so a separate record is the expensive choice.
2. Create an **Apple Distribution** and a **Mac Installer Distribution**
   certificate. Export both into one `.p12` and set `MAS_CSC_LINK` and
   `MAS_CSC_KEY_PASSWORD`.
3. Create a **Mac App Store Connect** provisioning profile for the App ID, then
   set `MAS_PROVISIONING_PROFILE_BASE64` and `APPLE_TEAM_ID`.
4. Dispatch the workflow, download `desktop-mas-signed`, and upload the pkg with
   Transporter. Review and release happen in App Store Connect.

What is different under the sandbox: the app group is
`<APPLE_TEAM_ID>.com.ricoslabs.trackyourtime`, and the entitlements are
generated per build by `masEntitlementsPlist`. The app gets network client
access and read/write access to files the user picks. It has no in-app updater,
because the store updates it (`selfUpdates` in `electron/src/distribution.ts`).
Open at login works through SMAppService, as in the Developer ID build.

### Windows, NSIS and winget

1. Pick one signing route:
   - **Azure Trusted Signing.** Create a Trusted Signing account and pass
     identity validation. Eligibility for individuals and organizations
     depends on the country, so check the current rules first. Then create a
     Public Trust certificate profile. Register an app in Entra ID, give it the
     "Trusted Signing Certificate Profile Signer" role on the account, and set
     the seven `AZURE_*` secrets.
   - **A certificate file.** New OV and EV code-signing certificates have been
     issued on hardware or cloud HSMs since 2023 and cannot be exported as a
     `.pfx`. `WIN_CSC_LINK` therefore only fits a certificate that can still be
     exported. Cloud HSM services need a custom sign hook, which this repo does
     not have.
2. Dispatch the workflow. The `win` leg verifies the installer and the
   unpacked executables with `signtool verify /pa`.
3. **winget**, once the release is published: run Desktop Manifests (below),
   then copy `manifests/winget/*.yaml` to
   `manifests/t/Trebeljahr/TrackYourTime/<version>/` in a fork of
   `microsoft/winget-pkgs`. Run `winget validate` on that folder and open the
   pull request. `wingetcreate submit <folder>` does the same.

### Windows, Microsoft Store (appx)

1. Open a Partner Center developer account and reserve the name "Track Your
   Time".
2. Copy the three values from Product management → Product identity into the
   `WINDOWS_STORE_*` repository variables.
3. Dispatch the workflow and upload the `.appx` files from `desktop-win-store`
   to a submission. The package is not signed here, because the Store signs it.

In the Store build, open at login is off. A packaged app's `Run` key is never
read, and Electron does not expose `StartupTask`. Settings shows the row
disabled. There is no in-app updater.

### Linux: AppImage, deb, rpm, Snap Store, Flathub

The AppImage, deb, rpm and tar.gz files are for the GitHub Release. No apt or
rpm repository is hosted, so a deb or rpm install is not updated by the
package manager.

**Snap Store:**

1. Create a Snapcraft account and run `snapcraft register trackyourtime`.
2. Upload: `snapcraft upload --release=stable trackyourtime_<version>_amd64.snap`,
   and do the same for arm64.
3. The `password-manager-service` plug is not auto-connected. Until the
   Snapcraft forum grants auto-connection, the user runs
   `snap connect trackyourtime:password-manager-service`. Without it, the app
   keeps the session in memory only and says so in Settings → Devices.

**Flathub:**

1. Add a `<screenshots>` block to
   `packaging/flatpak/com.ricoslabs.trackyourtime.metainfo.xml.template`,
   pointing at a committed capture. Flathub requires at least one.
2. Once the release is published, run Desktop Manifests. Then open a pull
   request against `flathub/flathub` (branch `new-pr`) with the files from
   `manifests/flatpak/`. After acceptance, updates are commits to the
   `flathub/com.ricoslabs.trackyourtime` repository that Flathub creates.
3. The manifest repackages the release's tar.gz. Flathub reviewers can ask
   for a source build of an open-source app instead. That build would need
   every npm dependency vendored with `flatpak-node-generator`, which this
   repo has not done.
4. Verifying the app id (the badge) needs control of `trebeljahr.com`.

In the Flatpak, open at login is unsupported and the in-app updater is off,
the same as in the stores.

### Homebrew

1. Create a public repository named `homebrew-tap` under your account. Set the
   variable `HOMEBREW_TAP_REPO` to `<owner>/homebrew-tap` and the secret
   `HOMEBREW_TAP_TOKEN`.
2. After a release with signed dmgs is **published** (not a draft), run
   Actions → Desktop Manifests → Use workflow from → the `v<version>` tag. It
   downloads the release files, renders the cask, winget and Flathub
   manifests with real checksums, uploads them as an artifact, and commits
   `Casks/track-your-time.rb` to the tap.
3. Install with `brew install --cask <owner>/tap/track-your-time`. The cask
   says `auto_updates true`, because the app updates itself; `brew upgrade`
   then skips it unless run with `--greedy`. The official
   `homebrew/cask` repository has notability requirements for new casks, so
   the tap comes first.

Locally, the same rendering is
`node scripts/desktop-manifests.mjs --artifacts <folder with the release files> --out manifests`.
