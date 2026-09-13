# Self-hosting Track Your Time

Run your own instance on your own machine, with your own database. One VPS,
one domain, one `docker compose up -d`.

This document is the operational manual for that. It is not the maintainer's
own deployment — that one is a two-domain split on Coolify and is documented
separately in [`deploy.md`](./deploy.md). Nothing here interacts with it, and
the files it uses are untouched by the self-host layout.

---

## 1. What you get, and what it costs to run

One domain, five containers, everything on your machine:

| Container | Image | Does |
|---|---|---|
| `caddy` | `caddy:2.11-alpine` | TLS, and the only container with published ports. Routes `/api/*` and `/ws` to the server, everything else to the web app. |
| `server` | `ghcr.io/trebeljahr/tracktime-server` | The API (tRPC), authentication, and the live-sync WebSocket. |
| `client` | `ghcr.io/trebeljahr/tracktime-client-selfhost` | The web app — a static export served by a second, tiny Caddy. |
| `mongo` | `mongo:7.0` | All of your data, including accounts and sessions. |
| `redis` | `redis:7.4-alpine` | Present but unused; see [Optional integrations](#9-optional-integrations). |

The whole feature set works in this configuration with nothing else
configured: time tracking, the client/project/task catalog, tags, reports,
invoices, CSV and JSON import and export, and the browser and Raycast clients.
No account with any service is required, and with the analytics variables
unset at image build time the web app loads no third-party script at all, so a
self-hosted instance makes no outbound request from the browser that you did
not ask for.

**Running cost.** One small VPS and one domain name. Certificates come from
Let's Encrypt and are free. The following are guidance rather than benchmarks:

| | Guidance |
|---|---|
| RAM, pulling published images | 1 GB works for a single user; 2 GB is comfortable. MongoDB is the largest consumer. |
| RAM, building images on the box | 4 GB or more. `next build` is the memory-hungry step and will be killed on a 1 GB box. |
| Disk | 5 GB for images and volumes, plus your data. Time entries are small; a heavy year of tracking is measured in megabytes. |
| CPU | 1 vCPU is enough. The only bursty work is PDF and CSV generation. |

**What it does not do.** There is no clustering and no horizontal scaling: the
server must run as exactly one replica, because live sync fans out in-process.
A second replica would not error — it would deliver live updates only to the
devices that happened to connect to the same process, which is the worst kind
of failure. The compose file runs one, and it should stay that way.

---

## 2. Prerequisites

| Requirement | Notes |
|---|---|
| A machine with a public IP | Any VPS. 1 vCPU / 1–2 GB is enough. |
| Docker Engine 24.0+ with the Compose v2 plugin | Check with `docker compose version`. Older `docker-compose` (the Python v1 script) will not work — the compose file uses `depends_on` health conditions and `${VAR:?...}` substitution. |
| A domain, with an `A` record pointing at the VPS | And an `AAAA` record if the machine has IPv6. The record must resolve **before** you start the stack, or certificate issuance fails. |
| Ports 80 and 443 reachable from the internet | Port 80 is not optional: the ACME HTTP challenge is answered on it. 443/udp is also published, for HTTP/3. |
| Root or a user in the `docker` group | |

Check the Docker side:

```bash
docker --version && docker compose version
```

Check that DNS points where you think it does, from the VPS:

```bash
dig +short track.example.com
```

**ARM works.** The release workflow publishes `linux/amd64` and `linux/arm64`
for both images, so a Raspberry Pi, an Ampere VPS or an Apple-silicon machine
pulls a native image with no emulation.

---

## 3. Install

Everything below is run from the directory holding the compose file.

### 3.1 Get the files

```bash
git clone https://github.com/trebeljahr/tracktime.git && cd tracktime
```

Three files are what the stack actually reads —
`docker-compose.selfhost.yml`, `Caddyfile` and `.env.selfhost.example` — but
clone rather than downloading those three: building the images from source is
the fallback when no release has been published for the version you pinned,
and that needs the whole tree as the build context
(see [3.6](#36-where-the-images-come-from)).

### 3.2 Create your `.env`

```bash
cp .env.selfhost.example .env
```

Compose reads `.env` from the current directory automatically, which is why
the copy is named that. To keep a different filename, pass
`--env-file .env.selfhost` on every compose command.

### 3.3 Generate a session secret

```bash
openssl rand -base64 32
```

Copy the output into `BETTER_AUTH_SECRET` in `.env`. Keep it stable — changing
it signs every device out. Do not deploy the placeholder that ships in the
example file.

### 3.4 Set your domain

Edit `.env` and set `APP_DOMAIN` to the domain you pointed at the VPS, with no
scheme and no path:

```bash
APP_DOMAIN=track.example.com
```

That is the only other value you must set. Everything else in the file is
optional and commented out. In particular:

| Variable | When you need it |
|---|---|
| `APP_DOMAIN` | Always. The site address, and therefore the certificate that gets requested. |
| `BETTER_AUTH_SECRET` | Always. |
| `TRACKTIME_VERSION` | Pinned to a release. Bump it to upgrade — see [section 8](#8-upgrading). |
| `APP_URL` | Only when the origin is not `https://${APP_DOMAIN}` — a plain-HTTP trial, or a non-standard port. |
| `SMTP_*`, `EMAIL_FROM` | Only for outgoing mail — see [section 5](#5-email). |
| `TRUSTED_ORIGINS` | Only for the browser extension or a native shell — see [section 10](#10-the-other-clients). |
| `MONGODB_URI`, `REDIS_URL` | Only to point at a managed database instead of the containers. |

The app must be served at the **root** of the domain. Hosting it under
`https://example.com/tracktime/` breaks live sync: the WebSocket URL is derived
from the browser's origin and would still resolve to `example.com/ws`.

### 3.5 Start it

```bash
docker compose -f docker-compose.selfhost.yml up -d
```

The first run pulls the images, or builds them from your clone when no release
has been published for `TRACKTIME_VERSION` yet — see
[3.6](#36-where-the-images-come-from). Either way that first start takes
minutes; the ones after it take seconds.

Watch it come up:

```bash
docker compose -f docker-compose.selfhost.yml ps
```

All five services should reach `healthy`. Mongo and Redis come up first, then
the server, and Caddy last — it waits for both the server and the client to be
healthy before it starts. `depends_on` enforces that, so a slow first Mongo
start delays the rest rather than breaking it.

Then confirm the server is answering through the proxy:

```bash
curl -sS https://track.example.com/api/health
```

You should get back something like
`{"status":"ok","db":true,"webUrl":"https://track.example.com","timestamp":"…"}`.
`db: true` means MongoDB is connected, and `webUrl` is the origin the server
resolved from your `APP_URL` — if that string is not exactly what you type in
the browser, fix it now rather than debugging sign-in later.

Open `https://track.example.com` and you are done.

If you would rather not type `-f docker-compose.selfhost.yml` on every command,
export it once per shell:

```bash
export COMPOSE_FILE=docker-compose.selfhost.yml
```

The rest of this document keeps the flag, so every block is safe to paste.

### 3.6 Where the images come from

The `server` and `client` services carry both an `image:` and a `build:`, so
the command above works whether or not a release has been published. Compose
takes the published image for `TRACKTIME_VERSION` when it can reach one, and
builds from your clone when it cannot — the `build:` blocks already name the
right context, Dockerfile and build arguments, including the empty
`NEXT_PUBLIC_API_URL` that makes the web app same-origin.

Which images exist is a function of tags: they are published for a version
only once that tag has been pushed and
[`.github/workflows/release.yml`](../.github/workflows/release.yml) has run.
Until then the first `up -d` is a local build, which is slower than a pull —
the client is the memory-hungry step, so give the machine at least 4 GB of RAM,
or build elsewhere and push to your own registry.

To force one half or the other:

```bash
docker compose -f docker-compose.selfhost.yml pull    # published images only
docker compose -f docker-compose.selfhost.yml build   # local build only
```

Do **not** substitute `ghcr.io/trebeljahr/tracktime-client:main` for the
self-host client image. That is the maintainer's build, with their API host
compiled into the browser bundle; you would get a login screen that posts to a
domain you do not own. The self-host image is the separately named
`…-client-selfhost`, and that is exactly why the name is different.

---

## 4. First run: accounts, and what "admin" means here

**Sign-up is open.** The server enables email-and-password registration
unconditionally and there is no allowlist, no invite code, and no first-run
setup wizard. The first account you create is not special: go to
`https://track.example.com/signup`, fill in name, email and password (minimum
eight characters), and you are signed in. Email verification is off, so no mail
provider is needed to register.

**There is no instance administrator.** The app has no notion of a super-user
who can see other people's data or manage the instance. Every account gets its
own personal workspace on creation, and all data — clients, projects, tasks,
entries, tags, invoices — is scoped to a workspace. Workspaces support multiple
members and roles in the data model, but the web app ships no invitation or
member-management screen, so in practice one account is one private workspace.
If you self-host for yourself, that is exactly what you want. If you were
hoping to invite a team through the UI, that does not exist yet.

**Closing registration is not supported by the application.** There is no
configuration flag for it. Anyone who can reach your domain can create an
account. Three workarounds, in order of how well they hold up:

1. **Block the sign-up endpoint at the proxy** once your own account exists.
   Add this to your `Caddyfile` *above* the `handle /api/*` block, then
   `docker compose -f docker-compose.selfhost.yml restart caddy`:

   ```
   handle /api/auth/sign-up/* {
       respond "Registration is closed" 403
   }
   ```

   The `/signup` page still renders; submitting it fails. Note that this also
   blocks any future account you might want to create, so keep it in mind
   before you need a second one.

2. **Put the whole site behind an authentication layer** — Caddy's
   `basic_auth`, an identity-aware proxy, or a VPN such as Tailscale or
   WireGuard. This is the strongest option, but it also blocks the browser
   extension and the Raycast client unless they can carry the same
   credentials.

3. **Do not expose it publicly at all.** Bind the stack to a private network
   and reach it over a VPN. The trade-off is that Let's Encrypt's HTTP
   challenge needs public reachability, so you would need a DNS challenge or
   an internally-issued certificate instead.

**Deleting an account** is in the app: **Settings → Account → Delete account**.
An account with a password must type it. An account without one (Google sign-in)
must have signed in within the last 24 hours. Deletion signs out every device and
removes the account's data at once; there is no grace period and no undo. A
workspace other members still use keeps its catalog, its invoices and the entries
on those invoices. Your MongoDB backups still hold the deleted data until they
expire, so rotate them if that matters to you.

**If you lock yourself out**, see [section 5](#5-email) — without a mail
provider the password-reset link is written to the server log, and that is a
supported way back in.

---

## 5. Email

### What email is used for

Three things, all of them account-related: password reset, email verification
(off by default), and workspace invitations (no UI today). No feature of the
time tracker sends mail — reports, invoices and exports are all downloaded in
the browser.

So email is not required to run Track Your Time. It is required to reset a password
without shell access to the server.

### Configuring SMTP

Any SMTP relay works: a mailbox provider, a transactional service, or an
unauthenticated relay on your own network. Set these in `.env`:

| Variable | Meaning |
|---|---|
| `SMTP_HOST` | The relay host. Setting it is what selects SMTP as the transport. |
| `SMTP_PORT` | Defaults to `587` (STARTTLS). `465` is implicit TLS, `25` is an unencrypted relay. |
| `SMTP_USER` | Omit **both** user and password for an unauthenticated relay — no AUTH is then attempted, rather than offering empty credentials and being rejected. |
| `SMTP_PASSWORD` | |
| `SMTP_SECURE` | `true`/`false`. Unset it follows the port (`465` → implicit TLS), which is right for essentially every provider. |
| `EMAIL_FROM` | Required whenever `SMTP_HOST` is set. Most relays only accept a domain they are configured to send for, so there is no default worth guessing. |

Apply the change:

```bash
docker compose -f docker-compose.selfhost.yml up -d server
```

A missing `EMAIL_FROM` is deliberately *not* treated as "email is not
configured" — a send throws with a message naming the host, rather than
silently falling back to logging, because an operator who plainly configured a
relay should not have to guess why nothing arrives. The link is still written
to the log on the way out, so the recovery below keeps working while you sort
the relay out.

### When it is not configured

Nothing breaks and nothing is queued. Sign-up needs no verification, and a
password-reset request returns the usual "if this email exists…" response while
printing the reset link to the **server** log. That is how you get back into a
single-user instance you locked yourself out of:

```bash
docker compose -f docker-compose.selfhost.yml logs server | grep 'Password reset URL'
```

The line looks like `[auth] Password reset URL for you@example.com: https://…`.
Paste it into a browser. The link carries a `?token=` query parameter and lands
on `https://track.example.com/reset-password`, which is a real page in the web
app.

### Which transport is used

SMTP wins over Listmonk whenever `SMTP_HOST` is set, and the three auth call
sites — password reset, verification and invitation — branch on whether *any*
transport is configured, never on one provider's variables. So a self-host with
SMTP set up and Listmonk unset sends real mail, and needs no further wiring.

### Verifying a send

Request a password reset for your own account at
`https://track.example.com/forgot-password`, then watch the log:

```bash
docker compose -f docker-compose.selfhost.yml logs -f server
```

A delivery failure throws and is logged with the relay's own error and the host
and port it tried — a silent failure here would be worse than a loud one, so
nothing is swallowed. The link itself is printed too, as the same
`[auth] Password reset URL for …` line, so a relay you have not got right yet
cannot lock you out of your own instance.

---

## 6. Why one domain, and what it would take to split

The web app is a Next.js **static export**: HTML, CSS and JavaScript files with
no Node process behind them. Next inlines `NEXT_PUBLIC_*` variables into that
bundle when the image is **built**, not when it starts, so a client image that
knows an API URL is bound to that host forever.

The self-host client image is therefore built with an **empty**
`NEXT_PUBLIC_API_URL`. Every call site then falls back to a relative URL:

| Call | Resolves to |
|---|---|
| tRPC | `/api/trpc` |
| better-auth | `window.location.origin` + `/api/auth` |
| Live-sync WebSocket | `wss://<your host>/ws` |

Caddy in front makes those the same origin as the page by routing `/api/*` and
`/ws` to the server container and everything else to the static files. That is
the whole trick, and it buys three things: one published image works behind
anybody's domain, you need one DNS record and one certificate instead of two,
and the cross-origin cookie and CORS surface disappears entirely.

The consequences to know about:

- The app must live at the **root** of the domain. A subpath breaks the sync
  socket, whose URL comes from the browser origin.
- `/api/*` and `/ws` must be matched **before** the catch-all static rule. The
  shipped `Caddyfile` does this. A static handler that swallows
  `/api/auth/get-session` answers it with `index.html` and a `200`, which
  reaches the browser as a baffling auth failure rather than as the routing bug
  it is.
- `/ws` must be proxied without rewriting the path. The server compares the
  upgrade path literally against `/ws` and `/api/ws` and destroys the socket on
  anything else — which is why the Caddyfile uses `handle`, never `handle_path`.
- Your proxy must set `X-Forwarded-For`. Caddy does by default. Without it,
  better-auth cannot determine a client IP and silently disables its own rate
  limiting on sign-in and password reset, announcing it in one easily-missed
  warning line.

**Splitting the hosts later** is supported by the server, which is what
`FRONTEND_URL` and `BETTER_AUTH_URL` are for: set explicitly, they override the
single `APP_URL` and can name two different origins. But the client half is a
build-time decision — you would have to rebuild the client image with
`NEXT_PUBLIC_API_URL=https://api.example.com`, add a second DNS record and a
second certificate, and put the extension's and any native client's origins
into `TRUSTED_ORIGINS`. Unless you have a specific reason, stay on one domain.

---

## 7. Backup and restore

**Everything that matters is in MongoDB.** One database holds your tracked
data *and* your accounts and sessions (better-auth uses the same connection),
so a single dump is a complete backup of the instance.

The compose project is named `tracktime`, so the volumes are:

| Volume | Holds | Back up? |
|---|---|---|
| `tracktime_mongo-data` | All application and account data | Yes — but prefer `mongodump` below |
| `tracktime_mongo-config` | MongoDB's own local config | No |
| `tracktime_caddy-data` | Issued certificates and the ACME account key | Worth it — see below |
| `tracktime_caddy-config` | Caddy's autosaved config | No |
| `tracktime_redis-data` | Nothing the app reads | No |

Confirm the names on your machine:

```bash
docker volume ls | grep tracktime
```

### Back up the database

```bash
docker compose -f docker-compose.selfhost.yml exec -T mongo mongodump --uri "mongodb://127.0.0.1:27017/tracktime" --archive --gzip > tracktime-$(date +%Y%m%d-%H%M%S).archive.gz
```

`mongodump` and `mongorestore` ship inside the `mongo:7.0` image, so there is
nothing to install. The dump is consistent enough for a single-node instance
and can be taken while the stack is running. Copy the resulting file off the
machine — a backup that lives only on the VPS is not a backup.

### Restore

Stop the app so nothing writes while you restore, but leave Mongo up:

```bash
docker compose -f docker-compose.selfhost.yml stop server
```

```bash
docker compose -f docker-compose.selfhost.yml exec -T mongo mongorestore --uri "mongodb://127.0.0.1:27017" --archive --gzip --drop < tracktime-20260101-120000.archive.gz
```

```bash
docker compose -f docker-compose.selfhost.yml start server
```

`--drop` replaces each collection that is present in the archive. Collections
created after the dump are left alone, which is usually what you want; for a
clean rollback to exactly the dumped state, drop the database first.

### Certificates

`tracktime_caddy-data` holds the issued certificates and the ACME account key.
Losing it is not fatal — Caddy re-issues on the next start — but re-issuing
counts against Let's Encrypt's rate limits, which matters if you rebuild a
machine repeatedly. To keep it, stop the stack first so nothing is mid-write:

```bash
docker compose -f docker-compose.selfhost.yml down
```

```bash
docker run --rm -v tracktime_caddy-data:/data:ro -v "$PWD:/backup" alpine tar czf /backup/caddy-data.tar.gz -C /data .
```

The same `docker run … tar` pattern works for `tracktime_mongo-data` if you
would rather take a file-level copy than a dump — but only with the stack
stopped, and a `mongodump` is the more portable artifact.

### What is not in the backup

Your `.env` and any edits to `Caddyfile`. Keep those in a private repository or
a password manager; `BETTER_AUTH_SECRET` in particular is unrecoverable, and
losing it signs every device out.

---

## 8. Upgrading

Both images are tagged together, so one variable covers the whole stack.

Take a dump first — always:

```bash
docker compose -f docker-compose.selfhost.yml exec -T mongo mongodump --uri "mongodb://127.0.0.1:27017/tracktime" --archive --gzip > pre-upgrade-$(date +%Y%m%d-%H%M%S).archive.gz
```

Edit `TRACKTIME_VERSION` in `.env` to the release you want, then:

```bash
docker compose -f docker-compose.selfhost.yml pull
```

```bash
docker compose -f docker-compose.selfhost.yml up -d
```

Compose recreates only the containers whose image changed. Expect a few
seconds of downtime on the server container, and every connected client's sync
socket to reconnect on its own afterwards.

### Which tag to pin

| Tag | Meaning |
|---|---|
| `vX.Y.Z` | An exact release. The default, and the recommendation. |
| `X.Y` | The newest patch of that minor line. |
| `latest` | The newest stable release. Prereleases never move it. |
| `:main` | **Not a release.** The maintainer's own deploy tag, built from every push to `main`. Do not point `TRACKTIME_VERSION` at it. |

### Rolling back

Set `TRACKTIME_VERSION` back to the previous release and repeat `pull` and
`up -d`. If the newer version wrote data the older one cannot read, restore
the dump you took before upgrading (see [section 7](#7-backup-and-restore)).

### Migrations

**There is no migration runner, and nothing migrates at startup.** The server's
boot sequence is: connect to MongoDB, connect to Redis if configured,
initialise auth, listen. No schema step exists in it.

Schema changes are applied implicitly by Mongoose:

- New fields simply appear as absent on documents written by older versions,
  and the code is written to read an absent field as its default rather than
  requiring it. That is a deliberate convention in this codebase, not an
  accident.
- Indexes are created automatically by Mongoose when the models register at
  startup.
- Nothing rewrites existing documents.

The practical consequence: upgrades are usually just a new image, and a
downgrade usually works because old code ignores fields it does not know. But
"usually" is doing real work in that sentence, and there is no tooling to undo
a change that does rewrite data — which is why the `mongodump` above is not
optional advice.

One historical one-off script exists (`migrate:workspaces`, for databases that
predate workspace scoping). It is never run automatically, and a self-hosted
instance created from any released image does not need it.

---

## 9. Optional integrations

Every one of these is off when its variables are empty, and none of them is on
a boot path. The app is feature-complete without all of them.

**Redis.** Wired up, but nothing reads it: sessions live in MongoDB and live
sync fans out in-process. The compose file includes it because the server
connects when `REDIS_URL` is set. To run the smallest possible stack, delete
three things from `docker-compose.selfhost.yml`: the `REDIS_URL` line in the
server's `environment:` block (it defaults to the bundled container, so
commenting the variable out in `.env` leaves it set), the `redis` service, and
the `depends_on` entry that waits for it. The server then logs one line saying
it skipped the connection and carries on.

**Object storage (S3).** Not used at all. Invoice and report PDFs are rendered
and returned inline through the API, CSV and JSON exports are built in memory,
and imports arrive in the request body. There is no bucket to provision; do not
stand up MinIO for this. The `S3_*` / `AWS_*` variables belong to the starter
this app was generated from and are deliberately absent from the self-host
compose file.

**Sentry.** Set `SENTRY_DSN` to send server errors to any Sentry-protocol
endpoint, including a self-hosted GlitchTip. Unset, nothing is reported
anywhere and no error data leaves the machine.

**Google sign-in.** Set both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to
register the provider. With either empty, no social provider is registered and
no "Sign in with Google" button is rendered — there is no orphaned button
pointing at a provider that does not exist. Email and password sign-in always
works, so there is no reason to create an OAuth app you do not want.

**Stripe.** Subscription billing, only meaningful if you charge other people to
use your instance. With `STRIPE_MODE` empty the subscription card is not
rendered at all. A self-hosted instance normally leaves this alone.

**Listmonk.** An alternative mail transport to SMTP (not an addition), used by
the maintainer's hosted deploy. The newsletter subscribe/confirm endpoints that
come with it are marketing scaffolding from the starter; the time tracker's UI
never calls them, and they stay inert while the `LISTMONK_*` variables are
unset. Prefer plain SMTP — see [section 5](#5-email).

---

## 10. The other clients

Both are optional. The web app is complete on its own.

### Browser extension

The extension bakes its API URL in at build time, so a self-hoster builds their
own. In `packages/extension/manifest.config.ts`, edit `BUILD_TARGETS.production`
to point at your origin — under a single domain that is the bare app origin,
not an `api.` subdomain — changing both fields:

```ts
apiUrl: "https://track.example.com",
hostPermissions: ["https://track.example.com/*"],
```

Then build it and load `dist-prod/` as an unpacked extension:

```bash
pnpm run build:extension:prod
```

An unpacked extension's id, and therefore its `chrome-extension://<id>` origin,
is derived from the path it was loaded from. Print yours:

```bash
pnpm run extension:id prod
```

**That origin must be added to `TRUSTED_ORIGINS`** in your `.env`, then
`docker compose -f docker-compose.selfhost.yml up -d server`. Without it,
sign-in from the extension is refused with `403 INVALID_ORIGIN` before the
password is even checked. Multiple origins are comma-separated.

### Raycast extension

No code change and no `TRUSTED_ORIGINS` entry. Raycast sends no `Origin` header
at all and is guarded by the device-approval flow instead: it shows a short
code, you approve it at `https://track.example.com/device` in a browser where
you are already signed in.

Set both preference fields in Raycast Settings → Extensions → Track Your Time:

| Preference | Value under a single domain |
|---|---|
| **API URL** | `https://track.example.com` |
| **Web App URL** | `https://track.example.com` — the same value |

Left empty they fall back to the maintainer's hosts, so fill in both.

---

## 11. Troubleshooting

### Reading the logs

```bash
docker compose -f docker-compose.selfhost.yml logs -f server
```

Swap `server` for `caddy`, `client`, `mongo` or `redis`. Add `--tail 200` to
skip history, and omit `-f` for a one-shot read. Which one to look at:

| Symptom | Log |
|---|---|
| Sign-in, API errors, mail, password-reset links | `server` |
| Certificates, routing, `502`s, `404`s from the proxy | `caddy` |
| The web app not loading at all | `client` |
| `db: false` from `/api/health` | `mongo`, then `server` |

Overall state, including which container is unhealthy:

```bash
docker compose -f docker-compose.selfhost.yml ps
```

### `403 INVALID_ORIGIN` on sign-in

better-auth force-validates the `Origin` header whenever a request carries
`Sec-Fetch-*` headers — which every real browser fetch does. If the origin the
browser sends is not in the trusted list, sign-in is refused before the
password is checked.

The trusted list is `FRONTEND_URL` (which `APP_URL` supplies) plus anything in
`TRUSTED_ORIGINS`. So:

- **From the web app**: your `APP_URL` does not match what you actually typed
  in the browser. In production the comparison is a literal string match with
  no aliasing, so `https://track.example.com` and `https://www.track.example.com`
  are two different deployments — and so are `http://localhost:8080` and
  `http://127.0.0.1:8080`. Check what the server resolved:

  ```bash
  curl -sS https://track.example.com/api/health
  ```

  The `webUrl` field is the origin it trusts. Fix `APP_URL` (or `APP_DOMAIN`)
  to match your browser's address bar character for character, then
  `docker compose -f docker-compose.selfhost.yml up -d server`.

- **From the browser extension**: add its `chrome-extension://<id>` origin to
  `TRUSTED_ORIGINS` — see [section 10](#10-the-other-clients).

**`curl` will not reproduce this.** curl sends no `Origin` and no `Sec-Fetch-*`
headers, so the origin check returns early and the same request that fails in
the browser succeeds from the shell. Reproduce it in a browser, with the
network tab open, or you will conclude the server is fine.

Note also that same-origin requests never produce a CORS error, so this failure
shows up as a plain `403` with no explanatory console message.

### The WebSocket does not connect

The app works but nothing updates live across devices, and the sync status in
the app shell never reaches "open".

1. **Check the path is not being rewritten.** The server compares the upgrade
   path literally against `/ws` and `/api/ws` and destroys the socket on
   anything else — with no error the browser can explain. In Caddy this means
   `handle /ws`, never `handle_path /ws` (which strips the prefix). If you put
   another proxy, a CDN, or Cloudflare in front of Caddy, check it too.
2. **Check the upgrade is forwarded.** The proxy must pass `Upgrade` and
   `Connection: Upgrade` on an HTTP/1.1 hop. Caddy's `reverse_proxy` does this
   natively; a hand-written nginx config needs the standard `Upgrade` map.
3. **Check `Cookie` reaches the server.** That is how the web app
   authenticates the socket. A proxy that strips cookies gives you an upgrade
   that is accepted and then immediately closed.
4. **Check `Sec-WebSocket-Protocol` reaches the server** if you are debugging
   the browser extension or Raycast — that is where their bearer token rides.
5. **Check idle timeouts.** The server pings every 10 seconds, so anything
   above ~30 seconds is fine. An aggressive 10-second idle timeout on an
   intermediate proxy will cut the connection repeatedly.
6. **Check you are at the domain root.** Under a subpath the browser still
   derives `wss://<host>/ws` from its origin, which will not match where you
   mounted the app.

In the browser's network tab the request to filter for is `ws`; a healthy one
shows status `101 Switching Protocols`.

### The certificate is not issued

Symptoms: the browser refuses to connect, or shows Caddy's internal
certificate. Read the proxy log first:

```bash
docker compose -f docker-compose.selfhost.yml logs caddy | grep -i -E 'acme|certificate|obtain'
```

The usual causes, in the order worth checking:

| Cause | Check |
|---|---|
| DNS does not point here yet | `dig +short track.example.com` from the VPS, compared against its public IP |
| Port 80 is blocked | The ACME HTTP challenge is answered on port 80; a firewall or security group that only opens 443 fails issuance. Both must be open **from the internet** |
| Something else already owns port 80 or 443 | `docker compose … logs caddy` shows a bind error; `ss -tlnp` finds the other process |
| `APP_DOMAIN` is wrong | The site block matches it, so a mismatch means Caddy requests a certificate for a name you do not control |
| Let's Encrypt rate limits | Repeated failed attempts against the same name are throttled for hours. Fix the cause before retrying, rather than restarting in a loop |

No ACME contact email is configured by default, so the CA cannot mail you if
renewals ever stop. Caddy renews well before expiry on its own; if you want the
safety net, add a global options block at the top of the `Caddyfile`:

```
{
    email you@example.com
}
```

For a local trial with no public DNS at all, set `APP_DOMAIN=localhost` and
`APP_URL=http://localhost` — Caddy skips ACME for localhost and issues its own
internal certificate. Then use one spelling consistently: `127.0.0.1` is a
different origin from `localhost` for both the session cookie and the origin
check, and in production mode there is deliberately no aliasing between them.

### MongoDB does not start

```bash
docker compose -f docker-compose.selfhost.yml logs mongo
```

| Cause | What you see, and the fix |
|---|---|
| No disk space | Mongo refuses to start or aborts on a write. `df -h`, then free space |
| Unclean shutdown | Recovery messages on start. Usually resolves itself; give the healthcheck its `start_period` before assuming failure |
| CPU without AVX support | `mongo:7.0` requires AVX. On an older or heavily virtualised x86 host this is an immediate crash on start. Use an image built for your hardware, or a managed database via `MONGODB_URI` |
| Volume permissions | After a manual restore of `tracktime_mongo-data` from a tarball, ownership can be wrong. Restore with the `docker run … tar` pattern from [section 7](#7-backup-and-restore), which preserves it |
| A previous data directory from a different major version | Mongo refuses to start on a newer binary. Restore from a `mongodump` into a fresh volume rather than upgrading in place |

While Mongo is unhealthy the server will not start at all — `depends_on` gates
it — so an unhealthy `mongo` is the first thing to look at whenever several
services are down at once.

### Other things worth knowing

- **`/api/…` returns the web app's HTML with a `200`.** Your proxy's catch-all
  is matching before the API rule. In the shipped `Caddyfile`, `handle /api/*`
  and `handle /ws` come first for exactly this reason.
- **Everything works but you are signed out constantly.** `BETTER_AUTH_SECRET`
  is changing between restarts (an unset variable, or a regenerated one), or
  you are alternating between two spellings of the origin.
- **`docker compose` refuses to start with `required variable APP_DOMAIN is
  missing a value`.** That is the compose file failing fast on purpose, rather
  than starting a stack that would request a certificate for an empty name. Set
  it in `.env`.
- **Sign-in rate limiting is silently off.** Look for a warning from
  better-auth about not being able to determine a client IP. It means
  `X-Forwarded-For` is not reaching the server — check any proxy you put in
  front of Caddy.

---

## Reference: the files involved

| File | Role |
|---|---|
| `docker-compose.selfhost.yml` | The stack. Five services, five volumes, one published port set |
| `.env.selfhost.example` | Copy to `.env`. Two values are required; the rest are commented out |
| `Caddyfile` | The single-domain routing rules: `/api/*` and `/ws` to the server, everything else to the web app |
| `packages/client/Dockerfile.selfhost` | Builds the web app with an empty `NEXT_PUBLIC_API_URL` and serves the static export |
| `packages/server/Dockerfile` | The server image, shared with the maintainer's deploy |
| `packages/server/.env.example` | Every server variable, with an explanation for each |
| `.github/workflows/release.yml` | Publishes the multi-arch, version-tagged images on a `v*` tag |
| [`docs/deploy.md`](./deploy.md) | The maintainer's own two-domain Coolify deployment. Not this |
