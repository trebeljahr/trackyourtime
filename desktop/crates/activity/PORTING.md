# tyt-activity — porting notes

Desktop activity capture and Autopilot, ported from `electron/src/activity/**`
and `packages/core/src/activity/**` to Rust with no Tauri and no async runtime.
The rules in CLAUDE.md → "Desktop activity capture" and "Autopilot" hold here
unchanged; the comments in each module keep the TypeScript's reasoning.

## Module map

| TypeScript | Rust |
| --- | --- |
| `packages/core/src/activity/types.ts` | `core::types` (rule, proposal, interval, filing and history types are aliases of the `tyt_wire` types) |
| `packages/core/src/activity/segments.ts` | `core::segments` |
| `packages/core/src/activity/rules.ts` | `core::rules` |
| `packages/core/src/activity/suggest.ts` | `core::suggest` |
| `packages/core/src/activity/autopilot.ts` | `core::autopilot` |
| `electron/src/activity/keys.ts` | `keys` |
| `settings.ts` | `settings` |
| `model.ts` | `model` |
| `store.ts` | `store` |
| `protection.ts` | `protection` |
| `vault.ts` | `vault` |
| `secure-store.ts` (`createSecureStore`, as the vault uses it) | `secure_store` |
| `suggest.ts` | `suggest` |
| `autopilot.ts` | `autopilot` |
| `service.ts` | `service` |
| `source.ts` | `source` (traits, restart policy, line splitter) + `timers` (`Timers`, real and fake) |
| `source-macos.ts` | `source_macos` |
| `source-windows.ts` | `source_windows` (script in `src/windows-foreground.ps1`) |
| `source-linux.ts` | `source_linux` |
| `macos-titles.ts` | `macos_titles` (script in `src/macos-title.js`) |
| `process-runner.ts` | `process_runner` (the only module that touches `std::process`) |
| `platform-source.ts` | `platform_source` |
| `source-fake.ts` | `source_fake` |
| `ipc-parse.ts` | `ipc_parse` |
| `test-hook.ts` | `test_hook` |
| `install.ts` | `install` (`ActivityController`) |
| `wire.ts` | not needed: core's types *are* the wire types (aliases cannot drift) |
| `distribution.ts` → `activityCaptureSupport` | `distribution` |
| — | `js` (the JavaScript semantics the port relies on: whitespace, UTF-16 order and length, `Math.round`, `JSON.stringify` numbers, ISO dates) |

Tests: every `*.test.ts` above is ported (`#[cfg(test)]` modules, plus
`src/{service,sources,vault,install}_tests.rs`), with the same cases and names
in snake case. `headless.test.ts` and `import-graph.test.ts` became
`tests/no_spawn.rs` (source-text checks: only `install.rs` builds a platform
source and only outside headless; only `process_runner.rs` touches
`std::process`; no timer or idle sample headless; no network code and an
allowlist of dependencies; no permission-prompt API). `distribution.test.ts`'s
`activityCaptureSupport` cases are in `distribution`.

## Public API (for the shell)

```rust
pub struct ActivityOptions {
    pub headless: bool,
    pub platform: String,            // "darwin" | "win32" | "linux"
    pub channel: String,             // DistributionChannel as distribution.ts names it
    pub env: HashMap<String, String>,
    pub user_data: PathBuf,
    pub encryption: Option<Arc<dyn tyt_wire::Encryption>>, // ignored headless
    pub titles_permitted: Arc<dyn Fn() -> bool + Send + Sync>,
    pub parent_pid: u32,
}
pub trait ActivityHost: Send + Sync + 'static {
    fn changed(&self, snapshot: &DesktopActivitySnapshot); // already throttled (CHANGED_THROTTLE_MS)
}
impl ActivityController {               // Send + Sync, 'static
    pub fn install(options: ActivityOptions, host: Arc<dyn ActivityHost>) -> Self;
    pub fn handles(channel: &str) -> bool;  // the 18 activity:* call channels
    pub fn call(&self, channel: &str, args: Vec<Value>) -> Result<Value, String>;
    pub fn idle(&self, sample: &DesktopIdlePayload);
    pub fn pause_autopilot(&self, paused: bool);
    pub fn test_call(&self, method: &str, args: Value) -> Result<Value, String>;
    pub fn dispose(&self);              // idempotent; also on Drop
}
```

As specified, with these details:

