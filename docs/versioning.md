# Versioning

## Client and server compatibility

### Three clocks

A client and the server it talks to are almost never the same release.

- **Self-hosted servers lag.** An operator upgrades when they get to it, often
  months after a release.
- **Store clients lead.** The browser extension, Raycast and the phone apps
  update themselves, so they are often newer than the server they talk to.
- **Some clients trail.** A desktop build or a browser tab left open across a
  deploy is often older than the server.

A release number cannot answer "do these two understand each other?". Each side
therefore declares an **API level**, and each side names the lowest level of
the other that it still works with.

### Principles

1. **Additive only.** A release adds procedures, input fields, enum values and
   sync event kinds. It does not change what an existing one means.
2. **Removals wait.** A procedure or field that is going away stays for at
   least one minor release after the release that stopped using it.
3. **Skew never deletes user data.** A write that a server or a build cannot
   handle is held, never dropped. See "User-data stores hold, never drop"
   below, and the held rows in CLAUDE.md.
4. **Gate on the declared API level.** Never on a release number, a commit or a
   user agent.
5. **Fail loudly, with a way out.** A refusal names which side is too old and
   what to update. It never shows as a generic network error.

### The API level

`API_LEVEL` in `packages/shared/src/api-level.ts` is an integer. It names the
set of tRPC procedures, input fields, enum values and sync event kinds a build
knows. `API_LEVEL_CHANGES` beside it lists what each level added.

**Bump `API_LEVEL` whenever a tRPC procedure, an input field, an enum value or a
sync event kind is added.** Add a row to `API_LEVEL_CHANGES` in the same commit.
Never lower the level. The server tests check that the table ends at
`API_LEVEL` and skips no level.

Level 0 is every server and client released before the handshake. They send
no level and report none.

Two floors:

| Constant | Where | Meaning |
| --- | --- | --- |
| `MIN_CLIENT_API_LEVEL` | `@starter/shared` | The lowest client level the server serves. |
| `MIN_SERVER_API_LEVEL` | `@starter/core` | The lowest server level the web app, the phone apps, the extension and Raycast work with. |

Raise a floor only with a change that cannot work without it. Raising
`MIN_SERVER_API_LEVEL` past what the oldest supported self-hosted release reports
locks those servers out of every store client at once.

### The contract snapshot

`packages/server/contract/trpc-contract.json` is the tRPC surface as data:
every procedure's path, its type (query or mutation) and its input JSON Schema
(from `z.toJSONSchema`), every sync event kind with its payload schema, and
`apiLevel` / `minClientApiLevel`. It is committed, like the OpenAPI document,
so a change to what clients may send shows up in review.

```bash
pnpm run contract:emit    # regenerate after changing a procedure, an input or a sync event
```

`packages/server/src/tests/trpc-contract.test.ts` regenerates it and compares.
When they differ, it classifies the difference:

| Class | Changes | What the test asks for |
| --- | --- | --- |
| Breaking | Procedure removed or renamed, type changed, input added where there was none, required input property added, optional → required, enum value removed, type or bound narrowed, sync kind removed, required sync field removed | Raise `MIN_CLIENT_API_LEVEL` and `API_LEVEL` in the same change |
| Additive | Procedure added, optional input property added, enum value added, sync kind added | Bump `API_LEVEL` and add an `API_LEVEL_CHANGES` row |
| Neutral | Input property removed (zod strips unknown keys, never refuses them), a description changed | Regenerate |

Inputs are compared from the server's side (what an older client sends must
still parse) and sync payloads from the client's side (what an older client
receives must still make sense). A changed `pattern` or `format` cannot be
ordered, so it reads as breaking. Outputs are not in the snapshot: they are
TypeScript types that no client validates.

Sync event kinds live in three places: the `SyncEvent` union and
`SYNC_EVENT_KIND_SET` in `packages/shared/src/protocol.ts`, and
`packages/server/src/contract/sync-events.ts`. `tsc` fails when either copy
disagrees with the union.

### Unknown values from a newer server

A client can be older than its server, so every value a server sends can be one
the client has never heard of.

- **Sync events.** An unknown kind, or an unknown `catalog.changed` /
  `integrations.changed` scope, means "something changed": the web app
  invalidates every query, the extension drops its workspace caches and its
  running timer, Raycast revalidates. From another workspace an unknown kind
  reaches the timer (`syncEventReach` answers `"timer"`), because a timer spans
  workspaces. Known kinds keep their targeted handling.
