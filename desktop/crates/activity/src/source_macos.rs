//! macOS: `/usr/bin/lsappinfo`, polled (`source-macos.ts`).
//!
//! `lsappinfo front` prints the frontmost application's ASN
//! (`ASN:0x0-0xaadaad:`), and `lsappinfo info -long -only bundleid -only name
//! -only pid <ASN>` its bundle id, display name and pid. Both read
//! LaunchServices' own table: no TCC surface, no AppleEvents, no
//! Accessibility, no Screen Recording — nothing that can raise a permission
//! prompt. Each call is a spawn that exits at once.
//!
//! Optional titles use an injected metadata reader only after explicit opt-in
//! and the system Screen Recording grant. App identity remains permission-free.
//!
//! The output format is undocumented. A macOS release that changes it makes
//! the parser answer None — no capture, never wrong capture — and after three
//! failures the source reports `source-failed` and retries every five minutes.

use std::sync::{Arc, Mutex, Weak};

use crate::distribution::ActivityCaptureMechanism;
use crate::js;
use crate::keys::FrontmostTarget;
use crate::source::{
    FrontmostSource, PolicyAnswer, ProcessRunner, RestartPolicy, RunResult, SourceFailure,
    SourceFailureReason, SourceKind, SourceListener, RETRY_AFTER_MS,
};
use crate::timers::{TimerId, Timers};

pub const LSAPPINFO: &str = "/usr/bin/lsappinfo";
pub const MACOS_POLL_MS: f64 = 5_000.0;

/// Reads the frontmost window's title for a pid, or None.
pub trait TitleReader: Send + Sync {
    fn read(&self, pid: i64, done: Box<dyn FnOnce(Option<String>) + Send>);
}

fn is_hex(b: u8) -> bool {
    b.is_ascii_hexdigit()
}

/// The ASN `lsappinfo front` printed, or None for anything else
/// (`/ASN:0x[0-9a-f]+-0x[0-9a-f]+:/i`).
pub fn parse_lsappinfo_front(stdout: &str) -> Option<String> {
    let text = js::trim(stdout);
    let bytes = text.as_bytes();
    let lower = text.to_ascii_lowercase();
    let lower = lower.as_bytes();
    let mut start = 0;
    while let Some(offset) = lower[start..].windows(6).position(|w| w == b"asn:0x") {
        let at = start + offset;
        let mut i = at + 6;
        let first = i;
        while i < bytes.len() && is_hex(bytes[i]) {
            i += 1;
        }
        if i > first && lower[i..].starts_with(b"-0x") {
            i += 3;
            let second = i;
            while i < bytes.len() && is_hex(bytes[i]) {
                i += 1;
            }
            if i > second && i < bytes.len() && bytes[i] == b':' {
                return Some(text[at..=i].to_string());
            }
        }
        start = at + 1;
    }
    None
}

/// Decode a quoted lsappinfo value: `\"`, `\\` and `\uXXXX`.
fn unquote(value: &str) -> String {
    let mut units: Vec<u16> = Vec::with_capacity(value.len());
    let chars: Vec<char> = value.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && i + 1 < chars.len() {
            let next = chars[i + 1];
            if next == 'u'
                && i + 5 < chars.len()
                && chars[i + 2..i + 6].iter().all(|h| h.is_ascii_hexdigit())
            {
                let hex: String = chars[i + 2..i + 6].iter().collect();
                units.push(u16::from_str_radix(&hex, 16).expect("hex"));
                i += 6;
                continue;
            }
            if !js::is_js_line_terminator(next) {
                let mut buffer = [0u16; 2];
                units.extend_from_slice(next.encode_utf16(&mut buffer));
                i += 2;
                continue;
            }
        }
        let mut buffer = [0u16; 2];
        units.extend_from_slice(c.encode_utf16(&mut buffer));
        i += 1;
    }
    String::from_utf16_lossy(&units)
}

