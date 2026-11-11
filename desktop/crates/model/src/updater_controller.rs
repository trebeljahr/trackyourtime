//! The updater's state machine: check on launch and every six hours,
//! download in the background, install on quit, and restart only when the
//! person asks. Ported from `createUpdateController` in
//! `electron/src/updater-model.ts` and from `electron/src/updater.ts`.
//!
//! The shell's [`UpdaterBackend`] is `tauri-plugin-updater` over the signed
//! `latest.json` feed on GitHub Releases, in place of electron-updater. Its
//! work is asynchronous; the backend starts it and the shell reports each
//! outcome back through the desktop controller (`update_found`,
//! `update_progress`, `update_downloaded`, `update_failed`, …), which forwards
//! to [`UpdateController::found`] and friends. Everything that decides — the
//! status, the staged rollout, when to check, what installs when — is here.
//!
//! Direct downloads only (`updater_model::updater_policy`): the two stores,
//! Snap, Flatpak, deb, rpm, tar.gz, unsigned and local builds never load a
//! backend at all — `load` is not even called.
//!
//! **Headless** (tests, agents): no backend touches the network. A memory one
//! ([`MemoryUpdaterBackend`]) stands in, which does nothing until a spec
//! drives the controller through the test hook's `update.dispatch`, so the
//! "Restart to update" item and button can be exercised without a release,
//! and its install-and-restart is counted instead of quitting. It never reads
//! or writes `.updaterId` and never checks on a timer.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tyt_wire::{DesktopUpdateSnapshot, DesktopUpdateStatus};

use crate::timer_menu::js::{iso_from_ms, slice_utf16};
use crate::updater_model::{
    is_staging_match, may_check, next_update_status, read_or_create_staging_user_id, UpdaterEvent,
    UpdaterPolicy, FIRST_CHECK_DELAY_MS, UPDATE_CHECK_INTERVAL_MS,
};

/// How the backend is set up, as `createUpdateController` configured
/// electron-updater. The controller itself implements the first two (it asks
/// for the download when a release is found, and for the install at quit);
/// the backend must honour the last two (the GitHub `releases/latest` feed
/// skips prereleases; the default version comparison refuses older ones).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UpdaterConfig {
    pub auto_download: bool,
    pub install_on_quit: bool,
    pub allow_prerelease: bool,
    pub allow_downgrade: bool,
}

/// Download in the background, install on quit. Stable releases only, and
/// never back to an older version a later release was published over.
pub const UPDATER_CONFIG: UpdaterConfig = UpdaterConfig {
    auto_download: true,
    install_on_quit: true,
    allow_prerelease: false,
    allow_downgrade: false,
};

/// What the shell's updater does. Each start method returns at once; the
/// outcome comes back through the controller later.
pub trait UpdaterBackend: Send {
    /// Called once, right after the backend is loaded.
    fn configure(&mut self, _config: &UpdaterConfig) {}
    /// Look for a release newer than this one. Answer with `found` (version
    /// and the feed's raw `stagingPercentage`), `not_found` or `failed`.
    fn check(&mut self) -> Result<(), String>;
    /// Download what `check` found. Answer with `progress`, `downloaded` or
    /// `failed`; keep the files until `install_on_quit` or
    /// `install_and_restart`.
    fn download(&mut self) -> Result<(), String>;
    /// The app is quitting with a downloaded update: install it for the next
    /// launch without starting it.
    fn install_on_quit(&mut self);
    /// Install the downloaded update and start the new version now. Reached
    /// only through [`UpdateController::restart`].
    fn install_and_restart(&mut self);
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct MemoryUpdaterCounts {
    pub checks: u64,
    pub downloads: u64,
    /// Install-and-restart requests: the hook's `update.installs()`.
    pub installs: u64,
    pub quit_installs: u64,
    pub configured: Option<UpdaterConfig>,
}

/// The headless backend: nothing reaches the network or quits.
#[derive(Debug, Default, Clone)]
pub struct MemoryUpdaterBackend {
    pub counts: Arc<Mutex<MemoryUpdaterCounts>>,
}

impl MemoryUpdaterBackend {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn counts(&self) -> MemoryUpdaterCounts {
        self.counts.lock().map(|c| c.clone()).unwrap_or_default()
    }

