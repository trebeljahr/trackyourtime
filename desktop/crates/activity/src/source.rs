//! What is in front of the person, per OS, behind one interface (`source.ts`).
//!
//! A source reports the frontmost application ([`FrontmostTarget`]) or None
//! when nothing recordable is in front, and a failure when it cannot answer
//! at all. It never decides anything: exclusion, titles, idleness and the
//! segment lifecycle are [`crate::model`].
//!
//! No native module, no OS prompt, on any OS:
//!
//! - macOS: `/usr/bin/lsappinfo`, polled ([`crate::source_macos`]). No Screen
//!   Recording, Accessibility or Automation permission, so no prompt.
//! - Windows: one long-lived `powershell.exe` with an embedded script
//!   ([`crate::source_windows`]).
//! - Linux X11: `xprop -spy` ([`crate::source_linux`]).
//!
//! Headless runs (tests, agents) use [`crate::source_fake`] and nothing else:
//! no child process, no timer, and the machine owner's real frontmost app is
//! never read. Spawning goes through a [`ProcessRunner`], so the platform
//! sources are unit-tested with a fake one.
//!
//! Every callback here may be called from another thread. A source never
//! calls its runner, its timers or its listener while it holds its own lock:
//! a fake runner answers synchronously, and a fake child's `kill` reports the
//! exit synchronously, exactly as the TypeScript fakes did.

use std::sync::Arc;

use crate::distribution::ActivityCaptureMechanism;
use crate::keys::FrontmostTarget;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    Fake,
    Mechanism(ActivityCaptureMechanism),
}

