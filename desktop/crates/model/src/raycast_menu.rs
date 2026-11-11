//! One menu bar timer, not two: when Raycast's menu bar command shows its
//! item, the desktop app takes its tray icon down, and puts it back when
//! Raycast hides its own. Ported from `electron/src/raycast-menu.ts`.
//!
//! The two sides agree through lease files (`timer_menu.rs`):
//! Raycast writes `raycast-menu.json` (`{version: 1, visible, ownerPid}`),
//! the desktop app writes `desktop-menu.json` (`{version: 1, ownerPid,
//! visible}`) with *its* pid. Raycast shows its item only once the desktop
//! file says the desktop item is gone (`visible: false`) or its owner has
//! exited, so the desktop app acknowledges only after it has actually
//! destroyed its tray. macOS only; elsewhere nothing is read or written.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::Value;

use crate::timer_menu::{
    raycast_menu_visible, DESKTOP_MENU_LEASE_PARTS, RAYCAST_MENU_LEASE_PARTS, RAYCAST_MENU_POLL_MS,
};

fn lease_path(home: &Path, parts: &[&str]) -> PathBuf {
    parts
        .iter()
        .fold(home.to_path_buf(), |path, part| path.join(part))
}

/// Whether a process exists (`kill(pid, 0)`; a permission error still means
/// it exists).
#[cfg(unix)]
pub fn process_alive(pid: i64) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal 0 performs only the existence and permission check.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Only macOS reads leases, so there is nothing to probe elsewhere.
#[cfg(not(unix))]
pub fn process_alive(_pid: i64) -> bool {
    false
}

/// Missing or inaccessible state leaves the desktop item available. A host
/// pid survives command unloads, unlike the short-lived extension process.
pub fn has_raycast_menu(platform: &str, home: &Path) -> bool {
    has_raycast_menu_with(platform, home, process_alive)
}

fn has_raycast_menu_with(platform: &str, home: &Path, alive: fn(i64) -> bool) -> bool {
    if platform != "darwin" {
        return false;
    }
    let Ok(text) = fs::read_to_string(lease_path(home, &RAYCAST_MENU_LEASE_PARTS)) else {
        return false;
    };
    let Ok(lease) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    raycast_menu_visible(&lease).is_some_and(alive)
}

/// Write `desktop-menu.json` atomically, owner-only, with this process's pid.
pub fn publish_desktop_menu(visible: bool, home: &Path) -> io::Result<()> {
    let file = lease_path(home, &DESKTOP_MENU_LEASE_PARTS);
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let pid = std::process::id();
    let temp = PathBuf::from(format!("{}.{pid}", file.display()));
    let body = format!("{{\"version\":1,\"ownerPid\":{pid},\"visible\":{visible}}}");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut out = options.open(&temp)?;
    out.write_all(body.as_bytes())?;
    drop(out);
    fs::rename(&temp, &file)
}

/// The watch, as a value the shell polls every [`RAYCAST_MENU_POLL_MS`] (or
/// runs on a thread with [`spawn_raycast_menu_watch`]).
#[derive(Debug)]
pub struct RaycastMenuWatch {
    platform: String,
    home: PathBuf,
    visible: Option<bool>,
}

impl RaycastMenuWatch {
    /// Registers before checking the claim, so a concurrently launching
    /// Raycast command waits instead of racing creation of the desktop item;
    /// then reports the first answer through `on_change`.
    pub fn start(platform: &str, home: &Path, on_change: &mut dyn FnMut(bool)) -> Self {
        let mut watch = RaycastMenuWatch {
            platform: platform.to_string(),
            home: home.to_path_buf(),
            visible: None,
        };
        if platform == "darwin" {
            watch.acknowledge(true);
            watch.poll(on_change);
        }
        watch
    }

    fn acknowledge(&self, visible: bool) {
        // Tracking still works if ownership storage is unavailable.
        let _ = publish_desktop_menu(visible, &self.home);
    }

    /// One check. `on_change(true)` means Raycast shows its item: take the
    /// tray down inside the callback, because the acknowledgement written
    /// after it tells Raycast the desktop item is gone.
    pub fn poll(&mut self, on_change: &mut dyn FnMut(bool)) {
        if self.platform != "darwin" {
            return;
        }
        let next = has_raycast_menu(&self.platform, &self.home);
        if self.visible == Some(next) {
            return;
        }
        self.visible = Some(next);
        on_change(next);
        // Acknowledge only after on_change has destroyed the actual desktop tray.
        self.acknowledge(!next);
    }

    pub fn raycast_visible(&self) -> Option<bool> {
        self.visible
    }
}

/// Stops the thread on drop or [`RaycastMenuWatchHandle::stop`].
pub struct RaycastMenuWatchHandle {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl RaycastMenuWatchHandle {
    pub fn stop(mut self) {
        self.halt();
    }