- **Switches over server strings** (invoice and invitation status, idle and
  runaway behaviour, device client kind, theme, language, e-invoice fix
  location) keep their `never` checks for the build and return a safe value at
  runtime: a neutral label, no action, no crash. Codes that reach the UI
  (membership refusals, e-invoice refusals and issue codes) are checked against
  the known list first and fall back to a generic message.

### The header contract

Every first-party client sends two headers on every API request:

| Header | Value |
| --- | --- |
| `x-trackyourtime-client-version` | The client's release, e.g. `0.3.1`. |
| `x-trackyourtime-api-level` | The client's `API_LEVEL`, e.g. `1`. |

- The web app sends them from the tRPC link (`lib/trpc.ts`) and the better-auth
  client (`lib/auth-client.ts`). Core's `createApiClient` and the
  `session-auth.ts` helpers send them for the extension, Raycast and the
  move-server panel. The MCP server sends them on `/api/v1`.
- The sync socket cannot set headers, and its subprotocol carries the bearer
  token. It sends the same values as the `clientVersion` and `apiLevel` query
  parameters. The server routes on the path, so an older server ignores them.
- `x-trackyourtime-client` is unchanged. It decides the device label and the
  session window, and an unknown value reads as `unknown`.
- Never send the handshake headers to `/api/health` on a server that has not
  said it trusts the caller's origin. A custom header makes the browser send a
  preflight, and an untrusted origin's preflight fails. `checkServer` sends
  none.
- CORS reflects the headers a trusted origin asks for, so a new header needs no
  server change (`corsOptions` in `app.ts`).

The server records the version and level on the session row (`clientVersion`,
`clientApiLevel`, both optional). It stamps them when the session is created,
and moves them forward when a newer release uses the session. It never moves
them back, because every tab of a browser shares one cookie. Settings → Devices
shows the version beside the device name.

### What the server reports

`/api/health` and tRPC `health.check` return:

| Field | Value |
| --- | --- |
| `release` | The server's release, from its package.json. |
| `apiLevel` | The server's `API_LEVEL`. |
| `minClientApiLevel` | The server's `MIN_CLIENT_API_LEVEL`. |
| `commit` | The commit the image was built from, or `""`. |
| `version` | The same commit. Kept for released clients and `scripts/verify-release-images.sh`; new readers use `commit`. |

Core's `checkServer` reads `apiLevel` as 0 when it is absent.
`serverCompatibility` answers `SERVER_TOO_OLD`, `CLIENT_TOO_OLD` or `null`.

### Refusals

A request that declares an API level below `MIN_CLIENT_API_LEVEL` is refused:

- tRPC: `PRECONDITION_FAILED` (412) with `data.versionRefusal: "CLIENT_TOO_OLD"`.
  Core's `ApiError.versionRefusal` carries it. `health.*` is never refused, so
  the client can still learn the server's level.
- REST: 412 `application/problem+json` with type
  `https://trackyourtime.dev/problems/client-too-old`. The OpenAPI document is
  never refused.

A request that declares no level is a client from before the handshake, and is
always served. The status is 412, not 400: the offline queue drops a row on a
permanent status, and a version refusal is never a reason to delete queued time.

### The release version

The root `package.json` `version` is the single source of truth.

- The Next export (web, Capacitor, Electron, Tauri) reads it in
  `next.config.ts` and inlines it as `NEXT_PUBLIC_APP_VERSION`
  (`lib/app-version.ts`).
- The browser extension reads it in `manifest.config.ts` for the manifest, and
  `vite.config.ts` bakes it in as `VITE_APP_VERSION`.
- Hand-kept copies: every `packages/*/package.json` that has a version,
  `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`,
  `packages/raycast/src/lib/version.ts` (a Raycast Store submission has no root
  package.json), `packages/mcp/src/server.ts`, iOS `MARKETING_VERSION` and
  Android `versionName`. `scripts/lib/version-sync.test.mjs` fails when any of
  them disagrees with the root.

## Client storage

Every client persists values on the device: Capacitor Preferences and
`localStorage` in the web app and the phone shells, `chrome.storage.local` and
IndexedDB in the browser extension, `LocalStorage` in Raycast. Each value
outlives the build that wrote it. The next build reads it. So does an older
build, after a rollback, a store build that lags behind, or a stale unpacked
extension. Four rules keep those reads safe.

### 1. Structured values use the versioned envelope

A JSON object or array is written as `{ "v": <n>, "data": <value> }` through
`encodeVersioned` and read through `decodeVersioned` in
`packages/core/src/versioned-storage.ts`. The spec names the version this build
writes and a decoder for it:

