//! Linux on X11: `xprop` (`source-linux.ts`).
//!
//! `xprop -root -spy _NET_ACTIVE_WINDOW` prints a line whenever the window
//! manager changes the active window, so detection is event-driven; each new
//! window id is then described with one `xprop -id <wid> WM_CLASS
//! _NET_WM_PID _NET_WM_NAME`. The key is WM_CLASS's class (the second
//! string), which is what a desktop file's StartupWMClass names. The title
//! (`_NET_WM_NAME`) is read only while titles are on, and then also every
//! five seconds, since a title changes without the active window changing.
//!
//! Wayland is refused before this module is reached (distribution.rs):
//! XWayland answers only for X clients and would record wrong data, silently.
//!
//! `xprop` is looked up on PATH here and run by absolute path with no shell.
//! Missing → `tool-missing` with the package to install as the hint.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::distribution::ActivityCaptureMechanism;
use crate::js;
use crate::keys::FrontmostTarget;
use crate::source::{
    ChildHandle, FrontmostSource, PolicyAnswer, ProcessRunner, RestartPolicy, SourceFailure,
    SourceFailureReason, SourceKind, SourceListener, RETRY_AFTER_MS,
};
use crate::timers::{TimerId, Timers};

pub const LINUX_TITLE_REFRESH_MS: f64 = 5_000.0;

/// The spy prints nothing while nothing changes, so a quiet one is not a hung one; it only must not exit.
fn xprop_env() -> Vec<(String, String)> {
    vec![("LC_ALL".into(), "C.UTF-8".into())]
}

/// The window id in a `_NET_ACTIVE_WINDOW` line: `Some(None)` for `0x0`
/// (nothing focused), None for anything else.
pub fn parse_active_window_line(line: &str) -> Option<Option<String>> {
    const NEEDLE: &str = "_net_active_window(window): window id # 0x";
    let lower = line.to_ascii_lowercase();
    let mut from = 0;
    while let Some(offset) = lower[from..].find(NEEDLE) {
        let at = from + offset;
        let digits_start = at + NEEDLE.len();
        let digits = lower[digits_start..]
            .bytes()
            .take_while(u8::is_ascii_hexdigit)
            .count();
        if digits > 0 {
            let id = &lower[digits_start - 2..digits_start + digits];
            let zero = lower[digits_start..digits_start + digits]
                .bytes()
                .all(|b| b == b'0');
            return Some(if zero { None } else { Some(id.to_string()) });
        }
        from = at + 1;
    }
    None
}

