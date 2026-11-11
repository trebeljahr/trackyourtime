//! Which copy of the app this is, and what that allows: self-update, open at
//! login, activity capture. Ported from `electron/src/distribution.ts`.
//!
//! - **Updates.** Only the direct downloads replace themselves (the signed
//!   dmg/zip, the NSIS installer, the AppImage). Stores, Snap, Flatpak and the
//!   system package managers replace the app themselves.
//! - **Open at login.** See [`login_item_mechanism`].
//!
//! Pure: every input is passed in, so each channel is a unit test rather than
//! a build for another OS. `mas` and `windows_store` come from the build (the
//! `mas` cargo feature, and the MSIX package identity at runtime on Windows).

use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DistributionChannel {
    MacAppStore,
    MacDirect,
    WindowsStore,
    WindowsDirect,
    Snap,
    Flatpak,
    AppImage,
    LinuxPackage,
    Unpackaged,
}

impl DistributionChannel {
    /// The TypeScript spelling, which the activity crate and logs use.
    pub fn as_str(self) -> &'static str {
        match self {
            DistributionChannel::MacAppStore => "mac-app-store",
            DistributionChannel::MacDirect => "mac-direct",
            DistributionChannel::WindowsStore => "windows-store",
            DistributionChannel::WindowsDirect => "windows-direct",
            DistributionChannel::Snap => "snap",
            DistributionChannel::Flatpak => "flatpak",
            DistributionChannel::AppImage => "appimage",
            DistributionChannel::LinuxPackage => "linux-package",
            DistributionChannel::Unpackaged => "unpackaged",
        }
    }
}

#[derive(Debug, Clone)]
pub struct DistributionInputs<'a> {
    /// "darwin" | "win32" | "linux", as Node spelled it.
    pub platform: &'a str,
    pub is_packaged: bool,
    pub mas: bool,
    pub windows_store: bool,
    pub env: &'a HashMap<String, String>,
}

fn set(env: &HashMap<String, String>, key: &str) -> bool {
    env.get(key).is_some_and(|v| !v.is_empty())
}

pub fn distribution_channel(input: &DistributionInputs) -> DistributionChannel {
    if !input.is_packaged {
        return DistributionChannel::Unpackaged;
    }
    match input.platform {
        "darwin" if input.mas => DistributionChannel::MacAppStore,
        "darwin" => DistributionChannel::MacDirect,
        "win32" if input.windows_store => DistributionChannel::WindowsStore,
        "win32" => DistributionChannel::WindowsDirect,
        // snapd sets SNAP for every app it runs, and flatpak-spawn sets
        // FLATPAK_ID; AppImage's runtime sets APPIMAGE to the image's path.
        _ if set(input.env, "SNAP") => DistributionChannel::Snap,
        _ if set(input.env, "FLATPAK_ID") => DistributionChannel::Flatpak,
        _ if set(input.env, "APPIMAGE") => DistributionChannel::AppImage,
        _ => DistributionChannel::LinuxPackage,
    }
}