    fn count(&self, f: impl FnOnce(&mut MemoryUpdaterCounts)) {
        if let Ok(mut counts) = self.counts.lock() {
            f(&mut counts);
        }
    }
}

impl UpdaterBackend for MemoryUpdaterBackend {
    fn configure(&mut self, config: &UpdaterConfig) {
        self.count(|c| c.configured = Some(*config));
    }
    fn check(&mut self) -> Result<(), String> {
        self.count(|c| c.checks += 1);
        Ok(())
    }
    fn download(&mut self) -> Result<(), String> {
        self.count(|c| c.downloads += 1);
        Ok(())
    }
    fn install_on_quit(&mut self) {
        self.count(|c| c.quit_installs += 1);
    }
    fn install_and_restart(&mut self) {
        self.count(|c| c.installs += 1);
    }
}

#[derive(Debug, Clone)]
pub struct UpdateControllerOptions {
    pub policy: UpdaterPolicy,
    pub current_version: String,
    /// Whether to check on its own (after [`FIRST_CHECK_DELAY_MS`] and every
    /// [`UPDATE_CHECK_INTERVAL_MS`]). `false` in a headless run, where the
    /// memory backend answers no check, so a scheduled check would leave the
    /// status "checking" forever — a spec that reads the status or counts
    /// checks would then fail on nothing but its own timing.
    pub auto_check: bool,
    /// When the controller was created, for the schedule.
    pub now_ms: i64,
    /// The profile directory holding `.updaterId`, or `None` (headless) to
    /// never read or write it.
    pub staging_id_dir: Option<PathBuf>,
}

pub struct UpdateController {
    current_version: String,
    status: DesktopUpdateStatus,
    backend: Option<Box<dyn UpdaterBackend>>,
    first_check_at: Option<i64>,
    next_interval_at: Option<i64>,
    staging_id_dir: Option<PathBuf>,
    staging_id: Option<String>,
    installing: bool,
    changes: Vec<DesktopUpdateSnapshot>,
}

impl UpdateController {
    /// `load` runs only when the policy allows updates, so a disabled app
    /// never constructs an updater.
    pub fn new(
        options: UpdateControllerOptions,
        load: impl FnOnce() -> Box<dyn UpdaterBackend>,
    ) -> Self {
        let (status, backend) = match options.policy {
            UpdaterPolicy::Enabled => {
                let mut backend = load();
                backend.configure(&UPDATER_CONFIG);
                (
                    DesktopUpdateStatus::Idle {
                        last_checked_at: None,
                    },
                    Some(backend),
                )
            }
            UpdaterPolicy::Disabled(reason) => (DesktopUpdateStatus::Disabled { reason }, None),
        };
        let scheduled = backend.is_some() && options.auto_check;
        UpdateController {
            current_version: options.current_version,
            status,
            backend,
            first_check_at: scheduled.then_some(options.now_ms + FIRST_CHECK_DELAY_MS),
            next_interval_at: scheduled.then_some(options.now_ms + UPDATE_CHECK_INTERVAL_MS),
            staging_id_dir: options.staging_id_dir,
            staging_id: None,
            installing: false,
            changes: Vec::new(),
        }
    }

    pub fn snapshot(&self) -> DesktopUpdateSnapshot {
        DesktopUpdateSnapshot {
            current_version: self.current_version.clone(),
            status: self.status.clone(),
        }
    }

    pub fn status(&self) -> &DesktopUpdateStatus {
        &self.status
    }

    pub fn is_ready(&self) -> bool {
        matches!(self.status, DesktopUpdateStatus::Ready { .. })
    }