- **`call`** takes the renderer's arguments as passed; only `args[0]` is read
  (every activity channel takes one input or none). Results are JSON with
  numbers written as JavaScript writes them (`1792367400000`, not `…0.0`).
  `activity:scope`, `activity:forget`, `activity:accepted` and the
  `activity:autopilot-{learn,applied,hold,pause}` calls answer `null`. A bad
  payload is answered exactly as `install.ts` answered it (the snapshot, the
  current rules, `{kind:"none"}`, `{ok:false,reason:"bad-range"}`, `false`,
  `null`), never with an error. Errors are the TypeScript's messages
  (`Invalid activity key`, `Activity belongs to another account`,
  `A secure OS keychain is required to trust this device`,
  `Activity vault is closed`, …).
- **`test_call`** errors outside headless. `args` is the hook method's one
  argument, or a positional array: `setFrontmost({key,name,title?}|null)`,
  `setNow(ms|null)`, `tick()`, `heartbeat()`, `idle("idle", 120)` /
  `idle(["idle", 120])` / `idle({state, idleSeconds})`,
  `setSupport(DesktopActivitySupport|null)`, `setTitlesAvailable(bool)`,
  `sourceKind()` → `"fake"`, `capturing()`, `spawns()` → `[]`, `files()` →
  `{state, open, segments}`. `tick` returns after the detection was handled
  (a barrier through the event loop), like `await hook.tick()`.
- **Threads.** One background thread runs an mpsc loop: source answers, the
  heartbeat (60 s) and the daily prune (both non-headless only), and the push
  throttle. Bridge calls run on the caller's thread. Both take one lock around
  the vault and its service, which is the TypeScript's `serial()` queue.
  `host.changed` is called on the loop thread without that lock; it must not
  block on the thread that calls `dispose` (which joins the loop).
- **Platform sources** spawn only non-headless, only on a supported channel,
  and only while capture should run. macOS: `/usr/bin/lsappinfo` per 5 s poll
  (two short-lived processes per poll at most, each on a helper thread);
  Windows: one `powershell.exe -EncodedCommand` with `CREATE_NO_WINDOW`;
  Linux: `xprop -spy` plus one `xprop -id` per window change. Each platform
  source owns one timer thread.
- **`selfPid`** (never recorded) is `std::process::id()` of the shell process.

## On-disk compatibility

The Tauri build reads and writes the Electron build's `<userData>/activity/**`
in place: `state.json` (`v: 1`, the newer-format lock), `open.json`,
`segments/YYYY-MM-DD.jsonl` (UTC day of the start, torn lines skipped),
`protection.json`, `migration-backup.bin`, `*.torn.*`, `state.json.corrupt.<ms>`,
`<userData>/activity-protection-required`, the `activity.previous` /
`activity.protecting` swap folders, modes 0700/0600, and encrypted boxes
`{"v":2,"algorithm":"AES-256-GCM","nonce","data","tag"}` (base64url, no
padding; AAD `JSON.stringify(["trackyourtime-activity-v1", account, file])`;
`account = sha256(JSON.stringify([origin, userId]))`).

Proved by `tests/ts_store_compat.rs`:

- `fixtures/ts-store/` was written by the TypeScript store and codec
  (`fixtures/ts-store.mts`, a fixed key, committed): the Rust store reads the
  plain and the encrypted folder to the same `files()` the TypeScript answered,
  verifies the TypeScript's ciphertext, and appends to it.
- The same operations through the Rust store give **byte-identical** segment
  files and `open.json`, and the same JSON in `state.json`.
- A folder the Rust store wrote and protected opens in the TypeScript store
  and verifies with its codec (`fixtures/read-store.mts`; runs when `node` and
  the repo's `tsx` are present, skipped with a note otherwise or with
  `TYT_SKIP_NODE=1`).

`activity-device-key.bin` (the remembered key, "trust this device") is the
shell `Encryption`'s ciphertext. An Electron-era file is `safeStorage`
ciphertext; it opens only if the shell's `Encryption` decrypts old blobs (the
brief's plan). If it cannot, the secure store deletes the file and the person
enters the key once — never a plaintext fallback.

## Cross-language conformance

