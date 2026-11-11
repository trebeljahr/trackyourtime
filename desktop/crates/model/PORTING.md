# tyt-model: porting notes

This crate holds the pure decision logic of the Electron main process. Two sessions share it.
This file covers the tray, shortcuts, settings, windows and updates half. The coordinator's
modules (`csp`, `distribution`, `profile`, `resolve_app_path`, `secure_store`, `trust`,
`window_policy`) get their own section when the coordinator writes it.

Build and test with your own target directory:

```bash
CARGO_TARGET_DIR=<scratch>/target-<name> cargo test
CARGO_TARGET_DIR=<scratch>/target-<name> cargo clippy --all-targets -- -D warnings
```

The modules below are formatted with plain `rustfmt --edition 2021` (default config).

## Module map

| TypeScript | Rust | Tests ported |
| --- | --- | --- |
| `packages/shared/src/desktop-shortcuts.ts` (grammar) | `accelerator.rs` | `electron/src/desktop-shortcuts.test.ts`, plus the global-hotkey mapping |
| `electron/src/shortcuts.ts` | `shortcuts.rs` | `shortcuts.test.ts` |
| `electron/src/desktop-settings.ts` | `desktop_settings.rs` | `desktop-settings.test.ts`, plus the exact file bytes |
| `electron/src/tray-model.ts` | `tray_model.rs` | `tray-model.test.ts` |
| `packages/shared/src/timer-menu.ts` (and `formatDurationShort`) | `timer_menu.rs` | new (the shared file had no tests of its own) |
| JavaScript string, number and date semantics | `js_text.rs`, mounted as `timer_menu::js` | new |
| `electron/src/taskbar-model.ts` | `taskbar_model.rs` | `taskbar-model.test.ts` |
| `electron/src/login-item.ts` | `login_item.rs` | `login-item.test.ts` |
| `electron/src/idle.ts` (the pure part) | `idle.rs` | new |
| `electron/src/raycast-menu.ts` | `raycast_menu.rs` | the desktop half of `packages/raycast/scripts/menu-ownership.test.mjs` |
| `electron/src/window-state.ts`, the file half of `window.ts` | `window_state.rs` | `window-state.test.ts` |
| `electron/src/window-presentation.ts`, the launch half of `window.ts` | `window_presentation.rs` | `window-presentation.test.ts` |
| `electron/src/updater-model.ts` (policy, status), electron-updater's staging | `updater_model.rs` | `updater-model.test.ts` (the policy and status parts) |
| `createUpdateController` in `updater-model.ts`, `electron/src/updater.ts` | `updater_controller.rs` | `updater-model.test.ts` (the controller and source-rule parts) |
| `electron/src/desktop.ts`, the window handlers of `main.ts`, the close handler of `window.ts` | `desktop_controller.rs` (+ `desktop_controller/recording.rs`, `desktop_controller/tests.rs`) | what `e2e/desktop/tray.spec.ts`, `shell.spec.ts` and `compact.spec.ts` drive through the hook, plus the non-headless paths |
| `electron/src/tray.ts` | the tray diffing in `desktop_controller.rs` (`TrayUpdate`) | in `desktop_controller/tests.rs` |

149 tests in these modules. The crate total is 191 with the coordinator's tests.

## Public API for the integrator

### `desktop_controller`

