//! The main window: how it is created, guarded, shown, hidden and remembered.
//!
//! Security baseline (Electron's security.ts, carried over): the window never
//! leaves the app origin — an http(s) or mailto link goes to the OS, anything
//! else is refused; no new windows; devtools only in a dev run.
//!
//! Headless (tests, agents): created hidden and never shown, focused or put
//! in the taskbar, so a launch never takes focus from whoever is using the
//! machine. Background throttling is off, because the hidden window is where
//! the timer, the offline queue, the sync socket and Autopilot's driver run:
//! WebKit's default policy throttles and then suspends a hidden page.

use std::path::Path;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tyt_model::window_presentation::WindowLaunch;
use tyt_model::window_state::Rect;

use crate::shell::Shell;

pub const MAIN: &str = "main";
#[allow(dead_code)]
const QUIT_MENU_ID: &str = "app-quit";
const TITLE: &str = "Track Your Time";

/// Every display's work area in logical pixels, as Electron's
/// `screen.getAllDisplays().map(d => d.workArea)` reported them.
pub fn work_areas(app: &AppHandle) -> Vec<Rect> {
    app.available_monitors()
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

pub fn app_url(shell: &Shell) -> WebviewUrl {
    if let Some(dev) = shell
        .dev_url
        .as_deref()
        .and_then(|u| url::Url::parse(u).ok())
    {
        return WebviewUrl::External(dev);
    }
    let origin = tyt_wire::desktop_app_origin();
    WebviewUrl::CustomProtocol(url::Url::parse(&format!("{origin}/")).expect("app origin parses"))
}

/// A stable 16-byte identifier for a profile's WebKit data store (macOS 14+).
/// The installed app's own profile keeps WebKit's default store.
#[allow(dead_code)]
pub fn data_store_identifier(profile: &Path) -> [u8; 16] {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(profile.to_string_lossy().as_bytes());
    let mut id = [0u8; 16];
    id.copy_from_slice(&digest[..16]);
    // RFC 4122 version 8 (custom) and variant bits, so it is a valid UUID.
    id[6] = (id[6] & 0x0f) | 0x80;
    id[8] = (id[8] & 0x3f) | 0x80;
    id
}

fn is_default_profile(shell: &Shell) -> bool {
    !shell.headless
        && crate::is_packaged()
        && !shell
            .env
            .contains_key(tyt_model::profile::USER_DATA_DIR_ENV)
}

pub fn create_main(
    app: &AppHandle,
    shell: &Shell,
    launch: &WindowLaunch,
) -> tauri::Result<WebviewWindow> {
    let show = launch.show_when_ready && !shell.headless;
    let maximize = launch.maximize_when_ready;
    let dev_origin = shell.dev_origin();
    let migration = shell.migration.lock().unwrap().clone();
    let script = crate::bridge::script(dev_origin.as_deref(), migration.as_ref());
    let headless = shell.headless;
    let smoke = shell.smoke_report.is_some();
    let dev_url = shell.dev_url.clone();
    let nav_dev = dev_url.clone();
    let perm_dev = dev_url.clone();

    let mut builder = WebviewWindowBuilder::new(app, MAIN, app_url(shell))
        .title(TITLE)
        .inner_size(launch.bounds.width, launch.bounds.height)
        .min_inner_size(
            f64::from(launch.min_size.width),
            f64::from(launch.min_size.height),
        )
        .fullscreen(launch.fullscreen && !headless)
        .visible(false)
        .focused(!headless)
        .skip_taskbar(headless)
        .initialization_script_for_all_frames(include_str!("harden.js"))
        .initialization_script(script)
        .background_color(background_color(system_dark()))
        .on_download({
            let profile = shell.profile.clone();
            move |_webview, event| {
                match event {
                    tauri::webview::DownloadEvent::Requested { url, destination } => {
                        crate::downloads::requested(url.as_str(), destination, headless, &profile)
                    }
                    tauri::webview::DownloadEvent::Finished { url, path, success } => {
                        crate::downloads::finished(url.as_str(), path, success)
                    }
                    _ => {}
                }
                true
            }
        })
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .devtools(dev_url.is_some())
        .on_navigation(move |url| {
            let text = url.as_str();
            if tyt_model::trust::is_trusted_sender_url(Some(text), nav_dev.as_deref()) {
                return true;
            }
            if tyt_model::trust::is_os_handled_url(text) {
                let _ = crate::external::open_in_os(text, headless);
            } else {
                eprintln!("[security] blocked navigation to {text}");
            }
            false
        })
        // Every web permission is denied but notifications, and only for the
        // app's own document (trust.rs → GRANTED_PERMISSIONS). Clipboard
        // writes need no permission in the system WebViews.
        .on_permission_request(move |webview, kind| {
            let url = webview.url().map(|u| u.to_string()).ok();
            let name = match kind {
                tauri::webview::PermissionKind::Notifications => "notifications",
                _ => "denied",
            };
            if tyt_model::trust::is_permission_granted(name, url.as_deref(), perm_dev.as_deref()) {
                tauri::webview::PermissionResponse::Allow
            } else {
                tauri::webview::PermissionResponse::Deny
            }
        })
        .on_new_window(move |url, _features| {
            let text = url.as_str();
            if tyt_model::trust::is_os_handled_url(text) {
                let _ = crate::external::open_in_os(text, headless);
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |window, payload| {
            #[cfg(feature = "e2e")]
            if payload.event() == PageLoadEvent::Finished {
                crate::e2e::LOADS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            if payload.event() == PageLoadEvent::Finished && smoke {
                let _ = window.eval(crate::problems::SMOKE_SCRIPT);
            }
            if payload.event() == PageLoadEvent::Started {
                // A reload cannot finish recording a shortcut (desktop.ts's
                // did-start-loading → rendererReset).
                window
                    .app_handle()
                    .state::<Shell>()
                    .later(|c| c.renderer_reset());
            }
            if payload.event() == PageLoadEvent::Finished
                && show
                && !headless
                && !window.is_visible().unwrap_or(true)
            {
                if maximize {
                    let _ = window.maximize();
                }
                let _ = window.show();
                let _ = window.set_focus();
            }
        });

    if cfg!(feature = "e2e") || smoke {
        builder = builder.initialization_script(crate::problems::SCRIPT);
    }
    #[cfg(feature = "e2e")]
    {
        builder = builder.initialization_script(crate::e2e::DOM_SCRIPT);
    }
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(16.0, 20.0));
        if !is_default_profile(shell) {
            builder = builder.data_store_identifier(data_store_identifier(&shell.profile));
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = is_default_profile;
        builder = builder.data_directory(shell.profile.join("webview"));
    }

    if let (Some(x), Some(y)) = (launch.bounds.x, launch.bounds.y) {
        builder = builder.position(x, y);
    }
    let window = builder.build()?;
    let app_handle = app.clone();
    window.on_window_event(move |event| {
        let shell = app_handle.state::<Shell>();
        match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                // Decided by the controller off the main thread; until it
                // answers, the window stays (platform.rs threading rule).
                if shell.exit_ready.load(std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                api.prevent_close();
                let handle = app_handle.clone();
                shell.later(move |c| match c.window_close_requested() {
                    tyt_model::desktop_controller::CloseDecision::Close => {
                        if let Some(window) = handle.get_webview_window(MAIN) {
                            let _ = window.destroy();
                        }
                    }
                    tyt_model::desktop_controller::CloseDecision::Hide {
                        leave_fullscreen_first,
                    } => {
                        if let Some(window) = handle.get_webview_window(MAIN) {
                            if leave_fullscreen_first && window.is_fullscreen().unwrap_or(false) {
                                let _ = window.set_fullscreen(false);
                            }
                            let _ = window.hide();
                        }
                    }
                });
            }
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                let handle = app_handle.clone();
                shell.later(move |c| {
                    c.window_changed();
                    if handle
                        .get_webview_window(MAIN)
                        .is_some_and(|w| !w.is_fullscreen().unwrap_or(false))
                    {
                        c.fullscreen_left();
                    }
                });
            }
            _ => {}
        }
    });
    Ok(window)
}

/// The window's and WebView's colour before the page paints: the page's own
/// background for the OS theme (window_state::background_color_for), so a
/// launch never flashes the WebView's default white or the window's grey.
fn background_color(dark: bool) -> tauri::window::Color {
    let hex = tyt_model::window_state::background_color_for(dark).trim_start_matches('#');
    let channel = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).unwrap_or(0);
    tauri::window::Color(channel(0), channel(2), channel(4), 255)
}

