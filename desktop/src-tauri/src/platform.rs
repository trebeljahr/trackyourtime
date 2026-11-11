//! The Tauri side of `tyt_model::desktop_controller::DesktopPlatform` and
//! `tyt_model::window_presentation::WindowOps`: tray, global shortcuts,
//! notifications, Dock badge / taskbar overlay, the quit notice and the
//! window, drawn from what the controller decides.
//!
//! **Never call the controller from a main-thread callback.** The controller
//! holds its lock while it calls into this file, and several Tauri calls made
//! here wait for the main thread. A tray click, a shortcut press or a
//! notification click therefore goes through `Executor::post`, a serial
//! background thread, so the main thread never waits on the controller lock.

use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, OnceLock};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tyt_model::desktop_controller::{DesktopController, DesktopPlatform, TrayUpdate};
use tyt_model::taskbar_model::UserTask;
use tyt_model::tray_model::TrayMenuItem;
use tyt_model::window_presentation::WindowOps;
use tyt_model::window_state::{InitialBounds, Rect};
use tyt_wire::{DesktopNotice, DesktopShortcutAction};

/// A serial background thread for work that must not run on the main thread.
#[derive(Clone)]
pub struct Executor(Sender<Box<dyn FnOnce() + Send>>);

impl Executor {
    pub fn start() -> Executor {
        let (tx, rx) = channel::<Box<dyn FnOnce() + Send>>();
        std::thread::Builder::new()
            .name("desktop-controller".into())
            .spawn(move || {
                for job in rx {
                    job();
                }
            })
            .expect("controller thread");
        Executor(tx)
    }

    pub fn post(&self, job: impl FnOnce() + Send + 'static) {
        let _ = self.0.send(Box::new(job));
    }
}

/// The controller, once it exists (it is created after the platform).
pub type ControllerCell = Arc<OnceLock<Arc<DesktopController>>>;

fn later(
    executor: &Executor,
    cell: &ControllerCell,
    job: impl FnOnce(&DesktopController) + Send + 'static,
) {
    let cell = cell.clone();
    executor.post(move || {
        if let Some(controller) = cell.get() {
            job(controller);
        }
    });
}

pub const TRAY_ID: &str = "main";

fn tray_icon_bytes(file: &str) -> Option<&'static [u8]> {
    Some(match file {
        "tray-mac.png" => include_bytes!("../icons/tray/tray-mac.png"),
        "tray.ico" => include_bytes!("../icons/tray/tray.ico"),
        "tray-running.ico" => include_bytes!("../icons/tray/tray-running.ico"),
        "tray.png" => include_bytes!("../icons/tray/tray.png"),
        "tray-running.png" => include_bytes!("../icons/tray/tray-running.png"),
        "overlay-running.png" => include_bytes!("../icons/tray/overlay-running.png"),
        _ => return None,
    })
}

fn image(file: &str) -> Option<Image<'static>> {
    tray_icon_bytes(file).and_then(|bytes| Image::from_bytes(bytes).ok())
}

pub struct TauriWindow(WebviewWindow);

impl WindowOps for TauriWindow {
    fn is_destroyed(&self) -> bool {
        self.0
            .app_handle()
            .get_webview_window(crate::window::MAIN)
            .is_none()
    }
    fn is_visible(&self) -> bool {
        self.0.is_visible().unwrap_or(false)
    }
    fn is_maximized(&self) -> bool {
        self.0.is_maximized().unwrap_or(false)
    }
    fn is_full_screen(&self) -> bool {
        self.0.is_fullscreen().unwrap_or(false)
    }
    fn normal_bounds(&self) -> Rect {
        let scale = self.0.scale_factor().unwrap_or(1.0);
        let pos = self
            .0
            .outer_position()
            .map(|p| p.to_logical::<f64>(scale))
            .unwrap_or(LogicalPosition::new(0.0, 0.0));
        let size = self
            .0
            .inner_size()
            .map(|s| s.to_logical::<f64>(scale))
            .unwrap_or(LogicalSize::new(1280.0, 800.0));
        Rect {
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
        }
    }
    fn work_areas(&self) -> Vec<Rect> {
        self.0
            .available_monitors()
            .unwrap_or_default()
            .iter()
            .map(|m| {
                let scale = m.scale_factor();
                let area = m.work_area();
                let pos = area.position.to_logical::<f64>(scale);
                let size = area.size.to_logical::<f64>(scale);
                Rect {
                    x: pos.x,
                    y: pos.y,
                    width: size.width,
                    height: size.height,
                }
            })
            .collect()
    }
    fn set_minimum_size(&mut self, width: f64, height: f64) {
        let _ = self.0.set_min_size(Some(LogicalSize::new(width, height)));
    }
    fn set_bounds(&mut self, bounds: &InitialBounds) {
        let _ = self
            .0
            .set_size(LogicalSize::new(bounds.width, bounds.height));
        if let (Some(x), Some(y)) = (bounds.x, bounds.y) {
            let _ = self.0.set_position(LogicalPosition::new(x, y));
        }
    }
    fn set_always_on_top(&mut self, enabled: bool) {
        let _ = self.0.set_always_on_top(enabled);
    }
    fn unmaximize(&mut self) {
        let _ = self.0.unmaximize();
    }
    fn maximize(&mut self) {
        let _ = self.0.maximize();
    }
    fn leave_fullscreen(&mut self) -> bool {
        if !self.0.is_fullscreen().unwrap_or(false) {
            return true;
        }
        let _ = self.0.set_fullscreen(false);
        // Tauri answers set_fullscreen once the window has left it on every
        // platform but macOS, whose animation ends later: the shell reports
        // `fullscreen_left` from the Resized event (window.rs).
        !self.0.is_fullscreen().unwrap_or(false)
    }
}