    /// Every status change since the last call, oldest first: each is one
    /// `update:status-changed` push and a tray redraw.
    pub fn take_changes(&mut self) -> Vec<DesktopUpdateSnapshot> {
        std::mem::take(&mut self.changes)
    }

    /// Feeds an event as the updater would; the shell's callbacks and the
    /// test hook use it. Returns whether the status changed.
    pub fn dispatch(&mut self, event: UpdaterEvent, now_ms: i64) -> bool {
        let next = next_update_status(&self.status, &event, &iso_from_ms(now_ms));
        if next == self.status {
            return false;
        }
        self.status = next;
        self.changes.push(self.snapshot());
        true
    }

    /// The staging id, read or created once per run (electron-updater's lazy
    /// `stagingUserIdPromise`, first needed by a check).
    fn staging_id(&mut self) -> Option<&str> {
        if self.staging_id.is_none() {
            let dir = self.staging_id_dir.as_ref()?;
            self.staging_id = Some(read_or_create_staging_user_id(dir));
        }
        self.staging_id.as_deref()
    }

    /// Starts a check unless one is running; returns the snapshot after starting it.
    pub fn check(&mut self, now_ms: i64) -> DesktopUpdateSnapshot {
        if self.backend.is_none() || !may_check(&self.status) {
            return self.snapshot();
        }
        // The backend's own "checking" would come later; dispatching here makes
        // the button's state change before the first network round trip.
        self.dispatch(UpdaterEvent::Checking, now_ms);
        let _ = self.staging_id();
        let started = self.backend.as_mut().map(|backend| backend.check());
        if let Some(Err(error)) = started {
            eprintln!("[updater] check failed {error}");
            self.dispatch(UpdaterEvent::Error, now_ms);
        }
        self.snapshot()
    }

    /// A check found a newer release. Outside this install's rollout bucket it
    /// is no update at all (electron-updater answered `update-not-available`);
    /// inside, it downloads at once.
    pub fn found(&mut self, version: &str, staging_percentage: Option<&Value>, now_ms: i64) {
        if self.backend.is_none() {
            return;
        }
        let version = slice_utf16(version, 50);
        let within = match staging_percentage.filter(|v| !v.is_null()) {
            None => true,
            Some(percentage) => match self.staging_id() {
                Some(id) => is_staging_match(Some(percentage), id),
                // Headless has no id and no feed; nothing to stage against.
                None => true,
            },
        };
        if !within {
            self.dispatch(UpdaterEvent::NotAvailable, now_ms);
            return;
        }
        self.dispatch(UpdaterEvent::Available { version }, now_ms);
        let started = self.backend.as_mut().map(|backend| backend.download());
        if let Some(Err(error)) = started {
            eprintln!("[updater] download failed {error}");
            self.dispatch(UpdaterEvent::Error, now_ms);
        }
    }

    pub fn not_found(&mut self, now_ms: i64) {
        self.dispatch(UpdaterEvent::NotAvailable, now_ms);
    }

    pub fn progress(&mut self, percent: f64, now_ms: i64) {
        if percent.is_finite() {
            self.dispatch(UpdaterEvent::Progress { percent }, now_ms);
        }
    }

    pub fn downloaded(&mut self, version: &str, now_ms: i64) {
        self.dispatch(
            UpdaterEvent::Downloaded {
                version: slice_utf16(version, 50),
            },
            now_ms,
        );
    }

    pub fn failed(&mut self, error: &str, now_ms: i64) {
        eprintln!("[updater] error {error}");
        self.dispatch(UpdaterEvent::Error, now_ms);
    }

    /// Installs and relaunches, only when an update is ready. Called from a
    /// person's click and nowhere else: the tray's "Restart to update" item
    /// and the Settings → Desktop button (desktop_controller.rs).
    ///
    /// `before_install` runs first: it marks the app as quitting, so the
    /// window's close handler lets it close instead of hiding it.
    pub fn restart(&mut self, before_install: &mut dyn FnMut()) -> bool {
        if !self.is_ready() {
            return false;
        }
        let Some(backend) = self.backend.as_mut() else {
            return false;
        };
        before_install();
        self.installing = true;
        backend.install_and_restart();
        true
    }

