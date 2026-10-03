# Hosted same-origin gateway proposal

Status: local configuration proof, **not a deployed topology or rollout-ready
client image**. Nothing in the hosted workflows, compose files, manifest, API
configuration, or native builds imports this proposal.

## Current contracts and the safe boundary

`.hatchkit.json` declares `topology: split`, `coolifyRuntime: image`, and ports
6477/5159. The active workflow builds the Node/static client Dockerfile with
an explicit public API origin, and the deploy verifier checks that origin in
`/version.json`. The compose files describe the separate client/server apps;
they do not establish a shared Docker network for the current image runtime.
There is no verified private server address this repository can safely select.

Commits `1235217c` and `b82f39f6`, plus `docs/deploy.md`, record the failed
shared-site experiment: two apps claimed the same Caddy site label; the
client catch-all swallowed API requests, and `handle_path` stripped `/api`.
Do not add the apex to the server app, generate shared site labels, or change
the API mount. Keep the public API host for desktop, mobile, extension,
Raycast, MCP, and already-installed clients. Keep the self-host Caddyfile and
native server selection unchanged.

The candidate is **one gateway owned by the web origin**, ahead of the
existing `serve.mjs` static server. It sends `/api`, `/api/*`, and `/ws` to the
existing API and everything else to the static server. The API app keeps its
own public host and independent deploy lifecycle. The gateway may use the
public HTTPS API as its upstream until a private address/network is verified;
that removes browser preflight but still adds a server-side network hop.
A web deploy would disconnect web sockets passing through this gateway;
public native sockets remain independent. Do not promise unchanged web socket
uptime merely because the API still deploys separately.

`deploy/hosted-origin/Caddyfile` is a loopback-only executable model of this
routing. It preserves the mount, query, body, cookies, authorization, Origin,
Location, response version headers, and upgrades. It uses the upstream Host
for HTTPS while Caddy supplies the original X-Forwarded-Host/Proto. Keep TLS
verification enabled. No arbitrary URL forwarding or cookie/redirect rewriting
is included. Static routes still use `serve.mjs`, preserving legacy redirects,
docs responses, no-framing policy, and `/version.json` cache behavior.

## Auth prevents a transparent switch today

`packages/server/src/auth/auth.ts` configures a single `BETTER_AUTH_URL` and
no `crossSubDomainCookies` or cookie Domain override. The installed Better Auth
cookie implementation therefore emits host-only cookies (Path=/, HttpOnly,
SameSite=Lax, Secure for HTTPS). Current browser sessions belong to the public
API host. A browser will not send those cookies to the apex gateway.
Conversely, a password login through the apex creates an apex cookie; direct
public API requests and sockets cannot use it. Routing only tRPC while leaving
auth or sync on the public API is therefore insufficient.

Google callbacks and verification links use the server's configured auth base
URL. Passing their Location headers unchanged preserves current behavior,
but callbacks on the API host do not create an apex session. Naively rewriting
Location does not fix provider redirect registration, signed state, secure
cookies, or mail links. Existing API-host and new apex-host sessions also need
coherent logout/revocation behavior during migration and rollback.

Do not broaden cookies to `.trackyourtime.dev` as an incidental performance
change. That changes the trust boundary to every sibling subdomain and can
leave duplicate old host-only and new domain cookies. A host-only design
needs an explicit, tested callback/session handoff while retaining old public
callbacks for installed clients and already-issued email links. Neither
strategy is selected or implemented here. This is the rollout blocker.

## Local configuration and build path

Run from an isolated worktree with dependencies installed. Use a disposable
local API/database and fake records only. Choose three free high ports;
59631–59633 below are examples, not reserved ports. No DNS changes are needed.

```sh
# Existing native builds retain their explicit API origin; this export is web-only.
pnpm --filter @starter/shared run build
pnpm --filter @starter/invoice-pdf run build
pnpm --filter @starter/core run build
NEXT_PUBLIC_API_URL= NEXT_PUBLIC_WS_URL= \
  pnpm --filter @starter/client exec next build --webpack
COMMIT_SHA="$(git rev-parse HEAD)" NEXT_PUBLIC_API_URL= \
  node scripts/write-version-json.mjs packages/client/out/version.json
HOST=127.0.0.1 PORT=59632 node packages/client/serve.mjs
```

