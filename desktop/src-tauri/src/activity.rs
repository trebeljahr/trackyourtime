//! Activity capture (Stage 8) and Autopilot: the shell's side of
//! `tyt_activity::ActivityController`.
//!
//! The controller composes suggestions itself, so raw segments never cross
//! the bridge; this file only feeds it the platform (encryption, the macOS
//! Screen Recording grant) and pushes its throttled `activity:changed`.

use std::sync::Arc;
use tauri::AppHandle;
use tyt_activity::{ActivityController, ActivityHost, ActivityOptions};
use tyt_model::distribution::DistributionChannel;
use tyt_wire::DesktopActivitySnapshot;

use crate::shell::Shell;

pub type Activity = ActivityController;

struct Host(AppHandle);

impl ActivityHost for Host {
    fn changed(&self, snapshot: &DesktopActivitySnapshot) {
        // Called on the controller's loop thread, without its lock. `eval`
        // only queues the script, so this never waits on the main thread
        // (which may be the one disposing the controller and joining us).
        crate::shell::push(
            &self.0,
            tyt_wire::channels::ACTIVITY_CHANGED,
            &serde_json::to_value(snapshot).unwrap_or_default(),
        );
    }
}

pub fn install(app: &AppHandle, shell: &Shell, channel: DistributionChannel) -> Arc<Activity> {
    let options = ActivityOptions {
        headless: shell.headless,
        platform: crate::platform().to_string(),
        channel: channel.as_str().to_string(),
        env: shell.env.clone(),
        user_data: shell.profile.clone(),
        encryption: if shell.headless {
            None
        } else {
            Some(shell.encryption.clone() as Arc<dyn tyt_wire::Encryption>)
        },
        titles_permitted: Arc::new(screen_recording::granted),
        parent_pid: std::process::id(),
    };
    Arc::new(ActivityController::install(
        options,
        Arc::new(Host(app.clone())),
    ))
}

/// Before the renderer's "store window titles" reaches the controller, ask
/// macOS for Screen Recording (what Electron's `desktopCapturer.getSources`
/// triggered). The controller then reads the grant; while it is missing it
/// saves titles off and answers `titlesPermissionRequired: true`. Never
/// headless: the prompt would take focus.
pub fn before_call(shell: &Shell, channel: &str, args: &[serde_json::Value]) {
    if shell.headless || channel != tyt_wire::channels::ACTIVITY_SETTINGS {
        return;
    }
    if args
        .first()
        .and_then(|patch| patch.get("storeTitles"))
        .and_then(|v| v.as_bool())
        == Some(true)
        && !screen_recording::granted()
    {
        screen_recording::request();
    }
}

#[cfg(target_os = "macos")]
mod screen_recording {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }
    pub fn granted() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() }
    }
    pub fn request() {
        unsafe {
            CGRequestScreenCaptureAccess();
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod screen_recording {
    // Window titles need no permission on Windows and X11.
    pub fn granted() -> bool {
        true
    }
    pub fn request() {}
}