    /// The app is quitting: a downloaded update installs now, for the next
    /// launch, unless a restart is already installing it.
    pub fn app_will_quit(&mut self) {
        if self.installing || !self.is_ready() {
            return;
        }
        if let Some(backend) = self.backend.as_mut() {
            self.installing = true;
            backend.install_on_quit();
        }
    }

    /// The schedule: the first check [`FIRST_CHECK_DELAY_MS`] after launch,
    /// then one every [`UPDATE_CHECK_INTERVAL_MS`] (a missed interval while
    /// the machine slept fires once, as a Node interval does).
    pub fn tick(&mut self, now_ms: i64) {
        if self.first_check_at.is_some_and(|at| now_ms >= at) {
            self.first_check_at = None;
            self.check(now_ms);
        }
        if self.next_interval_at.is_some_and(|at| now_ms >= at) {
            self.next_interval_at = Some(now_ms + UPDATE_CHECK_INTERVAL_MS);
            self.check(now_ms);
        }
    }

    /// Whether anything is scheduled (the shell may stop ticking otherwise).
    pub fn is_scheduled(&self) -> bool {
        self.first_check_at.is_some() || self.next_interval_at.is_some()
    }

    pub fn dispose(&mut self) {
        self.first_check_at = None;
        self.next_interval_at = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tyt_wire::DesktopUpdateDisabledReason;

    const NOW: i64 = 1_789_639_200_000; // 2026-09-17T10:00:00.000Z
    const NOW_ISO: &str = "2026-09-17T10:00:00.000Z";

    #[derive(Default)]
    struct Fake {
        counts: Arc<Mutex<MemoryUpdaterCounts>>,
        fail_check: bool,
    }

    impl UpdaterBackend for Fake {
        fn configure(&mut self, config: &UpdaterConfig) {
            self.counts.lock().unwrap().configured = Some(*config);
        }
        fn check(&mut self) -> Result<(), String> {
            self.counts.lock().unwrap().checks += 1;
            if self.fail_check {
                Err("offline".into())
            } else {
                Ok(())
            }
        }
        fn download(&mut self) -> Result<(), String> {
            self.counts.lock().unwrap().downloads += 1;
            Ok(())
        }
        fn install_on_quit(&mut self) {
            self.counts.lock().unwrap().quit_installs += 1;
        }
        fn install_and_restart(&mut self) {
            self.counts.lock().unwrap().installs += 1;
        }
    }

    fn setup_with(
        policy: UpdaterPolicy,
        auto_check: bool,
        fail_check: bool,
    ) -> (UpdateController, Arc<Mutex<MemoryUpdaterCounts>>, u32) {
        let counts = Arc::new(Mutex::new(MemoryUpdaterCounts::default()));
        let shared = counts.clone();
        let mut loads = 0;
        let controller = UpdateController::new(
            UpdateControllerOptions {
                policy,
                current_version: "0.1.0".into(),
                auto_check,
                now_ms: NOW,
                staging_id_dir: None,
            },
            || {
                loads += 1;
                Box::new(Fake {
                    counts: shared,
                    fail_check,
                })
            },
        );
        (controller, counts, loads)
    }

    fn setup() -> (UpdateController, Arc<Mutex<MemoryUpdaterCounts>>) {
        let (controller, counts, _) = setup_with(UpdaterPolicy::Enabled, true, false);
        (controller, counts)
    }

    fn checks(counts: &Arc<Mutex<MemoryUpdaterCounts>>) -> u64 {
        counts.lock().unwrap().checks
    }

    #[test]
    fn never_loads_the_updater_schedules_or_checks_when_updates_are_off() {
        let policy = UpdaterPolicy::Disabled(DesktopUpdateDisabledReason::Store);
        let (mut controller, counts, loads) = setup_with(policy, true, false);
        assert_eq!(loads, 0);
        assert!(!controller.is_scheduled());
        assert_eq!(
            serde_json::to_value(controller.check(NOW)).unwrap(),
            json!({"currentVersion": "0.1.0", "status": {"kind": "disabled", "reason": "store"}})
        );
        assert_eq!(checks(&counts), 0);
        assert!(!controller.restart(&mut || panic!("no install")));
    }

    #[test]
    fn downloads_in_the_background_and_installs_on_quit_stable_releases_only() {
        let (_controller, counts) = setup();
        assert_eq!(
            counts.lock().unwrap().configured,
            Some(UpdaterConfig {
                auto_download: true,
                install_on_quit: true,
                allow_prerelease: false,
                allow_downgrade: false
            })
        );
    }

    #[test]
    fn checks_after_launch_and_every_six_hours() {
        let (mut controller, counts) = setup();
        assert_eq!(UPDATE_CHECK_INTERVAL_MS, 21_600_000);
        controller.tick(NOW + FIRST_CHECK_DELAY_MS - 1);
        assert_eq!(checks(&counts), 0);
        controller.tick(NOW + FIRST_CHECK_DELAY_MS);
        assert_eq!(checks(&counts), 1);
        // Still checking: the interval firing now must not start a second request.
        controller.tick(NOW + UPDATE_CHECK_INTERVAL_MS);
        assert_eq!(checks(&counts), 1);
        controller.not_found(NOW);
        controller.tick(NOW + 2 * UPDATE_CHECK_INTERVAL_MS);
        assert_eq!(checks(&counts), 2);
    }

    #[test]
    fn never_restarts_on_its_own_when_an_update_arrives() {
        let (mut controller, counts) = setup();
        controller.check(NOW);
        controller.found("0.1.1", None, NOW);
        assert_eq!(counts.lock().unwrap().downloads, 1, "downloads at once");
        controller.progress(99.9, NOW);
        controller.downloaded("0.1.1", NOW);
        assert_eq!(
            controller.snapshot().status,
            DesktopUpdateStatus::Ready {
                version: "0.1.1".into()
            }
        );
        assert!(matches!(
            controller.take_changes().last().unwrap().status,
            DesktopUpdateStatus::Ready { .. }
        ));
        // Downloaded and announced, and nothing quit.
        assert_eq!(counts.lock().unwrap().installs, 0);
    }

    #[test]
    fn restarts_only_when_asked_and_only_with_an_update_ready() {
        let (mut controller, counts) = setup();
        let mut before = 0;
        assert!(!controller.restart(&mut || before += 1));
        controller.found("0.1.1", None, NOW);
        assert!(
            !controller.restart(&mut || before += 1),
            "still downloading"
        );
        controller.downloaded("0.1.1", NOW);
        assert!(controller.restart(&mut || before += 1));
        assert_eq!(counts.lock().unwrap().installs, 1);
        assert_eq!(before, 1);
    }

    #[test]
    fn turns_a_failed_check_into_an_error_status_and_tries_again_later() {
        let (mut controller, counts, _) = setup_with(UpdaterPolicy::Enabled, true, true);
        controller.check(NOW);
        assert_eq!(
            controller.snapshot().status,
            DesktopUpdateStatus::Error {
                last_checked_at: None
            }
        );
        controller.tick(NOW + FIRST_CHECK_DELAY_MS);
        assert_eq!(checks(&counts), 2);
        controller.tick(NOW + UPDATE_CHECK_INTERVAL_MS);
        assert_eq!(checks(&counts), 3);
    }

    #[test]
    fn schedules_nothing_with_auto_check_off_and_still_checks_and_reports_when_driven() {
        let (mut controller, counts, _) = setup_with(UpdaterPolicy::Enabled, false, false);
        assert!(!controller.is_scheduled());
        controller.tick(NOW + 10 * UPDATE_CHECK_INTERVAL_MS);
        assert_eq!(checks(&counts), 0);
        assert_eq!(
            controller.snapshot().status,
            DesktopUpdateStatus::Idle {
                last_checked_at: None
            }
        );
        controller.check(NOW);
        assert_eq!(checks(&counts), 1);
        controller.dispatch(
            UpdaterEvent::Downloaded {
                version: "0.1.1".into(),
            },
            NOW,
        );
        assert_eq!(
            controller.snapshot().status,
            DesktopUpdateStatus::Ready {
                version: "0.1.1".into()
            }
        );
    }

    #[test]
    fn stops_its_timers_on_dispose() {
        let (mut controller, counts) = setup();
        controller.dispose();
        assert!(!controller.is_scheduled());
        controller.tick(NOW + 10 * UPDATE_CHECK_INTERVAL_MS);
        assert_eq!(checks(&counts), 0);
    }

    #[test]
    fn installs_a_download_on_quit_once_and_not_after_a_restart() {
        let (mut controller, counts) = setup();
        controller.app_will_quit();
        assert_eq!(
            counts.lock().unwrap().quit_installs,
            0,
            "nothing downloaded"
        );
        controller.downloaded("0.1.1", NOW);
        controller.app_will_quit();
        controller.app_will_quit();
        assert_eq!(counts.lock().unwrap().quit_installs, 1);

        let (mut restarted, counts) = setup();
        restarted.downloaded("0.1.1", NOW);
        assert!(restarted.restart(&mut || {}));
        restarted.app_will_quit();
        assert_eq!(counts.lock().unwrap().quit_installs, 0);
    }

    #[test]
    fn records_each_change_once_and_stamps_the_check_time() {
        let (mut controller, _) = setup();
        controller.check(NOW);
        controller.dispatch(UpdaterEvent::Checking, NOW);
        controller.not_found(NOW);
        let changes = controller.take_changes();
        assert_eq!(changes.len(), 2);
        assert_eq!(
            changes[1].status,
            DesktopUpdateStatus::Idle {
                last_checked_at: Some(NOW_ISO.into())
            }
        );
        assert!(controller.take_changes().is_empty());
    }

    #[test]
    fn a_release_outside_this_installs_rollout_is_no_update() {
        let dir = tempfile::tempdir().unwrap();
        // Bucket ≈ 0.3118 (updater_model's tests).
        std::fs::write(
            dir.path().join(".updaterId"),
            "6ba7b812-9dad-51d1-80b4-00c04fd430c8",
        )
        .unwrap();
        let counts = Arc::new(Mutex::new(MemoryUpdaterCounts::default()));
        let shared = counts.clone();
        let mut controller = UpdateController::new(
            UpdateControllerOptions {
                policy: UpdaterPolicy::Enabled,
                current_version: "0.1.0".into(),
                auto_check: false,
                now_ms: NOW,
                staging_id_dir: Some(dir.path().to_path_buf()),
            },
            || {
                Box::new(Fake {
                    counts: shared,
                    fail_check: false,
                })
            },
        );
        controller.check(NOW);
        controller.found("0.2.0", Some(&json!(25)), NOW);
        assert_eq!(
            controller.snapshot().status,
            DesktopUpdateStatus::Idle {
                last_checked_at: Some(NOW_ISO.into())
            }
        );
        assert_eq!(counts.lock().unwrap().downloads, 0);
        controller.check(NOW);
        controller.found("0.2.0", Some(&json!(50)), NOW);
        assert_eq!(
            controller.snapshot().status,
            DesktopUpdateStatus::Downloading {
                version: "0.2.0".into(),
                percent: None
            }
        );
        assert_eq!(counts.lock().unwrap().downloads, 1);
    }

    #[test]
    fn creates_the_staging_id_on_the_first_check_and_never_headless() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(".updaterId");
        let mut controller = UpdateController::new(
            UpdateControllerOptions {
                policy: UpdaterPolicy::Enabled,
                current_version: "0.1.0".into(),
                auto_check: false,
                now_ms: NOW,
                staging_id_dir: Some(dir.path().to_path_buf()),
            },
            || Box::new(MemoryUpdaterBackend::new()),
        );
        assert!(!file.exists(), "not before a check");
        controller.check(NOW);
        assert!(file.exists());

        let (mut headless, _) = setup();
        headless.check(NOW);
        headless.found("0.2.0", Some(&json!(1)), NOW);
        assert!(
            matches!(
                headless.snapshot().status,
                DesktopUpdateStatus::Downloading { .. }
            ),
            "no id, nothing to stage against"
        );
    }

