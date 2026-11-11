//! `sources.test.ts` and `macos-titles.test.ts`: the platform sources against
//! a fake runner and fake timers, so no test spawns anything or waits.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use crate::keys::FrontmostTarget;
use crate::macos_titles::MacosTitleReader;
use crate::source::{
    ChildHandle, ExitCallback, FrontmostSource, LineCallback, ProcessRunner, RunCallback,
    RunResult, SourceFailure, SourceFailureReason, SourceListener, RETRY_AFTER_MS,
};
use crate::source_linux::LinuxSource;
use crate::source_macos::{MacosSource, TitleReader, LSAPPINFO};
use crate::source_windows::{WindowsSource, WINDOWS_WATCHDOG_MS};
use crate::timers::FakeTimers;

// ── fakes ─────────────────────────────────────────────────────────────

type Answer = Box<dyn FnMut(&str, &[String]) -> Option<RunResult> + Send>;

struct FakeChild {
    file: String,
    args: Vec<String>,
    killed: AtomicBool,
    on_line: Mutex<Option<LineCallback>>,
    on_exit: Mutex<Option<ExitCallback>>,
}

impl FakeChild {
    fn emit_line(&self, line: &str) {
        let callback = self.on_line.lock().unwrap().take();
        if let Some(mut callback) = callback {
            callback(line.to_string());
            *self.on_line.lock().unwrap() = Some(callback);
        }
    }
    fn exit(&self, code: Option<i32>) {
        let callback = self.on_exit.lock().unwrap().take();
        if let Some(callback) = callback {
            callback(code);
        }
    }
    fn killed(&self) -> bool {
        self.killed.load(Ordering::SeqCst)
    }
}

struct Handle(Arc<FakeChild>);
impl ChildHandle for Handle {
    fn kill(&self) {
        self.0.killed.store(true, Ordering::SeqCst);
        self.0.exit(None);
    }
}

struct FakeRunner {
    /// None defers the answer: the test finishes it through `deferred`.
    answer: Mutex<Answer>,
    runs: Mutex<Vec<Vec<String>>>,
    deferred: Mutex<Vec<RunCallback>>,
    children: Mutex<Vec<Arc<FakeChild>>>,
}

impl FakeRunner {
    fn new(answer: impl FnMut(&str, &[String]) -> Option<RunResult> + Send + 'static) -> Arc<Self> {
        Arc::new(FakeRunner {
            answer: Mutex::new(Box::new(answer)),
            runs: Mutex::new(Vec::new()),
            deferred: Mutex::new(Vec::new()),
            children: Mutex::new(Vec::new()),
        })
    }
    fn runs(&self) -> Vec<Vec<String>> {
        self.runs.lock().unwrap().clone()
    }
    fn child(&self, index: usize) -> Arc<FakeChild> {
        self.children.lock().unwrap()[index].clone()
    }
    fn child_count(&self) -> usize {
        self.children.lock().unwrap().len()
    }
}

impl ProcessRunner for FakeRunner {
    fn run(&self, file: &str, args: &[String], _env: &[(String, String)], done: RunCallback) {
        let mut run = vec![file.to_string()];
        run.extend(args.iter().cloned());
        self.runs.lock().unwrap().push(run);
        let answer = (self.answer.lock().unwrap())(file, args);
        match answer {
            Some(result) => done(result),
            None => self.deferred.lock().unwrap().push(done),
        }
    }

    fn spawn(
        &self,
        file: &str,
        args: &[String],
        _env: &[(String, String)],
        on_line: LineCallback,
        on_exit: ExitCallback,
    ) -> Box<dyn ChildHandle> {
        let child = Arc::new(FakeChild {
            file: file.to_string(),
            args: args.to_vec(),
            killed: AtomicBool::new(false),
            on_line: Mutex::new(Some(on_line)),
            on_exit: Mutex::new(Some(on_exit)),
        });
        self.children.lock().unwrap().push(child.clone());
        Box::new(Handle(child))
    }
}

fn ok(stdout: &str) -> Option<RunResult> {
    Some(RunResult {
        code: Some(0),
        stdout: stdout.to_string(),
    })
}

#[derive(Clone, Default)]
struct Recorder {
    targets: Arc<Mutex<Vec<Option<FrontmostTarget>>>>,
    failures: Arc<Mutex<Vec<Option<SourceFailure>>>>,
}

