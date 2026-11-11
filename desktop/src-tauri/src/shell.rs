//! The shell's state and lifecycle: what the Electron main.ts did between
//! `whenReady` and `will-quit`.
//!
//! Threading rule (platform.rs): the main thread never waits on the desktop
//! controller's lock. Main-thread events (tray, shortcuts, window events, the
//! quit request) are posted to the executor; bridge calls arrive on Tauri's
//! async workers and call the controller directly.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tyt_model::desktop_controller::{system_clock, DesktopController, DesktopOptions};
use tyt_model::distribution::{
    distribution_channel, login_item_mechanism, DistributionChannel, DistributionInputs,
};
use tyt_model::login_item::{select_login_item, LoginItemBackend};
use tyt_model::secure_store::{DiskSessionFile, SecureStore, SESSION_FILE};
use tyt_model::updater_controller::UpdaterBackend;
use tyt_wire::DesktopLoginItemStatus;

use crate::platform::{ControllerCell, Executor, TauriDesktop};

pub struct ShellOptions {
    pub headless: bool,
    pub profile: PathBuf,
    pub dev_url: Option<String>,
    pub env: HashMap<String, String>,
}

pub struct InstanceLock(#[allow(dead_code)] pub std::fs::File);

pub struct Shell {
    pub headless: bool,
    pub profile: PathBuf,
    pub dev_url: Option<String>,
    pub env: HashMap<String, String>,
    /// Shared by the token store and the activity vault's device key.
    pub encryption: Arc<crate::secure::OsEncryption>,
    pub secure: SecureStore,
    pub idle: OnceLock<crate::idle::IdleMonitor>,
    /// Keys handed to the page from the Electron build's localStorage.
    pub migration: Mutex<Option<BTreeMap<String, String>>>,
    /// Set once the quit sequence started; the close handler stops hiding.
    pub quitting: AtomicBool,
    /// Set once the quit sequence finished; the next exit request goes through.
    pub exit_ready: AtomicBool,
    /// Smoke mode: where to write the report (problems.rs).
    pub smoke_report: Option<PathBuf>,
    pub executor: Executor,
    pub desktop: ControllerCell,
    pub activity: OnceLock<Arc<crate::activity::Activity>>,
}

impl Shell {
    pub fn new(options: ShellOptions) -> Shell {
        let encryption = Arc::new(crate::secure::OsEncryption::new(
            options.headless,
            options.profile.clone(),
        ));
        let secure = SecureStore::new(
            encryption.clone(),
            Box::new(DiskSessionFile::at(&options.profile, SESSION_FILE)),
        );
        let migration = crate::migrate::pending(&options.profile);
        let smoke_report = options
            .env
            .get(crate::problems::SMOKE_ENV)
            .filter(|p| !p.is_empty())
            .map(PathBuf::from);
        Shell {
            headless: options.headless,
            profile: options.profile,
            dev_url: options.dev_url,
            env: options.env,
            encryption,
            secure,
            idle: OnceLock::new(),
            migration: Mutex::new(migration),
            quitting: AtomicBool::new(false),
            exit_ready: AtomicBool::new(false),
            smoke_report,
            executor: Executor::start(),
            desktop: Arc::new(OnceLock::new()),
            activity: OnceLock::new(),
        }
    }

    /// The origin of the dev server, when this is a dev run.
    pub fn dev_origin(&self) -> Option<String> {
        let url = url::Url::parse(self.dev_url.as_deref()?).ok()?;
        Some(url.origin().ascii_serialization())
    }

    pub fn controller(&self) -> Option<&Arc<DesktopController>> {
        self.desktop.get()
    }

    /// Run `job` on the executor once the controller exists.
    pub fn later(&self, job: impl FnOnce(&DesktopController) + Send + 'static) {
        let cell = self.desktop.clone();
        self.executor.post(move || {
            if let Some(controller) = cell.get() {
                job(controller);
            }
        });
    }

    pub fn channel(&self) -> DistributionChannel {
        distribution_channel(&DistributionInputs {
            platform: crate::platform(),
            is_packaged: crate::is_packaged(),
            mas: cfg!(feature = "mas"),
            windows_store: crate::windows_store(),
            env: &self.env,
        })
    }
}

struct NativeLoginItem;

impl LoginItemBackend for NativeLoginItem {
    fn status(&self) -> Result<DesktopLoginItemStatus, String> {
        Ok(crate::login::status())
    }
    fn set(&mut self, enabled: bool) -> Result<(), String> {
        crate::login::set(enabled).map(|_| ())
    }
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let headless = app.state::<Shell>().headless;

    #[cfg(target_os = "macos")]
    if headless {
        // Never activate, never show a Dock icon: a test run must not take
        // focus from whoever is using the machine.
        app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        app.set_dock_visibility(false);
    }

    let shell = app.state::<Shell>();
    crate::window::install_menu(&handle, shell.dev_url.is_some())?;
    // dev:desktop: the bridge on the Next dev server's origin (debug builds
    // only; a release build never has a dev URL).
    if let Some(origin) = shell.dev_origin() {
        use tauri::ipc::CapabilityBuilder;
        app.add_capability(
            CapabilityBuilder::new("dev-server")
                .remote(format!("{origin}/*"))
                .window(crate::window::MAIN)
                .permission("allow-desktop-call")
                .permission("allow-e2e-result")
                .permission("core:window:allow-start-dragging")
                .permission("core:window:allow-internal-toggle-maximize"),
        )?;
    }
    let channel = shell.channel();
    let platform = crate::platform();

    // Activity capture (Stage 8). Off until the person turns it on; headless
    // runs get the fake source and the test hook, never the real frontmost app.
    let activity = crate::activity::install(&handle, &shell, channel);
    let _ = shell.activity.set(activity.clone());

    if !headless {
        let push_handle = handle.clone();
        let activity_idle = activity.clone();
        let monitor = crate::idle::start(move |sample| {
            activity_idle.idle(&sample);
            push(
                &push_handle,
                tyt_wire::channels::IDLE_STATE,
                &serde_json::to_value(&sample).unwrap(),
            );
        });
        let _ = shell.idle.set(monitor);
    }

    // The desktop controller: tray, shortcuts, settings, notifications,
    // windows and updates (tyt_model::desktop_controller).
    let has_feed = crate::updater::has_feed(app.config());
    let options = DesktopOptions {
        headless,
        platform: platform.to_string(),
        user_data: shell.profile.clone(),
        is_packaged: crate::is_packaged(),
        exec_path: std::env::current_exe()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        current_version: app.package_info().version.to_string(),
        updater_policy: tyt_model::updater_model::updater_policy(channel, has_feed, &shell.env),
        default_window_mode: tyt_model::window_policy::default_window_mode(platform, &shell.env),
        clock: system_clock(),
    };
    let pause_activity = activity.clone();
    let tauri_platform = TauriDesktop::new(
        handle.clone(),
        shell.executor.clone(),
        shell.desktop.clone(),
        Arc::new(move |paused| pause_activity.pause_autopilot(paused)),
    );
    let exec = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let mechanism = login_item_mechanism(channel, &exec, &shell.env, "trackyourtime");
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let login = select_login_item(
        headless,
        crate::is_packaged(),
        &mechanism,
        &shell.env,
        &home,
        || Box::new(NativeLoginItem),
    );
    let updater_handle = handle.clone();
    let updater_executor = shell.executor.clone();
    let updater_cell = shell.desktop.clone();
    let load_updater: Box<dyn FnOnce() -> Box<dyn UpdaterBackend> + Send> = Box::new(move || {
        Box::new(crate::updater::TauriUpdater::new(
            updater_handle,
            updater_executor,
            updater_cell,
        )) as Box<dyn UpdaterBackend>
    });
    let controller = Arc::new(DesktopController::new(
        options,
        Box::new(tauri_platform),
        login,
        load_updater,
    ));
    let _ = shell.desktop.set(controller.clone());

    let argv: Vec<String> = std::env::args().collect();
    let show = !shell.headless && !controller.launch_hidden(&argv);
    let work_areas = crate::window::work_areas(&handle);
    let launch = controller.window_launch(&work_areas, show);
    crate::window::create_main(&handle, &shell, &launch)?;
    controller.launched(&argv);

    // The tray clock, the shortcut-suspension limit, the updater schedule
    // and the bounds debounce all run on `tick` (deviation 2, PORTING.md).
    let tick_cell = shell.desktop.clone();
    let tick_handle = handle.clone();
    std::thread::Builder::new()
        .name("desktop-tick".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_millis(1_000));
            if tick_handle.state::<Shell>().quitting.load(Ordering::SeqCst) {
                break;
            }
            if let Some(controller) = tick_cell.get() {
                controller.tick(now_ms());
            }
        })?;

    // The Raycast menu bar timer: while it is visible, the desktop menu bar
    // clock steps aside (raycast_menu.rs).
    if !headless {
        let cell = shell.desktop.clone();
        let watch =
            tyt_model::raycast_menu::spawn_raycast_menu_watch(platform, &home, move |visible| {
                if let Some(controller) = cell.get() {
                    controller.raycast_menu_changed(visible);
                }
            });
        app.manage(RaycastWatch(Mutex::new(Some(watch))));
    }

    #[cfg(feature = "e2e")]
    crate::e2e::start(&handle);
    Ok(())
}

