//! `tyt_model::updater_controller::UpdaterBackend` over tauri-plugin-updater.
//!
//! Only builds that carry an update feed register the plugin (the generated
//! config's `plugins.updater`: endpoints and the minisign public key), and the
//! controller only loads this backend when `updater_policy` allows updates.
//! Every method starts work and returns; outcomes go back to the controller
//! through the executor, never under its lock.
//!
//! The rules (CLAUDE.md → Desktop): a download installs when the app quits
//! (`install_on_quit`, called from `will_quit`); `install_and_restart` is
//! reached only from "Restart to update" (tray and Settings); nothing restarts
//! on the person's behalf. Staged rollout is decided by the controller from
//! the feed's raw `stagingPercentage`, passed through untouched.

use std::sync::{Arc, Mutex};
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};
use tyt_model::updater_controller::{UpdaterBackend, UpdaterConfig};

use crate::platform::{ControllerCell, Executor};

/// Whether this build's config carries a feed (the plugin needs one to load).
pub fn has_feed(config: &tauri::Config) -> bool {
    config.plugins.0.get("updater").is_some_and(|u| {
        u.get("pubkey")
            .and_then(|k| k.as_str())
            .is_some_and(|k| !k.is_empty())
            && u.get("endpoints")
                .and_then(|e| e.as_array())
                .is_some_and(|e| !e.is_empty())
    })
}

#[derive(Default)]
struct State {
    found: Option<Update>,
    downloaded: Option<(Update, Vec<u8>)>,
}

pub struct TauriUpdater {
    app: AppHandle,
    executor: Executor,
    controller: ControllerCell,
    state: Arc<Mutex<State>>,
}

impl TauriUpdater {
    pub fn new(app: AppHandle, executor: Executor, controller: ControllerCell) -> Self {
        TauriUpdater {
            app,
            executor,
            controller,
            state: Arc::default(),
        }
    }

    fn report(
        &self,
        job: impl FnOnce(&tyt_model::desktop_controller::DesktopController) + Send + 'static,
    ) {
        let cell = self.controller.clone();
        self.executor.post(move || {
            if let Some(controller) = cell.get() {
                job(controller);
            }
        });
    }

    /// On Windows `install` runs the NSIS installer and exits this process;
    /// `restart` decides whether the installer starts the new version after
    /// (only "Restart to update" asks for that; install-on-quit never does).
    fn install_downloaded(&self, restart: bool) -> Result<(), String> {
        let downloaded = self.state.lock().unwrap().downloaded.take();
        let Some((update, bytes)) = downloaded else {
            return Err("no update downloaded".into());
        };
        update
            .restart_after_install(restart)
            .install(bytes)
            .map_err(|e| e.to_string())
    }
}

impl UpdaterBackend for TauriUpdater {
    fn configure(&mut self, config: &UpdaterConfig) {
        // Stable releases only and never back down: the plugin's default
        // comparator offers only a newer version, and the feed lists the
        // latest published release, which a draft or prerelease never is.
        let _ = config;
    }

    fn check(&mut self) -> Result<(), String> {
        let app = self.app.clone();
        let state = self.state.clone();
        let this = (self.executor.clone(), self.controller.clone());
        tauri::async_runtime::spawn(async move {
            let report =
                |job: Box<dyn FnOnce(&tyt_model::desktop_controller::DesktopController) + Send>| {
                    let cell = this.1.clone();
                    this.0.post(move || {
                        if let Some(c) = cell.get() {
                            job(c)
                        }
                    });
                };
            let result = match app.updater() {
                Ok(updater) => updater.check().await.map_err(|e| e.to_string()),
                Err(error) => Err(error.to_string()),
            };
            match result {
                Ok(Some(update)) => {
                    let version = update.version.clone();
                    let staging = update.raw_json.get("stagingPercentage").cloned();
                    state.lock().unwrap().found = Some(update);
                    report(Box::new(move |c| {
                        c.update_found(&version, staging.as_ref())
                    }));
                }
                Ok(None) => report(Box::new(|c| c.update_not_found())),
                Err(error) => report(Box::new(move |c| c.update_failed(&error))),
            }
        });
        Ok(())
    }

    fn download(&mut self) -> Result<(), String> {
        let Some(update) = self.state.lock().unwrap().found.take() else {
            return Err("nothing to download".into());
        };
        let state = self.state.clone();
        let (executor, cell) = (self.executor.clone(), self.controller.clone());
        tauri::async_runtime::spawn(async move {
            let post =
                |job: Box<dyn FnOnce(&tyt_model::desktop_controller::DesktopController) + Send>| {
                    let cell = cell.clone();
                    executor.post(move || {
                        if let Some(c) = cell.get() {
                            job(c)
                        }
                    });
                };
            let mut received = 0usize;
            let mut last_percent = -1.0f64;
            let progress = |chunk: usize, total: Option<u64>| {
                received += chunk;
                if let Some(total) = total.filter(|t| *t > 0) {
                    let percent = (received as f64 / total as f64 * 100.0).floor();
                    if percent > last_percent {
                        last_percent = percent;
                        post(Box::new(move |c| c.update_progress(percent)));
                    }
                }
            };
            match update.download(progress, || {}).await {
                Ok(bytes) => {
                    let version = update.version.clone();
                    state.lock().unwrap().downloaded = Some((update, bytes));
                    post(Box::new(move |c| c.update_downloaded(&version)));
                }
                Err(error) => {
                    let error = error.to_string();
                    post(Box::new(move |c| c.update_failed(&error)));
                }
            }
        });
        Ok(())
    }

    fn install_on_quit(&mut self) {
        // macOS and the AppImage replace the installed copy for the next
        // launch; on Windows the installer starts and this process exits.
        if let Err(error) = self.install_downloaded(false) {
            eprintln!("[update] install on quit failed: {error}");
        }
    }

    fn install_and_restart(&mut self) {
        match self.install_downloaded(true) {
            Ok(()) => {
                // `restart` skips the quit sequence; persist what `will_quit`
                // would have (the open activity segment) first.
                crate::shell::before_restart(&self.app);
                self.app.restart()
            }
            Err(error) => {
                eprintln!("[update] install failed: {error}");
                self.report(move |c| c.update_failed(&error));
            }
        }
    }
}