    /// The source rules, as updater-model.test.ts checked them in the
    /// TypeScript: one install-and-restart call, reached only from the two
    /// clicks; no timer in a headless run; one rollout decision.
    #[test]
    fn calls_install_and_restart_in_one_place_and_restart_only_from_a_tray_click_or_the_settings_button(
    ) {
        let sources = non_test_sources();
        let callers = |needle: &str| -> Vec<String> {
            sources
                .iter()
                .flat_map(|(name, text)| {
                    std::iter::repeat_n(name.clone(), text.matches(needle).count())
                })
                .collect()
        };
        assert_eq!(callers(".install_and_restart("), ["updater_controller.rs"]);
        // One call into the controller, behind `restart_for_update`, which
        // exactly two places reach: the tray's "restart-to-update" item and the
        // update:restart channel, which only the "Restart to update" button
        // invokes.
        assert_eq!(callers("updates.restart("), ["desktop_controller.rs"]);
        assert_eq!(
            callers("restart_for_update()"),
            ["desktop_controller.rs", "desktop_controller.rs"]
        );
        let desktop = &sources
            .iter()
            .find(|(name, _)| name == "desktop_controller.rs")
            .unwrap()
            .1;
        assert!(
            desktop.contains("\"restart-to-update\" => _ = self.restart_for_update()"),
            "the tray item"
        );
        assert!(
            desktop.contains(
                "channels::UPDATE_RESTART => Ok(Value::Bool(inner.restart_for_update()))"
            ),
            "the button"
        );
        // A headless run must not check on a timer: the memory backend answers
        // no check, so a scheduled one would strand the status at "checking".
        assert!(desktop.contains("auto_check: !options.headless"));
        assert!(desktop.contains("staging_id_dir: (!options.headless).then"));
    }

