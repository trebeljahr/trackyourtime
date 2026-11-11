//! The real frontmost-app source for this OS (`platform-source.ts`). Called
//! only from the non-headless branch of [`crate::install`]; `tests/no_spawn.rs`
//! pins that, and that this is the only way a runner backed by
//! `std::process` is made.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::distribution::ActivityCaptureMechanism;
use crate::macos_titles::{MacosTitleReader, Permitted};
use crate::process_runner::StdProcessRunner;
use crate::source::{
    ChildHandle, ExitCallback, FrontmostSource, LineCallback, ProcessRunner, RunCallback,
};
use crate::source_linux::LinuxSource;
use crate::source_macos::MacosSource;
use crate::source_windows::WindowsSource;
use crate::timers::RealTimers;

/// Every attempted child, by file name, for the test hook's `spawns`.
pub type Spawns = Arc<Mutex<Vec<String>>>;

/// Wraps a runner so every attempted child is named in `spawns`.
pub struct RecordingRunner {
    inner: Arc<dyn ProcessRunner>,
    spawns: Spawns,
}

impl RecordingRunner {
    pub fn new(inner: Arc<dyn ProcessRunner>, spawns: Spawns) -> Self {
        RecordingRunner { inner, spawns }
    }

    fn record(&self, file: &str) {
        self.spawns.lock().expect("spawns").push(file.to_string());
    }
}

impl ProcessRunner for RecordingRunner {
    fn run(&self, file: &str, args: &[String], env: &[(String, String)], done: RunCallback) {
        self.record(file);
        self.inner.run(file, args, env, done);
    }

    fn spawn(
        &self,
        file: &str,
        args: &[String],
        env: &[(String, String)],
        on_line: LineCallback,
        on_exit: ExitCallback,
    ) -> Box<dyn ChildHandle> {
        self.record(file);
        self.inner.spawn(file, args, env, on_line, on_exit)
    }
}

pub fn create_platform_source(
    mechanism: ActivityCaptureMechanism,
    env: &HashMap<String, String>,
    parent_pid: u32,
    spawns: Spawns,
    titles_permitted: Permitted,
) -> Arc<dyn FrontmostSource> {
    let runner: Arc<dyn ProcessRunner> =
        Arc::new(RecordingRunner::new(Arc::new(StdProcessRunner), spawns));
    let timers = RealTimers::new();
    match mechanism {
        ActivityCaptureMechanism::MacosLsappinfo => {
            let titles = Arc::new(MacosTitleReader::new(runner.clone(), titles_permitted));
            Arc::new(MacosSource::new(runner, timers, Some(titles)))
        }
        ActivityCaptureMechanism::WindowsPowershell => {
            Arc::new(WindowsSource::new(runner, timers, env.clone(), parent_pid))
        }
        ActivityCaptureMechanism::LinuxXprop => {
            Arc::new(LinuxSource::new(runner, timers, env.clone()))
        }
    }
}
