//! A [`DesktopPlatform`] that records every call instead of touching the OS,
//! with a fake window. The controller's own tests use it, and the shell can
//! use it to exercise its bridge without a tray, a shortcut or a window.
//!
//! Everything it records sits behind an `Arc<Mutex<_>>` the creator keeps a
//! clone of, because the controller owns the platform it is given.

use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::Value;
use tyt_wire::{DesktopNotice, DesktopShortcutAction};

use super::{DesktopPlatform, TrayUpdate};
use crate::taskbar_model::UserTask;
use crate::tray_model::TrayMenuItem;
use crate::window_presentation::WindowOps;
use crate::window_state::{InitialBounds, Rect};

/// A window's state, as the fake keeps it.
#[derive(Debug, Clone, PartialEq)]
pub struct FakeWindow {
    pub rect: Rect,
    pub min_size: (f64, f64),
    pub work_areas: Vec<Rect>,
    pub visible: bool,
    pub focused: bool,
    pub minimized: bool,
    pub maximized: bool,
    pub fullscreen: bool,
    pub always_on_top: bool,
    pub destroyed: bool,
    /// Whether leaving fullscreen happens at once (`true`) or waits for
    /// `fullscreen_left`, as a macOS animation does.
    pub leaves_fullscreen_at_once: bool,
}

impl Default for FakeWindow {
    fn default() -> Self {
        FakeWindow {
            rect: Rect {
                x: 30.0,
                y: 40.0,
                width: 1100.0,
                height: 720.0,
            },
            min_size: (800.0, 500.0),
            work_areas: vec![Rect {
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            }],
            visible: false,
            focused: false,
            minimized: false,
            maximized: false,
            fullscreen: false,
            always_on_top: false,
            destroyed: false,
            leaves_fullscreen_at_once: true,
        }
    }
}

/// The fake window, shared between the platform and the test.
#[derive(Debug, Clone, Default)]
pub struct SharedWindow(pub Arc<Mutex<FakeWindow>>);

impl SharedWindow {
    pub fn get(&self) -> MutexGuard<'_, FakeWindow> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
}

impl WindowOps for SharedWindow {
    fn is_destroyed(&self) -> bool {
        self.get().destroyed
    }
    fn is_visible(&self) -> bool {
        self.get().visible
    }
    fn is_maximized(&self) -> bool {
        self.get().maximized
    }
    fn is_full_screen(&self) -> bool {
        self.get().fullscreen
    }
    fn normal_bounds(&self) -> Rect {
        self.get().rect
    }
    fn work_areas(&self) -> Vec<Rect> {
        self.get().work_areas.clone()
    }
    fn set_minimum_size(&mut self, width: f64, height: f64) {
        self.get().min_size = (width, height);
    }
    fn set_bounds(&mut self, bounds: &InitialBounds) {
        let mut window = self.get();
        window.rect.x = bounds.x.unwrap_or(window.rect.x);
        window.rect.y = bounds.y.unwrap_or(window.rect.y);
        window.rect.width = bounds.width;
        window.rect.height = bounds.height;
    }
    fn set_always_on_top(&mut self, enabled: bool) {
        self.get().always_on_top = enabled;
    }
    fn unmaximize(&mut self) {
        self.get().maximized = false;
    }
    fn maximize(&mut self) {
        let mut window = self.get();
        window.maximized = true;
        // Maximizing shows a hidden window, which is why the model only asks
        // while it is visible.
        window.visible = true;
    }
    fn leave_fullscreen(&mut self) -> bool {
        let mut window = self.get();
        if !window.fullscreen {
            return true;
        }
        if window.leaves_fullscreen_at_once {
            window.fullscreen = false;
            return true;
        }
        false
    }
}

/// The tray as the platform last drew it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RecordedTray {
    pub menu: Vec<TrayMenuItem>,
    pub icon_file: String,
    pub title: String,
    pub tooltip: String,
}

#[derive(Debug, Default)]
pub struct Recording {
    pub emitted: Vec<(String, Value)>,
    pub reveals: u64,
    pub hides: u64,
    pub tray: Option<RecordedTray>,
    pub tray_updates: Vec<TrayUpdate>,
    pub tray_destroys: u64,
    pub registered: Vec<(String, DesktopShortcutAction)>,
    /// Chords another application holds.
    pub taken: Vec<String>,
    /// Accelerators the registrar cannot parse.
    pub unparseable: Vec<String>,
    pub notifications_unsupported: bool,
    pub notifications: Vec<DesktopNotice>,
    pub closed_notifications: Vec<String>,
    pub badge: Vec<(bool, String)>,
    pub user_tasks: Vec<Vec<UserTask>>,
    pub refuse_user_tasks: bool,
    pub quit_notices: Vec<(String, String, String)>,
    pub quits: u64,
    pub autopilot_pauses: Vec<bool>,
}