impl SourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SourceKind::Fake => "fake",
            SourceKind::Mechanism(mechanism) => mechanism.as_str(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceFailureReason {
    ToolMissing,
    BlockedByPolicy,
    SourceFailed,
}

impl SourceFailureReason {
    pub fn wire(self) -> tyt_wire::DesktopActivityUnavailableReason {
        use tyt_wire::DesktopActivityUnavailableReason as R;
        match self {
            SourceFailureReason::ToolMissing => R::ToolMissing,
            SourceFailureReason::BlockedByPolicy => R::BlockedByPolicy,
            SourceFailureReason::SourceFailed => R::SourceFailed,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceFailure {
    pub reason: SourceFailureReason,
    /// A package or tool name for `tool-missing`; never prose.
    pub hint: Option<String>,
}

pub type TargetCallback = Arc<dyn Fn(Option<FrontmostTarget>) + Send + Sync>;
pub type FailureCallback = Arc<dyn Fn(Option<SourceFailure>) + Send + Sync>;

#[derive(Clone)]
pub struct SourceListener {
    /// What is in front now. Sources may repeat the same answer; that keeps a segment alive.
    pub target: TargetCallback,
    /// A failure, or None once the source answers again.
    pub failure: FailureCallback,
}

pub trait FrontmostSource: Send + Sync {
    fn kind(&self) -> SourceKind;
    fn start(&self, listener: SourceListener);
    /// Stops polling and kills any child process. Idempotent.
    fn stop(&self);
    /// Titles on or off. Where a helper bakes it in, it is restarted.
    fn set_titles(&self, on: bool);
}

// ── processes ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunResult {
    pub code: Option<i32>,
    pub stdout: String,
}

pub trait ChildHandle: Send + Sync {
    fn kill(&self);
}

pub type RunCallback = Box<dyn FnOnce(RunResult) + Send>;
pub type LineCallback = Box<dyn FnMut(String) + Send>;
pub type ExitCallback = Box<dyn FnOnce(Option<i32>) + Send>;

/// Every child process a source starts. Absolute paths, fixed argv, never a
/// shell: the controller builds the real one from [`crate::process_runner`]
/// in the non-headless branch only.
pub trait ProcessRunner: Send + Sync {
    /// Run to completion; `done` is called once, from any thread.
    fn run(&self, file: &str, args: &[String], env: &[(String, String)], done: RunCallback);
    /// A long-lived child. Lines and the exit arrive on the callbacks, from
    /// any thread; a binary that cannot start reports an exit with no code.
    fn spawn(
        &self,
        file: &str,
        args: &[String],
        env: &[(String, String)],
        on_line: LineCallback,
        on_exit: ExitCallback,
    ) -> Box<dyn ChildHandle>;
}

// ── restart policy ────────────────────────────────────────────────────

/// Three failures inside this window and the source gives up for a while.
pub const FAILURE_WINDOW_MS: f64 = 10.0 * 60_000.0;
pub const MAX_FAILURES: usize = 3;
/// How long a source that gave up waits before trying again.
pub const RETRY_AFTER_MS: f64 = 5.0 * 60_000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyAnswer {
    Restart,
    GiveUp,
}

#[derive(Debug, Default, Clone)]
pub struct RestartPolicy {
    failures: Vec<f64>,
}

impl RestartPolicy {
    /// Record a failure; answers whether to retry at once or give up for [`RETRY_AFTER_MS`].
    pub fn fail(&mut self, at: f64) -> PolicyAnswer {
        self.failures.retain(|t| at - t < FAILURE_WINDOW_MS);
        self.failures.push(at);
        if self.failures.len() >= MAX_FAILURES {
            self.failures.clear();
            return PolicyAnswer::GiveUp;
        }
        PolicyAnswer::Restart
    }

    /// A good answer arrived.
    pub fn succeed(&mut self) {
        self.failures.clear();
    }
}

/// The longest stdout line a source accepts; anything longer is not the tool talking.
pub const MAX_LINE_BYTES: usize = 64 * 1024;

/// Splits a text stream into lines, dropping over-long ones (`createLineSplitter`).
pub struct LineSplitter {
    buffer: String,
    discarding: bool,
}

impl Default for LineSplitter {
    fn default() -> Self {
        Self::new()
    }
}

impl LineSplitter {
    pub fn new() -> Self {
        LineSplitter {
            buffer: String::new(),
            discarding: false,
        }
    }

    pub fn push(&mut self, chunk: &str, on_line: &mut dyn FnMut(String)) {
        self.buffer.push_str(chunk);
        while let Some(newline) = self.buffer.find('\n') {
            let mut line: String = self.buffer[..newline].to_string();
            self.buffer.drain(..=newline);
            if line.ends_with('\r') {
                line.pop();
            }
            if !self.discarding {
                on_line(line);
            }
            self.discarding = false;
        }
        if crate::js::utf16_len(&self.buffer) > MAX_LINE_BYTES {
            self.buffer.clear();
            self.discarding = true;
        }
    }
}

/// Bytes to text across read boundaries, like Node's `setEncoding("utf8")`:
/// a multi-byte character split between two reads is kept whole, and
/// invalid bytes become U+FFFD.
#[derive(Default)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    out.push_str(text);
                    self.pending.clear();
                    return out;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    out.push_str(
                        std::str::from_utf8(&self.pending[..valid]).expect("valid prefix"),
                    );
                    match error.error_len() {
                        Some(bad) => {
                            out.push('\u{FFFD}');
                            self.pending.drain(..valid + bad);
                        }
                        None => {
                            self.pending.drain(..valid);
                            return out;
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_chunks_and_drops_an_over_long_line() {
        let mut lines = Vec::new();
        let mut split = LineSplitter::new();
        let mut push = |chunk: &str| split.push(chunk, &mut |line| lines.push(line));
        push("a\r\nb");
        push("c\n");
        push(&"x".repeat(70_000));
        push("tail\nnext\n");
        assert_eq!(lines, ["a", "bc", "next"]);
    }

    #[test]
    fn keeps_a_character_split_across_reads() {
        let mut stream = Utf8Stream::default();
        let bytes = "Grüße".as_bytes();
        let first = stream.push(&bytes[..3]);
        let rest = stream.push(&bytes[3..]);
        assert_eq!(first + &rest, "Grüße");
        assert_eq!(stream.push(&[0xff, b'a']), "\u{FFFD}a");
    }

    #[test]
    fn the_policy_gives_up_after_three_failures_in_ten_minutes() {
        let mut policy = RestartPolicy::default();
        assert_eq!(policy.fail(0.0), PolicyAnswer::Restart);
        assert_eq!(policy.fail(1.0), PolicyAnswer::Restart);
        assert_eq!(policy.fail(2.0), PolicyAnswer::GiveUp);
        assert_eq!(policy.fail(3.0), PolicyAnswer::Restart);
        assert_eq!(policy.fail(FAILURE_WINDOW_MS + 4.0), PolicyAnswer::Restart);
        policy.succeed();
        assert_eq!(policy.fail(0.0), PolicyAnswer::Restart);
    }
}