/// Whether the OS is in dark mode, read before the window exists.
fn system_dark() -> bool {
    #[cfg(target_os = "macos")]
    {
        // Set in the global domain only while the system appearance is dark
        // (including "Auto" after sunset).
        let defaults = objc2_foundation::NSUserDefaults::standardUserDefaults();
        defaults
            .stringForKey(&objc2_foundation::NSString::from_str("AppleInterfaceStyle"))
            .is_some_and(|style| style.to_string().eq_ignore_ascii_case("dark"))
    }
    #[cfg(windows)]
    {
        use windows::core::HSTRING;
        use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
        let mut value = 1u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        let ok = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                &HSTRING::from("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
                &HSTRING::from("AppsUseLightTheme"),
                RRF_RT_REG_DWORD,
                None,
                Some(&mut value as *mut u32 as *mut _),
                Some(&mut size),
            )
        }
        .is_ok();
        ok && value == 0
    }
    #[cfg(target_os = "linux")]
    {
        std::env::var("GTK_THEME").is_ok_and(|t| t.to_ascii_lowercase().contains("dark"))
    }
}

pub fn reveal(window: &WebviewWindow) {
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window.set_skip_taskbar(false);
    let _ = window.show();
    let _ = window.set_focus();
}

/// The macOS application menu (Edit roles are what make copy and paste work
/// in a WebView); Windows and Linux have none outside a dev run.
pub fn install_menu(app: &AppHandle, dev: bool) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use tauri::menu::{MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder};
        let name = "Track Your Time";
        let app_menu = SubmenuBuilder::new(app, name)
            .item(&PredefinedMenuItem::about(app, None, None)?)
            .separator()
            .item(&PredefinedMenuItem::hide(app, None)?)
            .item(&PredefinedMenuItem::hide_others(app, None)?)
            .item(&PredefinedMenuItem::show_all(app, None)?)
            .separator()
            // Not the predefined Quit: that sends `terminate:`, which ends the
            // event loop without an exit request, skipping the unsent-changes
            // notice and install-on-quit (shell.rs → request_quit).
            .item(&MenuItem::with_id(
                app,
                QUIT_MENU_ID,
                "Quit Track Your Time",
                true,
                Some("CmdOrCtrl+Q"),
            )?)
            .build()?;
        let edit = SubmenuBuilder::new(app, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;
        let view = SubmenuBuilder::new(app, "View")
            .item(&PredefinedMenuItem::fullscreen(app, None)?)
            .build()?;
        let window = SubmenuBuilder::new(app, "Window")
            .item(&PredefinedMenuItem::minimize(app, None)?)
            .item(&PredefinedMenuItem::maximize(app, None)?)
            .item(&PredefinedMenuItem::close_window(app, None)?)
            .build()?;
        let menu = MenuBuilder::new(app)
            .items(&[&app_menu, &edit, &view, &window])
            .build()?;
        app.set_menu(menu)?;
        app.on_menu_event(|app, event| {
            if event.id().as_ref() == QUIT_MENU_ID {
                crate::shell::request_quit(app);
            }
        });
        let _ = dev;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, dev);
    }
    Ok(())
}