/// Decode xprop's C-style escapes: `\"`, `\\`, `\n` and octal byte runs
/// (`\303\244`) as UTF-8.
pub fn decode_xprop_string(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut bytes: Vec<u8> = Vec::with_capacity(value.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && i + 1 < chars.len() {
            let octal: Vec<char> = chars[i + 1..]
                .iter()
                .take(3)
                .take_while(|d| ('0'..='7').contains(d))
                .copied()
                .collect();
            if !octal.is_empty() {
                let text: String = octal.iter().collect();
                bytes.push((u32::from_str_radix(&text, 8).expect("octal") & 0xff) as u8);
                i += 1 + octal.len();
                continue;
            }
            let next = chars[i + 1];
            let decoded = match next {
                'n' => '\n',
                't' => '\t',
                other => other,
            };
            let mut buffer = [0u8; 4];
            bytes.extend_from_slice(decoded.encode_utf8(&mut buffer).as_bytes());
            i += 2;
            continue;
        }
        let mut buffer = [0u8; 4];
        bytes.extend_from_slice(c.encode_utf8(&mut buffer).as_bytes());
        i += 1;
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Every `"…"` in a line (`/"((?:[^"\\]|\\.)*)"/g`), decoded.
fn quoted_strings(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '"' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        let closed = loop {
            match chars.get(j) {
                None => break None,
                Some('"') => break Some(j),
                Some('\\') => match chars.get(j + 1) {
                    Some(next) if !js::is_js_line_terminator(*next) => j += 2,
                    _ => break None,
                },
                Some(_) => j += 1,
            }
        };
        match closed {
            Some(end) => {
                let raw: String = chars[i + 1..end].iter().collect();
                out.push(decode_xprop_string(&raw));
                i = end + 1;
            }
            None => i += 1,
        }
    }
    out
}

/// The target `xprop -id` describes, or None without a WM_CLASS.
pub fn parse_xprop_window(stdout: &str) -> Option<FrontmostTarget> {
    let mut key: Option<String> = None;
    let mut pid: Option<i64> = None;
    let mut title: Option<String> = None;
    for line in stdout.split('\n') {
        if line.starts_with("WM_CLASS(") {
            let strings = quoted_strings(line);
            let class = strings
                .get(1)
                .or(strings.first())
                .cloned()
                .unwrap_or_default();
            let trimmed = js::trim(&class);
            key = (!trimmed.is_empty()).then(|| trimmed.to_string());
        } else if line.starts_with("_NET_WM_PID(") {
            // `/=\s*(\d+)/`: the first `=` that has digits after it.
            for (eq, _) in line.match_indices('=') {
                let rest = line[eq + 1..].trim_start_matches(js::is_js_whitespace);
                let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
                if !digits.is_empty() {
                    pid = digits.parse().ok();
                    break;
                }
            }
        } else if line.starts_with("_NET_WM_NAME(") {
            if let Some(name) = quoted_strings(line).into_iter().next() {
                title = Some(name);
            }
        }
    }
    let key = key?;
    Some(FrontmostTarget {
        name: key.clone(),
        key,
        pid,
        title,
    })
}

fn path_delimiter() -> char {
    if cfg!(windows) {
        ';'
    } else {
        ':'
    }
}

pub fn is_executable(file: &Path) -> bool {
    match std::fs::metadata(file) {
        Ok(meta) if meta.is_file() => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                meta.permissions().mode() & 0o111 != 0
            }
            #[cfg(not(unix))]
            {
                true
            }
        }
        _ => false,
    }
}

