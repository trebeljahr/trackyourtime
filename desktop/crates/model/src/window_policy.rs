//! When the close button hides instead of quitting, and when a launch may
//! stay in the tray. Ported from `electron/src/window-policy.ts`.

use std::collections::HashMap;
use tyt_wire::DesktopWindowMode;

/// GNOME gets a useful timer without depending on an indicator extension.
pub fn default_window_mode(platform: &str, env: &HashMap<String, String>) -> DesktopWindowMode {
    let gnome = platform == "linux"
        && env
            .get("XDG_CURRENT_DESKTOP")
            .map(|d| {
                d.split([':', ';'])
                    .any(|name| name.trim().eq_ignore_ascii_case("gnome"))
            })
            .unwrap_or(false);
    if gnome {
        DesktopWindowMode::Compact
    } else {
        DesktopWindowMode::Full
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowPolicy {
    pub hide_on_close: bool,
    pub allow_hidden_launch: bool,
}

/// A tray object does not prove the desktop displays it (notably GNOME), so
/// Linux must opt into background operation explicitly. Windows keeps its
/// tray launch; macOS keeps its normal window and Dock recovery.
pub fn desktop_window_policy(
    platform: &str,
    show_in_tray: bool,
    close_hides: bool,
) -> WindowPolicy {
    let background = show_in_tray && close_hides;
    WindowPolicy {
        hide_on_close: platform == "darwin" || background,
        allow_hidden_launch: show_in_tray
            && (platform == "win32" || (platform == "linux" && background)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(desktop: &str) -> HashMap<String, String> {
        HashMap::from([("XDG_CURRENT_DESKTOP".to_string(), desktop.to_string())])
    }

    #[test]
    fn defaults_gnome_to_compact() {
        for desktop in ["GNOME", "ubuntu:GNOME", "GNOME;Other"] {
            assert_eq!(
                default_window_mode("linux", &env(desktop)),
                DesktopWindowMode::Compact,
                "{desktop}"
            );
        }
        for desktop in ["KDE", "XFCE", "X-Cinnamon", ""] {
            assert_eq!(
                default_window_mode("linux", &env(desktop)),
                DesktopWindowMode::Full,
                "{desktop}"
            );
        }
        assert_eq!(
            default_window_mode("win32", &env("GNOME")),
            DesktopWindowMode::Full
        );
    }

    // Defaults as desktop_settings::default_desktop_settings gives them:
    // Linux shows the tray and does not hide on close; Windows does both.
    #[test]
    fn keeps_a_default_linux_login_launch_reachable() {
        assert_eq!(
            desktop_window_policy("linux", true, false),
            WindowPolicy {
                hide_on_close: false,
                allow_hidden_launch: false
            }
        );
    }

    #[test]
    fn allows_linux_background_launches_only_after_opting_in() {
        assert!(desktop_window_policy("linux", true, true).allow_hidden_launch);
        assert_eq!(
            desktop_window_policy("linux", false, true),
            WindowPolicy {
                hide_on_close: false,
                allow_hidden_launch: false
            }
        );
    }

    #[test]
    fn preserves_windows_tray_launches_and_macos_dock_recovery() {
        assert_eq!(
            desktop_window_policy("win32", true, true),
            WindowPolicy {
                hide_on_close: true,
                allow_hidden_launch: true
            }
        );
        assert_eq!(
            desktop_window_policy("darwin", false, false),
            WindowPolicy {
                hide_on_close: true,
                allow_hidden_launch: false
            }
        );
        assert_eq!(
            desktop_window_policy("win32", false, true),
            WindowPolicy {
                hide_on_close: false,
                allow_hidden_launch: false
            }
        );
    }
}