```rust
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
pub fn system_clock() -> Clock;
pub const DESKTOP_TEST_HOOK: &str;          // "__trackYourTimeDesktop"
pub const SUSPEND_LIMIT_MS: i64;            // 60_000
pub const LABELS_FILE: &str;                // "tray-labels.json"
pub const WINDOW_SAVE_DELAY_MS: i64;        // 400

pub struct DesktopOptions { headless, platform: String, user_data: PathBuf, is_packaged,
    exec_path: String, current_version: String, updater_policy: UpdaterPolicy,
    default_window_mode: DesktopWindowMode, clock: Clock }
pub struct TrayUpdate { create: bool, menu: Option<Vec<TrayMenuItem>>,
    icon: Option<(TrayIconVariant, &'static str)>, title: Option<String>, tooltip: Option<String> }
pub enum CloseDecision { Close, Hide { leave_fullscreen_first: bool } }
pub struct QuitNotice { title: String, body: String }

pub trait DesktopPlatform: Send {
    fn emit(&mut self, channel: &str, payload: Value);
    fn reveal_window(&mut self);
    fn hide_window(&mut self);
    fn window_visible(&self) -> bool;
    fn window_focused(&self) -> bool;
    fn window_minimized(&self) -> bool;
    fn window(&mut self) -> Option<&mut dyn WindowOps>;
    fn tray_update(&mut self, update: &TrayUpdate);
    fn tray_destroy(&mut self);
    fn register_shortcut(&mut self, accelerator: &str, action: DesktopShortcutAction) -> Result<bool, String>;
    fn unregister_shortcut(&mut self, accelerator: &str);
    fn notifications_supported(&self) -> bool;
    fn post_notification(&mut self, notice: &DesktopNotice);
    fn close_notification(&mut self, tag: &str);
    fn set_running_badge(&mut self, on: bool, label: &str);
    fn set_user_tasks(&mut self, tasks: &[UserTask]) -> bool;
    fn show_quit_notice(&mut self, title: &str, body: &str, button: &str);
    fn quit(&mut self);
    fn pause_autopilot(&mut self, paused: bool);
}

impl DesktopController {
    pub fn new(options: DesktopOptions, platform: Box<dyn DesktopPlatform>,
               login_item: Box<dyn LoginItemBackend>,
               load_updater: Box<dyn FnOnce() -> Box<dyn UpdaterBackend> + Send>) -> Self;
    // Bridge: desktop:timer-state, desktop:settings-get, desktop:settings-update,
    // desktop:shortcuts-suspend, desktop:window-show, desktop:notify, desktop:window-get,
    // desktop:window-mode, desktop:window-pin, update:status, update:check, update:restart.
    pub fn call(&self, channel: &str, args: Vec<Value>) -> Result<Value, String>;
    pub fn test_call(&self, method: &str, args: Value) -> Result<Value, String>; // headless only
    pub fn tick(&self, now_ms: i64);
    pub fn wants_tick(&self) -> bool;
    // Shell events
    pub fn click_tray(&self, id: &str);
    pub fn tray_activated(&self);                       // Windows left click
    pub fn trigger(&self, action: DesktopShortcutAction);
    pub fn notification_clicked(&self, tag: &str);
    pub fn notification_closed(&self, tag: &str);
    pub fn raycast_menu_changed(&self, visible: bool);
    pub fn renderer_reset(&self);                        // reload or crash
    pub fn window_changed(&self);                        // move/resize/(un)maximize/fullscreen
    pub fn fullscreen_left(&self);
    pub fn window_close_requested(&self) -> CloseDecision;
    pub fn second_instance<S: AsRef<str>>(&self, argv: &[S]);
    pub fn activate(&self);                              // macOS Dock click
    pub fn launched<S: AsRef<str>>(&self, argv: &[S]);   // after the window exists
    pub fn system_shutdown(&self);
    pub fn before_quit(&self);
    pub fn will_quit(&self);
    // Updater outcomes (the shell's tauri-plugin-updater tasks)
    pub fn update_found(&self, version: &str, staging_percentage: Option<&Value>);
    pub fn update_not_found(&self);
    pub fn update_progress(&self, percent: f64);
    pub fn update_downloaded(&self, version: &str);
    pub fn update_failed(&self, error: &str);
    // Queries
    pub fn hide_on_close(&self) -> bool;
    pub fn launch_hidden<S: AsRef<str>>(&self, argv: &[S]) -> bool;
    pub fn window_launch(&self, work_areas: &[Rect], show_on_ready: bool) -> WindowLaunch;
    pub fn update_snapshot(&self) -> DesktopUpdateSnapshot;
    pub fn window_snapshot(&self) -> DesktopWindowSnapshot;
    pub fn settings(&self) -> DesktopSettings;
}
```

