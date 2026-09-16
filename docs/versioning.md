# Versioning

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

The extension's activity database (IndexedDB `trackyourtime-activity`) follows
the same rule. A version bump must be additive: create stores and indexes, and
never delete, rename or re-key one. When an older build finds a newer database,
IndexedDB refuses to open it with `VersionError`. The older build then stops
capture and shows "Activity data was created by a newer version of the
extension" in Settings → Activity. It does not delete the database, because the
newer build can still read it.
