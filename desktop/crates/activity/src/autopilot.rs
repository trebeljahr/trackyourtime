//! Autopilot, in the shell: the memory around core's `decide_autopilot`
//! (`electron/src/activity/autopilot.ts`).
//!
//! Core decides from one moment's facts. What has to be remembered between
//! moments lives here:
//!
//! - **Which timer is Autopilot's.** A write is only counted once the
//!   renderer reports it made (`applied`), and the running entry stays
//!   Autopilot's only while its start and filing are exactly what was
//!   written. An edit, a stop or a new start by hand makes it the person's,
//!   for good.
//! - **What the person said no to.** A timer stopped or replaced by hand, an
//!   Undo, or "not work" puts that filing (or app) on hold until the next
//!   break of [`HOLD_BREAK_MS`] — so a stopped timer does not come straight back.
//! - **What was learned** from the person's own entries, per scope.
//! - **What it did**, as a short log for the screen.
//! - **A pause** of [`AUTOPILOT_PAUSE_MS`] the person asked for (the tray,
//!   the strip, the Activity screen). It belongs to the account, so a
//!   workspace switch keeps it and a sign-out ends it, and it is persisted so
//!   a restart keeps it until it runs out.
//!
//! No file access: the service hands everything in and persists `owned` and
//! the pause through an [`AutopilotSink`] (the store).

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use tyt_wire::{
    DesktopActivityApp, DesktopActivitySettings, DesktopAutopilotAction,
    DesktopAutopilotHistoryEntry, DesktopAutopilotLogEntry, DesktopAutopilotOwned,
    DesktopAutopilotPlan, DesktopAutopilotRunning, DesktopAutopilotState, DesktopAutopilotWatch,
    DesktopFilingVia,
};

use crate::core::{
    app_hold_key, decide_autopilot, filing_key_of, had_break_since, learn_filings,
    ActivityInterval, ActivityRule, ActivitySegment, AutopilotDecision, AutopilotFiling,
    AutopilotInput, AutopilotOptionsPatch, AutopilotRunning, FilingResolver, LearnFilingsOptions,
    DEFAULT_AUTOPILOT_OPTIONS,
};
use crate::js;

const MINUTE_MS: f64 = 60_000.0;

/// A hold ends at the first stretch this long with no activity at all.
pub const HOLD_BREAK_MS: f64 = 10.0 * MINUTE_MS;
/// …or after this long, whatever happened.
pub const HOLD_MAX_MS: f64 = 4.0 * 60.0 * MINUTE_MS;
/// How long the renderer's running entry may lag a write it reported made.
pub const SETTLE_MS: f64 = 30_000.0;
/// A plan not reported back within this long is forgotten.
pub const PENDING_TTL_MS: f64 = 60_000.0;
/// Two starts this close are one start (the server keeps milliseconds; be lenient).
pub const SAME_START_MS: f64 = 1_000.0;
pub const LOG_MAX: usize = 30;
pub const LOG_TTL_MS: f64 = 24.0 * 60.0 * MINUTE_MS;
/// How much activity a decision reads back.
pub const AUTOPILOT_WINDOW_MS: f64 = DEFAULT_AUTOPILOT_OPTIONS.lookback_ms + HOLD_BREAK_MS;
/// "Pause Autopilot for an hour": the one length every surface offers.
pub const AUTOPILOT_PAUSE_MS: f64 = 60.0 * MINUTE_MS;

/// The Autopilot-owned timer, as persisted (`state.json`) so a restart keeps it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedTimer {
    pub scope: String,
    #[serde(serialize_with = "js::serialize_number")]
    pub start: f64,
    pub filing_key: String,
    pub app: Option<DesktopActivityApp>,
    pub via: DesktopFilingVia,
    pub log_id: String,
}

/// A pause, as persisted (`state.json`). `account` is the scope prefix `<userId>:`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutopilotPause {
    pub account: String,
    #[serde(serialize_with = "js::serialize_number")]
    pub until: f64,
}

/// `<userId>:` of a `<userId>:<workspaceId>` scope.
pub fn account_of_scope(scope: &str) -> String {
    match scope.find(':') {
        Some(index) => scope[..=index].to_string(),
        None => String::new(),
    }
}