`desktop_controller::recording::{RecordingPlatform, SharedWindow, FakeWindow, Recording, RecordedTray}`
is a `DesktopPlatform` that records every call. It has a fake window. The controller's tests use it,
and the shell may use it too.

Startup order, as main.ts did it: build the controller first, then call
`window_launch(work_areas, !launch_hidden(argv))` and create the window from it. After that, call
`launched(argv)`, start the Raycast watch (`raycast_menu::spawn_raycast_menu_watch` or a polled
`RaycastMenuWatch` → `raycast_menu_changed`), and call `tick(now)` about once a second.

Test hook methods for `test_call`: `state`, `settings`, `trayMenu`/`trayTitle`/`trayTooltip` (each
takes an optional `nowMs`), `clickTray`, `trigger`, `registered`, `takeChord`, `notifications`,
`clickNotification`, `pretendFocused`, `quitNotices`, `badge`, `reveals`, `commands`,
`update.snapshot`, `update.dispatch`, `update.installs`, `update.checks`, and `beforeQuit`. `args`
is the single argument the TypeScript method took (`null` when it took none). An array is read as
its first element. `activity.*` belongs to the activity crate: route it there.

### `updater_controller`

```rust
pub struct UpdaterConfig { auto_download, install_on_quit, allow_prerelease, allow_downgrade }
pub const UPDATER_CONFIG: UpdaterConfig;   // true, true, false, false
pub trait UpdaterBackend: Send {
    fn configure(&mut self, _config: &UpdaterConfig) {}
    fn check(&mut self) -> Result<(), String>;      // starts; answer via found/not_found/failed
    fn download(&mut self) -> Result<(), String>;   // starts; answer via progress/downloaded/failed
    fn install_on_quit(&mut self);
    fn install_and_restart(&mut self);              // reached only through UpdateController::restart
}
pub struct MemoryUpdaterBackend { pub counts: Arc<Mutex<MemoryUpdaterCounts>> }
pub struct MemoryUpdaterCounts { checks, downloads, installs, quit_installs, configured }
pub struct UpdateControllerOptions { policy, current_version, auto_check, now_ms, staging_id_dir: Option<PathBuf> }
impl UpdateController {
    pub fn new(options, load: impl FnOnce() -> Box<dyn UpdaterBackend>) -> Self;
    pub fn snapshot(&self) -> DesktopUpdateSnapshot;
    pub fn status(&self) -> &DesktopUpdateStatus;
    pub fn is_ready(&self) -> bool;
    pub fn take_changes(&mut self) -> Vec<DesktopUpdateSnapshot>;
    pub fn dispatch(&mut self, event: UpdaterEvent, now_ms: i64) -> bool;
    pub fn check(&mut self, now_ms: i64) -> DesktopUpdateSnapshot;
    pub fn found(&mut self, version: &str, staging_percentage: Option<&Value>, now_ms: i64);
    pub fn not_found(&mut self, now_ms: i64);
    pub fn progress(&mut self, percent: f64, now_ms: i64);
    pub fn downloaded(&mut self, version: &str, now_ms: i64);
    pub fn failed(&mut self, error: &str, now_ms: i64);
    pub fn restart(&mut self, before_install: &mut dyn FnMut()) -> bool;
    pub fn app_will_quit(&mut self);
    pub fn tick(&mut self, now_ms: i64);
    pub fn is_scheduled(&self) -> bool;
    pub fn dispose(&mut self);
}
```