pub struct TauriDesktop {
    app: AppHandle,
    executor: Executor,
    controller: ControllerCell,
    window: Option<TauriWindow>,
    tray: Option<TrayIcon>,
    activity_pause: Arc<dyn Fn(bool) + Send + Sync>,
}

impl TauriDesktop {
    pub fn new(
        app: AppHandle,
        executor: Executor,
        controller: ControllerCell,
        activity_pause: Arc<dyn Fn(bool) + Send + Sync>,
    ) -> Self {
        TauriDesktop {
            app,
            executor,
            controller,
            window: None,
            tray: None,
            activity_pause,
        }
    }

    fn main_window(&self) -> Option<WebviewWindow> {
        self.app.get_webview_window(crate::window::MAIN)
    }

    fn build_menu(&self, items: &[TrayMenuItem]) -> tauri::Result<Menu<tauri::Wry>> {
        let menu = Menu::new(&self.app)?;
        for item in items {
            match item {
                TrayMenuItem::Item { id, label, enabled } => {
                    menu.append(&MenuItem::with_id(
                        &self.app,
                        id.as_str(),
                        label,
                        *enabled,
                        None::<&str>,
                    )?)?;
                }
                TrayMenuItem::Heading { label } => {
                    menu.append(&MenuItem::new(&self.app, label, false, None::<&str>)?)?;
                }
                TrayMenuItem::Separator => {
                    menu.append(&PredefinedMenuItem::separator(&self.app)?)?;
                }
            }
        }
        Ok(menu)
    }
}

impl DesktopPlatform for TauriDesktop {
    fn emit(&mut self, channel: &str, payload: serde_json::Value) {
        crate::shell::push(&self.app, channel, &payload);
    }

    fn reveal_window(&mut self) {
        crate::shell::show_main(&self.app);
    }

    fn hide_window(&mut self) {
        if let Some(window) = self.main_window() {
            let _ = window.hide();
        }
    }

    fn window_visible(&self) -> bool {
        self.main_window()
            .is_some_and(|w| w.is_visible().unwrap_or(false))
    }

    fn window_focused(&self) -> bool {
        self.main_window()
            .is_some_and(|w| w.is_focused().unwrap_or(false))
    }

    fn window_minimized(&self) -> bool {
        self.main_window()
            .is_some_and(|w| w.is_minimized().unwrap_or(false))
    }

    fn window(&mut self) -> Option<&mut dyn WindowOps> {
        self.window = self.main_window().map(TauriWindow);
        self.window.as_mut().map(|w| w as &mut dyn WindowOps)
    }