In a separate terminal, after starting the disposable API on 59633:

```sh
export GATEWAY_PORT=59631
export WEB_UPSTREAM=http://127.0.0.1:59632
export API_UPSTREAM=http://127.0.0.1:59633
caddy validate --config deploy/hosted-origin/Caddyfile --adapter caddyfile
caddy run --config deploy/hosted-origin/Caddyfile --adapter caddyfile
```

Open `http://127.0.0.1:59631` only for local testing. Configure the disposable
API's auth/frontend/trusted origins for this local origin. The loopback HTTP
harness cannot validate production Secure cookies or OAuth provider setup;
those require a separately authorized HTTPS staging environment. Stop both
owned processes afterward. The `.env.example` documents the harness variables;
Caddy reads exported environment variables, not that file automatically.

The hosted Dockerfile deliberately rejects an empty `NEXT_PUBLIC_API_URL`.
The hosted workflow also supplies a public-host fallback. Do not bypass these
guards or set a production variable to `/api`: the client appends `/api` itself.
A future approved image/build target must explicitly permit and verify a
same-origin web export, include the gateway and unchanged Node static server,
and leave the existing hosted/native/self-host targets functional. Runtime
NEXT_PUBLIC variables cannot alter a prebuilt bundle.

## Proof and its limits

```sh
node --test deploy/hosted-origin/gateway.test.mjs
```

Requires Node >=24 and Caddy on PATH. Uses only temporary fixtures, real Caddy,
and loopback high ports; cleans up its child processes and files. It validates
Caddy configuration, then checks POST body/query/mount, auth/version headers,
separate Set-Cookie fields, unchanged redirects, API error status, static
redirect/cache behavior, streaming, both socket paths and cookie/token
protocols, direct API availability, and a 502 for an unavailable API.
These are proxy contract tests, not full Better Auth or provider tests.
They do not measure browser OPTIONS counts or production response times.
The local empty-origin Webpack export also passed TypeScript and generated all
53 static pages. Validation temporarily capped Next at two build workers and
used existing local dependency outputs; no worker setting or client-code change
is committed. The standard Turbopack and Docker image builds were not rerun.
For a browser request whose page and API URL have the same scheme/host/port,
CORS preflight is unnecessary; verify that property in an HTTPS staging browser
before claiming the benefit for this app's actual request paths.

## Rollout and rollback gates for a later authorized change

1. Record actual image digests, proxy owner/labels, networks, container ports,
   server auth/frontend/trusted origins, and current provider callback URLs.
   Confirm the apex has exactly one owner. Keep the public API route intact.
2. Choose and test the auth migration above before changing web calls. Cover
   existing sessions, password/2FA/magic-link login, Google, verification,
   password reset, logout, callback errors, and old mail/provider links.
   Include public/native clients and selected self-host servers.
3. Build a distinct opt-in web image; preserve `serve.mjs` and version stamping.
   The deploy gate in `scripts/lib/coolify-deploy.mjs` currently compares
   `version.apiUrl` with the public API URL. Extend it to validate the intended
   web API mode separately from the still-public native API. Probe gateway
   health/session/tRPC and authenticated socket upgrade as well as public API
   health. Do not treat a static health check as proof of API routing.
4. In authorized staging, inspect same-origin requests with custom client/version
   headers: no OPTIONS for those requests, correct cookies, preserved redirects,
   working `/api/ws` and `/ws`, and no static HTML returned as API success.
   Compare request counts, not invented latency. Reject a switch if any auth
   path silently sends requests back to the public API.
5. Roll out gateway support before the relative browser bundle. Keep old bundles
   and public API calls functional. Use immutable images, confirm the served
   `/version.json`, and retain the prior image and auth configuration.
6. Roll back the browser bundle to its explicit public API origin **first**;
   restore the matching verifier expectation and prior immutable image. Keep
   gateway routes temporarily for cached relative bundles/open tabs. Restore
   auth settings only through the tested migration plan; apex cookies do not
   automatically authenticate requests to the API host. A re-login may be
   required. Remove the gateway only after old relative clients are handled.

No push, deployment, remote configuration, or infrastructure change is part
of this proposal. Production still uses separate browser/API origins.