`updater_model` holds `updater_policy(channel, has_feed, env)`, `next_update_status`, `may_check`,
`UpdaterEvent` (serde `{kind: …}`, as the hook's `update.dispatch` sends it), and the staged
rollout functions: `is_staging_match(staging_percentage, id)`, `staging_bucket(id)`,
`is_valid_staging_id`, `read_or_create_staging_user_id(user_data)`, `new_staging_user_id()` and
`UPDATER_ID_FILE`.

### `shortcuts` and `accelerator`

```rust
pub trait ShortcutRegistrar {
    fn register(&mut self, accelerator: &str, action: DesktopShortcutAction) -> Result<bool, String>;
    fn unregister(&mut self, accelerator: &str);
}
impl ShortcutManager {
    pub fn new() -> Self;
    pub fn apply(&mut self, registrar: &mut dyn ShortcutRegistrar, bindings: &DesktopShortcutBindings) -> Vec<DesktopShortcutStatus>;
    pub fn suspend(&mut self, registrar: &mut dyn ShortcutRegistrar);
    pub fn resume(&mut self, registrar: &mut dyn ShortcutRegistrar) -> Vec<DesktopShortcutStatus>;
    pub fn is_suspended(&self) -> bool;
    pub fn statuses(&self) -> &[DesktopShortcutStatus];
    pub fn dispose(&mut self, registrar: &mut dyn ShortcutRegistrar);
}
pub struct MemoryRegistrar { pub taken: Vec<String>, pub registered: Vec<(String, DesktopShortcutAction)> }
impl MemoryRegistrar { new, take, accelerators, fire }

pub enum AcceleratorModifier { CommandOrControl, Command, Control, Super, Alt, Shift }
pub const MODIFIER_ORDER: [AcceleratorModifier; 6];
pub struct ParsedAccelerator { pub modifiers: Vec<AcceleratorModifier>, pub key: String }
pub fn parse_accelerator(input: &str) -> Option<ParsedAccelerator>;
pub fn normalize_accelerator(input: &str) -> Option<String>;
pub fn accelerator_chord(input: &str, platform: &str) -> Option<String>;
pub fn duplicate_shortcut_action(bindings: &DesktopShortcutBindings, action: DesktopShortcutAction,
                                 accelerator: &str, platform: &str) -> Option<DesktopShortcutAction>;
pub fn is_desktop_shortcut_action(value: &str) -> bool;
pub fn tauri_accelerator(accelerator: &str) -> Option<String>;   // global-hotkey syntax
```

The settings file, the memory registrar and the hook's `registered()` keep the canonical Electron
spelling. Only the shell's call into `tauri-plugin-global-shortcut` uses `tauri_accelerator`. A
test runs every key the grammar accepts through the real `global_hotkey::HotKey::from_str` (a
dev-dependency, the same 0.8 parser the plugin uses) and checks the modifiers and the key.

### Others

- `desktop_settings`: `default_desktop_settings`, `parse_desktop_settings`, `apply_settings_patch`
  (takes the raw JSON, as the TypeScript took `unknown`), `read_desktop_settings`,
  `write_desktop_settings`. The file is byte-identical to Electron's (`JSON.stringify(…, null, 2)`
  plus a newline, temp file and rename).
- `tray_model`: `fallback_tray_labels`, `parse_tray_labels`, `parse_timer_state`, `tray_clock`,
  `elapsed_sec_at`, `running_label`, `autopilot_paused_at`, `TrayMenuItem` (serde
  `{type: "item" | "heading" | "separator"}`), `tray_menu_model(state, update_ready, now_ms)`,
  `tray_title`, `tray_tooltip`, `TrayIconVariant`, `tray_icon_variant`, `tray_icon_file`,
  `OVERLAY_RUNNING_FILE`, `parse_notice`, `AUTOPILOT_MARK`, `MAX_TRAY_RECENTS`.
- `timer_menu`: `timer_menu_clock`, `timer_menu_text`, `format_duration_short`,
  `timer_menu_sections`, `TimerMenuLabels`, `raycast_menu_visible`, the lease path parts,
  `RAYCAST_MENU_POLL_MS`.
