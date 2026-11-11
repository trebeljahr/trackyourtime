//! Open at login. Ported from `electron/src/login-item.ts` (the pure parts:
//! the hidden-launch argument, the XDG autostart file, the memory and
//! unsupported backends, and the trait the platform backends implement).
//!
//! Which backend applies is decided per distribution channel
//! (`crate::distribution::login_item_mechanism`; the Microsoft Store and
//! Flatpak have none) and picked by [`select_login_item`].
//!
//! macOS and Windows go through the OS API, which the shell implements
//! (SMAppService; the `Run` registry key). Linux has none, so the app writes
//! the XDG autostart entry itself: `~/.config/autostart/trackyourtime.desktop`,
//! pointing at the AppImage when it runs from one (`$APPIMAGE`: the executable
//! path is inside a mount that disappears on exit).
//!
//! A launch the OS started at login gets `--hidden` (Windows and Linux) and
//! opens to the tray without a window when the tray is on; Linux also requires
//! opting into hide-on-close because a tray host may be absent. macOS 13 and
//! later register through SMAppService, which passes no arguments, so a Mac
//! opens its window at login; its close button hides it.
//!
//! Headless and unpackaged runs never touch the OS: registering a development
//! binary as a login item on somebody's machine from a test would outlive the
//! test. They get [`MemoryLoginItem`].

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use tyt_wire::DesktopLoginItemStatus;

use crate::distribution::LoginItemMechanism;

pub const HIDDEN_LAUNCH_ARG: &str = "--hidden";
pub const LINUX_AUTOSTART_FILE: &str = "trackyourtime.desktop";
/// The name the autostart entry shows in a desktop's startup settings.
pub const LOGIN_ITEM_NAME: &str = "Track Your Time";
/// The `HKCU\…\Run` value name Electron wrote (its default is the
/// AppUserModelId, which main.ts set to the bundle id). A Windows backend that
/// keeps it finds an existing install's entry and reports it as enabled.
pub const WINDOWS_RUN_VALUE_NAME: &str = "com.ricoslabs.trackyourtime";

/// A platform's way of opening the app at login. `status` failing reads as
/// `unsupported` in Settings (the desktop controller); `set` failing is logged
/// and leaves the stored preference as it was asked.
pub trait LoginItemBackend: Send {
    fn status(&self) -> Result<DesktopLoginItemStatus, String>;
    fn set(&mut self, enabled: bool) -> Result<(), String>;
}

#[derive(Debug, Default, Clone)]
pub struct MemoryLoginItem {
    pub enabled: bool,
}

impl LoginItemBackend for MemoryLoginItem {
    fn status(&self) -> Result<DesktopLoginItemStatus, String> {
        Ok(if self.enabled {
            DesktopLoginItemStatus::Enabled
        } else {
            DesktopLoginItemStatus::Disabled
        })
    }

    fn set(&mut self, enabled: bool) -> Result<(), String> {
        self.enabled = enabled;
        Ok(())
    }
}

/// A channel with no way to open at login; Settings disables the row.
#[derive(Debug, Default, Clone, Copy)]
pub struct UnsupportedLoginItem;

impl LoginItemBackend for UnsupportedLoginItem {
    fn status(&self) -> Result<DesktopLoginItemStatus, String> {
        Ok(DesktopLoginItemStatus::Unsupported)
    }

    fn set(&mut self, _enabled: bool) -> Result<(), String> {
        Ok(())
    }
}

/// A value for a desktop entry's Exec key, quoted per the XDG spec.
pub fn quote_exec_arg(arg: &str) -> String {
    let plain = !arg.is_empty()
        && arg
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'/' | b'-'));
    if plain {
        return arg.to_string();
    }
    let mut quoted = String::with_capacity(arg.len() + 2);
    quoted.push('"');
    for c in arg.chars() {
        if matches!(c, '"' | '`' | '$' | '\\') {
            quoted.push('\\');
        }
        quoted.push(c);
    }
    quoted.push('"');
    quoted
}

pub fn linux_autostart_entry(exec: &str, name: &str) -> String {
    [
        "[Desktop Entry]".to_string(),
        "Type=Application".to_string(),
        format!("Name={}", name.replace(['\r', '\n'], " ")),
        format!("Exec={} {HIDDEN_LAUNCH_ARG}", quote_exec_arg(exec)),
        "X-GNOME-Autostart-enabled=true".to_string(),
        "Terminal=false".to_string(),
        String::new(),
    ]
    .join("\n")
}