    fn tray_update(&mut self, update: &TrayUpdate) {
        if update.create && self.tray.is_none() {
            let executor = self.executor.clone();
            let cell = self.controller.clone();
            let click_executor = self.executor.clone();
            let click_cell = self.controller.clone();
            let windows = cfg!(windows);
            let mut builder = TrayIconBuilder::with_id(TRAY_ID)
                .show_menu_on_left_click(!windows)
                .on_menu_event(move |_app, event| {
                    let id = event.id().as_ref().to_string();
                    later(&executor, &cell, move |c| c.click_tray(&id));
                })
                .on_tray_icon_event(move |_tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if windows {
                            later(&click_executor, &click_cell, |c| c.tray_activated());
                        }
                    }
                });
            if let Some((_, file)) = update.icon {
                if let Some(icon) = image(file) {
                    builder = builder.icon(icon);
                }
            }
            match builder.build(&self.app) {
                Ok(tray) => self.tray = Some(tray),
                Err(error) => eprintln!("[tray] could not create the tray: {error}"),
            }
        }
        let Some(tray) = self.tray.as_ref() else {
            return;
        };
        if let Some(items) = &update.menu {
            match self.build_menu(items) {
                Ok(menu) => {
                    let _ = tray.set_menu(Some(menu));
                }
                Err(error) => eprintln!("[tray] menu failed: {error}"),
            }
        }
        if let Some((_, file)) = update.icon {
            if let Some(icon) = image(file) {
                let _ = tray.set_icon(Some(icon));
                #[cfg(target_os = "macos")]
                let _ = tray.set_icon_as_template(false);
            }
        }
        if let Some(title) = &update.title {
            #[cfg(target_os = "macos")]
            {
                let _ = tray.set_title(if title.is_empty() {
                    None
                } else {
                    Some(title.as_str())
                });
                monospaced_digits(tray);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = title;
        }
        if let Some(tooltip) = &update.tooltip {
            let _ = tray.set_tooltip(Some(tooltip.as_str()));
        }
    }

    fn tray_destroy(&mut self) {
        if let Some(tray) = self.tray.take() {
            let _ = self.app.remove_tray_by_id(tray.id());
        }
    }

    fn register_shortcut(
        &mut self,
        accelerator: &str,
        action: DesktopShortcutAction,
    ) -> Result<bool, String> {
        let spec =
            tyt_model::accelerator::tauri_accelerator(accelerator).ok_or("not an accelerator")?;
        let shortcut: tauri_plugin_global_shortcut::Shortcut =
            spec.parse().map_err(|e| format!("{e:?}"))?;
        let executor = self.executor.clone();
        let cell = self.controller.clone();
        match self
            .app
            .global_shortcut()
            .on_shortcut(shortcut, move |_app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    later(&executor, &cell, move |c| c.trigger(action));
                }
            }) {
            Ok(()) => Ok(true),
            // Another application or the OS holds the chord.
            Err(tauri_plugin_global_shortcut::Error::GlobalHotkey(_)) => Ok(false),
            Err(error) => Err(error.to_string()),
        }
    }

    fn unregister_shortcut(&mut self, accelerator: &str) {
        if let Some(spec) = tyt_model::accelerator::tauri_accelerator(accelerator) {
            if let Ok(shortcut) = spec.parse::<tauri_plugin_global_shortcut::Shortcut>() {
                let _ = self.app.global_shortcut().unregister(shortcut);
            }
        }
    }

    fn notifications_supported(&self) -> bool {
        true
    }

    fn post_notification(&mut self, notice: &DesktopNotice) {
        let executor = self.executor.clone();
        let cell = self.controller.clone();
        let tag = notice.tag.clone();
        if let Err(error) = crate::notify::post(
            &notice.title,
            &notice.body,
            &notice.tag,
            Box::new(move || {
                later(&executor, &cell, move |c| c.notification_clicked(&tag));
            }),
        ) {
            eprintln!("[notify] could not post: {error}");
        }
    }

    fn close_notification(&mut self, _tag: &str) {
        // A newer notice with the same tag replaces the old one on Windows
        // and Linux; macOS stacks them, as the Electron build did.
    }

    fn set_running_badge(&mut self, on: bool, label: &str) {
        let Some(window) = self.main_window() else {
            return;
        };
        #[cfg(target_os = "macos")]
        {
            let _ = label;
            let _ = window.set_badge_label(if on { Some("●".to_string()) } else { None });
        }
        #[cfg(windows)]
        {
            let _ = label;
            let _ = window.set_overlay_icon(if on {
                image(tyt_model::tray_model::OVERLAY_RUNNING_FILE)
            } else {
                None
            });
        }
        #[cfg(target_os = "linux")]
        let _ = (window, on, label);
    }

    fn set_user_tasks(&mut self, _tasks: &[UserTask]) -> bool {
        // The Windows jump list needs ICustomDestinationList, which Tauri does
        // not wrap; the taskbar's own "Track Your Time" entry still works.
        false
    }

    fn show_quit_notice(&mut self, title: &str, body: &str, button: &str) {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        let _ = self
            .app
            .dialog()
            .message(body)
            .title(title)
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCustom(button.to_string()))
            .blocking_show();
    }

    fn quit(&mut self) {
        crate::shell::request_quit(&self.app);
    }

    fn pause_autopilot(&mut self, paused: bool) {
        let pause = self.activity_pause.clone();
        // The activity controller has a lock of its own; never take it under ours.
        std::thread::spawn(move || pause(paused));
    }
}

/// The menu bar clock in monospaced digits, so it does not jitter as it
/// ticks (Electron's `setTitle(title, { fontType: "monospacedDigit" })`).
#[cfg(target_os = "macos")]
fn monospaced_digits(tray: &TrayIcon) {
    let _ = tray.with_inner_tray_icon(|inner| {
        let Some(item) = inner.ns_status_item() else {
            return;
        };
        let Some(mtm) = objc2::MainThreadMarker::new() else {
            return;
        };
        unsafe {
            if let Some(button) = item.button(mtm) {
                let size = objc2_app_kit::NSFont::systemFontSize();
                let font = objc2_app_kit::NSFont::monospacedDigitSystemFontOfSize_weight(
                    size,
                    objc2_app_kit::NSFontWeightRegular,
                );
                button.setFont(Some(&font));
            }
        }
    });
}
