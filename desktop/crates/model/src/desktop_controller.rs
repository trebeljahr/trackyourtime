//! Stages 4, 5 and 7 of docs/desktop-app-plan.md, wired together: the tray,
//! the global shortcuts, Settings → Desktop, open at login, notifications for
//! prompts a hidden window would swallow, the running badge, the notice on
//! quitting with unsent changes, the updater's status and "Restart to update".
//! Ported from `electron/src/desktop.ts` (and the window handlers of
//! `main.ts` / `window.ts`), generic over a [`DesktopPlatform`] the Tauri
//! shell implements.
//!
//! The renderer owns the timer (the socket, the offline queue, the locale);
//! the shell draws what it publishes and sends commands back. Nothing here
//! starts or stops a timer by itself. The one tray item that does not go back
//! to the renderer is Autopilot's pause, whose state lives in the activity
//! crate and is handed straight to it ([`DesktopPlatform::pause_autopilot`]).
//!
//! **Headless** (tests, agents): no tray icon, no global shortcut registered
//! with the OS, no notification posted, no dialog, no badge, no login item
//! and no window shown, focused or pinned. Each of those is recorded instead,
//! and [`DesktopController::test_call`] reads and drives the record with the
//! method names and JSON shapes of `globalThis.__trackYourTimeDesktop`
//! (`DesktopTestHook`). The updater is a memory stand-in there: no network,
//! and a restart is counted instead of quitting. The window and the renderer
//! are real in a headless run: commands, settings and window changes still
//! reach the page through [`DesktopPlatform::emit`].
//!
//! Time: everything that ticks (the tray clock, the 60-second shortcut
//! suspension, the updater's schedule, the window-bounds debounce) moves only
//! in [`DesktopController::tick`], which the shell calls about once a second
//! with the clock's time; calls in between read the injected [`Clock`].
//!
//! Threading: the controller is `Sync` (one mutex). Platform methods run with
//! that lock held, so they must not call back into the controller
//! synchronously — report events (a click, a notification click, a window
//! event) from the event loop afterwards, as Tauri delivers them anyway.

pub mod recording;

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use serde_json::{json, Value};
use tyt_wire::{
    channels, DesktopCommand, DesktopLoginItemStatus, DesktopNotice, DesktopSettings,
    DesktopSettingsCapabilities, DesktopSettingsSnapshot, DesktopSettingsUpdate,
    DesktopShortcutAction, DesktopTimerState, DesktopTrayLabels, DesktopUpdateSnapshot,
    DesktopWindowMode, DesktopWindowSnapshot,
};

use crate::desktop_settings::{
    apply_settings_patch, read_desktop_settings, write_desktop_settings,
};
use crate::login_item::{is_hidden_launch, LoginItemBackend};
use crate::shortcuts::{MemoryRegistrar, ShortcutManager, ShortcutRegistrar};
use crate::taskbar_model::{requested_window_mode, windows_user_tasks, UserTask};
use crate::tray_model::{
    parse_notice, parse_timer_state, parse_tray_labels, tray_icon_file, tray_icon_variant,
    tray_menu_model, tray_title, tray_tooltip, TrayIconVariant, TrayMenuItem,
};
use crate::updater_controller::{
    MemoryUpdaterBackend, UpdateController, UpdateControllerOptions, UpdaterBackend,
};
use crate::updater_model::{UpdaterEvent, UpdaterPolicy};
use crate::window_policy::desktop_window_policy;
use crate::window_presentation::{
    window_launch, PresentationEffects, WindowLaunch, WindowOps, WindowPresentation,
};
use crate::window_state::{read_window_state, write_window_state, Rect, WindowState};

/// The global the Electron build installed its hook on; the shell's e2e
/// bridge exposes [`DesktopController::test_call`] under the same name.
pub const DESKTOP_TEST_HOOK: &str = "__trackYourTimeDesktop";
/// How long Settings may hold the shortcuts unregistered before they come back on their own.
pub const SUSPEND_LIMIT_MS: i64 = 60_000;
pub const LABELS_FILE: &str = "tray-labels.json";
/// How many sent commands the test hook keeps.
pub const MAX_RECORDED_COMMANDS: usize = 100;
/// Window bounds are remembered this long after the last move or resize.
pub const WINDOW_SAVE_DELAY_MS: i64 = 400;

/// Epoch milliseconds now.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

pub fn system_clock() -> Clock {
    Arc::new(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    })
}

/// What changed in the tray since the last draw; `None` fields stay as they
/// are. The first update after a tray is (re)created has `create` set and
/// every field filled.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TrayUpdate {
    pub create: bool,
    pub menu: Option<Vec<TrayMenuItem>>,
    /// The variant and its file under the bundle's `tray/` directory.
    pub icon: Option<(TrayIconVariant, &'static str)>,
    /// macOS only: the text beside the icon (monospaced digits, so it does
    /// not jitter as the clock ticks). Empty clears it.
    pub title: Option<String>,
    pub tooltip: Option<String>,
}

/// What the close button does (window.ts's close handler).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseDecision {
    /// Let the window close (quitting, or no way back to a hidden window).
    Close,
    /// Prevent the close and hide; leave fullscreen first when in it, or the
    /// hidden window comes back as an empty fullscreen space on macOS.
    Hide { leave_fullscreen_first: bool },
}

/// The shell. Called only from the controller, with its lock held: never call
/// back into the controller from these methods.
pub trait DesktopPlatform: Send {
    /// Push to the renderer: `desktop:command`, `desktop:settings-changed`,
    /// `desktop:window-changed`, `update:status-changed`.
    fn emit(&mut self, channel: &str, payload: Value);

