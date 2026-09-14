# Deploying Track Your Time

Two Coolify apps on **two hosts of one zone**:

| Coolify app | Routed at | Compose file | Serves |
|---|---|---|---|
| `tracktime-client` | `https://trackyourtime.dev` | `docker-compose.client.yml` | the Next web app |
| `tracktime-server` | `https://api.trackyourtime.dev` | `docker-compose.server.yml` | the Express API, tRPC and the `/api/ws` socket |

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

1. **Databases.** `tracktime-mongo` already exists as a Coolify database.
   Add a Redis one if you want it; the server treats `REDIS_URL` as optional
   and logs "skipping Redis connection" when it is unset.
2. **Two applications**, both from this repo, build pack `dockercompose`:
   - `tracktime-server` → compose path `docker-compose.server.yml`,
     domain `https://api.trackyourtime.dev`
   - `tracktime-client` → compose path `docker-compose.client.yml`,
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
   `TRUSTED_ORIGINS`, `S3_PUBLIC_URL`, `AWS_ACCESS_KEY_ID`,
   `AWS_SECRET_ACCESS_KEY`.

   These are now **different** values, which they were not under the
   one-domain layout:

   - `BETTER_AUTH_URL=https://api.trackyourtime.dev` — better-auth's own
     origin, where it mounts `/api/auth` and signs cookies for.
   - `FRONTEND_URL=https://trackyourtime.dev` — the web app, and the CORS
     allow-list entry. The browser client is cross-origin again, so this is
     what makes its calls pass preflight at all.
   - `TRUSTED_ORIGINS` — plus the extension's `chrome-extension://<id>`.

   `.env.production` is a local convenience only — it is what
   `NODE_ENV=production pnpm --filter @starter/server start` reads — and it is
   untracked here, so Coolify's env fields are the real source of truth.
4. **DNS**: two records on the `trackyourtime.dev` zone — the apex `@` and
   `api`, both proxied. The old `tracktime` record on `trebeljahr.com` (and
   any leftover `api.tracktime`) can go once the move is verified; nothing in
   the app points at them any more. `assets.tracktime.trebeljahr.com` is a
   separate thing and stays — it is the R2 asset host, unrelated to this
   move.
5. **GitHub secrets** so CI can trigger both deploys:
   `COOLIFY_SERVER_RESOURCE_UUID` and `COOLIFY_CLIENT_RESOURCE_UUID`
   (alongside the existing `COOLIFY_BASE_URL` and `COOLIFY_API_TOKEN`). With
   neither set, the workflow falls back to the single `COOLIFY_RESOURCE_UUID`.
   All four are already set on this repo.

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
  server and its required `host_permissions`. A person can pick another server
  in the popup, so this is where a fresh install starts, not the only host.
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

- `TRUST_STORE_APPS=true` — trusts `capacitor://localhost`, `https://localhost`
  and `chrome-extension://opibnndhibnigcfgfbgbipakadhnbjfi` together, from
  code. The self-host compose file sets this by default.
- or list them in `TRUSTED_ORIGINS`, comma-separated, if this deployment's
  trust list should stay spelled out by hand.

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

## Android release signing

Play will not accept an unsigned bundle, and `.github/workflows/
mobile-release.yml` builds one on every `v*` tag. The wiring is done —
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
  -keystore ~/keys/tracktime-upload.keystore \
  -storetype PKCS12 \
  -alias tracktime \
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
base64 -i ~/keys/tracktime-upload.keystore | gh secret set ANDROID_KEYSTORE_BASE64
gh secret set ANDROID_KEYSTORE_PASSWORD   # the password from step 1
gh secret set ANDROID_KEY_ALIAS --body tracktime
gh secret set ANDROID_KEY_PASSWORD        # the same password, for PKCS12
```

On Linux, `base64 -w0 ~/keys/tracktime-upload.keystore | gh secret set …` —
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
cp ~/keys/tracktime-upload.keystore android/app/release.keystore
cd android
KEYSTORE_PASSWORD='…' KEY_ALIAS=tracktime KEY_PASSWORD='…' ./gradlew bundleRelease
jarsigner -verify -verbose:summary \
  app/build/outputs/bundle/release/app-release.aab
```

`jarsigner` prints `jar verified.` for a signed bundle. It also warns that the
certificate is self-signed — that is expected and correct for an upload key.

**Without any of that, `./gradlew bundleRelease` still works.** It logs
`tracktime: no release signing key …` and produces an unsigned bundle, which is
what you want for a build you are only going to `bundletool` onto a device. The
guard exists so that a fresh checkout is not a Gradle error; CI is where an
unsigned artifact must not pass silently, and there it does not.