/// `$XDG_CONFIG_HOME/autostart/trackyourtime.desktop` when that is absolute,
/// else `~/.config/autostart/trackyourtime.desktop`.
pub fn linux_autostart_path(env: &HashMap<String, String>, home: &Path) -> PathBuf {
    let config_home = match env.get("XDG_CONFIG_HOME") {
        Some(dir) if !dir.is_empty() && Path::new(dir).is_absolute() => PathBuf::from(dir),
        _ => home.join(".config"),
    };
    config_home.join("autostart").join(LINUX_AUTOSTART_FILE)
}

#[derive(Debug, Clone)]
pub struct LinuxLoginItem {
    pub exec: String,
    pub name: String,
    pub file: PathBuf,
}

impl LoginItemBackend for LinuxLoginItem {
    /// Enabled only when the entry points at this executable: one written for
    /// another binary (a moved AppImage) is not ours.
    fn status(&self) -> Result<DesktopLoginItemStatus, String> {
        Ok(match fs::read_to_string(&self.file) {
            Ok(text) if text.contains(&format!("Exec={}", quote_exec_arg(&self.exec))) => {
                DesktopLoginItemStatus::Enabled
            }
            _ => DesktopLoginItemStatus::Disabled,
        })
    }

    fn set(&mut self, enabled: bool) -> Result<(), String> {
        if !enabled {
            return match fs::remove_file(&self.file) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    Err(error.to_string())
                }
                _ => Ok(()),
            };
        }
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        fs::write(&self.file, linux_autostart_entry(&self.exec, &self.name))
            .map_err(|e| e.to_string())
    }
}

/// Whether this launch came from the login item.
pub fn is_hidden_launch<S: AsRef<str>>(argv: &[S]) -> bool {
    argv.iter().any(|arg| arg.as_ref() == HIDDEN_LAUNCH_ARG)
}

/// The backend for this copy, as desktop.ts chose it: memory for headless and
/// unpackaged runs, none where the channel has no mechanism, the XDG entry on
/// Linux, and the shell's OS backend (`native`, only called when it applies)
/// on macOS and Windows.
pub fn select_login_item(
    headless: bool,
    is_packaged: bool,
    mechanism: &LoginItemMechanism,
    env: &HashMap<String, String>,
    home: &Path,
    native: impl FnOnce() -> Box<dyn LoginItemBackend>,
) -> Box<dyn LoginItemBackend> {
    if headless || !is_packaged {
        return Box::new(MemoryLoginItem::default());
    }
    match mechanism {
        LoginItemMechanism::Unsupported { .. } => Box::new(UnsupportedLoginItem),
        LoginItemMechanism::XdgAutostart { exec } => Box::new(LinuxLoginItem {
            exec: exec.clone(),
            name: LOGIN_ITEM_NAME.into(),
            file: linux_autostart_path(env, home),
        }),
        LoginItemMechanism::Native => native(),
    }
}

/// What a native backend reports, as desktop.ts read Electron's
/// `getLoginItemSettings`: on macOS SMAppService's own status wins
/// (`requires-approval` when the person must allow it in System Settings),
/// otherwise whether the item opens at login.
pub fn native_login_status(
    platform: &str,
    service_status: Option<&str>,
    open_at_login: bool,
) -> DesktopLoginItemStatus {
    if platform == "darwin" {
        match service_status {
            Some("requires-approval") => return DesktopLoginItemStatus::RequiresApproval,
            Some("enabled") => return DesktopLoginItemStatus::Enabled,
            _ => {}
        }
    }
    if open_at_login {
        DesktopLoginItemStatus::Enabled
    } else {
        DesktopLoginItemStatus::Disabled
    }
}