    /// Show and focus the window, bringing the app in front (on macOS
    /// `focus` alone leaves it behind the app that had focus): restore it
    /// when minimized, put it back in the taskbar off macOS, and open a new
    /// window when there is none (main.ts's `showMain`). Never called
    /// headless.
    fn reveal_window(&mut self);
    fn hide_window(&mut self);
    /// False when there is no window.
    fn window_visible(&self) -> bool;
    fn window_focused(&self) -> bool;
    fn window_minimized(&self) -> bool;
    /// The window the presentation (full or compact) drives; `None` before it
    /// exists or after it closed.
    fn window(&mut self) -> Option<&mut dyn WindowOps>;

    /// Create the tray when `update.create`, then apply what is set. Never
    /// called headless. Clicks come back through
    /// [`DesktopController::click_tray`] with the item's id; on Windows a
    /// left click on the icon is [`DesktopController::tray_activated`].
    fn tray_update(&mut self, update: &TrayUpdate);
    fn tray_destroy(&mut self);

    /// Register a canonical accelerator (convert it with
    /// [`crate::accelerator::tauri_accelerator`]); `Ok(false)` when another
    /// application holds it, `Err` when it cannot be registered. Report a
    /// press with [`DesktopController::trigger`]. Never called headless.
    fn register_shortcut(
        &mut self,
        accelerator: &str,
        action: DesktopShortcutAction,
    ) -> Result<bool, String>;
    fn unregister_shortcut(&mut self, accelerator: &str);

    fn notifications_supported(&self) -> bool;
    /// Post a notification. A click comes back through
    /// [`DesktopController::notification_clicked`] with its tag. Never
    /// called headless.
    fn post_notification(&mut self, notice: &DesktopNotice);
    /// Withdraw the posted notification with this tag (a newer one replaces it).
    fn close_notification(&mut self, tag: &str);

    /// macOS: the Dock badge `●` (or none). Windows: the taskbar overlay icon
    /// (`tray_model::OVERLAY_RUNNING_FILE`) with `label` as its description.
    /// Elsewhere nothing. Never called headless.
    fn set_running_badge(&mut self, on: bool, label: &str);
    /// The jump-list tasks (Windows); true when they were set.
    fn set_user_tasks(&mut self, tasks: &[UserTask]) -> bool;

    /// An informational dialog with one button; quitting proceeds after it.
    /// Never called headless.
    fn show_quit_notice(&mut self, title: &str, body: &str, button: &str);
    /// Quit the app (the shell then calls `before_quit` and `will_quit`).
    fn quit(&mut self);

    /// "Pause Autopilot for an hour" (true) and "Resume Autopilot" (false).
    fn pause_autopilot(&mut self, paused: bool);
}

#[derive(Clone)]
pub struct DesktopOptions {
    pub headless: bool,
    /// "darwin" | "win32" | "linux", as Node spelled it.
    pub platform: String,
    /// The profile directory (profile.rs), which holds `desktop-settings.json`,
    /// `tray-labels.json`, `window-state.json` and `.updaterId`.
    pub user_data: PathBuf,
    pub is_packaged: bool,
    /// The executable the Windows jump-list tasks start.
    pub exec_path: String,
    pub current_version: String,
    /// From `updater_model::updater_policy`; ignored headless, where the
    /// memory updater is always on.
    pub updater_policy: UpdaterPolicy,
    /// `window_policy::default_window_mode`, for a profile with no saved mode.
    pub default_window_mode: DesktopWindowMode,
    pub clock: Clock,
}

impl std::fmt::Debug for DesktopOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DesktopOptions")
            .field("headless", &self.headless)
            .field("platform", &self.platform)
            .field("user_data", &self.user_data)
            .field("is_packaged", &self.is_packaged)
            .field("exec_path", &self.exec_path)
            .field("current_version", &self.current_version)
            .field("updater_policy", &self.updater_policy)
            .field("default_window_mode", &self.default_window_mode)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QuitNotice {
    pub title: String,
    pub body: String,
}

/// The last values drawn into the tray, for diffing.
#[derive(Debug, Clone, Default)]
struct DrawnTray {
    created: bool,
    menu: Option<Vec<TrayMenuItem>>,
    variant: Option<TrayIconVariant>,
    title: Option<String>,
    tooltip: Option<String>,
}

struct PlatformRegistrar<'a>(&'a mut dyn DesktopPlatform);

impl ShortcutRegistrar for PlatformRegistrar<'_> {
    fn register(
        &mut self,
        accelerator: &str,
        action: DesktopShortcutAction,
    ) -> Result<bool, String> {
        self.0.register_shortcut(accelerator, action)
    }
    fn unregister(&mut self, accelerator: &str) {
        self.0.unregister_shortcut(accelerator);
    }
}

struct Inner {
    headless: bool,
    platform_name: String,
    user_data: PathBuf,
    is_packaged: bool,
    exec_path: String,
    clock: Clock,
    platform: Box<dyn DesktopPlatform>,

    settings: DesktopSettings,
    state: Option<DesktopTimerState>,
    tray: Option<DrawnTray>,
    raycast_menu: bool,
    suspend_until: Option<i64>,
    quit_notice_shown: bool,
    shutting_down: bool,
    /// window.ts's `quitting`: set by `before_quit` and right before an
    /// update installs, so the close handler lets the window go.
    quitting: bool,
    /// The last labels a renderer sent, so a German tray stays German before sign-in.
    remembered_labels: DesktopTrayLabels,
    taskbar: Option<Vec<UserTask>>,

