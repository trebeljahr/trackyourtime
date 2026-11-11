//! Windows: one long-lived `powershell.exe` running an embedded script
//! (`source-windows.ts`).
//!
//! The script P/Invokes `GetForegroundWindow`, `GetWindowThreadProcessId`
//! and `QueryFullProcessImageNameW` (with `PROCESS_QUERY_LIMITED_INFORMATION`,
//! the right a standard user has over other processes), and `GetWindowTextW`
//! only when titles are on — the flag is baked into the script, so toggling
//! titles restarts the helper. It checks once a second and prints a JSON line
//! only on a change, plus `{"alive":true}` every 30 s so a hung helper can be
//! told from a person who stayed in one app.
//!
//! The script is a string constant in the binary and goes to PowerShell as
//! `-EncodedCommand`: no `.ps1` file is ever written or executed.
//! Constrained Language Mode (AppLocker or WDAC) refuses `Add-Type`; the
//! script checks first and reports `constrained-language`, which is
//! `blocked-by-policy` here. Output is switched to UTF-8 after that check
//! (setting `[Console]` is itself refused under CLM), since the console's OEM
//! code page would mangle non-ASCII names.
//!
//! Watchdog: no line for 90 s → kill and respawn; three failures in ten
//! minutes → `source-failed`, retried every five minutes. The helper also
//! exits on its own when this app's process is gone, so a crash leaves
//! nothing behind.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::Engine;
use serde_json::Value;

use crate::distribution::ActivityCaptureMechanism;
use crate::keys::FrontmostTarget;
use crate::source::{
    ChildHandle, FrontmostSource, PolicyAnswer, ProcessRunner, RestartPolicy, SourceFailure,
    SourceFailureReason, SourceKind, SourceListener, RETRY_AFTER_MS,
};
use crate::timers::{TimerId, Timers};

/// A helper silent for this long is presumed hung.
pub const WINDOWS_WATCHDOG_MS: f64 = 90_000.0;

