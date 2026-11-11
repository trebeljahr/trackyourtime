//! The real [`ProcessRunner`] (`process-runner.ts`): `std::process` with no
//! shell, a hidden window on Windows, no stdin and stderr thrown away.
//! Constructed only by [`crate::platform_source::create_platform_source`],
//! which the controller calls in its non-headless branch only, so a test run
//! never spawns anything. This is the one module that touches
//! `std::process` (`tests/no_spawn.rs` greps for it).

use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::source::{
    ChildHandle, ExitCallback, LineCallback, LineSplitter, ProcessRunner, RunCallback, RunResult,
    Utf8Stream, MAX_LINE_BYTES,
};

/// A one-shot helper that has not answered in this long is killed.
const RUN_TIMEOUT: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(10);

/// This process's id: the activity it must never record, and the parent the
/// Windows helper watches.
pub fn current_pid() -> u32 {
    std::process::id()
}

fn command(file: &str, args: &[String], env: &[(String, String)]) -> Command {
    let mut command = Command::new(file);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for (key, value) in env {
        command.env(key, value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Like `execFile` with `timeout` and `maxBuffer`: an exit code, or None for
/// a signal, a timeout, an overflow or a binary that would not start.
fn run_blocking(file: &str, args: &[String], env: &[(String, String)]) -> RunResult {
    let mut child = match command(file, args, env).spawn() {
        Ok(child) => child,
        Err(_) => {
            return RunResult {
                code: None,
                stdout: String::new(),
            }
        }
    };
    let overflow = Arc::new(AtomicBool::new(false));
    let reader = child.stdout.take().map(|mut stdout| {
        let overflow = overflow.clone();
        thread::spawn(move || {
            let mut collected = Vec::new();
            let mut buffer = [0u8; 8192];
            loop {
                match stdout.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        collected.extend_from_slice(&buffer[..n]);
                        if collected.len() > MAX_LINE_BYTES {
                            collected.truncate(MAX_LINE_BYTES);
                            overflow.store(true, Ordering::SeqCst);
                            break;
                        }
                    }
                }
            }
            collected
        })
    });
    let deadline = Instant::now() + RUN_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if overflow.load(Ordering::SeqCst) || Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => thread::sleep(POLL),
            Err(_) => break None,
        }
    };
    let stdout = reader.and_then(|r| r.join().ok()).unwrap_or_default();
    let code = if overflow.load(Ordering::SeqCst) {
        None
    } else {
        status.and_then(|s| s.code())
    };
    RunResult {
        code,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
    }
}

pub struct StdProcessRunner;

struct StdChild {
    child: Arc<Mutex<Child>>,
    exited: Arc<AtomicBool>,
}

impl ChildHandle for StdChild {
    fn kill(&self) {
        if !self.exited.load(Ordering::SeqCst) {
            if let Ok(mut child) = self.child.lock() {
                let _ = child.kill();
            }
        }
    }
}

struct NoChild;
impl ChildHandle for NoChild {
    fn kill(&self) {}
}

impl ProcessRunner for StdProcessRunner {
    fn run(&self, file: &str, args: &[String], env: &[(String, String)], done: RunCallback) {
        let (file, args, env) = (file.to_string(), args.to_vec(), env.to_vec());
        thread::Builder::new()
            .name("tyt-activity-run".into())
            .spawn(move || done(run_blocking(&file, &args, &env)))
            .expect("a helper thread starts");
    }

    fn spawn(
        &self,
        file: &str,
        args: &[String],
        env: &[(String, String)],
        mut on_line: LineCallback,
        on_exit: ExitCallback,
    ) -> Box<dyn ChildHandle> {
        let mut child = match command(file, args, env).spawn() {
            Ok(child) => child,
            Err(_) => {
                // A missing binary is an exit with no code, reported later,
                // never from inside the caller.
                thread::spawn(move || on_exit(None));
                return Box::new(NoChild);
            }
        };
        let stdout = child.stdout.take();
        let child = Arc::new(Mutex::new(child));
        let exited = Arc::new(AtomicBool::new(false));
        let (waiter, done) = (child.clone(), exited.clone());
        thread::Builder::new()
            .name("tyt-activity-child".into())
            .spawn(move || {
                if let Some(mut stdout) = stdout {
                    let mut text = Utf8Stream::default();
                    let mut lines = LineSplitter::new();
                    let mut buffer = [0u8; 8192];
                    loop {
                        match stdout.read(&mut buffer) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                let chunk = text.push(&buffer[..n]);
                                lines.push(&chunk, &mut |line| on_line(line));
                            }
                        }
                    }
                }
                let code = loop {
                    let status = waiter.lock().map(|mut child| child.try_wait());
                    match status {
                        Ok(Ok(Some(status))) => break status.code(),
                        Ok(Ok(None)) => thread::sleep(Duration::from_millis(20)),
                        _ => break None,
                    }
                };
                done.store(true, Ordering::SeqCst);
                on_exit(code);
            })
            .expect("a reader thread starts");
        Box::new(StdChild { child, exited })
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn runs_a_command_and_reports_its_exit_code() {
        let (tx, rx) = mpsc::channel();
        StdProcessRunner.run(
            "/bin/sh",
            &["-c".into(), "printf 'a\\nb'; exit 3".into()],
            &[],
            Box::new(move |r| tx.send(r).unwrap()),
        );
        let result = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(
            result,
            RunResult {
                code: Some(3),
                stdout: "a\nb".into()
            }
        );
    }

    #[test]
    fn a_missing_binary_answers_no_code() {
        let (tx, rx) = mpsc::channel();
        StdProcessRunner.run(
            "/nonexistent-tyt-binary",
            &[],
            &[],
            Box::new(move |r| tx.send(r).unwrap()),
        );
        assert_eq!(rx.recv_timeout(Duration::from_secs(10)).unwrap().code, None);
    }

    #[test]
    fn spawns_streams_lines_and_reports_a_kill_as_an_exit() {
        let (lines_tx, lines_rx) = mpsc::channel();
        let (exit_tx, exit_rx) = mpsc::channel();
        let child = StdProcessRunner.spawn(
            "/bin/sh",
            &["-c".into(), "echo one; echo two; exec sleep 30".into()],
            &[],
            Box::new(move |line| lines_tx.send(line).unwrap()),
            Box::new(move |code| exit_tx.send(code).unwrap()),
        );
        assert_eq!(
            lines_rx.recv_timeout(Duration::from_secs(10)).unwrap(),
            "one"
        );
        assert_eq!(
            lines_rx.recv_timeout(Duration::from_secs(10)).unwrap(),
            "two"
        );
        child.kill();
        assert_eq!(exit_rx.recv_timeout(Duration::from_secs(10)).unwrap(), None);
    }
}