    fn halt(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for RaycastMenuWatchHandle {
    fn drop(&mut self) {
        self.halt();
    }
}

/// The watch on a thread of its own, polling every 500 ms. Off macOS no
/// thread is started at all.
pub fn spawn_raycast_menu_watch(
    platform: &str,
    home: &Path,
    mut on_change: impl FnMut(bool) + Send + 'static,
) -> RaycastMenuWatchHandle {
    let stop = Arc::new(AtomicBool::new(false));
    if platform != "darwin" {
        return RaycastMenuWatchHandle { stop, thread: None };
    }
    let (platform, home, flag) = (platform.to_string(), home.to_path_buf(), stop.clone());
    let thread = std::thread::spawn(move || {
        let mut watch = RaycastMenuWatch::start(&platform, &home, &mut on_change);
        while !flag.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(RAYCAST_MENU_POLL_MS));
            if flag.load(Ordering::SeqCst) {
                break;
            }
            watch.poll(&mut on_change);
        }
    });
    RaycastMenuWatchHandle {
        stop,
        thread: Some(thread),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_raycast(home: &Path, contents: &str) {
        let file = lease_path(home, &RAYCAST_MENU_LEASE_PARTS);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, contents).unwrap();
    }

    fn desktop_lease(home: &Path) -> Value {
        serde_json::from_str(
            &fs::read_to_string(lease_path(home, &DESKTOP_MENU_LEASE_PARTS)).unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn raycast_claims_first_and_the_desktop_yields_only_after_destroying_its_item() {
        let home = tempfile::tempdir().unwrap();
        let pid = std::process::id();
        publish_desktop_menu(true, home.path()).unwrap();
        write_raycast(
            home.path(),
            &format!("{{\"version\":1,\"visible\":true,\"ownerPid\":{pid}}}"),
        );
        assert!(has_raycast_menu("darwin", home.path()));
        assert!(!has_raycast_menu("win32", home.path()));
        assert!(!has_raycast_menu("linux", home.path()));

        let mut changes = Vec::new();
        let path = home.path().to_path_buf();
        let mut on_change = |visible: bool| {
            if visible {
                // The desktop hides its item before acknowledging.
                assert_eq!(desktop_lease(&path)["visible"], Value::Bool(true));
            }
            changes.push(visible);
        };
        let mut watch = RaycastMenuWatch::start("darwin", home.path(), &mut on_change);
        assert_eq!(changes, [true]);
        assert_eq!(
            desktop_lease(home.path())["visible"],
            Value::Bool(false),
            "acknowledged after the change"
        );
        assert_eq!(desktop_lease(home.path())["ownerPid"], Value::from(pid));

        write_raycast(
            home.path(),
            &format!("{{\"version\":1,\"visible\":false,\"ownerPid\":{pid}}}"),
        );
        watch.poll(&mut |visible| changes.push(visible));
        assert_eq!(
            changes,
            [true, false],
            "desktop returns when Raycast hides its item"
        );
        assert_eq!(desktop_lease(home.path())["visible"], Value::Bool(true));
    }

    #[test]
    fn dead_hosts_and_malformed_files_cannot_keep_the_desktop_hidden() {
        let home = tempfile::tempdir().unwrap();
        let dead = |_: i64| false;
        write_raycast(
            home.path(),
            "{\"version\":1,\"visible\":true,\"ownerPid\":4242}",
        );
        assert!(!has_raycast_menu_with("darwin", home.path(), dead));
        for value in [
            "broken",
            "null",
            "{\"version\":1,\"visible\":true,\"ownerPid\":-1}",
        ] {
            write_raycast(home.path(), value);
            assert!(!has_raycast_menu("darwin", home.path()), "{value}");
        }
        fs::remove_file(lease_path(home.path(), &RAYCAST_MENU_LEASE_PARTS)).unwrap();
        assert!(!has_raycast_menu("darwin", home.path()));
    }

    #[cfg(unix)]
    #[test]
    fn probes_processes() {
        assert!(process_alive(i64::from(std::process::id())));
        assert!(!process_alive(-1));
        assert!(!process_alive(i64::from(i32::MAX) + 1));
    }

    #[cfg(unix)]
    #[test]
    fn the_desktop_lease_is_owner_only_and_atomic() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        publish_desktop_menu(false, home.path()).unwrap();
        let file = lease_path(home.path(), &DESKTOP_MENU_LEASE_PARTS);
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let pid = std::process::id();
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            format!("{{\"version\":1,\"ownerPid\":{pid},\"visible\":false}}")
        );
        assert_eq!(fs::read_dir(file.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn nothing_happens_off_macos() {
        let home = tempfile::tempdir().unwrap();
        let mut calls = 0;
        let mut watch = RaycastMenuWatch::start("linux", home.path(), &mut |_| calls += 1);
        watch.poll(&mut |_| calls += 1);
        assert_eq!(calls, 0);
        assert!(
            fs::read_dir(home.path()).unwrap().next().is_none(),
            "no lease written"
        );
        let handle = spawn_raycast_menu_watch("win32", home.path(), |_| {});
        handle.stop();
    }
}