- `raycast_menu`: `process_alive`, `has_raycast_menu`, `publish_desktop_menu`,
  `RaycastMenuWatch::{start, poll}`, `spawn_raycast_menu_watch`.
- `login_item`: `LoginItemBackend`, `MemoryLoginItem`, `UnsupportedLoginItem`, `LinuxLoginItem`,
  `quote_exec_arg`, `linux_autostart_entry`, `linux_autostart_path`, `is_hidden_launch`,
  `select_login_item(headless, is_packaged, mechanism, env, home, native)`, `native_login_status`,
  `windows_run_command`, `WINDOWS_RUN_VALUE_NAME`, `HIDDEN_LAUNCH_ARG`.
- `idle`: `IDLE_POLL_MS`, `IdleState`, `IdleSample`, `idle_state`, `IdleTracker`.
- `taskbar_model`: `UserTask`, `windows_user_tasks`, `requested_window_mode`.
- `window_state`: `Rect`, `WindowState`, `InitialBounds`, `initial_bounds`, `parse_window_state`,
  `read_window_state`, `write_window_state`, `background_color_for`, and the size constants.
- `window_presentation`: `WindowOps`, `WindowPresentation`, `PresentationEffects`, `WindowLaunch`,
  `window_launch`.

## What the shell must keep

These rules are not enforced in this crate. They depend on how the shell implements the traits.

- **Coordinates are logical (DIP) pixels** in `WindowOps` and `window-state.json`, as Electron's
  `getNormalBounds` reported them. Convert Tauri's physical positions and sizes with the scale
  factor, or an existing install's window opens at the wrong place.
- **Never call back into the controller from a platform method.** They run under the controller's
  lock. Tauri delivers clicks and window events on the event loop afterwards, which is fine. Do not
  invoke a controller method synchronously from inside `emit`, `quit`, `reveal_window` or a dialog
  callback.
- **`register_shortcut` takes the canonical accelerator.** Convert it with
  `accelerator::tauri_accelerator`. Map a plugin "already registered" error to `Ok(false)` and a
  parse error to `Err`.
- **`install_and_restart` is the only way to restart for an update.** It runs only after
  `before_install` has set the controller's quitting flag. The close handler must ask
  `window_close_requested()`, as window.ts's handler did, so the window closes instead of hiding.
- **Install on quit:** `will_quit` calls `install_on_quit` when an update is ready. With
  tauri-plugin-updater, keep the downloaded bytes and call `install` at that moment. On Windows the
  NSIS installer then runs and the process exits. Do not relaunch.
- **Staged rollout:** pass the feed's raw `stagingPercentage` (from `Update.raw_json`) to
  `update_found`. The release scripts must write it into `latest.json` the way
  `scripts/lib/desktop-rollout.mjs` writes it into `latest*.yml`. `100` removes the key.
- **Headless:** the controller never calls the tray, shortcut, notification, badge, dialog or
  reveal methods. The window and `emit` stay real. The shell must still never show or focus a
  window headless, and must keep the window painting while hidden.

## Deviations and gaps

1. **Shortcut registrar.** TypeScript passed a callback per registration. Here the action travels
   with the accelerator, and the shell reports a press with `trigger(action)`.
2. **Leaving fullscreen is two steps.** TypeScript awaited `leaveFullscreen()`. A blocking wait
   would deadlock on the thread that delivers the window's events. `WindowOps::leave_fullscreen`
   returns `false` when the window has to animate out, and the shell calls `fullscreen_left()`.
   Changes that arrive meanwhile update the preferences, and the switch uses the latest of them.
   TypeScript queued them, which ends in the same state. Meanwhile `desktop:window-mode` answers
   with the current, unswitched snapshot. The switched one follows as `desktop:window-changed`,
   which the renderer already follows.
3. **Window effects are returned, not called back.** `WindowPresentation` returns
   `PresentationEffects`. The controller writes `window-state.json` and emits
   `desktop:window-changed`. The window channels moved from main.ts into the controller.
