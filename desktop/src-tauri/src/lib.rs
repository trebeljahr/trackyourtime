#![recursion_limit = "256"]
//! Track Your Time desktop shell (Tauri 2).
//!
//! Serves `packages/client/out-desktop` — embedded in the binary — from the
//! app protocol (`protocol.rs`) and installs the desktop bridge
//! (`bridge.js`) before any page script. The decisions live in pure crates
//! (`tyt-model`, `tyt-activity`); this crate binds them to the OS.
//!
//! Dev (`pnpm dev:desktop`, debug builds only): loads TRACKYOURTIME_DEV_URL,
//! the Next dev server. A release build ignores it: honoring it would let
//! anything that can set an environment variable load an arbitrary page with
//! the bridge.

mod activity;
mod bridge;
mod downloads;
mod external;
mod idle;
mod instance;
mod ipc;
mod legacy;
mod login;
mod migrate;
mod notify;
mod platform;
mod problems;
mod protocol;
mod secure;
mod shell;
mod updater;
mod window;

#[cfg(feature = "e2e")]
mod e2e;

use std::collections::HashMap;
use std::sync::Arc;
use tauri::{Manager, RunEvent};

pub const HEADLESS_ENV: &str = "TRACKYOURTIME_HEADLESS";
pub const DEV_URL_ENV: &str = "TRACKYOURTIME_DEV_URL";

pub fn is_headless() -> bool {
    std::env::var(HEADLESS_ENV).as_deref() == Ok("1")
}

/// Node's spelling of the OS, which the renderer and the models use.
pub fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "win32"
    } else {
        "linux"
    }
}

/// A release build is the "packaged" app: it pins the profile by name and
/// may update itself. Debug builds (dev runs, the e2e harness) are not.
pub fn is_packaged() -> bool {
    !cfg!(debug_assertions)
}

/// Running from an MSIX package (the Microsoft Store build): such a process
/// has a package identity, which a direct install does not.
pub fn windows_store() -> bool {
    #[cfg(windows)]
    unsafe {
        let mut length = 0u32;
        // ERROR_INSUFFICIENT_BUFFER (122) means there is a name to return.
        windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName(&mut length, None).0
            == 122
    }
    #[cfg(not(windows))]
    false
}

fn app_data_base() -> std::path::PathBuf {
    // Electron's `appData`: ~/Library/Application Support, %APPDATA%,
    // $XDG_CONFIG_HOME or ~/.config. The profile lives under it by name.
    #[cfg(target_os = "macos")]
    {
        std::path::PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
            .join("Library/Application Support")
    }
    #[cfg(windows)]
    {
        std::path::PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default())
    }
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("XDG_CONFIG_HOME")
            .filter(|v| !v.is_empty())
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::path::PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
                    .join(".config")
            })
    }
}

pub fn run() {
    let headless = is_headless();
    let env: HashMap<String, String> = std::env::vars().collect();
    let profile = tyt_model::profile::user_data_dir(
        &app_data_base(),
        is_packaged(),
        headless,
        env.get(tyt_model::profile::USER_DATA_DIR_ENV)
            .map(String::as_str),
    );

    // One instance per profile, decided before anything else runs.
    let primary = match instance::acquire(&profile) {
        Ok(instance::Instance::Primary {
            _lock,
            listener,
            token,
        }) => (_lock, listener, token),
        Ok(instance::Instance::Secondary) => {
            println!(
                "[main] another instance holds {}; handed over to it",
                profile.display()
            );
            return;
        }
        Err(error) => {
            eprintln!(
                "[main] could not lock the profile {}: {error}",
                profile.display()
            );
            std::process::exit(1);
        }
    };

    // The window's WM_CLASS / Wayland app id, which the desktop entry's
    // StartupWMClass names; without it GNOME shows a second, iconless dock item.
    #[cfg(target_os = "linux")]
    {
        gtk::glib::set_prgname(Some("trackyourtime"));
        gtk::glib::set_application_name("Track Your Time");
    }

    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        // DMA-BUF rendering blanks the window on several driver stacks and
        // under Xvfb; the compositing fallback is fine for this app.
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    let dev_url = if cfg!(debug_assertions) {
        env.get(DEV_URL_ENV).cloned().filter(|u| !u.is_empty())
    } else {
        None
    };

    let mut context = tauri::generate_context!();
    // The protocol handler needs exact lookups (no SPA fallback), so it takes
    // the embedded export and Tauri's own resolver is handed a view of it.
    let assets: protocol::SharedAssets = Arc::new(context.set_assets(Box::new(EmptyAssets)));
    context.set_assets(Box::new(protocol::ForwardAssets(assets.clone())));

    let shell_state = shell::Shell::new(shell::ShellOptions {
        headless,
        profile: profile.clone(),
        dev_url: dev_url.clone(),
        env,
    });

    let protocol_assets = assets.clone();
    let builder = tauri::Builder::default()
        .register_uri_scheme_protocol(tyt_wire::DESKTOP_APP_SCHEME, move |_ctx, request| {
            protocol::handle(&protocol_assets, &request)
        })
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(shell_state)
        .setup(move |app| {
            let (lock, listener, token) = primary;
            app.manage(shell::InstanceLock(lock));
            let handle = app.handle().clone();
            instance::listen(listener, token, move |argv| {
                shell::second_instance(&handle, argv)
            });
            shell::setup(app)?;
            Ok(())
        });

    // Only builds with an update feed carry the plugin: it refuses to load
    // without endpoints and a public key (updater.rs).
    let builder = if updater::has_feed(context.config()) {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    };
    #[cfg(feature = "e2e")]
    let builder =
        builder.invoke_handler(tauri::generate_handler![ipc::desktop_call, e2e::e2e_result]);
    #[cfg(not(feature = "e2e"))]
    let builder = builder.invoke_handler(tauri::generate_handler![ipc::desktop_call]);

    let app = builder
        .build(context)
        .expect("Track Your Time desktop startup failed");
    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, code, .. } => shell::exit_requested(app, &api, code),
        RunEvent::Exit => shell::exit(app),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => shell::reopen(app),
        _ => {}
    });
}

/// What Tauri's own protocol gets while ours is being set up; replaced at once.
struct EmptyAssets;

impl tauri::Assets<tauri::Wry> for EmptyAssets {
    fn get(&self, _key: &tauri::utils::assets::AssetKey) -> Option<std::borrow::Cow<'_, [u8]>> {
        None
    }
    fn iter(&self) -> Box<tauri::utils::assets::AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }
    fn csp_hashes(
        &self,
        _html_path: &tauri::utils::assets::AssetKey,
    ) -> Box<dyn Iterator<Item = tauri::utils::assets::CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}