/// The `Run` value's data Electron wrote for `{ openAtLogin, args: ["--hidden"] }`.
pub fn windows_run_command(exec_path: &str) -> String {
    format!("\"{exec_path}\" {HIDDEN_LAUNCH_ARG}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_an_exec_path_with_spaces_and_shell_characters() {
        assert_eq!(
            quote_exec_arg("/opt/TrackYourTime/app"),
            "/opt/TrackYourTime/app"
        );
        assert_eq!(
            quote_exec_arg("/home/a b/Track $Time`.AppImage"),
            "\"/home/a b/Track \\$Time\\`.AppImage\""
        );
    }

    #[test]
    fn writes_an_entry_that_launches_hidden() {
        let entry =
            linux_autostart_entry("/home/me/Apps/Track Your Time.AppImage", "Track Your Time");
        assert!(entry.starts_with("[Desktop Entry]\n"));
        assert!(entry.contains("\nExec=\"/home/me/Apps/Track Your Time.AppImage\" --hidden\n"));
        assert!(entry.ends_with("Terminal=false\n"));
    }

    #[test]
    fn honours_an_absolute_xdg_config_home_only() {
        let home = Path::new("/home/me");
        let env = |v: &str| HashMap::from([("XDG_CONFIG_HOME".to_string(), v.to_string())]);
        assert_eq!(
            linux_autostart_path(&env("/x/cfg"), home),
            PathBuf::from("/x/cfg/autostart/trackyourtime.desktop")
        );
        assert_eq!(
            linux_autostart_path(&env("rel"), home),
            PathBuf::from("/home/me/.config/autostart/trackyourtime.desktop")
        );
    }

    #[test]
    fn round_trips_enable_and_disable_on_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("autostart").join("trackyourtime.desktop");
        let mut item = LinuxLoginItem {
            exec: "/opt/tyt".into(),
            name: "Track Your Time".into(),
            file: file.clone(),
        };
        assert_eq!(item.status(), Ok(DesktopLoginItemStatus::Disabled));
        item.set(true).unwrap();
        assert_eq!(item.status(), Ok(DesktopLoginItemStatus::Enabled));
        assert!(fs::read_to_string(&file)
            .unwrap()
            .contains("Exec=/opt/tyt --hidden"));
        item.set(false).unwrap();
        assert_eq!(item.status(), Ok(DesktopLoginItemStatus::Disabled));
        item.set(false).unwrap();
        // An entry written for another binary (a moved AppImage) is not ours.
        let moved = LinuxLoginItem {
            exec: "/opt/elsewhere".into(),
            name: "Track Your Time".into(),
            file,
        };
        item.set(true).unwrap();
        assert_eq!(moved.status(), Ok(DesktopLoginItemStatus::Disabled));
    }

    #[test]
    fn memory_login_item_never_reaches_the_os() {
        let mut item = MemoryLoginItem::default();
        item.set(true).unwrap();
        assert_eq!(item.status(), Ok(DesktopLoginItemStatus::Enabled));
    }

    #[test]
    fn detects_hidden() {
        assert!(is_hidden_launch(&["/app", "--hidden"]));
        assert!(!is_hidden_launch(&["/app"]));
    }

    #[test]
    fn selects_per_run_and_channel() {
        let env = HashMap::new();
        let home = Path::new("/home/me");
        let native = || -> Box<dyn LoginItemBackend> { panic!("not native") };
        let memory = select_login_item(true, true, &LoginItemMechanism::Native, &env, home, native);
        assert_eq!(memory.status(), Ok(DesktopLoginItemStatus::Disabled));
        let unsupported = select_login_item(
            false,
            true,
            &LoginItemMechanism::Unsupported { reason: "x".into() },
            &env,
            home,
            native,
        );
        assert_eq!(
            unsupported.status(),
            Ok(DesktopLoginItemStatus::Unsupported)
        );
        let called =
            select_login_item(false, true, &LoginItemMechanism::Native, &env, home, || {
                Box::new(MemoryLoginItem { enabled: true })
            });
        assert_eq!(called.status(), Ok(DesktopLoginItemStatus::Enabled));
    }

    #[test]
    fn reads_native_status_like_electron() {
        assert_eq!(
            native_login_status("darwin", Some("requires-approval"), false),
            DesktopLoginItemStatus::RequiresApproval
        );
        assert_eq!(
            native_login_status("darwin", Some("enabled"), false),
            DesktopLoginItemStatus::Enabled
        );
        assert_eq!(
            native_login_status("darwin", Some("not-registered"), false),
            DesktopLoginItemStatus::Disabled
        );
        assert_eq!(
            native_login_status("win32", Some("requires-approval"), true),
            DesktopLoginItemStatus::Enabled
        );
        assert_eq!(
            windows_run_command("C:\\A b\\t.exe"),
            "\"C:\\A b\\t.exe\" --hidden"
        );
    }
}
