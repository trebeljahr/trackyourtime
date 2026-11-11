//! Idle detection, the pure half of `electron/src/idle.ts`.
//!
//! The renderer cannot see this. A browser tab only knows about input that
//! reaches it, so a person typing all afternoon in their editor looks idle to
//! the web app; the OS idle counter counts every application. The shell
//! therefore does the *detecting* and the renderer does the *deciding* — the
//! policy lives in @starter/core/idle, shared with the browser extension.
//!
//! Nothing here pauses anything: it reports "the machine has seen no input
//! for N seconds" and lets the renderer apply the person's settings to that.
//! The shell reads the counter (`user-idle` or the OS call), feeds lock,
//! suspend, unlock and resume events into [`IdleTracker`], polls every
//! [`IDLE_POLL_MS`], and broadcasts each sample as `idle:state` and to the
//! activity capturer.

use serde::{Deserialize, Serialize};
use tyt_wire::DesktopIdlePayload;

/// How often the idle counter is sampled. Cheap; the call is a syscall.
pub const IDLE_POLL_MS: u64 = 15_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IdleState {
    Active,
    Idle,
    Locked,
}

impl IdleState {
    pub fn as_str(self) -> &'static str {
        match self {
            IdleState::Active => "active",
            IdleState::Idle => "idle",
            IdleState::Locked => "locked",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleSample {
    pub state: IdleState,
    pub idle_seconds: u64,
}

impl IdleSample {
    pub fn payload(self) -> DesktopIdlePayload {
        DesktopIdlePayload {
            state: self.state.as_str().to_string(),
            idle_seconds: self.idle_seconds,
        }
    }
}

/// The state for an idle counter reading.
///
/// "Active" means input landed inside the last polling window, not that the
/// counter reads exactly zero. The OS counter returns 0 only in the second
/// after a keystroke, so a poller testing for zero would report "idle" at
/// someone typing continuously — and the renderer would never see the sign of
/// life that reopens a paused entry. A locked screen is sticky until it
/// unlocks: the idle counter does not report it.
pub fn idle_state(idle_seconds: u64, screen_locked: bool) -> IdleState {
    if screen_locked {
        IdleState::Locked
    } else if idle_seconds.saturating_mul(1000) >= IDLE_POLL_MS {
        IdleState::Idle
    } else {
        IdleState::Active
    }
}

/// The lock flag between samples. `lock-screen` and `suspend` are the
/// deliberate walk-aways; the shell broadcasts a sample right after each
/// event rather than waiting for the next poll, because the renderer may
/// treat a lock as away without the threshold.
#[derive(Debug, Default, Clone, Copy)]
pub struct IdleTracker {
    screen_locked: bool,
}

impl IdleTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Screen locked or the machine suspended.
    pub fn lock(&mut self) {
        self.screen_locked = true;
    }

    /// Screen unlocked or the machine resumed.
    pub fn unlock(&mut self) {
        self.screen_locked = false;
    }

    pub fn is_locked(&self) -> bool {
        self.screen_locked
    }

    /// A sample for a counter reading (seconds since the last input anywhere).
    pub fn sample(&self, idle_seconds: u64) -> IdleSample {
        IdleSample {
            state: idle_state(idle_seconds, self.screen_locked),
            idle_seconds,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_inside_the_polling_window_idle_from_it() {
        assert_eq!(idle_state(0, false), IdleState::Active);
        assert_eq!(idle_state(14, false), IdleState::Active);
        assert_eq!(idle_state(15, false), IdleState::Idle);
        assert_eq!(idle_state(3600, false), IdleState::Idle);
    }

    #[test]
    fn a_lock_is_sticky_until_unlocked() {
        let mut tracker = IdleTracker::new();
        tracker.lock();
        assert_eq!(tracker.sample(0).state, IdleState::Locked);
        tracker.unlock();
        assert_eq!(tracker.sample(0).state, IdleState::Active);
    }

    #[test]
    fn payload_matches_the_wire() {
        let payload = IdleTracker::new().sample(20).payload();
        assert_eq!(
            serde_json::to_value(payload).unwrap(),
            serde_json::json!({"state": "idle", "idleSeconds": 20})
        );
    }
}