/// `xprop` on PATH, as an absolute path, or None.
pub fn find_on_path(
    tool: &str,
    env_path: Option<&str>,
    executable: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    for dir in env_path.unwrap_or("").split(path_delimiter()) {
        if dir.is_empty() || !Path::new(dir).is_absolute() {
            continue;
        }
        let candidate = Path::new(dir).join(tool);
        if executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// The package that ships `xprop` on this distribution. A name, never a sentence.
pub fn xprop_package_hint(exists: &dyn Fn(&Path) -> bool) -> String {
    if exists(Path::new("/etc/debian_version")) {
        return "x11-utils".into();
    }
    if exists(Path::new("/etc/arch-release")) {
        return "xorg-xprop".into();
    }
    "xprop".into()
}

struct LinuxState {
    listener: Option<SourceListener>,
    spy: Option<u64>,
    handle: Option<Box<dyn ChildHandle>>,
    next_child: u64,
    retry: Option<TimerId>,
    refresh: Option<TimerId>,
    titles: bool,
    active_id: Option<String>,
    generation: u64,
    policy: RestartPolicy,
}

struct LinuxShared {
    runner: Arc<dyn ProcessRunner>,
    timers: Arc<dyn Timers>,
    env: HashMap<String, String>,
    state: Mutex<LinuxState>,
}

pub struct LinuxSource {
    shared: Arc<LinuxShared>,
}

impl LinuxSource {
    pub fn new(
        runner: Arc<dyn ProcessRunner>,
        timers: Arc<dyn Timers>,
        env: HashMap<String, String>,
    ) -> Self {
        LinuxSource {
            shared: Arc::new(LinuxShared {
                runner,
                timers,
                env,
                state: Mutex::new(LinuxState {
                    listener: None,
                    spy: None,
                    handle: None,
                    next_child: 0,
                    retry: None,
                    refresh: None,
                    titles: false,
                    active_id: None,
                    generation: 0,
                    policy: RestartPolicy::default(),
                }),
            }),
        }
    }
}

fn lock(shared: &LinuxShared) -> std::sync::MutexGuard<'_, LinuxState> {
    shared.state.lock().expect("Linux source lock")
}

fn xprop(shared: &LinuxShared) -> Option<PathBuf> {
    find_on_path(
        "xprop",
        shared.env.get("PATH").map(String::as_str),
        &is_executable,
    )
}

fn describe(shared: &Arc<LinuxShared>, id: Option<String>) {
    let (mine, titles, listener) = {
        let mut state = lock(shared);
        state.generation += 1;
        (state.generation, state.titles, state.listener.clone())
    };
    let Some(id) = id else {
        if let Some(listener) = listener {
            (listener.target)(None);
        }
        return;
    };
    let Some(xprop) = xprop(shared) else { return };
    let mut args = vec![
        "-id".to_string(),
        id,
        "WM_CLASS".into(),
        "_NET_WM_PID".into(),
    ];
    if titles {
        args.push("_NET_WM_NAME".into());
    }
    let weak = Arc::downgrade(shared);
    shared.runner.run(
        &xprop.to_string_lossy(),
        &args,
        &xprop_env(),
        Box::new(move |result| {
            let Some(shared) = weak.upgrade() else { return };
            let (listener, titles) = {
                let state = lock(&shared);
                // A newer change overtook this one: its answer wins.
                if mine != state.generation {
                    return;
                }
                let Some(listener) = state.listener.clone() else {
                    return;
                };
                (listener, state.titles)
            };
            let mut target = if result.code == Some(0) {
                parse_xprop_window(&result.stdout)
            } else {
                None
            };
            if let Some(target) = &mut target {
                if !titles {
                    target.title = None;
                }
            }
            (listener.target)(target);
        }),
    );
}

fn clear_timers(shared: &LinuxShared, state: &mut LinuxState) {
    if let Some(id) = state.retry.take() {
        shared.timers.clear(id);
    }
    if let Some(id) = state.refresh.take() {
        shared.timers.clear(id);
    }
}

fn kill(shared: &LinuxShared) {
    let handle = {
        let mut state = lock(shared);
        state.spy = None;
        state.handle.take()
    };
    if let Some(handle) = handle {
        handle.kill();
    }
}

fn sync_refresh(shared: &Arc<LinuxShared>) {
    let mut state = lock(shared);
    if let Some(id) = state.refresh.take() {
        shared.timers.clear(id);
    }
    if state.titles && state.listener.is_some() {
        let weak = Arc::downgrade(shared);
        state.refresh = Some(shared.timers.set_interval(
            LINUX_TITLE_REFRESH_MS,
            Box::new(move || {
                let Some(shared) = weak.upgrade() else { return };
                let id = lock(&shared).active_id.clone();
                describe(&shared, id);
            }),
        ));
    }
}

fn launch(shared: &Arc<LinuxShared>) {
    kill(shared);
    let Some(xprop) = xprop(shared) else {
        let listener = lock(shared).listener.clone();
        if let Some(listener) = listener {
            let hint = xprop_package_hint(&|path: &Path| path.exists());
            (listener.failure)(Some(SourceFailure {
                reason: SourceFailureReason::ToolMissing,
                hint: Some(hint),
            }));
        }
        return;
    };
    let id = {
        let mut state = lock(shared);
        state.next_child += 1;
        state.spy = Some(state.next_child);
        state.next_child
    };
    let on_line = {
        let weak = Arc::downgrade(shared);
        Box::new(move |line: String| {
            let Some(shared) = weak.upgrade() else { return };
            let listener = {
                let mut state = lock(&shared);
                if state.spy != Some(id) {
                    return;
                }
                let Some(listener) = state.listener.clone() else {
                    return;
                };
                let Some(active) = parse_active_window_line(&line) else {
                    return;
                };
                state.policy.succeed();
                state.active_id = active.clone();
                (listener, active)
            };
            (listener.0.failure)(None);
            describe(&shared, listener.1);
        })
    };
    let on_exit = {
        let weak = Arc::downgrade(shared);
        Box::new(move |_code: Option<i32>| {
            let Some(shared) = weak.upgrade() else { return };
            let answer = {
                let mut state = lock(&shared);
                if state.spy != Some(id) || state.listener.is_none() {
                    return;
                }
                state.spy = None;
                state.handle = None;
                state.policy.fail(shared.timers.now())
            };
            if answer == PolicyAnswer::Restart {
                launch(&shared);
                return;
            }
            let listener = {
                let mut state = lock(&shared);
                clear_timers(&shared, &mut state);
                let weak = Arc::downgrade(&shared);
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
                            sync_refresh(&shared);
                        }
                    }),
                ));
                state.listener.clone()
            };
            if let Some(listener) = listener {
                (listener.failure)(Some(SourceFailure {
                    reason: SourceFailureReason::SourceFailed,
                    hint: None,
                }));
            }
        })
    };
    let handle = shared.runner.spawn(
        &xprop.to_string_lossy(),
        &["-root".into(), "-spy".into(), "_NET_ACTIVE_WINDOW".into()],
        &xprop_env(),
        on_line,
        on_exit,
    );
    let mut state = lock(shared);
    if state.spy == Some(id) {
        state.handle = Some(handle);
    } else {
        drop(state);
        handle.kill();
    }
}

