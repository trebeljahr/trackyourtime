//! "Open at login", per OS. Which mechanism applies to which channel is
//! decided by tyt_model::distribution::login_item_mechanism; this is the
//! native half of the `Native` mechanism.
//!
//! - macOS 13+: SMAppService.mainApp, which System Settings → Login Items
//!   lists and may hold for approval ("requires-approval"); allowed in the
//!   App Sandbox. macOS 12 has no SMAppService: a per-user LaunchAgent, which
//!   is what the Electron build's API did there too.
//! - Windows: the `Run` key under HKCU, value named after the AppUserModelId
//!   (the name the Electron build wrote, so an update replaces its entry
//!   instead of leaving a second one that points at the old executable).

use tyt_wire::DesktopLoginItemStatus;

/// What the Windows Run entry launches with: a login launch stays in the tray.
#[cfg_attr(not(windows), allow(dead_code))]
pub const HIDDEN_ARG: &str = tyt_model::login_item::HIDDEN_LAUNCH_ARG;

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use objc2_service_management::{SMAppService, SMAppServiceStatus};

    fn has_sm_app_service() -> bool {
        // SMAppService exists from macOS 13.
        let version = objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion();
        version.majorVersion >= 13
    }

    fn agent_path() -> std::path::PathBuf {
        std::path::PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
            .join("Library/LaunchAgents/com.ricoslabs.trackyourtime.plist")
    }

    pub fn status() -> DesktopLoginItemStatus {
        if !has_sm_app_service() {
            return if agent_path().exists() {
                DesktopLoginItemStatus::Enabled
            } else {
                DesktopLoginItemStatus::Disabled
            };
        }
        let status = unsafe { SMAppService::mainAppService().status() };
        if status == SMAppServiceStatus::Enabled {
            DesktopLoginItemStatus::Enabled
        } else if status == SMAppServiceStatus::RequiresApproval {
            DesktopLoginItemStatus::RequiresApproval
        } else {
            DesktopLoginItemStatus::Disabled
        }
    }

    pub fn set(enabled: bool) -> Result<DesktopLoginItemStatus, String> {
        if !has_sm_app_service() {
            let path = agent_path();
            if enabled {
                let exe = std::env::current_exe().map_err(|e| e.to_string())?;
                let plist = format!(
                    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>Label</key><string>com.ricoslabs.trackyourtime</string><key>ProgramArguments</key><array><string>{}</string></array><key>RunAtLoad</key><true/></dict></plist>\n",
                    exe.display().to_string().replace('&', "&amp;").replace('<', "&lt;")
                );
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                }
                std::fs::write(&path, plist).map_err(|e| e.to_string())?;
            } else {
                let _ = std::fs::remove_file(&path);
            }
            return Ok(status());
        }
        let service = unsafe { SMAppService::mainAppService() };
        let result = unsafe {
            if enabled {
                service.registerAndReturnError()
            } else {
                service.unregisterAndReturnError()
            }
        };
        if let Err(error) = result {
            // Unregistering what was never registered is not a failure.
            if enabled {
                return Err(error.localizedDescription().to_string());
            }
        }
        Ok(status())
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::System::Registry::{
        RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ,
    };

    const RUN: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    const NAME: &str = "com.ricoslabs.trackyourtime";

    pub fn status() -> DesktopLoginItemStatus {
        let mut size = 0u32;
        let found = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                &HSTRING::from(RUN),
                &HSTRING::from(NAME),
                RRF_RT_REG_SZ,
                None,
                None,
                Some(&mut size),
            )
        };
        if found.is_ok() {
            DesktopLoginItemStatus::Enabled
        } else {
            DesktopLoginItemStatus::Disabled
        }
    }

    pub fn set(enabled: bool) -> Result<DesktopLoginItemStatus, String> {
        if enabled {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let value = format!("\"{}\" {}", exe.display(), HIDDEN_ARG);
            let wide: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
            unsafe {
                RegSetKeyValueW(
                    HKEY_CURRENT_USER,
                    &HSTRING::from(RUN),
                    &HSTRING::from(NAME),
                    REG_SZ.0,
                    Some(wide.as_ptr() as *const _),
                    (wide.len() * 2) as u32,
                )
                .ok()
                .map_err(|e| e.to_string())?;
            }
        } else {
            unsafe {
                let _ = RegDeleteKeyValueW(
                    HKEY_CURRENT_USER,
                    &HSTRING::from(RUN),
                    PCWSTR(HSTRING::from(NAME).as_ptr()),
                );
            }
        }
        Ok(status())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;

    // Linux never takes this path: login_item_mechanism answers XdgAutostart
    // or Unsupported for every Linux channel.
    pub fn status() -> DesktopLoginItemStatus {
        DesktopLoginItemStatus::Unsupported
    }

    pub fn set(_enabled: bool) -> Result<DesktopLoginItemStatus, String> {
        Ok(DesktopLoginItemStatus::Unsupported)
    }
}

pub use platform::{set, status};