/// Whether the app may replace itself.
pub fn self_updates(channel: DistributionChannel) -> bool {
    matches!(
        channel,
        DistributionChannel::MacDirect
            | DistributionChannel::WindowsDirect
            | DistributionChannel::AppImage
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoginItemMechanism {
    /// The OS API: SMAppService on macOS (allowed inside the App Sandbox),
    /// the `Run` registry key on Windows.
    Native,
    XdgAutostart {
        exec: String,
    },
    Unsupported {
        reason: String,
    },
}

/// How "Open at login" works for a channel.
///
/// - **Microsoft Store: unsupported.** A packaged app's `Run` key is
///   virtualised and never read at login; the supported route is a
///   `windows.startupTask` manifest extension and the WinRT `StartupTask` API.
/// - AppImage: an XDG autostart entry pointing at `$APPIMAGE` (the executable
///   path is inside a mount that disappears on exit).
/// - Snap: the same entry under the snap's own `$HOME`, which is where
///   snapd's `autostart:` key looks; it names `/snap/bin/<name>`.
/// - **Flatpak: unsupported.** Writing the host's `~/.config/autostart` needs
///   a filesystem hole Flathub review refuses.
/// - deb/rpm: an XDG entry pointing at the installed executable.
pub fn login_item_mechanism(
    channel: DistributionChannel,
    exec_path: &str,
    env: &HashMap<String, String>,
    snap_command: &str,
) -> LoginItemMechanism {
    match channel {
        DistributionChannel::MacAppStore
        | DistributionChannel::MacDirect
        | DistributionChannel::WindowsDirect
        | DistributionChannel::Unpackaged => LoginItemMechanism::Native,
        DistributionChannel::WindowsStore => LoginItemMechanism::Unsupported {
            reason: "a Microsoft Store package cannot register a Run key".into(),
        },
        DistributionChannel::Flatpak => LoginItemMechanism::Unsupported {
            reason: "Flatpak has no autostart path reachable from the app".into(),
        },
        DistributionChannel::Snap => LoginItemMechanism::XdgAutostart {
            exec: format!("/snap/bin/{snap_command}"),
        },
        DistributionChannel::AppImage => LoginItemMechanism::XdgAutostart {
            exec: env
                .get("APPIMAGE")
                .filter(|v| !v.is_empty())
                .cloned()
                .unwrap_or_else(|| exec_path.to_string()),
        },
        DistributionChannel::LinuxPackage => LoginItemMechanism::XdgAutostart {
            exec: exec_path.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn channel(
        platform: &str,
        packaged: bool,
        mas: bool,
        store: bool,
        e: &[(&str, &str)],
    ) -> DistributionChannel {
        let env = env(e);
        distribution_channel(&DistributionInputs {
            platform,
            is_packaged: packaged,
            mas,
            windows_store: store,
            env: &env,
        })
    }

    #[test]
    fn is_unpackaged_before_anything_else() {
        assert_eq!(
            channel("linux", false, false, false, &[("SNAP", "/snap/x")]),
            DistributionChannel::Unpackaged
        );
    }

    #[test]
    fn tells_the_store_builds_apart() {
        assert_eq!(
            channel("darwin", true, true, false, &[]),
            DistributionChannel::MacAppStore
        );
        assert_eq!(
            channel("darwin", true, false, false, &[]),
            DistributionChannel::MacDirect
        );
        assert_eq!(
            channel("win32", true, false, true, &[]),
            DistributionChannel::WindowsStore
        );
        assert_eq!(
            channel("win32", true, false, false, &[]),
            DistributionChannel::WindowsDirect
        );
    }

    #[test]
    fn reads_the_linux_sandbox_from_the_environment() {
        assert_eq!(
            channel(
                "linux",
                true,
                false,
                false,
                &[("SNAP", "/snap/trackyourtime/12")]
            ),
            DistributionChannel::Snap
        );
        assert_eq!(
            channel(
                "linux",
                true,
                false,
                false,
                &[("FLATPAK_ID", "com.ricoslabs.trackyourtime")]
            ),
            DistributionChannel::Flatpak
        );
        assert_eq!(
            channel(
                "linux",
                true,
                false,
                false,
                &[("APPIMAGE", "/home/me/T.AppImage")]
            ),
            DistributionChannel::AppImage
        );
        assert_eq!(
            channel("linux", true, false, false, &[]),
            DistributionChannel::LinuxPackage
        );
        assert_eq!(
            channel("linux", true, false, false, &[("SNAP", "")]),
            DistributionChannel::LinuxPackage
        );
    }

    #[test]
    fn ignores_a_stray_snap_on_macos() {
        assert_eq!(
            channel("darwin", true, false, false, &[("SNAP", "x")]),
            DistributionChannel::MacDirect
        );
    }

    #[test]
    fn self_updates_only_for_direct_downloads() {
        use DistributionChannel::*;
        for c in [
            MacAppStore,
            WindowsStore,
            Snap,
            Flatpak,
            LinuxPackage,
            Unpackaged,
        ] {
            assert!(!self_updates(c), "{c:?}");
        }
        for c in [MacDirect, WindowsDirect, AppImage] {
            assert!(self_updates(c), "{c:?}");
        }
    }

    #[test]
    fn login_item_mechanisms() {
        use DistributionChannel::*;
        let exec = "/usr/bin/trackyourtime";
        let none = env(&[]);
        assert_eq!(
            login_item_mechanism(MacAppStore, exec, &none, "trackyourtime"),
            LoginItemMechanism::Native
        );
        assert_eq!(
            login_item_mechanism(WindowsDirect, exec, &none, "trackyourtime"),
            LoginItemMechanism::Native
        );
        assert!(matches!(
            login_item_mechanism(WindowsStore, exec, &none, "x"),
            LoginItemMechanism::Unsupported { .. }
        ));
        assert!(matches!(
            login_item_mechanism(Flatpak, exec, &none, "x"),
            LoginItemMechanism::Unsupported { .. }
        ));
        assert_eq!(
            login_item_mechanism(Snap, exec, &none, "trackyourtime"),
            LoginItemMechanism::XdgAutostart {
                exec: "/snap/bin/trackyourtime".into()
            }
        );
        assert_eq!(
            login_item_mechanism(
                AppImage,
                exec,
                &env(&[("APPIMAGE", "/home/me/T.AppImage")]),
                "x"
            ),
            LoginItemMechanism::XdgAutostart {
                exec: "/home/me/T.AppImage".into()
            }
        );
        assert_eq!(
            login_item_mechanism(LinuxPackage, exec, &none, "x"),
            LoginItemMechanism::XdgAutostart { exec: exec.into() }
        );
    }
}