    #[test]
    fn decides_staged_rollout_in_one_place_keyed_on_the_profile_directory() {
        let sources = non_test_sources();
        let users: Vec<&str> = sources
            .iter()
            .filter(|(name, text)| name != "updater_model.rs" && text.contains("is_staging_match("))
            .map(|(n, _)| n.as_str())
            .collect();
        assert_eq!(users, ["updater_controller.rs"]);
        let readers: Vec<&str> = sources
            .iter()
            .filter(|(name, text)| {
                name != "updater_model.rs" && text.contains("read_or_create_staging_user_id(")
            })
            .map(|(n, _)| n.as_str())
            .collect();
        assert_eq!(readers, ["updater_controller.rs"]);
    }

    /// Every `.rs` file under `src/`, cut at its first `#[cfg(test)]`; a
    /// `tests.rs` module is all test code and left out.
    fn non_test_sources() -> Vec<(String, String)> {
        fn walk(dir: &std::path::Path, out: &mut Vec<(String, String)>) {
            let mut entries: Vec<_> = std::fs::read_dir(dir)
                .unwrap()
                .map(|e| e.unwrap().path())
                .collect();
            entries.sort();
            for path in entries {
                if path.is_dir() {
                    walk(&path, out);
                } else if path.extension().is_some_and(|e| e == "rs") && !path.ends_with("tests.rs")
                {
                    let text = std::fs::read_to_string(&path).unwrap();
                    let cut = text.find("#[cfg(test)]").unwrap_or(text.len());
                    out.push((
                        path.file_name().unwrap().to_string_lossy().into_owned(),
                        text[..cut].to_string(),
                    ));
                }
            }
        }
        let mut out = Vec::new();
        walk(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut out,
        );
        out
    }
}