/// One `"name" = "value"` or `"name" = 123` line
/// (`/^\s*"([^"]+)"\s*=\s*(?:"((?:[^"\\]|\\.)*)"|(-?\d+))\s*$/`).
fn parse_field(line: &str) -> Option<(String, String)> {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    let skip_ws = |i: &mut usize| {
        while *i < chars.len() && js::is_js_whitespace(chars[*i]) {
            *i += 1;
        }
    };
    skip_ws(&mut i);
    if chars.get(i) != Some(&'"') {
        return None;
    }
    i += 1;
    let name_start = i;
    while i < chars.len() && chars[i] != '"' {
        i += 1;
    }
    if i >= chars.len() || i == name_start {
        return None;
    }
    let name: String = chars[name_start..i].iter().collect();
    i += 1;
    skip_ws(&mut i);
    if chars.get(i) != Some(&'=') {
        return None;
    }
    i += 1;
    skip_ws(&mut i);
    let value = if chars.get(i) == Some(&'"') {
        i += 1;
        let start = i;
        loop {
            match chars.get(i) {
                None => return None,
                Some('"') => break,
                Some('\\') => match chars.get(i + 1) {
                    Some(next) if !js::is_js_line_terminator(*next) => i += 2,
                    _ => return None,
                },
                Some(_) => i += 1,
            }
        }
        let quoted: String = chars[start..i].iter().collect();
        i += 1;
        unquote(&quoted)
    } else {
        let start = i;
        if chars.get(i) == Some(&'-') {
            i += 1;
        }
        let digits = i;
        while i < chars.len() && chars[i].is_ascii_digit() {
            i += 1;
        }
        if i == digits {
            return None;
        }
        chars[start..i].iter().collect()
    };
    skip_ws(&mut i);
    (i == chars.len()).then_some((name, value))
}

/// The target `lsappinfo info` describes, or None when it has no usable
/// identity. A missing bundle id (a bare executable) falls back to
/// `exe-<name>`, so the app is still recorded and can still be excluded.
pub fn parse_lsappinfo_info(stdout: &str) -> Option<FrontmostTarget> {
    let mut fields: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for line in stdout.split('\n') {
        if let Some((name, value)) = parse_field(line) {
            fields.insert(name, value);
        }
    }
    let bundle_id = fields
        .get("CFBundleIdentifier")
        .map(|v| js::trim(v).to_string())
        .unwrap_or_default();
    let display_name = fields
        .get("LSDisplayName")
        .map(|v| js::trim(v).to_string())
        .unwrap_or_default();
    let pid = fields
        .get("pid")
        .filter(|text| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|text| text.parse::<i64>().ok());
    if bundle_id.is_empty() && display_name.is_empty() {
        return None;
    }
    let key = if bundle_id.is_empty() {
        format!("exe-{display_name}")
    } else {
        bundle_id.clone()
    };
    let name = if display_name.is_empty() {
        bundle_id
    } else {
        display_name
    };
    Some(FrontmostTarget {
        key,
        name,
        title: None,
        pid,
    })
}

struct MacState {
    titles: bool,
    title_revision: u64,
    listener: Option<SourceListener>,
    poll: Option<TimerId>,
    retry: Option<TimerId>,
    busy: bool,
    last_asn: Option<String>,
    last_target: Option<FrontmostTarget>,
    generation: u64,
    policy: RestartPolicy,
}

struct MacShared {
    runner: Arc<dyn ProcessRunner>,
    timers: Arc<dyn Timers>,
    read_title: Option<Arc<dyn TitleReader>>,
    state: Mutex<MacState>,
}

pub struct MacosSource {
    shared: Arc<MacShared>,
}

impl MacosSource {
    pub fn new(
        runner: Arc<dyn ProcessRunner>,
        timers: Arc<dyn Timers>,
        read_title: Option<Arc<dyn TitleReader>>,
    ) -> Self {
        MacosSource {
            shared: Arc::new(MacShared {
                runner,
                timers,
                read_title,
                state: Mutex::new(MacState {
                    titles: false,
                    title_revision: 0,
                    listener: None,
                    poll: None,
                    retry: None,
                    busy: false,
                    last_asn: None,
                    last_target: None,
                    generation: 0,
                    policy: RestartPolicy::default(),
                }),
            }),
        }
    }
}

fn lock(shared: &MacShared) -> std::sync::MutexGuard<'_, MacState> {
    shared.state.lock().expect("macOS source lock")
}

fn clear(shared: &MacShared, state: &mut MacState) {
    if let Some(poll) = state.poll.take() {
        shared.timers.clear(poll);
    }
    if let Some(retry) = state.retry.take() {
        shared.timers.clear(retry);
    }
}