`fixtures/generate.mts` runs the TypeScript core over hand-picked and
seeded-random cases (1,343 of them: merge, union, subtract, host globs, rules,
suggestions, filing keys, learning, resolvers, runs, streaks, 400 Autopilot
decisions, breaks) and writes `fixtures/core-*.json`; `tests/conformance.rs`
replays every case and requires the same JSON, numbers compared as f64 —
bit-identical, including every `share`. `fixtures/check.mjs` (from the repo
root) regenerates into a temp dir and fails when a committed file is stale, and
also when `src/windows-foreground.ps1` or `src/macos-title.js` no longer equal
the TypeScript constants; `--write` regenerates both.

## Deviations, and why

1. **Promises → a lock and an event loop.** Source listeners hand their
   answers to the loop (`SourceEvent { service, run, … }`) instead of
   `void serial(…)`; an answer from a stopped run, or from a service the
   vault has since replaced, is dropped by its `(service, run)` id — the
   TypeScript compared `run === sourceRun` per service, and a replaced
   service was disposed.
2. **Process runner.** `spawn` takes its line and exit callbacks up front (a
   real child could print before late registration). A binary that will not
   start reports an exit with no code from a helper thread, like Node's
   `error` event. `run` reproduces `execFile`'s `timeout` (10 s) and
   `maxBuffer` (64 KiB): either gives no exit code.
3. **The macOS Screen Recording prompt.** `install.ts` called
   `desktopCapturer.getSources` on the first deliberate "store titles" toggle
   to make macOS ask. The crate has no way to prompt (and must not: no
   permission API in this crate, `tests/no_spawn.rs`). The shell should
   request the permission itself (e.g. `CGRequestScreenCaptureAccess`) when
   `activity:settings` carries `storeTitles: true` on macOS, before forwarding
   the call; the crate then checks `titles_permitted()` and, if still not
   granted, saves titles off and answers `titlesPermissionRequired: true`,
   exactly as before.
4. **JavaScript strings.** Lengths, slices and sort order use UTF-16 code
   units, whitespace is ECMAScript's set (`js`). Two unavoidable differences:
   a `slice` that would split a surrogate pair drops the pair (JavaScript
   would keep a lone surrogate, which a Rust `String` cannot hold); and the
   xprop decoder keeps an unescaped non-BMP character whole where the
   TypeScript, iterating code units, turned it into two U+FFFD. Lowercasing
   uses Rust's Unicode mapping (what V8 implements, final sigma included).
5. **`state.json` key order.** JavaScript orders an object's keys by how it
   was built, which differs by code path (a fresh rule is
   `{pattern,…,id,scope,createdAt}`, a reloaded one `{scope,id,pattern,…}`).
   The Rust store always writes one canonical order. The content is the same
   JSON, and every reader parses it; segment lines and `open.json` are
   byte-identical.
6. **Idle state names.** A sample whose state is neither `active` nor
   `locked` (e.g. `unknown`) is treated as `idle`, which is what `model.ts`'s
   `step` did with it.
7. **`serde_json` `float_roundtrip`.** Enabled so a number read from the
   renderer, a file or a fixture is the exact f64 JavaScript wrote (the
   default parser can land one ULP off; the conformance replay caught it).
   Feature unification turns it on for the whole shell; that only makes
   float parsing exact.
8. **Pids** are parsed as `i64`; a digit string too long for one reads as no
   pid (JavaScript would make an imprecise number).
9. **`secure_store`** is a local port of `createSecureStore` for the one file
   the vault uses, so this crate does not depend on `tyt-model`.

No gaps: every module and test listed above is ported. The opt-in
"real lsappinfo" test runs with `TRACKYOURTIME_ACTIVITY_REAL_SOURCE_TEST=1`
on macOS, as before.

## Wire notes for the coordinator

No `tyt_wire` type needed a change. One observation: `DesktopIdlePayload`
has `idle_seconds: u64`, so a fractional `idleSeconds` from a renderer would
not deserialize; the shell's idle monitor produces whole seconds, so nothing
breaks today.

## Commands

```bash
CARGO_TARGET_DIR=<scratch> cargo test                       # in desktop/crates/activity
CARGO_TARGET_DIR=<scratch> cargo clippy --all-targets -- -D warnings
CARGO_TARGET_DIR=<scratch> cargo check --all-targets --target x86_64-pc-windows-msvc
CARGO_TARGET_DIR=<scratch> cargo check --all-targets --target x86_64-unknown-linux-gnu
node desktop/crates/activity/fixtures/check.mjs              # from the repo root
node --import tsx desktop/crates/activity/fixtures/ts-store.mts   # regenerate ts-store (new nonces)
```