impl Recorder {
    fn listener(&self) -> SourceListener {
        let (targets, failures) = (self.targets.clone(), self.failures.clone());
        SourceListener {
            target: Arc::new(move |t| targets.lock().unwrap().push(t)),
            failure: Arc::new(move |f| failures.lock().unwrap().push(f)),
        }
    }
    fn targets(&self) -> Vec<Option<FrontmostTarget>> {
        self.targets.lock().unwrap().clone()
    }
    fn failures(&self) -> Vec<Option<SourceFailure>> {
        self.failures.lock().unwrap().clone()
    }
    fn last_failure(&self) -> Option<Option<SourceFailure>> {
        self.failures().last().cloned()
    }
}

fn source_failed() -> Option<SourceFailure> {
    Some(SourceFailure {
        reason: SourceFailureReason::SourceFailed,
        hint: None,
    })
}

// ── macOS ─────────────────────────────────────────────────────────────

#[test]
fn macos_polls_front_and_asks_info_only_when_the_asn_changes() {
    let asn = Arc::new(Mutex::new("ASN:0x0-0x1:".to_string()));
    let current = asn.clone();
    let runner = FakeRunner::new(move |_file, args| {
        if args[0] == "front" {
            ok(&format!("{}\n", current.lock().unwrap()))
        } else {
            ok(&format!(
                "\"CFBundleIdentifier\"=\"app.{}\"\n\"LSDisplayName\"=\"App\"\n\"pid\"=5\n",
                args.last().unwrap()
            ))
        }
    });
    let timers = FakeTimers::new();
    let source = MacosSource::new(runner.clone(), timers.clone(), None);
    let listener = Recorder::default();
    source.start(listener.listener());
    timers.advance(5_000.0);
    *asn.lock().unwrap() = "ASN:0x0-0x2:".into();
    timers.advance(5_000.0);
    let runs = runner.runs();
    assert!(runs.iter().all(|run| run[0] == LSAPPINFO));
    let info: Vec<&Vec<String>> = runs.iter().filter(|run| run[1] == "info").collect();
    assert_eq!(info.len(), 2);
    assert!(info.iter().all(|run| run.contains(&"-long".to_string())));
    assert_eq!(
        listener
            .targets()
            .iter()
            .map(|t| t.as_ref().unwrap().key.clone())
            .collect::<Vec<_>>(),
        ["app.ASN:0x0-0x1:", "app.ASN:0x0-0x1:", "app.ASN:0x0-0x2:"]
    );
    source.stop();
    let before = runner.runs().len();
    timers.advance(60_000.0);
    assert_eq!(runner.runs().len(), before);
}

type TitleDone = Box<dyn FnOnce(Option<String>) + Send>;

struct FakeTitles {
    reads: AtomicUsize,
    pending: Mutex<Option<TitleDone>>,
}

impl TitleReader for FakeTitles {
    fn read(&self, _pid: i64, done: Box<dyn FnOnce(Option<String>) + Send>) {
        let reads = self.reads.fetch_add(1, Ordering::SeqCst) + 1;
        if reads == 3 {
            *self.pending.lock().unwrap() = Some(done);
            return;
        }
        done(Some(format!("Document {reads}")));
    }
}

#[test]
fn macos_refreshes_titles_in_the_same_app_and_drops_a_result_after_titles_are_disabled() {
    let runner = FakeRunner::new(|_file, args| {
        if args[0] == "front" {
            ok("ASN:0x0-0x1:")
        } else {
            ok("\"CFBundleIdentifier\"=\"editor\"\n\"LSDisplayName\"=\"Editor\"\n\"pid\"=5\n")
        }
    });
    let timers = FakeTimers::new();
    let titles = Arc::new(FakeTitles {
        reads: AtomicUsize::new(0),
        pending: Mutex::new(None),
    });
    let source = MacosSource::new(runner.clone(), timers.clone(), Some(titles.clone()));
    let listener = Recorder::default();
    source.start(listener.listener());
    assert_eq!(titles.reads.load(Ordering::SeqCst), 0);
    let last_title = || {
        listener
            .targets()
            .last()
            .cloned()
            .flatten()
            .and_then(|t| t.title)
    };
    source.set_titles(true);
    timers.advance(5_000.0);
    assert_eq!(last_title().as_deref(), Some("Document 1"));
    timers.advance(5_000.0);
    assert_eq!(last_title().as_deref(), Some("Document 2"));
    timers.advance(5_000.0);
    source.set_titles(false);
    let finish = titles
        .pending
        .lock()
        .unwrap()
        .take()
        .expect("the third read is pending");
    finish(Some("Must not be recorded".into()));
    assert_eq!(last_title(), None);
    timers.advance(5_000.0);
    assert_eq!(titles.reads.load(Ordering::SeqCst), 3);
    assert_eq!(
        runner.runs().iter().filter(|run| run[1] == "info").count(),
        1
    );
    source.stop();
}