/// `crypto.randomUUID()`: a version 4 UUID.
pub fn random_uuid() -> String {
    let mut bytes: [u8; 16] = crate::protection::random_bytes();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = crate::protection::hex(&bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Where the controller persists what must survive a restart.
pub trait AutopilotSink {
    fn save_owned(&mut self, owned: Option<&OwnedTimer>) -> Result<(), String>;
    fn save_pause(&mut self, pause: Option<&AutopilotPause>) -> Result<(), String>;
}

/// A sink that keeps nothing, for callers with nowhere to write.
pub struct NoSink;
impl AutopilotSink for NoSink {
    fn save_owned(&mut self, _: Option<&OwnedTimer>) -> Result<(), String> {
        Ok(())
    }
    fn save_pause(&mut self, _: Option<&AutopilotPause>) -> Result<(), String> {
        Ok(())
    }
}

pub struct PlanContext<'a> {
    pub scope: &'a str,
    pub now: f64,
    pub settings: &'a DesktopActivitySettings,
    /// Switched on, capture supported and recording for an account.
    pub active: bool,
    /// The scope's segments for the last [`AUTOPILOT_WINDOW_MS`], the open one included.
    pub segments: &'a [ActivitySegment],
    pub names: &'a HashMap<String, String>,
    pub rules: &'a [ActivityRule],
    /// Everything tracked without the running entry, plus dismissals and just-accepted spans.
    pub holes: &'a [ActivityInterval],
    pub running: Option<&'a DesktopAutopilotRunning>,
}

#[derive(Debug, Clone, PartialEq)]
struct RunningKey {
    start: f64,
    filing_key: String,
}

#[derive(Debug, Clone)]
enum PendingDecision {
    Start { at: f64, filing: AutopilotFiling },
    Switch { at: f64, filing: AutopilotFiling },
    Stop { at: f64 },
}

#[derive(Debug, Clone)]
struct Pending {
    scope: String,
    at: f64,
    decision: PendingDecision,
    /// The app the plan named, with the name it showed.
    app: Option<DesktopActivityApp>,
}

#[derive(Debug, Clone)]
struct LoggedAction {
    scope: String,
    entry: DesktopAutopilotLogEntry,
}

#[derive(Debug, Clone)]
struct Settling {
    scope: String,
    at: f64,
    expect: Option<RunningKey>,
}

/// What the renderer reports after a plan's write.
#[derive(Debug, Clone, PartialEq)]
pub struct AppliedResult {
    pub token: String,
    pub ok: bool,
    /// What it actually filed, which can differ from the plan when the
    /// catalog no longer had a project.
    pub written: Option<Written>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Written {
    pub description: String,
    pub project_id: Option<String>,
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct HoldInput {
    pub filing_key: Option<String>,
    pub app_key: Option<String>,
    pub log_id: Option<String>,
}

fn running_key_of(running: Option<&DesktopAutopilotRunning>) -> Option<RunningKey> {
    running.map(|r| RunningKey {
        start: r.start,
        filing_key: filing_key_of(
            Some(&r.description),
            r.project_id.as_deref(),
            r.task_id.as_deref(),
        ),
    })
}

fn same_running(a: Option<&RunningKey>, b: Option<&RunningKey>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => {
            (a.start - b.start).abs() < SAME_START_MS && a.filing_key == b.filing_key
        }
        _ => false,
    }
}

fn app_of(key: &str, names: &HashMap<String, String>) -> DesktopActivityApp {
    DesktopActivityApp {
        key: key.to_string(),
        name: names.get(key).cloned().unwrap_or_else(|| key.to_string()),
    }
}

pub struct AutopilotController {
    owned: Option<OwnedTimer>,
    paused: Option<AutopilotPause>,
    /// What the running entry was at the last plan, to notice it change by hand.
    last_running: Option<(String, Option<RunningKey>)>,
    /// The last write reported made, until the renderer's running entry shows it.
    settling: Option<Settling>,
    holds: HashMap<(String, String), f64>,
    learned: HashMap<String, HashMap<String, AutopilotFiling>>,
    pending: HashMap<String, Pending>,
    log: Vec<LoggedAction>,
    watch: Option<(String, DesktopAutopilotWatch)>,
    new_id: Box<dyn FnMut() -> String + Send>,
}

impl AutopilotController {
    pub fn new(initial_owned: Option<OwnedTimer>, initial_pause: Option<AutopilotPause>) -> Self {
        Self::with_ids(initial_owned, initial_pause, Box::new(random_uuid))
    }

    pub fn with_ids(
        initial_owned: Option<OwnedTimer>,
        initial_pause: Option<AutopilotPause>,
        new_id: Box<dyn FnMut() -> String + Send>,
    ) -> Self {
        AutopilotController {
            owned: initial_owned,
            paused: initial_pause,
            last_running: None,
            settling: None,
            holds: HashMap::new(),
            learned: HashMap::new(),
            pending: HashMap::new(),
            log: Vec::new(),
            watch: None,
            new_id,
        }
    }

    /// `owned === next` holds only for null and null: every other assignment is a new object.
    fn set_owned(
        &mut self,
        next: Option<OwnedTimer>,
        sink: &mut dyn AutopilotSink,
    ) -> Result<(), String> {
        if self.owned.is_none() && next.is_none() {
            return Ok(());
        }
        self.owned = next;
        sink.save_owned(self.owned.as_ref())
    }

    fn set_paused(
        &mut self,
        next: Option<AutopilotPause>,
        sink: &mut dyn AutopilotSink,
    ) -> Result<(), String> {
        if self.paused.is_none() && next.is_none() {
            return Ok(());
        }
        self.paused = next;
        sink.save_pause(self.paused.as_ref())
    }

    /// When the scope's pause ends, or None when it is not paused at `now`.
    pub fn paused_until(&self, scope: Option<&str>, now: f64) -> Option<f64> {
        let paused = self.paused.as_ref()?;
        let scope = scope?;
        if account_of_scope(scope) != paused.account {
            return None;
        }
        (paused.until > now).then_some(paused.until)
    }

    fn add_hold(&mut self, scope: &str, key: &str, now: f64) {
        self.holds.insert((scope.to_string(), key.to_string()), now);
    }

    fn held_keys(&self, scope: &str) -> HashSet<String> {
        self.holds
            .keys()
            .filter(|(s, _)| s == scope)
            .map(|(_, key)| key.clone())
            .collect()
    }

    fn release_holds(&mut self, scope: &str, segments: &[ActivitySegment], now: f64) {
        self.holds.retain(|(s, _), at| {
            s != scope
                || !(now - *at > HOLD_MAX_MS || had_break_since(segments, *at, now, HOLD_BREAK_MS))
        });
    }

    fn prune_pending(&mut self, now: f64) {
        self.pending
            .retain(|_, entry| !(now - entry.at > PENDING_TTL_MS));
    }

    pub fn learn(
        &mut self,
        scope: &str,
        history: &[DesktopAutopilotHistoryEntry],
        segments: &[ActivitySegment],
    ) {
        self.learned.insert(
            scope.to_string(),
            learn_filings(segments, history, LearnFilingsOptions::default()),
        );
    }

    pub fn plan(
        &mut self,
        context: PlanContext<'_>,
        sink: &mut dyn AutopilotSink,
    ) -> Result<DesktopAutopilotPlan, String> {
        let scope = context.scope;
        let now = context.now;
        self.prune_pending(now);
        if !context.active {
            self.watch = None;
            self.last_running = None;
            return Ok(DesktopAutopilotPlan::None);
        }
        self.release_holds(scope, context.segments, now);

        let current = running_key_of(context.running);

        // A write reported made that the renderer does not show yet: decide
        // nothing, and above all do not read the gap as a stop by hand.
        if let Some(settling) = &self.settling {
            if settling.scope == scope {
                if same_running(current.as_ref(), settling.expect.as_ref()) {
                    self.settling = None;
                } else if now - settling.at < SETTLE_MS {
                    return Ok(DesktopAutopilotPlan::None);
                } else {
                    self.settling = None;
                }
            }
        }

        // The running entry changed, and not by Autopilot's hand: whatever
        // was running before was the person's decision to end. Hold it.
        let previous = match &self.last_running {
            Some((s, key)) if s == scope => key.clone(),
            _ => None,
        };
        if let Some(previous) = &previous {
            if !same_running(Some(previous), current.as_ref()) {
                let key = previous.filing_key.clone();
                self.add_hold(scope, &key, now);
            }
        }
        self.last_running = Some((scope.to_string(), current.clone()));

        let owned_here = self.owned.as_ref().filter(|o| o.scope == scope);
        let owned_now = owned_here.is_some_and(|o| {
            current.is_some()
                && same_running(
                    current.as_ref(),
                    Some(&RunningKey {
                        start: o.start,
                        filing_key: o.filing_key.clone(),
                    }),
                )
        });
        if owned_here.is_some() && !owned_now {
            self.set_owned(None, sink)?;
        }

        // Paused: the bookkeeping above still runs, so a timer stopped or
        // edited by hand meanwhile is the person's afterwards; nothing is decided.
        if self.paused.as_ref().is_some_and(|p| p.until <= now) {
            self.set_paused(None, sink)?;
        }
        if self.paused_until(Some(scope), now).is_some() {
            self.watch = None;
            return Ok(DesktopAutopilotPlan::None);
        }

        let empty = HashMap::new();
        let learned = self.learned.get(scope).unwrap_or(&empty);
        let mut resolver = FilingResolver::new(context.rules, learned);
        let mut resolve = |app: &str| resolver.resolve(app);
        let held = self.held_keys(scope);
        let decision = decide_autopilot(AutopilotInput {
            now,
            segments: context.segments,
            tracked: context.holes,
            running: current.as_ref().map(|c| AutopilotRunning {
                start: c.start,
                filing_key: c.filing_key.clone(),
                owned: owned_now,
            }),
            resolve: &mut resolve,
            held: &held,
            options: AutopilotOptionsPatch {
                start_after_ms: Some(context.settings.autopilot_start_minutes * MINUTE_MS),
                ..Default::default()
            },
        });

        let (pending, plan) = match decision {
            AutopilotDecision::None { watch } => {
                self.watch = watch.map(|seen| {
                    (
                        scope.to_string(),
                        DesktopAutopilotWatch {
                            app: app_of(&seen.app_key, context.names),
                            since: seen.since,
                            credited_ms: seen.credited_ms,
                            filing: seen.filing,
                            held: seen.held,
                        },
                    )
                });
                return Ok(DesktopAutopilotPlan::None);
            }
            AutopilotDecision::Stop { at } => {
                let token = (self.new_id)();
                let app = self.owned.as_ref().and_then(|o| o.app.clone());
                (
                    (token.clone(), PendingDecision::Stop { at }, app.clone()),
                    DesktopAutopilotPlan::Stop { token, at, app },
                )
            }
            AutopilotDecision::Start {
                at,
                filing,
                app_key,
                credited_ms,
            } => {
                let token = (self.new_id)();
                let app = app_of(&app_key, context.names);
                (
                    (
                        token.clone(),
                        PendingDecision::Start {
                            at,
                            filing: filing.clone(),
                        },
                        Some(app.clone()),
                    ),
                    DesktopAutopilotPlan::Start {
                        token,
                        at,
                        filing,
                        app,
                        credited_ms,
                    },
                )
            }
            AutopilotDecision::Switch {
                at,
                filing,
                app_key,
                credited_ms,
            } => {
                let token = (self.new_id)();
                let app = app_of(&app_key, context.names);
                (
                    (
                        token.clone(),
                        PendingDecision::Switch {
                            at,
                            filing: filing.clone(),
                        },
                        Some(app.clone()),
                    ),
                    DesktopAutopilotPlan::Switch {
                        token,
                        at,
                        filing,
                        app,
                        credited_ms,
                    },
                )
            }
        };
        self.watch = None;
        let (token, decision, app) = pending;
        self.pending.insert(
            token,
            Pending {
                scope: scope.to_string(),
                at: now,
                decision,
                app,
            },
        );
        Ok(plan)
    }

    /// The renderer made (or failed to make) the write for `token`. Returns
    /// whether anything changed.
    pub fn applied(
        &mut self,
        result: &AppliedResult,
        now: f64,
        sink: &mut dyn AutopilotSink,
    ) -> Result<bool, String> {
        let Some(entry) = self.pending.remove(&result.token) else {
            return Ok(false);
        };
        let Pending {
            scope,
            decision,
            app,
            ..
        } = entry;

        let (kind, at, filing) = match decision {
            PendingDecision::Stop { at } => {
                if !result.ok {
                    return Ok(false);
                }
                let log_id = (self.new_id)();
                self.set_owned(None, sink)?;
                self.settling = Some(Settling {
                    scope: scope.clone(),
                    at: now,
                    expect: None,
                });
                self.last_running = Some((scope.clone(), None));
                self.push_log(
                    LoggedAction {
                        scope,
                        entry: DesktopAutopilotLogEntry {
                            id: log_id,
                            kind: DesktopAutopilotAction::Stop,
                            at,
                            decided_at: now,
                            app,
                            filing: None,
                            undone: false,
                        },
                    },
                    now,
                );
                return Ok(true);
            }
            PendingDecision::Start { at, filing } => (DesktopAutopilotAction::Start, at, filing),
            PendingDecision::Switch { at, filing } => (DesktopAutopilotAction::Switch, at, filing),
        };

        if !result.ok {
            // Refused or failed: do not try the same thing again until a break.
            self.add_hold(&scope, &filing.key, now);
            return Ok(false);
        }

        let log_id = (self.new_id)();
        let written_key = match &result.written {
            None => filing.key.clone(),
            Some(w) => filing_key_of(
                Some(&w.description),
                w.project_id.as_deref(),
                w.task_id.as_deref(),
            ),
        };
        let expect = RunningKey {
            start: at,
            filing_key: written_key.clone(),
        };
        self.set_owned(
            Some(OwnedTimer {
                scope: scope.clone(),
                start: at,
                filing_key: written_key,
                app: app.clone(),
                via: filing.via,
                log_id: log_id.clone(),
            }),
            sink,
        )?;
        self.settling = Some(Settling {
            scope: scope.clone(),
            at: now,
            expect: Some(expect.clone()),
        });
        self.last_running = Some((scope.clone(), Some(expect)));
        self.push_log(
            LoggedAction {
                scope,
                entry: DesktopAutopilotLogEntry {
                    id: log_id,
                    kind,
                    at,
                    decided_at: now,
                    app,
                    filing: Some(filing),
                    undone: false,
                },
            },
            now,
        );
        Ok(true)
    }

    fn push_log(&mut self, action: LoggedAction, now: f64) {
        self.log.insert(0, action);
        self.log
            .retain(|action| now - action.entry.decided_at < LOG_TTL_MS);
        self.log.truncate(LOG_MAX);
    }

    pub fn hold(
        &mut self,
        scope: &str,
        input: &HoldInput,
        now: f64,
        sink: &mut dyn AutopilotSink,
    ) -> Result<(), String> {
        if let Some(key) = &input.filing_key {
            self.add_hold(scope, key, now);
        }
        if let Some(app) = &input.app_key {
            self.add_hold(scope, &app_hold_key(app), now);
        }
        if let Some(log_id) = &input.log_id {
            for action in &mut self.log {
                if action.scope == scope && &action.entry.id == log_id {
                    action.entry.undone = true;
                }
            }
            if self
                .owned
                .as_ref()
                .is_some_and(|o| o.scope == scope && &o.log_id == log_id)
            {
                self.set_owned(None, sink)?;
            }
        }
        Ok(())
    }

    /// Pause the scope's account until `until`, or resume (`None`).
    pub fn pause(
        &mut self,
        scope: &str,
        until: Option<f64>,
        sink: &mut dyn AutopilotSink,
    ) -> Result<(), String> {
        let next = until.map(|until| AutopilotPause {
            account: account_of_scope(scope),
            until,
        });
        self.set_paused(next, sink)?;
        if until.is_some() {
            self.watch = None;
        }
        Ok(())
    }

    pub fn state(&self, scope: Option<&str>, active: bool, now: f64) -> DesktopAutopilotState {
        let log = match scope {
            None => Vec::new(),
            Some(scope) => self
                .log
                .iter()
                .filter(|action| {
                    action.scope == scope && now - action.entry.decided_at < LOG_TTL_MS
                })
                .map(|action| action.entry.clone())
                .collect(),
        };
        let owned = self
            .owned
            .as_ref()
            .filter(|o| active && Some(o.scope.as_str()) == scope)
            .map(|o| DesktopAutopilotOwned {
                start: o.start,
                filing_key: o.filing_key.clone(),
                app: o.app.clone(),
                via: o.via,
                log_id: o.log_id.clone(),
            });
        let watch = self
            .watch
            .as_ref()
            .filter(|(s, _)| active && Some(s.as_str()) == scope)
            .map(|(_, w)| w.clone());
        DesktopAutopilotState {
            active,
            owned,
            watch,
            log,
            learned_apps: scope
                .and_then(|s| self.learned.get(s))
                .map_or(0, |learned| learned.len() as u64),
            paused_until: if active {
                self.paused_until(scope, now)
            } else {
                None
            },
        }
    }

    /// Forget everything: sign-out, wipe, another scope. A pause of the
    /// account `keep_pause_for` names (`<userId>:`) is kept; with none, it ends too.
    pub fn reset(
        &mut self,
        keep_pause_for: Option<&str>,
        sink: &mut dyn AutopilotSink,
    ) -> Result<(), String> {
        self.set_owned(None, sink)?;
        if self
            .paused
            .as_ref()
            .is_some_and(|p| Some(p.account.as_str()) != keep_pause_for)
        {
            self.set_paused(None, sink)?;
        }
        self.last_running = None;
        self.settling = None;
        self.holds.clear();
        self.learned.clear();
        self.pending.clear();
        self.log.clear();
        self.watch = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuids_are_version_4() {
        let id = random_uuid();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
        assert_ne!(id, random_uuid());
    }

    #[test]
    fn the_account_is_the_scope_up_to_its_first_colon() {
        assert_eq!(account_of_scope("u1:w1"), "u1:");
        assert_eq!(account_of_scope("nocolon"), "");
    }
}