impl FrontmostSource for LinuxSource {
    fn kind(&self) -> SourceKind {
        SourceKind::Mechanism(ActivityCaptureMechanism::LinuxXprop)
    }

    fn start(&self, listener: SourceListener) {
        lock(&self.shared).listener = Some(listener);
        launch(&self.shared);
        sync_refresh(&self.shared);
    }

    fn stop(&self) {
        {
            let mut state = lock(&self.shared);
            state.listener = None;
            state.generation += 1;
            clear_timers(&self.shared, &mut state);
        }
        kill(&self.shared);
        lock(&self.shared).active_id = None;
    }

    fn set_titles(&self, on: bool) {
        lock(&self.shared).titles = on;
        sync_refresh(&self.shared);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_active_window_id_and_0x0_as_nothing() {
        assert_eq!(
            parse_active_window_line("_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3A00007"),
            Some(Some("0x3a00007".into()))
        );
        assert_eq!(
            parse_active_window_line("_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0"),
            Some(None)
        );
        assert_eq!(parse_active_window_line("garbage"), None);
    }

    #[test]
    fn reads_wm_class_s_class_the_pid_and_the_title_decoding_octal_escapes() {
        let stdout = [
            r#"WM_CLASS(STRING) = "gnome-terminal-server", "Gnome-terminal""#,
            "_NET_WM_PID(CARDINAL) = 4321",
            r#"_NET_WM_NAME(UTF8_STRING) = "Gr\303\274\303\237e \"x\"""#,
        ]
        .join("\n");
        assert_eq!(
            parse_xprop_window(&stdout),
            Some(FrontmostTarget {
                key: "Gnome-terminal".into(),
                name: "Gnome-terminal".into(),
                pid: Some(4321),
                title: Some("Grüße \"x\"".into()),
            })
        );
    }

    #[test]
    fn answers_none_without_wm_class_and_tolerates_a_missing_pid() {
        assert_eq!(
            parse_xprop_window("WM_CLASS:  not found.\n_NET_WM_PID:  not found."),
            None
        );
        assert_eq!(
            parse_xprop_window(
                "WM_CLASS(STRING) = \"firefox\", \"firefox\"\n_NET_WM_PID:  not found."
            ),
            Some(FrontmostTarget {
                key: "firefox".into(),
                name: "firefox".into(),
                pid: None,
                title: None
            })
        );
        assert_eq!(decode_xprop_string("a\\\\b"), "a\\b");
    }

    #[cfg(unix)]
    #[test]
    fn finds_xprop_on_path_by_absolute_directory_only_and_names_the_package() {
        let is = |want: &'static str| move |file: &Path| file == Path::new(want);
        assert_eq!(
            find_on_path("xprop", Some("relative:/usr/bin"), &is("/usr/bin/xprop")),
            Some(PathBuf::from("/usr/bin/xprop"))
        );
        assert_eq!(find_on_path("xprop", Some("relative"), &|_| true), None);
        assert_eq!(xprop_package_hint(&is("/etc/debian_version")), "x11-utils");
        assert_eq!(xprop_package_hint(&is("/etc/arch-release")), "xorg-xprop");
        assert_eq!(xprop_package_hint(&|_| false), "xprop");
    }
}