#[test]
fn macos_gives_up_after_three_failures_and_retries_five_minutes_later() {
    let broken = Arc::new(AtomicBool::new(true));
    let flag = broken.clone();
    let runner = FakeRunner::new(move |_file, args| {
        if flag.load(Ordering::SeqCst) {
            Some(RunResult {
                code: Some(1),
                stdout: String::new(),
            })
        } else if args[0] == "front" {
            ok("ASN:0x0-0x1:")
        } else {
            ok("\"CFBundleIdentifier\"=\"a.b\"\n\"LSDisplayName\"=\"AB\"\n")
        }
    });
    let timers = FakeTimers::new();
    let source = MacosSource::new(runner.clone(), timers.clone(), None);
    let listener = Recorder::default();
    source.start(listener.listener());
    for _ in 0..3 {
        timers.advance(5_000.0);
    }
    assert_eq!(listener.last_failure(), Some(source_failed()));
    let runs_at_give_up = runner.runs().len();
    timers.advance(RETRY_AFTER_MS - 10_000.0);
    assert_eq!(runner.runs().len(), runs_at_give_up);
    broken.store(false, Ordering::SeqCst);
    timers.advance(10_000.0);
    assert_eq!(listener.last_failure(), Some(None));
    assert_eq!(
        listener
            .targets()
            .last()
            .cloned()
            .flatten()
            .map(|t| t.key)
            .as_deref(),
        Some("a.b")
    );
}

#[test]
fn macos_does_not_treat_the_native_no_frontmost_app_marker_as_a_helper_failure() {
    let runner = FakeRunner::new(|_, _| ok("[ NULL ] \n"));
    let timers = FakeTimers::new();
    let source = MacosSource::new(runner.clone(), timers.clone(), None);
    let listener = Recorder::default();
    source.start(listener.listener());
    for _ in 0..4 {
        timers.advance(5_000.0);
    }
    assert!(listener.failures().iter().all(Option::is_none));
    assert_eq!(listener.targets().last(), Some(&None));
    assert!(runner.runs().len() >= 5);
    source.stop();
}

#[test]
fn macos_drops_a_read_that_finishes_after_capture_was_stopped_and_restarted() {
    let runner = FakeRunner::new(|_, _| None);
    let timers = FakeTimers::new();
    let source = MacosSource::new(runner.clone(), timers.clone(), None);
    let (previous, next) = (Recorder::default(), Recorder::default());
    source.start(previous.listener());
    source.stop();
    source.start(next.listener());
    let finish = runner.deferred.lock().unwrap().remove(0);
    finish(RunResult {
        code: Some(0),
        stdout: "[ NULL ]".into(),
    });
    assert!(previous.targets().is_empty());
    assert!(next.targets().is_empty());
    source.stop();
}

// ── macOS titles ──────────────────────────────────────────────────────

#[test]
fn never_runs_a_title_reader_without_permission_and_discards_a_revoked_read() {
    let permitted = Arc::new(AtomicBool::new(false));
    let revoke = permitted.clone();
    let runner = FakeRunner::new(move |_, _| {
        revoke.store(false, Ordering::SeqCst);
        ok("\"synthetic title\"")
    });
    let gate = permitted.clone();
    let reader = MacosTitleReader::new(
        runner.clone(),
        Arc::new(move || gate.load(Ordering::SeqCst)),
    );
    let read = |pid: i64| {
        let answer = Arc::new(Mutex::new(Some(String::from("unset"))));
        let slot = answer.clone();
        reader.read(pid, Box::new(move |title| *slot.lock().unwrap() = title));
        let value = answer.lock().unwrap().clone();
        value
    };
    assert_eq!(read(123), None);
    assert_eq!(runner.runs().len(), 0);
    permitted.store(true, Ordering::SeqCst);
    assert_eq!(read(123), None);
    assert_eq!(runner.runs().len(), 1);
}