4. **Time is ticked.** The tray clock, the 60 s shortcut suspension, the updater's 30 s/6 h
   schedule and the 400 ms bounds debounce all resolve in `tick(now)`. The resolution is whatever
   interval the shell ticks at (once a second is enough). The tray is diffed and redrawn on every
   tick. Electron redrew every second while running, plus a timeout at the end of an Autopilot
   pause. The result on screen is the same. A missed six-hour interval fires once, as a Node
   interval does.
5. **`Date.parse`** accepts the ECMAScript date-time format only. That is what the renderer sends.
   V8's legacy fallback formats are refused. A date-time without an offset is read as UTC, not as
   local time.
6. **UTF-16 slicing.** `slice(0, n)` keeps whole characters. A surrogate pair that straddles the
   cut is dropped, because a Rust `String` cannot hold a lone surrogate.
7. **An accelerator quirk is not reproduced.** In TypeScript the tokens `constructor` and
   `__proto__` found `Object.prototype` members in `MODIFIER_ALIASES` and acted as invisible
   modifiers, so `constructor+F13` normalized to `F13`. Here they are unknown keys and refused.
8. **New staging ids** are 16 random bytes with the version-5 and RFC 4122 variant bits set.
   electron-updater hashed 4096 random bytes with SHA-1. Only the shape is ever checked, and an
   existing `.updaterId` is read and bucketed exactly as before, upper-case quirk included.
   electron-updater also sent the id as an `x-user-staging-id` header, which nothing read. Here it
   is not sent.
9. **Version comparison** is the Tauri updater's (newer only). electron-updater compared semver and
   allowed no downgrade. The result is the same for this app's tags.
10. **Settings patches** are read from the raw JSON. With serde_json's default map the shortcut
    entries are visited in alphabetical order, not JavaScript's insertion order. That matters only
    when one patch binds two actions to the same chord, and the renderer sends one action per
    patch. Wire's `DesktopSettingsPatch` uses a `BTreeMap` and has the same property, so it is not
    used here.
11. **Test hook shape.** `notifications`, `quitNotices` and `commands` are methods; they were live
    arrays. `beforeQuit` is new and stands in for the specs' `app.emit("before-quit")`. `state`
    adds `"autopilot": null` when Autopilot is off, as `parseTimerState` wrote it. The wire type
    omits the key.
12. **`tray-labels.json` key order** follows the wire struct, not the TypeScript object. The file
    is read by key, so either order loads.
13. **Login items.** Only the pure parts are here. The macOS (SMAppService) and Windows (`Run` key)
    backends belong to the shell, which implements `LoginItemBackend`. `native_login_status` reads
    status the way desktop.ts read `getLoginItemSettings`. `WINDOWS_RUN_VALUE_NAME` and
    `windows_run_command` reproduce what Electron wrote, so an existing entry reads as enabled.
    Both are taken from Electron's documented defaults (value name = the AppUserModelId) and are
    not verified against a real install.
14. **Idle.** Only the state rule and the lock flag are here. Reading the OS idle counter and the
    lock, suspend, unlock and resume events is the shell's job. Tauri has no `powerMonitor`, so it
    needs a crate or OS calls.
15. **Notification clicks.** The controller handles `notification_clicked(tag)`. Whether the shell
    can deliver clicks depends on the notification library. `tauri-plugin-notification` reports no
    clicks on desktop.
16. **Jump-list tasks** (`set_user_tasks`) have no Tauri API. The shell needs the Windows
    `ICustomDestinationList` through the `windows` crate. Until then, return `false`, and the
    controller tries again on the next label change.
17. **`process_alive`** uses `kill(pid, 0)` on Unix (`libc`). It always returns `false` elsewhere,
    where nothing reads Raycast leases.
18. **Crate dependencies added** (appended to Cargo.toml): `getrandom 0.4` (new staging ids),
    `libc 0.2` on Unix (`process_alive`), and the dev-dependency `global-hotkey 0.8` (the mapping
    test).