    memory_registrar: MemoryRegistrar,
    shortcuts: ShortcutManager,
    login_item: Box<dyn LoginItemBackend>,
    updates: UpdateController,
    memory_updater: Option<MemoryUpdaterBackend>,
    badge_on: bool,
    posted: HashMap<String, DesktopNotice>,
    presentation: WindowPresentation,
    window_save_at: Option<i64>,

    // Headless record (the test hook).
    notifications: Vec<DesktopNotice>,
    quit_notices: Vec<QuitNotice>,
    commands: VecDeque<DesktopCommand>,
    reveals: u64,
    pretend_focused: bool,
}

pub struct DesktopController {
    inner: Mutex<Inner>,
}

impl DesktopController {
    /// Reads `desktop-settings.json`, `tray-labels.json` and
    /// `window-state.json`, registers the saved shortcuts, sets up the login
    /// item and the updater, and draws the tray. `load_updater` is called
    /// only when the policy allows updates and the run is not headless.
    pub fn new(
        options: DesktopOptions,
        platform: Box<dyn DesktopPlatform>,
        login_item: Box<dyn LoginItemBackend>,
        load_updater: Box<dyn FnOnce() -> Box<dyn UpdaterBackend> + Send>,
    ) -> Self {
        let now = (options.clock)();
        let settings = read_desktop_settings(&options.user_data, &options.platform);
        let remembered_labels = fs::read_to_string(options.user_data.join(LABELS_FILE))
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .map(|value| parse_tray_labels(&value))
            .unwrap_or_else(crate::tray_model::fallback_tray_labels);

        let memory_updater = options.headless.then(MemoryUpdaterBackend::new);
        let policy = if memory_updater.is_some() {
            UpdaterPolicy::Enabled
        } else {
            options.updater_policy
        };
        let memory_for_load = memory_updater.clone();
        let updates = UpdateController::new(
            UpdateControllerOptions {
                policy,
                current_version: options.current_version.clone(),
                auto_check: !options.headless,
                now_ms: now,
                staging_id_dir: (!options.headless).then(|| options.user_data.clone()),
            },
            move || match memory_for_load {
                Some(memory) => Box::new(memory),
                None => load_updater(),
            },
        );

        let stored = read_window_state(&options.user_data);
        let saved = WindowState {
            mode: Some(stored.mode.unwrap_or(options.default_window_mode)),
            ..stored
        };

        let mut inner = Inner {
            headless: options.headless,
            platform_name: options.platform,
            user_data: options.user_data,
            is_packaged: options.is_packaged,
            exec_path: options.exec_path,
            clock: options.clock,
            platform,
            settings,
            state: None,
            tray: None,
            raycast_menu: false,
            suspend_until: None,
            quit_notice_shown: false,
            shutting_down: false,
            quitting: false,
            remembered_labels,
            taskbar: None,
            memory_registrar: MemoryRegistrar::new(),
            shortcuts: ShortcutManager::new(),
            login_item,
            updates,
            memory_updater,
            badge_on: false,
            posted: HashMap::new(),
            presentation: WindowPresentation::new(saved, options.headless),
            window_save_at: None,
            notifications: Vec::new(),
            quit_notices: Vec::new(),
            commands: VecDeque::new(),
            reveals: 0,
            pretend_focused: false,
        };
        inner.sync_taskbar();
        // The memory backend mirrors the stored preference; a real one is the
        // OS's own record and is changed only when the person asks.
        if inner.headless || !inner.is_packaged {
            let open = inner.settings.open_at_login;
            let _ = inner.login_item.set(open);
        }
        let bindings = inner.settings.shortcuts.clone();
        inner.with_registrar(|manager, registrar| {
            manager.apply(registrar, &bindings);
        });
        inner.sync_tray(now);
        DesktopController {
            inner: Mutex::new(inner),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A bridge call on a `desktop:*` or `update:*` channel. `args` are the
    /// invoke arguments (the first is the payload). Refusals keep the
    /// TypeScript messages the renderer and specs match on.
    pub fn call(&self, channel: &str, args: Vec<Value>) -> Result<Value, String> {
        let arg = args.into_iter().next().unwrap_or(Value::Null);
        let mut inner = self.lock();
        let now = inner.now();
        let result = match channel {
            channels::DESKTOP_PUBLISH_STATE => {
                inner.publish_state(&arg, now);
                Ok(Value::Null)
            }
            channels::DESKTOP_SETTINGS_GET => Ok(to_value(&inner.settings_snapshot())),
            channels::DESKTOP_SETTINGS_UPDATE => Ok(to_value(&inner.update_settings(&arg, now))),
            channels::DESKTOP_SUSPEND_SHORTCUTS => {
                inner.suspend_shortcuts(arg == Value::Bool(true), now);
                Ok(Value::Null)
            }
            channels::DESKTOP_SHOW_WINDOW => {
                inner.reveal(Some(DesktopWindowMode::Full));
                Ok(Value::Null)
            }
            channels::DESKTOP_NOTIFY => Ok(Value::Bool(inner.notify(&arg))),
            channels::WINDOW_GET => Ok(to_value(&inner.window_snapshot())),
            channels::WINDOW_MODE => {
                let mode = match arg.as_str() {
                    Some("full") => DesktopWindowMode::Full,
                    Some("compact") => DesktopWindowMode::Compact,
                    _ => return Err("Invalid desktop window mode".into()),
                };
                Ok(to_value(&inner.set_window_mode(mode)))
            }
            channels::WINDOW_PIN => {
                let Some(enabled) = arg.as_bool() else {
                    return Err("Invalid desktop pin preference".into());
                };
                Ok(to_value(&inner.set_always_on_top(enabled)))
            }
            channels::UPDATE_GET_STATUS => Ok(to_value(&inner.updates.snapshot())),
            channels::UPDATE_CHECK => Ok(to_value(&inner.updates.check(now))),
            // Only ever from a click on "Restart to update" (desktop-updates.tsx).
            channels::UPDATE_RESTART => Ok(Value::Bool(inner.restart_for_update())),
            _ => Err(format!("No handler registered for '{channel}'")),
        };
        inner.drain_updates(now);
        result
    }

    /// Advance everything that waits on time: the tray clock, the shortcut
    /// suspension limit, the updater's schedule and the bounds debounce.
    pub fn tick(&self, now_ms: i64) {
        let mut inner = self.lock();
        if inner.suspend_until.is_some_and(|until| now_ms >= until) {
            inner.resume_shortcuts();
        }
        if inner.window_save_at.is_some_and(|at| now_ms >= at) {
            inner.window_save_at = None;
            inner.with_window(|presentation, win| presentation.remember(win));
        }
        inner.updates.tick(now_ms);
        inner.drain_updates(now_ms);
        inner.redraw(now_ms);
    }

    /// Whether [`tick`](Self::tick) has anything to do soon: a running clock
    /// or Autopilot pause in the tray, a suspension, a scheduled check or a
    /// pending bounds save. The shell may tick every second regardless.
    pub fn wants_tick(&self) -> bool {
        let inner = self.lock();
        let now = inner.now();
        let tray_clock = inner.tray.is_some()
            && inner.state.as_ref().is_some_and(|state| {
                state.running.is_some()
                    || state
                        .autopilot
                        .as_ref()
                        .and_then(|a| a.paused_until)
                        .is_some_and(|until| until > now as f64)
            });
        tray_clock
            || inner.suspend_until.is_some()
            || inner.updates.is_scheduled()
            || inner.window_save_at.is_some()
    }

    /// A tray menu item was clicked.
    pub fn click_tray(&self, id: &str) {
        let mut inner = self.lock();
        let now = inner.now();
        inner.on_tray_item(id);
        inner.drain_updates(now);
    }

    /// Windows: a left click on the tray icon opens the window.
    pub fn tray_activated(&self) {
        self.lock().reveal(None);
    }

    /// A registered global shortcut was pressed.
    pub fn trigger(&self, action: DesktopShortcutAction) {
        self.lock().on_shortcut(action);
    }

    pub fn notification_clicked(&self, tag: &str) {
        let mut inner = self.lock();
        if let Some(notice) = inner.posted.get(tag).cloned() {
            inner.open_prompt(&notice);
        }
    }

    pub fn notification_closed(&self, tag: &str) {
        self.lock().posted.remove(tag);
    }

    /// Raycast's menu bar item appeared (true) or went (false), from
    /// `raycast_menu::RaycastMenuWatch`: the tray steps aside while it shows.
    pub fn raycast_menu_changed(&self, visible: bool) {
        let mut inner = self.lock();
        let now = inner.now();
        inner.raycast_menu = visible;
        inner.sync_tray(now);
    }

    /// Whether the close button should hide the window rather than quit.
    pub fn hide_on_close(&self) -> bool {
        self.lock().hide_on_close()
    }

    /// Whether this launch should stay in the tray without showing a window.
    pub fn launch_hidden<S: AsRef<str>>(&self, argv: &[S]) -> bool {
        let inner = self.lock();
        is_hidden_launch(argv)
            && desktop_window_policy(
                &inner.platform_name,
                inner.settings.show_in_tray,
                inner.settings.close_hides,
            )
            .allow_hidden_launch
    }

    /// How to create the window: remembered bounds, fullscreen, whether and
    /// when to show and maximize.
    pub fn window_launch(&self, work_areas: &[Rect], show_on_ready: bool) -> WindowLaunch {
        let inner = self.lock();
        window_launch(
            inner.presentation.saved(),
            work_areas,
            inner.headless,
            show_on_ready,
        )
    }

    /// After the window exists: a `--full-window` or `--compact-timer`
    /// argument picks the mode.
    pub fn launched<S: AsRef<str>>(&self, argv: &[S]) {
        if let Some(mode) = requested_window_mode(argv) {
            self.lock().set_window_mode(mode);
        }
    }

    /// Another launch handed over to this one. A login-item launch while the
    /// app already runs changes nothing on screen.
    pub fn second_instance<S: AsRef<str>>(&self, argv: &[S]) {
        if is_hidden_launch(argv) {
            return;
        }
        let mut inner = self.lock();
        if let Some(mode) = requested_window_mode(argv) {
            inner.set_window_mode(mode);
        }
        if !inner.headless {
            inner.platform.reveal_window();
        }
    }

    /// macOS: the Dock icon brings back a window hidden by its close button.
    pub fn activate(&self) {
        let mut inner = self.lock();
        if !inner.headless {
            inner.platform.reveal_window();
        }
    }

    /// The renderer reloaded or crashed: give back shortcuts it had suspended.
    pub fn renderer_reset(&self) {
        self.lock().resume_shortcuts();
    }

    /// The window moved, resized, (un)maximized or changed fullscreen.
    pub fn window_changed(&self) {
        let mut inner = self.lock();
        let now = inner.now();
        inner.window_save_at = Some(now + WINDOW_SAVE_DELAY_MS);
    }

    /// The window finished leaving fullscreen (or closed while it did).
    pub fn fullscreen_left(&self) {
        self.lock()
            .with_window(|presentation, win| presentation.fullscreen_left(win));
    }

    /// The close button. Closing the window hides it and the app keeps
    /// running, so the renderer — which owns the socket, the offline queue
    /// and the running timer — stays alive: macOS always (the Dock icon brings
    /// it back); Windows and Linux while the tray is there to bring it back.
    pub fn window_close_requested(&self) -> CloseDecision {
        let mut inner = self.lock();
        inner.window_save_at = None;
        inner.with_window(|presentation, win| presentation.remember(win));
        if inner.hide_on_close() && !inner.quitting {
            let fullscreen = inner
                .platform
                .window()
                .is_some_and(|win| win.is_full_screen());
            CloseDecision::Hide {
                leave_fullscreen_first: fullscreen,
            }
        } else {
            CloseDecision::Close
        }
    }

    /// The OS is logging out or shutting down: a modal box then would hold
    /// the whole session up.
    pub fn system_shutdown(&self) {
        self.lock().shutting_down = true;
    }

    /// The app is about to quit (Tauri's exit request). Names the unsent
    /// changes once; informational — quitting proceeds, the rows are in
    /// localStorage and are sent the next time the app starts.
    pub fn before_quit(&self) {
        self.lock().before_quit();
    }

    /// The app quits now: a downloaded update installs for the next launch,
    /// shortcuts are released and the tray goes.
    pub fn will_quit(&self) {
        let mut inner = self.lock();
        inner.updates.app_will_quit();
        inner.updates.dispose();
        inner.with_registrar(|manager, registrar| manager.dispose(registrar));
        if inner.tray.take().is_some() {
            inner.platform.tray_destroy();
        }
        inner.suspend_until = None;
        inner.window_save_at = None;
    }

    // ── updater outcomes (the shell's tauri-plugin-updater tasks) ───────────

    /// A check found a newer release; `staging_percentage` is the feed's raw
    /// `stagingPercentage`, if any.
    pub fn update_found(&self, version: &str, staging_percentage: Option<&Value>) {
        self.with_updates(|updates, now| updates.found(version, staging_percentage, now));
    }

    pub fn update_not_found(&self) {
        self.with_updates(|updates, now| updates.not_found(now));
    }

    pub fn update_progress(&self, percent: f64) {
        self.with_updates(|updates, now| updates.progress(percent, now));
    }

    pub fn update_downloaded(&self, version: &str) {
        self.with_updates(|updates, now| updates.downloaded(version, now));
    }

    pub fn update_failed(&self, error: &str) {
        self.with_updates(|updates, now| updates.failed(error, now));
    }

    fn with_updates(&self, f: impl FnOnce(&mut UpdateController, i64)) {
        let mut inner = self.lock();
        let now = inner.now();
        f(&mut inner.updates, now);
        inner.drain_updates(now);
    }

    pub fn update_snapshot(&self) -> DesktopUpdateSnapshot {
        self.lock().updates.snapshot()
    }

    pub fn window_snapshot(&self) -> DesktopWindowSnapshot {
        self.lock().window_snapshot()
    }

    pub fn settings(&self) -> DesktopSettings {
        self.lock().settings.clone()
    }

    /// The test hook (`DesktopTestHook`), headless only. `args` is the one
    /// argument the TypeScript method took (or `null`); an array is read as
    /// its first element. Method names are the hook's: `state`, `settings`,
    /// `trayMenu`, `trayTitle`, `trayTooltip` (each with an optional `nowMs`),
    /// `clickTray`, `trigger`, `registered`, `takeChord`, `notifications`,
    /// `clickNotification`, `pretendFocused`, `quitNotices`, `badge`,
    /// `reveals`, `commands`, `update.snapshot`, `update.dispatch`,
    /// `update.installs`, `update.checks`, plus `beforeQuit` (what the
    /// Electron specs did with `app.emit("before-quit")`). `activity.*`
    /// belongs to the activity crate's hook.
    pub fn test_call(&self, method: &str, args: Value) -> Result<Value, String> {
        let arg = match args {
            Value::Array(items) => items.into_iter().next().unwrap_or(Value::Null),
            other => other,
        };
        let mut inner = self.lock();
        if !inner.headless {
            return Err("the desktop test hook exists only in a headless run".into());
        }
        let now = inner.now();
        let at = arg.as_f64().unwrap_or(now as f64);
        let result = match method {
            "state" => Ok(inner.state.as_ref().map(hook_state).unwrap_or(Value::Null)),
            "settings" => Ok(to_value(&inner.settings)),
            "trayMenu" => Ok(if inner.settings.show_in_tray {
                to_value(&tray_menu_model(
                    Some(&inner.drawn_state()),
                    inner.updates.is_ready(),
                    at,
                ))
            } else {
                Value::Null
            }),
            "trayTitle" => Ok(Value::String(tray_title(
                Some(&inner.drawn_state()),
                at,
                &inner.platform_name,
            ))),
            "trayTooltip" => Ok(Value::String(tray_tooltip(Some(&inner.drawn_state()), at))),
            "clickTray" => {
                inner.on_tray_item(arg.as_str().unwrap_or_default());
                Ok(Value::Null)
            }
            "trigger" => {
                if let Some(action) = arg.as_str().and_then(DesktopShortcutAction::parse) {
                    inner.on_shortcut(action);
                }
                Ok(Value::Null)
            }
            "registered" => Ok(to_value(&inner.memory_registrar.accelerators())),
            "takeChord" => {
                inner
                    .memory_registrar
                    .take(arg.as_str().unwrap_or_default());
                Ok(Value::Null)
            }
            "notifications" => Ok(to_value(&inner.notifications)),
            "clickNotification" => {
                let notice = arg
                    .as_u64()
                    .and_then(|i| inner.notifications.get(i as usize).cloned());
                if let Some(notice) = notice {
                    inner.open_prompt(&notice);
                }
                Ok(Value::Null)
            }
            "pretendFocused" => {
                inner.pretend_focused = arg == Value::Bool(true);
                Ok(Value::Null)
            }
            "quitNotices" => Ok(to_value(&inner.quit_notices)),
            "badge" => Ok(Value::Bool(inner.badge_on)),
            "reveals" => Ok(json!(inner.reveals)),
            "commands" => Ok(to_value(&inner.commands)),
            "beforeQuit" => {
                inner.before_quit();
                Ok(Value::Null)
            }
            "update.snapshot" => Ok(to_value(&inner.updates.snapshot())),
            "update.dispatch" => {
                let event: UpdaterEvent = serde_json::from_value(arg)
                    .map_err(|e| format!("Invalid updater event: {e}"))?;
                inner.updates.dispatch(event, now);
                Ok(Value::Null)
            }
            "update.installs" => Ok(json!(inner.memory_counts().installs)),
            "update.checks" => Ok(json!(inner.memory_counts().checks)),
            _ => Err(format!("Unknown desktop test hook method '{method}'")),
        };
        inner.drain_updates(now);
        result
    }
}

fn to_value<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// The timer state as the TypeScript parser produced it: `autopilot` is
/// always present, `null` when off (the wire type omits it).
fn hook_state(state: &DesktopTimerState) -> Value {
    let mut value = to_value(state);
    if let Value::Object(map) = &mut value {
        map.entry("autopilot").or_insert(Value::Null);
    }
    value
}

impl Inner {
    fn now(&self) -> i64 {
        (self.clock)()
    }

    fn signed_in(&self) -> bool {
        self.state.as_ref().is_some_and(|state| state.signed_in)
    }

    /// What the tray draws when no renderer has spoken yet: the remembered labels.
    fn drawn_state(&self) -> DesktopTimerState {
        self.state.clone().unwrap_or_else(|| DesktopTimerState {
            signed_in: false,
            running: None,
            recents: Vec::new(),
            unsent: 0,
            autopilot: None,
            labels: self.remembered_labels.clone(),
        })
    }

    fn memory_counts(&self) -> crate::updater_controller::MemoryUpdaterCounts {
        self.memory_updater
            .as_ref()
            .map(MemoryUpdaterBackend::counts)
            .unwrap_or_default()
    }

    fn hide_on_close(&self) -> bool {
        desktop_window_policy(
            &self.platform_name,
            self.settings.show_in_tray,
            self.settings.close_hides,
        )
        .hide_on_close
    }

    fn with_registrar<R>(
        &mut self,
        f: impl FnOnce(&mut ShortcutManager, &mut dyn ShortcutRegistrar) -> R,
    ) -> R {
        if self.headless {
            f(&mut self.shortcuts, &mut self.memory_registrar)
        } else {
            f(
                &mut self.shortcuts,
                &mut PlatformRegistrar(self.platform.as_mut()),
            )
        }
    }

    fn with_window(
        &mut self,
        f: impl FnOnce(&mut WindowPresentation, &mut dyn WindowOps) -> PresentationEffects,
    ) {
        let Some(win) = self.platform.window() else {
            return;
        };
        let effects = f(&mut self.presentation, win);
        if let Some(save) = effects.save {
            if let Err(error) = write_window_state(&self.user_data, &save) {
                eprintln!("[window-state] save failed: {error}");
            }
        }
        if let Some(snapshot) = effects.changed {
            self.platform
                .emit(channels::WINDOW_CHANGED, to_value(&snapshot));
        }
    }

    fn has_window(&mut self) -> bool {
        self.platform.window().is_some()
    }

    /// The presentation's snapshot, or the full app when there is no window
    /// (main.ts's `currentWindowState`).
    fn window_snapshot(&mut self) -> DesktopWindowSnapshot {
        if self.has_window() {
            self.presentation.snapshot()
        } else {
            DesktopWindowSnapshot {
                mode: DesktopWindowMode::Full,
                always_on_top: false,
            }
        }
    }

    fn set_window_mode(&mut self, mode: DesktopWindowMode) -> DesktopWindowSnapshot {
        self.with_window(|presentation, win| presentation.set_mode(win, mode));
        self.window_snapshot()
    }

    fn set_always_on_top(&mut self, enabled: bool) -> DesktopWindowSnapshot {
        self.with_window(|presentation, win| presentation.set_always_on_top(win, enabled));
        self.window_snapshot()
    }

    fn sync_taskbar(&mut self) {
        let Some(tasks) = windows_user_tasks(
            &self.platform_name,
            self.is_packaged,
            self.headless,
            &self.exec_path,
            &self.remembered_labels.open,
            &self.remembered_labels.compact_timer,
        ) else {
            return;
        };
        if self.taskbar.as_ref() == Some(&tasks) {
            return;
        }
        if self.platform.set_user_tasks(&tasks) {
            self.taskbar = Some(tasks);
        }
    }

    fn reveal(&mut self, mode: Option<DesktopWindowMode>) {
        if let Some(mode) = mode {
            self.set_window_mode(mode);
        }
        self.reveals += 1;
        if !self.headless {
            self.platform.reveal_window();
        }
    }

    fn send(&mut self, command: DesktopCommand) {
        self.commands.push_back(command.clone());
        if self.commands.len() > MAX_RECORDED_COMMANDS {
            self.commands.pop_front();
        }
        self.platform
            .emit(channels::DESKTOP_COMMAND, to_value(&command));
    }

    fn on_shortcut(&mut self, action: DesktopShortcutAction) {
        match action {
            DesktopShortcutAction::ToggleTimer => {
                // Signed out there is no timer to toggle and nobody to ask: show the app.
                if self.signed_in() {
                    self.send(DesktopCommand::Toggle);
                } else {
                    self.reveal(None);
                }
            }
            DesktopShortcutAction::NewTimer => {
                self.reveal(None);
                if self.signed_in() {
                    self.send(DesktopCommand::Compose);
                }
            }
            DesktopShortcutAction::ToggleWindow => {
                if self.platform.window_visible() && self.platform.window_focused() {
                    self.platform.hide_window();
                } else {
                    self.reveal(None);
                }
            }
            DesktopShortcutAction::OpenPalette => {
                self.reveal(None);
                if self.signed_in() {
                    self.send(DesktopCommand::OpenPalette);
                }
            }
        }
    }

    fn restart_for_update(&mut self) -> bool {
        let quitting = &mut self.quitting;
        self.updates.restart(&mut || *quitting = true)
    }

    fn on_tray_item(&mut self, id: &str) {
        match id {
            "stop" => self.send(DesktopCommand::Stop),
            "start" | "edit" => {
                self.reveal(None);
                self.send(DesktopCommand::Compose);
            }
            "autopilot-pause" => self.platform.pause_autopilot(true),
            "autopilot-resume" => self.platform.pause_autopilot(false),
            "compact" => self.reveal(Some(DesktopWindowMode::Compact)),
            "open" => self.reveal(Some(DesktopWindowMode::Full)),
            "settings" => {
                self.reveal(None);
                self.send(DesktopCommand::OpenSettings);
            }
            "restart-to-update" => _ = self.restart_for_update(),
            "quit" => self.platform.quit(),
            other => {
                if let Some(key) = other.strip_prefix("continue:") {
                    self.send(DesktopCommand::Continue {
                        key: key.to_string(),
                    });
                }
            }
        }
    }

    // ── tray, badge ─────────────────────────────────────────────────────────

    fn redraw(&mut self, now: i64) {
        let Some(drawn) = self.tray.clone() else {
            return;
        };
        let state = self.drawn_state();
        let now = now as f64;
        let menu = tray_menu_model(Some(&state), self.updates.is_ready(), now);
        let variant = tray_icon_variant(Some(&state));
        let title = (self.platform_name == "darwin")
            .then(|| tray_title(Some(&state), now, &self.platform_name));
        let tooltip = tray_tooltip(Some(&state), now);

        let mut update = TrayUpdate {
            create: !drawn.created,
            ..Default::default()
        };
        if drawn.menu.as_ref() != Some(&menu) {
            update.menu = Some(menu.clone());
        }
        if drawn.variant != Some(variant) {
            update.icon = Some((variant, tray_icon_file(&self.platform_name, variant)));
        }
        if title.is_some() && drawn.title != title {
            update.title = title.clone();
        }
        if drawn.tooltip.as_ref() != Some(&tooltip) {
            update.tooltip = Some(tooltip.clone());
        }
        if update == TrayUpdate::default() {
            return;
        }
        self.platform.tray_update(&update);
        self.tray = Some(DrawnTray {
            created: true,
            menu: Some(menu),
            variant: Some(variant),
            title: title.or_else(|| drawn.title.clone()),
            tooltip: Some(tooltip),
        });
    }

    fn sync_tray(&mut self, now: i64) {
        if !self.settings.show_in_tray || self.raycast_menu || self.headless {
            if self.tray.take().is_some() {
                self.platform.tray_destroy();
            }
            return;
        }
        if self.tray.is_none() {
            self.tray = Some(DrawnTray::default());
        }
        self.redraw(now);
    }

    fn sync_badge(&mut self) {
        let want =
            self.settings.running_badge && self.state.as_ref().is_some_and(|s| s.running.is_some());
        if want == self.badge_on {
            return;
        }
        self.badge_on = want;
        if self.headless {
            return;
        }
        let label = if want {
            self.drawn_state().labels.running_badge
        } else {
            String::new()
        };
        self.platform.set_running_badge(want, &label);
    }

    fn drain_updates(&mut self, now: i64) {
        let changes = self.updates.take_changes();
        if changes.is_empty() {
            return;
        }
        self.redraw(now);
        for snapshot in changes {
            self.platform
                .emit(channels::UPDATE_STATUS_CHANGED, to_value(&snapshot));
        }
    }

    // ── IPC ─────────────────────────────────────────────────────────────────

    fn publish_state(&mut self, payload: &Value, now: i64) {
        let Some(next) = parse_timer_state(payload) else {
            return;
        };
        let signed_in = next.signed_in;
        let labels_changed = next.labels != self.remembered_labels;
        if labels_changed {
            self.remembered_labels = next.labels.clone();
        }
        self.state = Some(next);
        self.with_window(|presentation, win| presentation.set_signed_in(win, signed_in));
        if labels_changed {
            self.sync_taskbar();
            // A cosmetic cache: a failed write costs a first-launch English tray.
            if let Ok(text) = serde_json::to_string(&self.remembered_labels) {
                let _ = fs::write(self.user_data.join(LABELS_FILE), text);
            }
        }
        self.redraw(now);
        self.sync_badge();
    }

    fn login_status(&self) -> DesktopLoginItemStatus {
        self.login_item
            .status()
            .unwrap_or(DesktopLoginItemStatus::Unsupported)
    }

    fn settings_snapshot(&self) -> DesktopSettingsSnapshot {
        let login = self.login_status();
        let mut settings = self.settings.clone();
        settings.open_at_login = matches!(
            login,
            DesktopLoginItemStatus::Enabled | DesktopLoginItemStatus::RequiresApproval
        );
        DesktopSettingsSnapshot {
            settings,
            shortcuts: self.shortcuts.statuses().to_vec(),
            shortcuts_suspended: self.shortcuts.is_suspended(),
            login_item: login,
            capabilities: DesktopSettingsCapabilities {
                close_hides: self.platform_name != "darwin",
                running_badge: self.platform_name == "darwin" || self.platform_name == "win32",
            },
        }
    }

    fn broadcast_settings(&mut self) {
        let snapshot = to_value(&self.settings_snapshot());
        self.platform
            .emit(channels::DESKTOP_SETTINGS_CHANGED, snapshot);
    }

    fn update_settings(&mut self, patch: &Value, now: i64) -> DesktopSettingsUpdate {
        let result = apply_settings_patch(&self.settings, patch, &self.platform_name);
        // Only when asked: the stored value can lag the OS (a person who removed
        // the login item in System Settings), and an unrelated change must not
        // put it back.
        let login_changed = patch.get("openAtLogin").is_some_and(Value::is_boolean)
            && result.next.open_at_login != self.settings_snapshot().settings.open_at_login;
        self.settings = result.next;
        if let Err(error) = write_desktop_settings(&self.user_data, &self.settings) {
            eprintln!("[desktop] settings save failed: {error}");
        }
        if login_changed {
            let open = self.settings.open_at_login;
            if let Err(error) = self.login_item.set(open) {
                eprintln!("[desktop] login item failed: {error}");
            }
        }
        let bindings = self.settings.shortcuts.clone();
        self.with_registrar(|manager, registrar| {
            manager.apply(registrar, &bindings);
        });
        self.sync_tray(now);
        self.sync_badge();
        let snapshot = self.settings_snapshot();
        self.broadcast_settings();
        DesktopSettingsUpdate {
            snapshot,
            refused: result.refused,
        }
    }

    fn suspend_shortcuts(&mut self, suspended: bool, now: i64) {
        if suspended {
            self.with_registrar(|manager, registrar| manager.suspend(registrar));
            // A recorder that never says "done" (a crashed tab, a closed window)
            // must not leave the person's shortcuts off for the rest of the day.
            self.suspend_until = Some(now + SUSPEND_LIMIT_MS);
            self.broadcast_settings();
        } else {
            self.resume_shortcuts();
        }
    }

    fn resume_shortcuts(&mut self) {
        self.suspend_until = None;
        if !self.shortcuts.is_suspended() {
            return;
        }
        self.with_registrar(|manager, registrar| {
            manager.resume(registrar);
        });
        self.broadcast_settings();
    }

    // ── notifications ───────────────────────────────────────────────────────

    fn window_in_front(&self) -> bool {
        if self.headless {
            return self.pretend_focused;
        }
        self.platform.window_visible()
            && !self.platform.window_minimized()
            && self.platform.window_focused()
    }

    fn open_prompt(&mut self, notice: &DesktopNotice) {
        self.reveal(None);
        self.send(DesktopCommand::OpenPrompt {
            prompt: notice.kind,
        });
    }

    /// A tag replaces an earlier notice; it does not say whether this is the
    /// same event again (idle posts every idle period under one tag), so
    /// skipping a repeat is the renderer's job (`notifyDesktopOnce`).
    /// Headless records every request, replacements included, which is what
    /// makes a repeat visible.
    fn notify(&mut self, payload: &Value) -> bool {
        let Some(notice) = parse_notice(payload) else {
            return false;
        };
        if self.window_in_front() {
            return false;
        }
        if self.headless {
            self.notifications.push(notice);
            return true;
        }
        if !self.platform.notifications_supported() {
            return false;
        }
        if self.posted.remove(&notice.tag).is_some() {
            self.platform.close_notification(&notice.tag);
        }
        self.platform.post_notification(&notice);
        self.posted.insert(notice.tag.clone(), notice);
        true
    }

    // ── quit ────────────────────────────────────────────────────────────────

    fn before_quit(&mut self) {
        self.quitting = true;
        if self.quit_notice_shown || self.shutting_down {
            return;
        }
        let Some(state) = self.state.as_ref().filter(|state| state.unsent > 0) else {
            return;
        };
        self.quit_notice_shown = true;
        let labels = state.labels.clone();
        if self.headless {
            self.quit_notices.push(QuitNotice {
                title: labels.quit_unsent_title,
                body: labels.quit_unsent_body,
            });
            return;
        }
        self.platform.show_quit_notice(
            &labels.quit_unsent_title,
            &labels.quit_unsent_body,
            &labels.quit_unsent_button,
        );
    }
}

#[cfg(test)]
mod tests;