pub fn powershell_path(env: &HashMap<String, String>) -> String {
    let root = env
        .get("SystemRoot")
        .or_else(|| env.get("SYSTEMROOT"))
        .map(String::as_str)
        .unwrap_or("C:\\Windows");
    format!("{root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
}

/// The script, byte for byte the TypeScript's `WINDOWS_FOREGROUND_SCRIPT`
/// (a test pins the encoded command's hash).
pub const WINDOWS_FOREGROUND_SCRIPT: &str = include_str!("windows-foreground.ps1");

/// The script with its two parameters filled in, as `-EncodedCommand` wants
/// it (UTF-16LE, base64).
pub fn encoded_foreground_script(titles: bool, parent_pid: u32) -> String {
    let script = WINDOWS_FOREGROUND_SCRIPT
        .replacen("__TITLES__", if titles { "$true" } else { "$false" }, 1)
        .replacen("__PARENT__", &parent_pid.to_string(), 1);
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowsHelperLine {
    Target(FrontmostTarget),
    None,
    Alive,
    Error(String),
    Junk,
}

pub fn parse_windows_helper_line(line: &str) -> WindowsHelperLine {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return WindowsHelperLine::Junk;
    };
    let Some(record) = value.as_object() else {
        return WindowsHelperLine::Junk;
    };
    if record.get("alive") == Some(&Value::Bool(true)) {
        return WindowsHelperLine::Alive;
    }
    if record.get("none") == Some(&Value::Bool(true)) {
        return WindowsHelperLine::None;
    }
    if let Some(error) = record.get("error").and_then(Value::as_str) {
        return WindowsHelperLine::Error(error.to_string());
    }
    let Some(key) = record
        .get("key")
        .and_then(Value::as_str)
        .filter(|k| !crate::js::trim(k).is_empty())
    else {
        return WindowsHelperLine::Junk;
    };
    let name = record
        .get("name")
        .and_then(Value::as_str)
        .filter(|n| !crate::js::trim(n).is_empty())
        .unwrap_or(key);
    let pid = record
        .get("pid")
        .and_then(Value::as_f64)
        .filter(|p| p.fract() == 0.0 && p.is_finite())
        .map(|p| p as i64);
    WindowsHelperLine::Target(FrontmostTarget {
        key: key.to_string(),
        name: name.to_string(),
        pid,
        title: record
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

struct WinState {
    listener: Option<SourceListener>,
    /// The id of the helper whose lines count; None once it was killed.
    current: Option<u64>,
    handle: Option<Box<dyn ChildHandle>>,
    next_child: u64,
    watchdog: Option<TimerId>,
    retry: Option<TimerId>,
    titles: bool,
    last_target: Option<FrontmostTarget>,
    policy: RestartPolicy,
}

struct WinShared {
    runner: Arc<dyn ProcessRunner>,
    timers: Arc<dyn Timers>,
    env: HashMap<String, String>,
    parent_pid: u32,
    state: Mutex<WinState>,
}

pub struct WindowsSource {
    shared: Arc<WinShared>,
}

impl WindowsSource {
    pub fn new(
        runner: Arc<dyn ProcessRunner>,
        timers: Arc<dyn Timers>,
        env: HashMap<String, String>,
        parent_pid: u32,
    ) -> Self {
        WindowsSource {
            shared: Arc::new(WinShared {
                runner,
                timers,
                env,
                parent_pid,
                state: Mutex::new(WinState {
                    listener: None,
                    current: None,
                    handle: None,
                    next_child: 0,
                    watchdog: None,
                    retry: None,
                    titles: false,
                    last_target: None,
                    policy: RestartPolicy::default(),
                }),
            }),
        }
    }
}

fn lock(shared: &WinShared) -> std::sync::MutexGuard<'_, WinState> {
    shared.state.lock().expect("Windows source lock")
}

fn clear_timers(shared: &WinShared, state: &mut WinState) {
    if let Some(id) = state.watchdog.take() {
        shared.timers.clear(id);
    }
    if let Some(id) = state.retry.take() {
        shared.timers.clear(id);
    }
}

/// Forget the current helper and kill it, outside the lock: a fake child
/// reports its exit synchronously.
fn kill(shared: &WinShared) {
    let handle = {
        let mut state = lock(shared);
        state.current = None;
        state.handle.take()
    };
    if let Some(handle) = handle {
        handle.kill();
    }
}

fn arm_watchdog(shared: &Arc<WinShared>, state: &mut WinState) {
    if let Some(id) = state.watchdog.take() {
        shared.timers.clear(id);
    }
    let weak = Arc::downgrade(shared);
    state.watchdog = Some(shared.timers.set_timeout(
        WINDOWS_WATCHDOG_MS,
        Box::new(move || {
            let Some(shared) = weak.upgrade() else { return };
            lock(&shared).watchdog = None;
            kill(&shared);
            failed(&shared);
        }),
    ));
}

fn give_up(shared: &Arc<WinShared>, reason: SourceFailureReason) {
    let listener = {
        let mut state = lock(shared);
        clear_timers(shared, &mut state);
        state.listener.clone()
    };
    kill(shared);
    if let Some(listener) = &listener {
        (listener.failure)(Some(SourceFailure { reason, hint: None }));
    }
    if reason == SourceFailureReason::SourceFailed {
        let weak = Arc::downgrade(shared);
        let mut state = lock(shared);
        state.retry = Some(shared.timers.set_timeout(
            RETRY_AFTER_MS,
            Box::new(move || {
                let Some(shared) = weak.upgrade() else { return };
                let again = {
                    let mut state = lock(&shared);
                    state.retry = None;
                    state.listener.is_some()
                };
                if again {
                    launch(&shared);
                }
            }),
        ));
    }
}

fn failed(shared: &Arc<WinShared>) {
    let answer = {
        let mut state = lock(shared);
        if state.listener.is_none() {
            return;
        }
        state.policy.fail(shared.timers.now())
    };
    match answer {
        PolicyAnswer::GiveUp => give_up(shared, SourceFailureReason::SourceFailed),
        PolicyAnswer::Restart => launch(shared),
    }
}

fn launch(shared: &Arc<WinShared>) {
    kill(shared);
    let (id, titles) = {
        let mut state = lock(shared);
        state.next_child += 1;
        state.current = Some(state.next_child);
        (state.next_child, state.titles)
    };
    let args: Vec<String> = [
        "-NoProfile",
        "-NonInteractive",
        "-NoLogo",
        "-EncodedCommand",
    ]
    .iter()
    .map(|a| a.to_string())
    .chain([encoded_foreground_script(titles, shared.parent_pid)])
    .collect();
    let on_line = {
        let weak = Arc::downgrade(shared);
        Box::new(move |line: String| {
            if let Some(shared) = weak.upgrade() {
                on_line(&shared, id, &line);
            }
        })
    };
    let on_exit = {
        let weak = Arc::downgrade(shared);
        Box::new(move |_code: Option<i32>| {
            if let Some(shared) = weak.upgrade() {
                on_exit(&shared, id);
            }
        })
    };
    let handle = shared
        .runner
        .spawn(&powershell_path(&shared.env), &args, &[], on_line, on_exit);
    let mut state = lock(shared);
    if state.current == Some(id) {
        state.handle = Some(handle);
        arm_watchdog(shared, &mut state);
    } else {
        // Overtaken (stopped, or exited at once) while it was being spawned.
        drop(state);
        handle.kill();
    }
}

fn on_line(shared: &Arc<WinShared>, id: u64, line: &str) {
    let mut state = lock(shared);
    if state.current != Some(id) || state.listener.is_none() {
        return;
    }
    let parsed = parse_windows_helper_line(line);
    if parsed == WindowsHelperLine::Junk {
        return;
    }
    arm_watchdog(shared, &mut state);
    match parsed {
        WindowsHelperLine::Error(error) => {
            drop(state);
            let reason = if error == "constrained-language" {
                SourceFailureReason::BlockedByPolicy
            } else {
                SourceFailureReason::SourceFailed
            };
            give_up(shared, reason);
        }
        other => {
            state.policy.succeed();
            match other {
                WindowsHelperLine::Target(target) => state.last_target = Some(target),
                WindowsHelperLine::None => state.last_target = None,
                // `alive` repeats the last answer, which keeps a long stretch in one app alive.
                _ => {}
            }
            let listener = state.listener.clone().expect("checked above");
            let target = state.last_target.clone();
            drop(state);
            (listener.failure)(None);
            (listener.target)(target);
        }
    }
}

fn on_exit(shared: &Arc<WinShared>, id: u64) {
    {
        let mut state = lock(shared);
        if state.current != Some(id) {
            return;
        }
        state.current = None;
        state.handle = None;
        if let Some(watchdog) = state.watchdog.take() {
            shared.timers.clear(watchdog);
        }
    }
    failed(shared);
}

impl FrontmostSource for WindowsSource {
    fn kind(&self) -> SourceKind {
        SourceKind::Mechanism(ActivityCaptureMechanism::WindowsPowershell)
    }

    fn start(&self, listener: SourceListener) {
        lock(&self.shared).listener = Some(listener);
        launch(&self.shared);
    }

    fn stop(&self) {
        {
            let mut state = lock(&self.shared);
            state.listener = None;
            clear_timers(&self.shared, &mut state);
        }
        kill(&self.shared);
        lock(&self.shared).last_target = None;
    }

    fn set_titles(&self, on: bool) {
        let relaunch = {
            let mut state = lock(&self.shared);
            if on == state.titles {
                return;
            }
            state.titles = on;
            state.listener.is_some() && state.current.is_some()
        };
        if relaunch {
            launch(&self.shared);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn target(key: &str, name: &str, pid: Option<i64>, title: Option<&str>) -> FrontmostTarget {
        FrontmostTarget {
            key: key.into(),
            name: name.into(),
            pid,
            title: title.map(str::to_string),
        }
    }

    #[test]
    fn parses_targets_none_alive_and_errors() {
        assert_eq!(
            parse_windows_helper_line(
                r#"{"key":"Code.exe","name":"Visual Studio Code","pid":42,"title":"a.ts"}"#
            ),
            WindowsHelperLine::Target(target(
                "Code.exe",
                "Visual Studio Code",
                Some(42),
                Some("a.ts")
            ))
        );
        assert_eq!(
            parse_windows_helper_line(r#"{"key":"x.exe","name":""}"#),
            WindowsHelperLine::Target(target("x.exe", "x.exe", None, None))
        );
        assert_eq!(
            parse_windows_helper_line(r#"{"none":true}"#),
            WindowsHelperLine::None
        );
        assert_eq!(
            parse_windows_helper_line(r#"{"alive":true}"#),
            WindowsHelperLine::Alive
        );
        assert_eq!(
            parse_windows_helper_line(r#"{"error":"constrained-language"}"#),
            WindowsHelperLine::Error("constrained-language".into())
        );
        assert_eq!(
            parse_windows_helper_line("Add-Type : something"),
            WindowsHelperLine::Junk
        );
    }

    fn decode(b64: &str) -> String {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap();
        let units: Vec<u16> = bytes
            .chunks(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16(&units).unwrap()
    }

    #[test]
    fn bakes_the_titles_flag_and_the_parent_pid_into_the_encoded_script() {
        assert!(decode(&encoded_foreground_script(false, 77))
            .contains("$titles = $false\n$parentId = 77\n"));
        assert!(decode(&encoded_foreground_script(true, 77)).contains("$titles = $true"));
        let env: HashMap<String, String> = [("SystemRoot".to_string(), "D:\\Win".to_string())]
            .into_iter()
            .collect();
        assert_eq!(
            powershell_path(&env),
            "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
        );
    }

    #[test]
    fn the_encoded_command_is_the_typescripts_byte_for_byte() {
        // sha256 of `encodedForegroundScript(true, 77)` from source-windows.ts.
        let digest = Sha256::digest(encoded_foreground_script(true, 77).as_bytes());
        assert_eq!(
            crate::protection::hex(&digest),
            "64e27d95bc14f983373d2b3aeb3f43940e07a91c5390a28c834c2ec342722377"
        );
    }

    #[test]
    fn writes_utf8_switched_only_after_the_language_mode_check() {
        let script = WINDOWS_FOREGROUND_SCRIPT;
        let encoding = script
            .find("[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false")
            .unwrap();
        // Under CLM setting [Console] throws, which would hide the policy answer.
        assert!(encoding > script.find("constrained-language").unwrap());
        assert!(encoding < script.find("while ($true)").unwrap());
    }
}