impl Recording {
    pub fn emitted_on(&self, channel: &str) -> Vec<Value> {
        self.emitted
            .iter()
            .filter(|(c, _)| c == channel)
            .map(|(_, v)| v.clone())
            .collect()
    }

    pub fn accelerators(&self) -> Vec<String> {
        self.registered.iter().map(|(a, _)| a.clone()).collect()
    }
}

#[derive(Debug, Clone, Default)]
pub struct RecordingPlatform {
    pub record: Arc<Mutex<Recording>>,
    pub window: Option<SharedWindow>,
}

impl RecordingPlatform {
    /// A platform with a hidden fake window.
    pub fn new() -> Self {
        RecordingPlatform {
            record: Arc::default(),
            window: Some(SharedWindow::default()),
        }
    }

    /// A platform with no window at all.
    pub fn windowless() -> Self {
        RecordingPlatform {
            record: Arc::default(),
            window: None,
        }
    }

    pub fn record(&self) -> MutexGuard<'_, Recording> {
        self.record.lock().unwrap_or_else(|p| p.into_inner())
    }
}

impl DesktopPlatform for RecordingPlatform {
    fn emit(&mut self, channel: &str, payload: Value) {
        self.record().emitted.push((channel.to_string(), payload));
    }

    fn reveal_window(&mut self) {
        self.record().reveals += 1;
        if let Some(window) = &self.window {
            let mut window = window.get();
            window.visible = true;
            window.focused = true;
            window.minimized = false;
        }
    }

    fn hide_window(&mut self) {
        self.record().hides += 1;
        if let Some(window) = &self.window {
            let mut window = window.get();
            window.visible = false;
            window.focused = false;
        }
    }

    fn window_visible(&self) -> bool {
        self.window.as_ref().is_some_and(|w| w.get().visible)
    }

    fn window_focused(&self) -> bool {
        self.window.as_ref().is_some_and(|w| w.get().focused)
    }

    fn window_minimized(&self) -> bool {
        self.window.as_ref().is_some_and(|w| w.get().minimized)
    }

    fn window(&mut self) -> Option<&mut dyn WindowOps> {
        self.window.as_mut().map(|w| w as &mut dyn WindowOps)
    }

    fn tray_update(&mut self, update: &TrayUpdate) {
        let mut record = self.record();
        record.tray_updates.push(update.clone());
        let tray = record.tray.get_or_insert_with(RecordedTray::default);
        if let Some(menu) = &update.menu {
            tray.menu = menu.clone();
        }
        if let Some((_, file)) = update.icon {
            tray.icon_file = file.to_string();
        }
        if let Some(title) = &update.title {
            tray.title = title.clone();
        }
        if let Some(tooltip) = &update.tooltip {
            tray.tooltip = tooltip.clone();
        }
    }

    fn tray_destroy(&mut self) {
        let mut record = self.record();
        record.tray = None;
        record.tray_destroys += 1;
    }

    fn register_shortcut(
        &mut self,
        accelerator: &str,
        action: DesktopShortcutAction,
    ) -> Result<bool, String> {
        let mut record = self.record();
        if record.unparseable.iter().any(|a| a == accelerator) {
            return Err(format!("cannot parse {accelerator}"));
        }
        if record.taken.iter().any(|a| a == accelerator)
            || record.registered.iter().any(|(a, _)| a == accelerator)
        {
            return Ok(false);
        }
        record.registered.push((accelerator.to_string(), action));
        Ok(true)
    }

    fn unregister_shortcut(&mut self, accelerator: &str) {
        self.record().registered.retain(|(a, _)| a != accelerator);
    }

    fn notifications_supported(&self) -> bool {
        !self.record().notifications_unsupported
    }

    fn post_notification(&mut self, notice: &DesktopNotice) {
        self.record().notifications.push(notice.clone());
    }

    fn close_notification(&mut self, tag: &str) {
        self.record().closed_notifications.push(tag.to_string());
    }

    fn set_running_badge(&mut self, on: bool, label: &str) {
        self.record().badge.push((on, label.to_string()));
    }

    fn set_user_tasks(&mut self, tasks: &[UserTask]) -> bool {
        let mut record = self.record();
        if record.refuse_user_tasks {
            return false;
        }
        record.user_tasks.push(tasks.to_vec());
        true
    }

    fn show_quit_notice(&mut self, title: &str, body: &str, button: &str) {
        self.record()
            .quit_notices
            .push((title.to_string(), body.to_string(), button.to_string()));
    }

    fn quit(&mut self) {
        self.record().quits += 1;
    }

    fn pause_autopilot(&mut self, paused: bool) {
        self.record().autopilot_pauses.push(paused);
    }
}