/// Records a failure. Returns the listener to tell `source-failed`, after the lock is released.
fn fail(shared: &Arc<MacShared>, state: &mut MacState) -> Option<SourceListener> {
    state.last_asn = None;
    if state.policy.fail(shared.timers.now()) == PolicyAnswer::Restart {
        return None;
    }
    clear(shared, state);
    let weak = Arc::downgrade(shared);
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
                begin(&shared);
            }
        }),
    ));
    state.listener.clone()
}

fn tell_failed(listener: Option<SourceListener>) {
    if let Some(listener) = listener {
        (listener.failure)(Some(SourceFailure {
            reason: SourceFailureReason::SourceFailed,
            hint: None,
        }));
    }
}

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|a| a.to_string()).collect()
}

fn read(shared: &Arc<MacShared>) {
    let run = {
        let mut state = lock(shared);
        if state.busy || state.listener.is_none() {
            return;
        }
        state.busy = true;
        state.generation
    };
    let weak: Weak<MacShared> = Arc::downgrade(shared);
    shared.runner.run(
        LSAPPINFO,
        &args(&["front"]),
        &[],
        Box::new(move |front| {
            if let Some(shared) = weak.upgrade() {
                after_front(&shared, run, front);
            }
        }),
    );
}

fn after_front(shared: &Arc<MacShared>, run: u64, front: RunResult) {
    let mut state = lock(shared);
    if state.listener.is_none() || run != state.generation {
        state.busy = false;
        return;
    }
    if front.code != Some(0) {
        let notify = fail(shared, &mut state);
        state.busy = false;
        drop(state);
        tell_failed(notify);
        return;
    }
    let Some(asn) = parse_lsappinfo_front(&front.stdout) else {
        let trimmed = js::trim(&front.stdout);
        if trimmed.is_empty() || trimmed == "[ NULL ]" {
            // Nothing in front (every window closed, a transition): not a failure.
            state.last_asn = None;
            state.last_target = None;
            state.policy.succeed();
            state.busy = false;
            let listener = state.listener.clone();
            drop(state);
            if let Some(listener) = listener {
                (listener.failure)(None);
                (listener.target)(None);
            }
            return;
        }
        let notify = fail(shared, &mut state);
        state.busy = false;
        drop(state);
        tell_failed(notify);
        return;
    };
    if state.last_asn.as_deref() != Some(asn.as_str()) {
        drop(state);
        // Without -long, lsappinfo prints a human-readable summary instead
        // of the quoted LaunchServices fields parsed above.
        let weak = Arc::downgrade(shared);
        let info_args = args(&[
            "info", "-long", "-only", "bundleid", "-only", "name", "-only", "pid", &asn,
        ]);
        shared.runner.run(
            LSAPPINFO,
            &info_args,
            &[],
            Box::new(move |info| {
                if let Some(shared) = weak.upgrade() {
                    after_info(&shared, run, asn, info);
                }
            }),
        );
        return;
    }
    drop(state);
    with_target(shared, run);
}

fn after_info(shared: &Arc<MacShared>, run: u64, asn: String, info: RunResult) {
    let mut state = lock(shared);
    if state.listener.is_none() || run != state.generation {
        state.busy = false;
        return;
    }
    let target = if info.code == Some(0) {
        parse_lsappinfo_info(&info.stdout)
    } else {
        None
    };
    let Some(target) = target else {
        let notify = fail(shared, &mut state);
        state.busy = false;
        drop(state);
        tell_failed(notify);
        return;
    };
    state.last_asn = Some(asn);
    state.last_target = Some(target);
    drop(state);
    with_target(shared, run);
}

fn with_target(shared: &Arc<MacShared>, run: u64) {
    let (target, revision) = {
        let state = lock(shared);
        let target = state.last_target.clone();
        let wants_title = state.titles
            && shared.read_title.is_some()
            && target.as_ref().is_some_and(|t| t.pid.is_some());
        (target, wants_title.then_some(state.title_revision))
    };
    match (
        revision,
        &shared.read_title,
        target.as_ref().and_then(|t| t.pid),
    ) {
        (Some(revision), Some(reader), Some(pid)) => {
            let weak = Arc::downgrade(shared);
            reader.read(
                pid,
                Box::new(move |title| {
                    if let Some(shared) = weak.upgrade() {
                        after_title(&shared, run, revision, target, title);
                    }
                }),
            );
        }
        _ => finish(shared, run, target),
    }
}