#[test]
fn accepts_only_a_bounded_json_title_from_the_metadata_reader() {
    let stdout = Arc::new(Mutex::new("\"synthetic title\"".to_string()));
    let current = stdout.clone();
    let runner = FakeRunner::new(move |_, _| ok(&current.lock().unwrap()));
    let reader = MacosTitleReader::new(runner, Arc::new(|| true));
    let read = |pid: i64| {
        let answer = Arc::new(Mutex::new(None));
        let slot = answer.clone();
        reader.read(pid, Box::new(move |title| *slot.lock().unwrap() = title));
        let value = answer.lock().unwrap().clone();
        value
    };
    assert_eq!(read(42).as_deref(), Some("synthetic title"));
    *stdout.lock().unwrap() = "invalid output".into();
    assert_eq!(read(42), None);
    assert_eq!(read(-1), None);
}

// ── Windows ───────────────────────────────────────────────────────────

fn windows() -> (Arc<FakeRunner>, Arc<FakeTimers>, Recorder, WindowsSource) {
    let runner = FakeRunner::new(|_, _| ok(""));
    let timers = FakeTimers::new();
    let env: HashMap<String, String> = [("SystemRoot".to_string(), "C:\\Windows".to_string())]
        .into_iter()
        .collect();
    let source = WindowsSource::new(runner.clone(), timers.clone(), env, 9);
    let listener = Recorder::default();
    source.start(listener.listener());
    (runner, timers, listener, source)
}

