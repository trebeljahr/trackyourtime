//! Pure decision logic of the desktop shell, ported from the Electron main
//! process (`electron/src/*.ts` before 2026-11-12). Nothing here touches
//! Tauri, a window or the OS beyond files: `desktop/src-tauri` binds it.

// Shell bootstrap (origin, profile, trust, CSP, the token store).
pub mod csp;
pub mod distribution;
pub mod profile;
pub mod resolve_app_path;
pub mod secure_store;
pub mod trust;
pub mod window_policy;

// Tray, settings, shortcuts, updates, windows.
pub mod accelerator;
pub mod desktop_settings;
pub mod idle;
pub mod login_item;
pub mod shortcuts;
pub mod taskbar_model;
pub mod timer_menu;
pub mod tray_model;
pub mod updater_model;
pub mod window_presentation;
pub mod window_state;

// Controllers: the state machines of desktop.ts and updater.ts over a
// platform trait the Tauri shell implements (and a recording fake headless).
pub mod desktop_controller;
pub mod raycast_menu;
pub mod updater_controller;