fn after_title(
    shared: &Arc<MacShared>,
    run: u64,
    revision: u64,
    base: Option<FrontmostTarget>,
    title: Option<String>,
) {
    let target = {
        let mut state = lock(shared);
        if state.listener.is_none() || run != state.generation {
            state.busy = false;
            return;
        }
        let mut target = base;
        if state.titles && state.title_revision == revision {
            if let (Some(target), Some(title)) = (target.as_mut(), title) {
                target.title = Some(title);
            }
        }
        target
    };
    finish(shared, run, target);
}

fn finish(shared: &Arc<MacShared>, run: u64, target: Option<FrontmostTarget>) {
    let listener = {
        let mut state = lock(shared);
        if state.listener.is_none() || run != state.generation {
            state.busy = false;
            return;
        }
        state.policy.succeed();
        state.busy = false;
        state.listener.clone()
    };
    if let Some(listener) = listener {
        (listener.failure)(None);
        (listener.target)(target);
    }
}

fn begin(shared: &Arc<MacShared>) {
    {
        let mut state = lock(shared);
        clear(shared, &mut state);
        let weak = Arc::downgrade(shared);
        state.poll = Some(shared.timers.set_interval(
            MACOS_POLL_MS,
            Box::new(move || {
                if let Some(shared) = weak.upgrade() {
                    read(&shared);
                }
            }),
        ));
    }
    read(shared);
}

impl FrontmostSource for MacosSource {
    fn kind(&self) -> SourceKind {
        SourceKind::Mechanism(ActivityCaptureMechanism::MacosLsappinfo)
    }

    fn start(&self, listener: SourceListener) {
        {
            let mut state = lock(&self.shared);
            state.generation += 1;
            state.listener = Some(listener);
        }
        begin(&self.shared);
    }

    fn stop(&self) {
        let mut state = lock(&self.shared);
        state.generation += 1;
        state.listener = None;
        clear(&self.shared, &mut state);
        state.last_asn = None;
        state.last_target = None;
    }

    fn set_titles(&self, on: bool) {
        let mut state = lock(&self.shared);
        if state.titles != on {
            state.title_revision += 1;
        }
        state.titles = on;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_asn_from_front() {
        assert_eq!(
            parse_lsappinfo_front("ASN:0x0-0xaadaad:\n").as_deref(),
            Some("ASN:0x0-0xaadaad:")
        );
        assert_eq!(parse_lsappinfo_front("[ NULL ]"), None);
        assert_eq!(parse_lsappinfo_front(""), None);
        assert_eq!(
            parse_lsappinfo_front("x asn:0X1-0xAb: y").as_deref(),
            Some("asn:0X1-0xAb:")
        );
        assert_eq!(
            parse_lsappinfo_front("ASN:0x-0x1: ASN:0x2-0x3:").as_deref(),
            Some("ASN:0x2-0x3:")
        );
    }

    #[test]
    fn reads_bundle_id_name_and_pid() {
        let stdout = "\"CFBundleIdentifier\"=\"com.google.Chrome\"\n\"LSDisplayName\"=\"Google Chrome\"\n\"pid\"=60880\n";
        assert_eq!(
            parse_lsappinfo_info(stdout),
            Some(FrontmostTarget {
                key: "com.google.Chrome".into(),
                name: "Google Chrome".into(),
                title: None,
                pid: Some(60880)
            })
        );
    }

    #[test]
    fn falls_back_to_exe_name_without_a_bundle_id_and_decodes_escapes() {
        let stdout = "\"CFBundleIdentifier\"=[ NULL ]\n\"LSDisplayName\"=\"my \\\"tool\\\" \\u00e4\"\n\"pid\"=12\n";
        assert_eq!(
            parse_lsappinfo_info(stdout),
            Some(FrontmostTarget {
                key: "exe-my \"tool\" ä".into(),
                name: "my \"tool\" ä".into(),
                title: None,
                pid: Some(12)
            })
        );
    }

    #[test]
    fn answers_none_for_output_it_does_not_recognise() {
        assert_eq!(parse_lsappinfo_info("something else entirely"), None);
    }

    #[test]
    fn decodes_surrogate_pairs_written_as_two_escapes() {
        assert_eq!(unquote("\\ud83d\\ude00 x"), "\u{1F600} x");
    }
}