#[test]
fn windows_spawns_one_absolute_powershell_with_no_profile_and_an_encoded_command() {
    let (runner, _timers, listener, _source) = windows();
    let child = runner.child(0);
    assert_eq!(
        child.file,
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    );
    assert_eq!(
        child.args[..4],
        [
            "-NoProfile",
            "-NonInteractive",
            "-NoLogo",
            "-EncodedCommand"
        ]
    );
    child.emit_line(r#"{"key":"code.exe","name":"Code","pid":1}"#);
    child.emit_line(r#"{"alive":true}"#);
    child.emit_line(r#"{"none":true}"#);
    assert_eq!(
        listener
            .targets()
            .iter()
            .map(|t| t.as_ref().map(|t| t.key.clone()))
            .collect::<Vec<_>>(),
        [
            Some("code.exe".to_string()),
            Some("code.exe".to_string()),
            None
        ]
    );
}

#[test]
fn windows_reports_constrained_language_mode_as_blocked_by_policy_and_does_not_retry() {
    let (runner, timers, listener, _source) = windows();
    runner
        .child(0)
        .emit_line(r#"{"error":"constrained-language"}"#);
    assert_eq!(
        listener.last_failure(),
        Some(Some(SourceFailure {
            reason: SourceFailureReason::BlockedByPolicy,
            hint: None
        }))
    );
    timers.advance(60.0 * 60_000.0);
    assert_eq!(runner.child_count(), 1);
}

#[test]
fn windows_respawns_a_silent_helper_and_gives_up_after_three_failures() {
    let (runner, timers, listener, _source) = windows();
    timers.advance(WINDOWS_WATCHDOG_MS);
    assert!(runner.child(0).killed());
    assert_eq!(runner.child_count(), 2);
    runner.child(1).exit(Some(1));
    assert_eq!(runner.child_count(), 3);
    runner.child(2).exit(Some(1));
    assert_eq!(listener.last_failure(), Some(source_failed()));
    assert_eq!(runner.child_count(), 3);
    timers.advance(RETRY_AFTER_MS);
    assert_eq!(runner.child_count(), 4);
}

#[test]
fn windows_restarts_the_helper_when_titles_are_toggled_and_kills_it_on_stop() {
    let (runner, _timers, _listener, source) = windows();
    source.set_titles(true);
    assert_eq!(runner.child_count(), 2);
    assert!(runner.child(0).killed());
    source.stop();
    assert!(runner.child(1).killed());
}

// ── Linux ─────────────────────────────────────────────────────────────

#[test]
fn linux_reports_tool_missing_without_spawning_when_xprop_is_not_on_path() {
    let runner = FakeRunner::new(|_, _| ok(""));
    let env: HashMap<String, String> = [("PATH".to_string(), "/nonexistent-tyt-dir".to_string())]
        .into_iter()
        .collect();
    let source = LinuxSource::new(runner.clone(), FakeTimers::new(), env);
    let listener = Recorder::default();
    source.start(listener.listener());
    assert_eq!(runner.child_count(), 0);
    assert_eq!(
        listener.last_failure().flatten().map(|f| f.reason),
        Some(SourceFailureReason::ToolMissing)
    );
}

#[cfg(unix)]
#[test]
fn linux_follows_the_spy_and_describes_each_window() {
    let dir = tempfile::tempdir().unwrap();
    let xprop = dir.path().join("xprop");
    std::fs::write(&xprop, "#!/bin/sh\n").unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&xprop, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let runner = FakeRunner::new(|_, args| {
        assert_eq!(args[0], "-id");
        ok("WM_CLASS(STRING) = \"code\", \"Code\"\n_NET_WM_PID(CARDINAL) = 7\n_NET_WM_NAME(UTF8_STRING) = \"main.rs\"")
    });
    let env: HashMap<String, String> = [(
        "PATH".to_string(),
        dir.path().to_string_lossy().into_owned(),
    )]
    .into_iter()
    .collect();
    let timers = FakeTimers::new();
    let source = LinuxSource::new(runner.clone(), timers.clone(), env);
    let listener = Recorder::default();
    source.start(listener.listener());
    let spy = runner.child(0);
    assert_eq!(spy.args, ["-root", "-spy", "_NET_ACTIVE_WINDOW"]);
    spy.emit_line("_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3a00007");
    // Titles off: the title is never asked for, and never kept.
    assert_eq!(runner.runs()[0].len(), 5);
    assert_eq!(
        listener.targets().last().cloned().flatten(),
        Some(FrontmostTarget {
            key: "Code".into(),
            name: "Code".into(),
            pid: Some(7),
            title: None
        })
    );
    source.set_titles(true);
    timers.advance(5_000.0);
    assert_eq!(
        listener
            .targets()
            .last()
            .cloned()
            .flatten()
            .and_then(|t| t.title)
            .as_deref(),
        Some("main.rs")
    );
    spy.emit_line("_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0");
    assert_eq!(listener.targets().last(), Some(&None));
    // The spy dying is restarted; three deaths in ten minutes give up.
    spy.exit(Some(1));
    assert_eq!(runner.child_count(), 2);
    runner.child(1).exit(Some(1));
    runner.child(2).exit(Some(1));
    assert_eq!(listener.last_failure(), Some(source_failed()));
    timers.advance(RETRY_AFTER_MS);
    assert_eq!(runner.child_count(), 4);
    source.stop();
    assert!(runner.child(3).killed());
}

/// Opt-in, never in CI: the parsers against a real `lsappinfo` on this Mac.
/// Read-only and prompt-free, but it does read the real frontmost app,
/// which is why it is off unless asked for.
#[cfg(target_os = "macos")]
#[test]
fn real_lsappinfo_parses_what_this_mac_answers() {
    if std::env::var("TRACKYOURTIME_ACTIVITY_REAL_SOURCE_TEST").as_deref() != Ok("1") {
        return;
    }
    use crate::process_runner::StdProcessRunner;
    use crate::source_macos::{parse_lsappinfo_front, parse_lsappinfo_info};
    let (tx, rx) = std::sync::mpsc::channel();
    let send = tx.clone();
    StdProcessRunner.run(
        LSAPPINFO,
        &["front".into()],
        &[],
        Box::new(move |r| send.send(r).unwrap()),
    );
    let front = rx.recv().unwrap();
    let asn = parse_lsappinfo_front(&front.stdout).expect("an ASN");
    let args: Vec<String> = [
        "info", "-long", "-only", "bundleid", "-only", "name", "-only", "pid", &asn,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    StdProcessRunner.run(
        LSAPPINFO,
        &args,
        &[],
        Box::new(move |r| tx.send(r).unwrap()),
    );
    let info = rx.recv().unwrap();
    assert!(
        parse_lsappinfo_info(&info.stdout).is_some_and(|t| !t.key.is_empty()),
        "{}",
        info.stdout
    );
}