struct RaycastWatch(
    #[allow(dead_code)] Mutex<Option<tyt_model::raycast_menu::RaycastMenuWatchHandle>>,
);

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Push to the renderer's bridge listeners (`webContents.send`).
pub fn push(app: &AppHandle, channel: &str, payload: &serde_json::Value) {
    if let Some(window) = app.get_webview_window(crate::window::MAIN) {
        let _ = window.eval(crate::bridge::push_script(channel, payload));
    }
}

/// Show and focus the main window (main.ts's `showMain`). Never headless.
pub fn show_main(app: &AppHandle) {
    let shell = app.state::<Shell>();
    if shell.headless {
        return;
    }
    if let Some(window) = app.get_webview_window(crate::window::MAIN) {
        crate::window::reveal(&window);
    } else if let Some(controller) = shell.controller() {
        let launch = controller.window_launch(&crate::window::work_areas(app), true);
        let _ = crate::window::create_main(app, &shell, &launch);
    }
}

/// A second launch handed its arguments over (instance.rs).
pub fn second_instance(app: &AppHandle, argv: Vec<String>) {
    app.state::<Shell>()
        .later(move |c| c.second_instance(&argv));
}

/// macOS: the Dock icon brings back a window hidden by its close button.
pub fn reopen(app: &AppHandle) {
    app.state::<Shell>().later(|c| c.activate());
}

