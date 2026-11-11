//! `activityCaptureSupport` from `electron/src/distribution.ts`. The rest of
//! that file (the channel itself, updates, open at login) is the shell's; the
//! channel arrives here as its string.

use std::collections::HashMap;

use tyt_wire::DesktopActivityUnavailableReason;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityCaptureMechanism {
    MacosLsappinfo,
    WindowsPowershell,
    LinuxXprop,
}

impl ActivityCaptureMechanism {
    pub fn as_str(self) -> &'static str {
        match self {
            ActivityCaptureMechanism::MacosLsappinfo => "macos-lsappinfo",
            ActivityCaptureMechanism::WindowsPowershell => "windows-powershell",
            ActivityCaptureMechanism::LinuxXprop => "linux-xprop",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityCaptureSupport {
    Supported(ActivityCaptureMechanism),
    /// One of `store`, `linux-sandbox`, `wayland`, `unsupported-platform`.
    Unsupported(DesktopActivityUnavailableReason),
}

/// Whether this copy can record which application is in front, and how. Only
/// the channel and the session decide here; the runtime reasons (`xprop`
/// missing, PowerShell locked down, a helper that keeps dying) are layered on
/// by the capturer.
///
/// - **Mac App Store and Microsoft Store: unavailable.** The App Sandbox is
///   inherited by every child process, and an app that watches other apps is
///   an App Review risk; MSIX spawning PowerShell is unverified.
/// - **Snap and Flatpak: unavailable.** The host's display and its tools are
///   outside the confinement.
/// - **Wayland: unavailable.** It tells no client which window is in front,
///   and asking XWayland answers for X clients only — wrong data, silently.
///   Linux with no `DISPLAY` at all has no X server to ask either.
pub fn activity_capture_support(
    channel: &str,
    platform: &str,
    env: &HashMap<String, String>,
) -> ActivityCaptureSupport {
    use ActivityCaptureMechanism as M;
    use ActivityCaptureSupport::{Supported, Unsupported};
    use DesktopActivityUnavailableReason as R;
    if channel == "mac-app-store" || channel == "windows-store" {
        return Unsupported(R::Store);
    }
    if channel == "snap" || channel == "flatpak" {
        return Unsupported(R::LinuxSandbox);
    }
    let var = |name: &str| env.get(name).map(String::as_str).unwrap_or("");
    match platform {
        "darwin" => Supported(M::MacosLsappinfo),
        "win32" => Supported(M::WindowsPowershell),
        "linux" => {
            if var("XDG_SESSION_TYPE") == "wayland" || !var("WAYLAND_DISPLAY").is_empty() {
                Unsupported(R::Wayland)
            } else if var("DISPLAY").is_empty() {
                Unsupported(R::UnsupportedPlatform)
            } else {
                Supported(M::LinuxXprop)
            }
        }
        _ => Unsupported(R::UnsupportedPlatform),
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

    fn answer(support: ActivityCaptureSupport) -> String {
        match support {
            ActivityCaptureSupport::Supported(mechanism) => mechanism.as_str().into(),
            ActivityCaptureSupport::Unsupported(reason) => serde_json::to_value(reason)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string(),
        }
    }

    #[test]
    fn answers_every_channel_under_x11_and_under_wayland() {
        let x11 = env(&[("DISPLAY", ":0"), ("XDG_SESSION_TYPE", "x11")]);
        let wayland = env(&[
            ("DISPLAY", ":0"),
            ("XDG_SESSION_TYPE", "wayland"),
            ("WAYLAND_DISPLAY", "wayland-0"),
        ]);
        let expected = [
            ("mac-app-store", "store", "store"),
            ("mac-direct", "macos-lsappinfo", "macos-lsappinfo"),
            ("windows-store", "store", "store"),
            ("windows-direct", "windows-powershell", "windows-powershell"),
            ("snap", "linux-sandbox", "linux-sandbox"),
            ("flatpak", "linux-sandbox", "linux-sandbox"),
            ("appimage", "linux-xprop", "wayland"),
            ("linux-package", "linux-xprop", "wayland"),
            ("unpackaged", "linux-xprop", "wayland"),
        ];
        for (channel, on_x11, on_wayland) in expected {
            let platform = if channel.starts_with("mac") {
                "darwin"
            } else if channel.starts_with("windows") {
                "win32"
            } else {
                "linux"
            };
            assert_eq!(
                answer(activity_capture_support(channel, platform, &x11)),
                on_x11,
                "{channel} x11"
            );
            assert_eq!(
                answer(activity_capture_support(channel, platform, &wayland)),
                on_wayland,
                "{channel} wayland"
            );
        }
    }

    #[test]
    fn reads_wayland_from_wayland_display_alone_too() {
        let support = activity_capture_support(
            "appimage",
            "linux",
            &env(&[("DISPLAY", ":0"), ("WAYLAND_DISPLAY", "wayland-1")]),
        );
        assert_eq!(
            support,
            ActivityCaptureSupport::Unsupported(DesktopActivityUnavailableReason::Wayland)
        );
    }

    #[test]
    fn refuses_linux_with_no_x_display_at_all() {
        assert_eq!(
            activity_capture_support("linux-package", "linux", &HashMap::new()),
            ActivityCaptureSupport::Unsupported(
                DesktopActivityUnavailableReason::UnsupportedPlatform
            )
        );
    }
}