- `v` equals the current version: `decode(data)`.
- No envelope: `legacy(value)`, for values written before the envelope existed.
- A lower `v`: `older[v](data)` when the spec has one, a miss otherwise.
- A higher `v`: a miss. A newer build wrote it, and this build cannot know what
  its fields mean.

Neither function ever throws. Decoders check the fields the code reads (ids,
dates, rates, currency) and pass unknown fields through, so a row from a newer
build that only added a field still renders. `stored-entry.ts` and
`stored-catalog.ts` in core hold the shared readers.

Bump `version` when a field changes meaning or type. Adding an optional field
is not a bump. When you bump, keep a reader for the old version in `older` for
as long as installs of that build can exist.

Values on the envelope today:

| Key | Store | Client |
| --- | --- | --- |
| `trackyourtime.running-entry` | Preferences | phone shells |
| `trackyourtime.optimistic-running` | `chrome.storage.local` | extension |
| `trackyourtime.optimistic-entries` | `chrome.storage.local` | extension |
| `trackyourtime.idle-watcher` | `chrome.storage.local` | extension |
| `trackyourtime.server-info` | `chrome.storage.local` | extension |
| `trackyourtime.local-cache:<workspace>` | `LocalStorage` | Raycast |
| `trackyourtime.offline.overlay:<workspace>` | `LocalStorage` | Raycast |
| `trackyourtime.timer.echo` | `LocalStorage` | Raycast |

`trackyourtime.server-choice` and `trackyourtime.known-workspaces` predate the
envelope and already decode field by field; move them onto it the next time
their shape changes.

### 2. Keys are never renamed

A key is a contract with every installed build. A new shape goes under the same
key, inside a new envelope version. Renaming a key loses the value for every
install that has not run the new build yet, and an older build never finds the
new key at all.

### 3. Caches decode to a miss

A cache holds something the server can answer again. When a value cannot be
decoded — garbage, a failed field check, an unknown version — the reader returns
`null` or the empty value, and the caller refetches. A cache never blocks a
screen, and it never guesses at a shape it does not know.

One exception: the phone's running-timer mirror is the only copy of the running
timer on a cold offline launch. Its reader requires only an id, a parseable
start and `end: null`, and gives every other field a neutral default. The
server's answer replaces it as soon as one arrives.

### 4. User-data stores hold, never drop

The offline queue holds time that no server has seen. A row that a build
cannot read is kept and shown, never read as a miss and never overwritten.

The queue (`trackyourtime.offline-queue`, every client) is written as
`{ "v": 1, "data": [rows] }` by `createOfflineQueue`, not through
`decodeVersioned`, whose miss would be an empty queue. A bare array is read
as version 1. A higher `v` locks the queue: its rows are listed as held
`unknown-op`, and nothing is written back. A value that does not parse is
copied to `trackyourtime.offline-queue.corrupt.<ms>` before the queue is reset.
A row with an op this build does not know is held, not dropped. CLAUDE.md →
"Held queue rows and the queue format" has the rest.

The extension's activity database (IndexedDB `trackyourtime-activity`) follows
the same rule. A version bump must be additive: create stores and indexes, and
never delete, rename or re-key one. When an older build finds a newer database,
IndexedDB refuses to open it with `VersionError`. The older build then stops
capture and shows "Activity data was created by a newer version of the
extension" in Settings → Activity. It does not delete the database, because the
newer build can still read it.

## Migration-bearing releases

A release is migration-bearing when it changes what is stored in MongoDB in a
way the runner has to know about: it adds a migration to
`packages/server/src/services/migrations/registry.ts`, or it changes the shape
of a collection another library owns. Its release notes say so, and say
whether older releases can still read the database afterwards (the migration's
`minReaderSchema`). See `docs/self-hosting.md` → Migrations and Rolling back.

### better-auth upgrades are migration-bearing

better-auth owns the shape of its collections (`user`, `session`, `account`,
`verification`, `organization`, `member`, `invitation`, `twoFactor`,
`deviceCode`), and a minor release can add or change fields there. That is why
`better-auth` is pinned to an exact version in `packages/server/package.json`
and `packages/client/package.json`, not a `^` range: a lockfile refresh must
never move it.

An upgrade is a deliberate change, released as migration-bearing:

1. Read the better-auth changelog for every version in between, for schema and
   stored-token changes.
2. Change both pins together, and keep the lockfile on that exact version.
3. Add a migration for any stored shape that changed. Raise its
   `minReaderSchema` when a server on the old version would misread the new
   shape, so a rollback refuses to start instead of reading it wrong.
4. Run the auth integration tests (`two-factor-integration`,
   `session-lifetime-integration`, `organization-http-lockdown`,
   `account-deletion-integration`) against a copy of a real database.