/// Begin quitting: the bridge's quit, the tray's Quit, the controller.
pub fn request_quit(app: &AppHandle) {
    let shell = app.state::<Shell>();
    if shell.exit_ready.load(Ordering::SeqCst) {
        app.exit(0);
        return;
    }
    if shell.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    shell.executor.post(move || finish_quit(&handle));
}

/// Exit at once with `code`, skipping the quit sequence (smoke mode: nothing
/// was signed in, queued or downloaded).
pub fn exit_now(app: &AppHandle, code: i32) {
    let shell = app.state::<Shell>();
    shell.quitting.store(true, Ordering::SeqCst);
    shell.exit_ready.store(true, Ordering::SeqCst);
    app.exit(code);
}

/// before-quit, will-quit, exit — off the main thread, in Electron's order.
fn finish_quit(app: &AppHandle) {
    let shell = app.state::<Shell>();
    if let Some(controller) = shell.controller() {
        controller.before_quit();
        controller.will_quit();
    }
    if let Some(activity) = shell.activity.get() {
        activity.dispose();
    }
    shell.exit_ready.store(true, Ordering::SeqCst);
    app.exit(0);
}

pub fn exit_requested(app: &AppHandle, api: &tauri::ExitRequestApi, code: Option<i32>) {
    let shell = app.state::<Shell>();
    if shell.exit_ready.load(Ordering::SeqCst) {
        return;
    }
    api.prevent_exit();
    // The last window went away without anyone quitting: macOS keeps running
    // (the Dock brings the window back); elsewhere the app quits, as
    // Electron's window-all-closed did.
    if code.is_none() && !shell.quitting.load(Ordering::SeqCst) && cfg!(target_os = "macos") {
        return;
    }
    request_quit(app);
}

/// "Restart to update": the updater installed and is about to relaunch.
pub fn before_restart(app: &AppHandle) {
    let shell = app.state::<Shell>();
    shell.quitting.store(true, Ordering::SeqCst);
    shell.exit_ready.store(true, Ordering::SeqCst);
    if let Some(activity) = shell.activity.get() {
        activity.dispose();
    }
}

/// The event loop is ending. Normally the quit sequence ran already; when it
/// did not (macOS `terminate:` from the Dock menu, logout, shutdown), run
/// `will_quit` here — on a helper thread with a deadline, because the main
/// thread must never wait on the controller lock without one.
pub fn exit(app: &AppHandle) {
    let shell = app.state::<Shell>();
    shell.quitting.store(true, Ordering::SeqCst);
    if !shell.exit_ready.swap(true, Ordering::SeqCst) {
        if let Some(controller) = shell.controller().cloned() {
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                controller.will_quit();
                let _ = tx.send(());
            });
            let _ = rx.recv_timeout(Duration::from_secs(3));
        }
    }
    if let Some(activity) = shell.activity.get() {
        activity.dispose();
    }
}

/// The e2e harness's view into the shell (feature `e2e`): `activity.*` goes
/// to the activity controller's hook, everything else to the desktop one's.
#[allow(dead_code)]
pub fn test_hook(
    app: &AppHandle,
    name: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let shell = app.state::<Shell>();
    if let Some(method) = name.strip_prefix("activity.") {
        return shell
            .activity
            .get()
            .ok_or("activity is not installed")?
            .test_call(method, args);
    }
    shell
        .controller()
        .ok_or("the desktop controller is not ready")?
        .test_call(name, args)
}
