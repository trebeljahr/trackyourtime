//! The capture state machine, pure (`model.ts`).
//!
//! Every input — a detection from the source, the one-minute heartbeat, an
//! idle or lock report, a settings change, a new account or workspace,
//! sign-out — is one [`step`], which answers the next state and the storage
//! effects to apply. The service applies them one at a time; this module
//! reads no clock and touches no file, so every rule below is a unit test.
//!
//! The rules are the browser extension's (`background/activity/capture.ts`):
//!
//! - The open segment is persisted when it opens or changes and by the
//!   heartbeat; a detection of the same app only moves `lastSeen` in memory.
//! - A segment whose `lastSeen` is more than [`STALE_AFTER_MS`] old is closed
//!   AT `lastSeen`: the machine slept or the app died, and none of that time
//!   was spent in the app.
//! - The heartbeat never opens a segment. Only a detection says attention is
//!   somewhere.
//! - A segment is written under the settings current when it CLOSES, so
//!   excluding the app on screen, or switching titles off, never stores what
//!   the person just asked not to be stored.

use serde::{Deserialize, Serialize};
use tyt_wire::DesktopActivitySettings;

use crate::core::{host_matches_any, ActivitySource};
use crate::js;
use crate::keys::{
    clean_name, is_built_in_never_record, to_activity_key, DescribedTarget, FrontmostTarget,
    ACTIVITY_KEY_MAX_LENGTH,
};
use crate::settings::{account_prefix_of, activity_scope_of};

/// Three missed heartbeats: late timers must not split a stretch; a sleeping laptop misses far more.
pub const STALE_AFTER_MS: f64 = 3.0 * 60_000.0;
pub const HEARTBEAT_MS: u64 = 60_000;
/// Below this many seconds without input the person is still at the machine.
pub const IDLE_THRESHOLD_SECONDS: f64 = 60.0;
pub const TITLE_MAX_LENGTH: usize = ACTIVITY_KEY_MAX_LENGTH;

/// The open segment, as `open.json` holds it (field order as the TypeScript writes it).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSegment {
    pub scope: String,
    pub key: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(serialize_with = "js::serialize_number")]
    pub start: f64,
    #[serde(serialize_with = "js::serialize_number")]
    pub last_seen: f64,
}

/// One closed segment as stored: core's `ActivitySegment` plus its scope and
/// a display name. One JSONL line, field order as the TypeScript writes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSegment {
    pub scope: String,
    pub source: ActivitySource,
    #[serde(serialize_with = "js::serialize_number")]
    pub start: f64,
    #[serde(serialize_with = "js::serialize_number")]
    pub end: f64,
    pub key: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub afk: bool,
}

impl StoredSegment {
    /// Core's view of it.
    pub fn as_core(&self) -> crate::core::ActivitySegment {
        crate::core::ActivitySegment {
            source: self.source,
            start: self.start,
            end: self.end,
            key: self.key.clone(),
            label: self.label.clone(),
            afk: self.afk,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CaptureState {
    pub settings: DesktopActivitySettings,
    /// `<userId>:<workspaceId>`, or None before sign-in and after sign-out.
    pub scope: Option<String>,
    pub open: Option<OpenSegment>,
    /// No input for at least [`IDLE_THRESHOLD_SECONDS`].
    pub idle: bool,
    /// The screen is locked or the machine suspended.
    pub locked: bool,
    /// Set by a lock or suspend and cleared only by input. Coming back from a
    /// closed lid is not attention on whatever app happens to be in front.
    pub awaiting_input: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptureContext {
    /// Supported on this channel and OS, and the store is this build's format.
    pub available: bool,
    /// Whether this OS can record window titles at all.
    pub titles_available: bool,
    /// This app's own process, never recorded.
    pub self_pid: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresenceState {
    Active,
    Idle,
    Locked,
}

impl PresenceState {
    /// The idle monitor's state names. Anything else ("unknown") is idle:
    /// `step` treats every state that is neither active nor locked that way.
    pub fn parse(value: &str) -> Self {
        match value {
            "active" => PresenceState::Active,
            "locked" => PresenceState::Locked,
            _ => PresenceState::Idle,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum CaptureEvent {
    Boot,
    Detect(Option<FrontmostTarget>),
    Heartbeat,
    Presence {
        state: PresenceState,
        idle_seconds: f64,
    },
    Settings(DesktopActivitySettings),
    Scope {
        user_id: String,
        workspace_id: String,
    },
    /// Sign-out, a revoked device, account deletion: every row and the scope.
    Forget,
    /// "Delete all activity now": every row; the scope stays.
    Wipe,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CaptureEffect {
    Append(StoredSegment),
    PersistOpen(OpenSegment),
    ClearOpen,
    /// Delete every stored segment whose key matches one of these patterns.
    PurgeApps(Vec<String>),
    /// Remove the label from every stored segment.
    StripLabels,
    /// Delete every segment, rule and dismissal whose scope does not start with this.
    SweepScopes(String),
    /// Delete every segment, rule and dismissal.
    Wipe,
    Prune,
    /// Settings or scope changed: write them.
    SaveState,
}

impl CaptureEffect {
    pub fn kind(&self) -> &'static str {
        match self {
            CaptureEffect::Append(_) => "append",
            CaptureEffect::PersistOpen(_) => "persist-open",
            CaptureEffect::ClearOpen => "clear-open",
            CaptureEffect::PurgeApps(_) => "purge-apps",
            CaptureEffect::StripLabels => "strip-labels",
            CaptureEffect::SweepScopes(_) => "sweep-scopes",
            CaptureEffect::Wipe => "wipe",
            CaptureEffect::Prune => "prune",
            CaptureEffect::SaveState => "save-state",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct StepResult {
    pub state: CaptureState,
    pub effects: Vec<CaptureEffect>,
}

pub fn initial_capture_state(
    settings: DesktopActivitySettings,
    scope: Option<String>,
    open: Option<OpenSegment>,
) -> CaptureState {
    CaptureState {
        settings,
        scope,
        open,
        idle: false,
        locked: false,
        awaiting_input: false,
    }
}

/// Whether a detection may open a segment now.
pub fn can_record(state: &CaptureState, ctx: &CaptureContext) -> bool {
    ctx.available
        && state.settings.enabled
        && state.scope.is_some()
        && !state.idle
        && !state.locked
        && !state.awaiting_input
}

/// Whether the source should run at all. Not while idle or locked: presence
/// comes from the idle monitor, never from the source, so nothing is lost.
pub fn should_capture(state: &CaptureState, ctx: &CaptureContext) -> bool {
    ctx.available && state.settings.enabled && state.scope.is_some() && !state.idle && !state.locked
}

/// The recordable identity of what is in front, or None when it must not be recorded.
pub fn describe_target(
    target: Option<&FrontmostTarget>,
    settings: &DesktopActivitySettings,
    ctx: &CaptureContext,
) -> Option<DescribedTarget> {
    let target = target?;
    let key = to_activity_key(&target.key);
    if key.is_empty() {
        return None;
    }
    if is_built_in_never_record(&key, target.pid, ctx.self_pid) {
        return None;
    }
    if host_matches_any(&settings.excluded_apps, &key) {
        return None;
    }
    let name = clean_name(&target.name, &key);
    let title = target
        .title
        .as_deref()
        .map(|title| js::trim(&js::collapse_whitespace(title)).to_string());
    match title {
        Some(title) if settings.store_titles && ctx.titles_available && !title.is_empty() => {
            Some(DescribedTarget {
                key,
                name,
                label: Some(js::slice_utf16(&title, TITLE_MAX_LENGTH).to_string()),
            })
        }
        _ => Some(DescribedTarget {
            key,
            name,
            label: None,
        }),
    }
}

/// The segment `open` becomes when closed at `end`, or None when it must not be written.
pub fn closed_segment(
    open: &OpenSegment,
    end: f64,
    settings: &DesktopActivitySettings,
    ctx: &CaptureContext,
) -> Option<StoredSegment> {
    if host_matches_any(&settings.excluded_apps, &open.key) {
        return None;
    }
    let stop = open.start.max(end);
    if stop <= open.start {
        return None;
    }
    let keep_label = open.label.is_some() && settings.store_titles && ctx.titles_available;
    Some(StoredSegment {
        scope: open.scope.clone(),
        source: ActivitySource::Desktop,
        start: open.start,
        end: stop,
        key: open.key.clone(),
        name: open.name.clone(),
        label: if keep_label { open.label.clone() } else { None },
        afk: false,
    })
}

/// A small builder so each branch below reads as the rule it is.
struct Step<'a> {
    state: CaptureState,
    effects: Vec<CaptureEffect>,
    ctx: &'a CaptureContext,
}

impl Step<'_> {
    /// Close the open segment at `end` under the current settings, and forget it.
    fn close(&mut self, end: f64) {
        let Some(open) = self.state.open.clone() else {
            return;
        };
        if let Some(segment) = closed_segment(&open, end, &self.state.settings, self.ctx) {
            self.effects.push(CaptureEffect::Append(segment));
        }
        self.drop_open();
    }

    /// Forget the open segment without writing it.
    fn drop_open(&mut self) {
        if self.state.open.is_none() {
            return;
        }
        self.state.open = None;
        self.effects.push(CaptureEffect::ClearOpen);
    }

    /// A segment nobody has confirmed for too long ended when it was last seen.
    fn close_stale(&mut self, now: f64) {
        if let Some(open) = &self.state.open {
            if now - open.last_seen > STALE_AFTER_MS {
                let last_seen = open.last_seen;
                self.close(last_seen);
            }
        }
    }

    fn result(self) -> StepResult {
        StepResult {
            state: self.state,
            effects: self.effects,
        }
    }
}

pub fn step(
    state: &CaptureState,
    event: &CaptureEvent,
    now: f64,
    ctx: &CaptureContext,
) -> StepResult {
    let mut s = Step {
        state: state.clone(),
        effects: Vec::new(),
        ctx,
    };

    match event {
        CaptureEvent::Boot => {
            let open = s.state.open.clone();
            match open {
                Some(open) if Some(&open.scope) != s.state.scope.as_ref() => {
                    // Left behind under a scope that is no longer current (a
                    // crash between writes): never filed under anybody, so
                    // another account's is never written.
                    s.drop_open();
                }
                Some(open) if !s.state.settings.enabled || !ctx.available => {
                    // Written by an earlier run under settings that no longer
                    // hold: it ended when it was last seen.
                    s.close(open.last_seen);
                }
                _ => s.close_stale(now),
            }
            s.result()
        }

        CaptureEvent::Detect(target) => {
            s.close_stale(now);
            let described = if can_record(&s.state, ctx) {
                describe_target(target.as_ref(), &s.state.settings, ctx)
            } else {
                None
            };
            let Some(target) = described else {
                s.close(now);
                return s.result();
            };
            if let Some(open) = &s.state.open {
                if Some(&open.scope) == s.state.scope.as_ref()
                    && open.key == target.key
                    && open.label == target.label
                {
                    // Same app, same title: only `lastSeen` moves, in memory.
                    // The heartbeat persists it; a write per poll would be a
                    // write every 5 s.
                    let mut moved = open.clone();
                    moved.last_seen = now;
                    moved.name = target.name;
                    s.state.open = Some(moved);
                    return s.result();
                }
            }
            s.close(now);
            let next = OpenSegment {
                scope: s.state.scope.clone().expect("can_record needs a scope"),
                key: target.key,
                name: target.name,
                label: target.label,
                start: now,
                last_seen: now,
            };
            s.state.open = Some(next.clone());
            s.effects.push(CaptureEffect::PersistOpen(next));
            s.result()
        }

        CaptureEvent::Heartbeat => {
            s.close_stale(now);
            let Some(open) = s.state.open.clone() else {
                return s.result();
            };
            if !can_record(&s.state, ctx) || Some(&open.scope) != s.state.scope.as_ref() {
                s.close(now);
                return s.result();
            }
            let mut refreshed = open;
            refreshed.last_seen = now;
            s.state.open = Some(refreshed.clone());
            s.effects.push(CaptureEffect::PersistOpen(refreshed));
            s.result()
        }

        CaptureEvent::Presence {
            state: presence,
            idle_seconds,
        } => {
            s.close_stale(now);
            match presence {
                PresenceState::Locked => {
                    s.close(now);
                    s.state.locked = true;
                    s.state.awaiting_input = true;
                }
                PresenceState::Active => {
                    s.state.locked = false;
                    s.state.idle = false;
                    s.state.awaiting_input = false;
                }
                PresenceState::Idle => {
                    s.state.locked = false;
                    if *idle_seconds >= IDLE_THRESHOLD_SECONDS {
                        // The OS reports idleness once it has already lasted:
                        // those seconds were not spent in the app, so the
                        // segment ends where input stopped.
                        if let Some(open) = &s.state.open {
                            let end = open.start.max(now - idle_seconds * 1000.0);
                            s.close(end);
                        }
                        s.state.idle = true;
                    } else if s.state.idle {
                        // Input landed between two samples.
                        s.state.idle = false;
                    }
                }
            }
            s.result()
        }

        CaptureEvent::Settings(next) => {
            let previous = s.state.settings.clone();
            s.state.settings = next.clone();
            s.effects.push(CaptureEffect::SaveState);

            let added: Vec<String> = next
                .excluded_apps
                .iter()
                .filter(|p| !previous.excluded_apps.contains(p))
                .cloned()
                .collect();
            if !added.is_empty() {
                // "Never record" covers what is already stored, not just what comes next.
                s.effects.push(CaptureEffect::PurgeApps(added.clone()));
                if let Some(open) = &s.state.open {
                    if host_matches_any(&added, &open.key) {
                        s.drop_open();
                    }
                }
            }
            if previous.store_titles && !next.store_titles {
                // Stricter than the extension on purpose: off means no stored titles.
                s.effects.push(CaptureEffect::StripLabels);
                s.close(now);
            }
            if previous.retention_days != next.retention_days {
                s.effects.push(CaptureEffect::Prune);
            }
            if !can_record(&s.state, ctx) {
                s.close(now);
            }
            s.result()
        }

        CaptureEvent::Scope {
            user_id,
            workspace_id,
        } => {
            let scope = activity_scope_of(user_id, workspace_id);
            if Some(&scope) == s.state.scope.as_ref() {
                return s.result();
            }
            let prefix = account_prefix_of(user_id);
            // The same person's other workspace keeps what it recorded;
            // another account's open segment is never written.
            match &s.state.open {
                Some(open) if open.scope.starts_with(&prefix) => s.close(now),
                _ => s.drop_open(),
            }
            s.effects.push(CaptureEffect::SweepScopes(prefix));
            s.state.scope = Some(scope);
            s.effects.push(CaptureEffect::SaveState);
            s.result()
        }

        CaptureEvent::Forget => {
            s.drop_open();
            s.effects.push(CaptureEffect::Wipe);
            s.state.scope = None;
            s.effects.push(CaptureEffect::SaveState);
            s.result()
        }

        CaptureEvent::Wipe => {
            s.drop_open();
            s.effects.push(CaptureEffect::Wipe);
            s.result()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::default_activity_settings;

    const CTX: CaptureContext = CaptureContext {
        available: true,
        titles_available: true,
        self_pid: 4242,
    };
    /// `Date.UTC(2026, 8, 22, 9, 0, 0)`.
    const T0: f64 = 1_790_067_600_000.0;
    const MIN: f64 = 60_000.0;

    fn on() -> DesktopActivitySettings {
        DesktopActivitySettings {
            enabled: true,
            ..default_activity_settings()
        }
    }

    fn target(key: &str, name: &str) -> FrontmostTarget {
        FrontmostTarget {
            key: key.into(),
            name: name.into(),
            title: None,
            pid: None,
        }
    }
    fn editor() -> FrontmostTarget {
        target("com.example.Editor", "Editor")
    }
    fn chat() -> FrontmostTarget {
        target("com.example.chat", "Chat")
    }
    fn detect(t: FrontmostTarget) -> CaptureEvent {
        CaptureEvent::Detect(Some(t))
    }

    fn run_with(
        start: CaptureState,
        events: Vec<(f64, CaptureEvent)>,
        ctx: CaptureContext,
    ) -> (CaptureState, Vec<CaptureEffect>) {
        let mut state = start;
        let mut effects = Vec::new();
        for (at, event) in events {
            let result = step(&state, &event, at, &ctx);
            state = result.state;
            effects.extend(result.effects);
        }
        (state, effects)
    }
    fn run(
        start: CaptureState,
        events: Vec<(f64, CaptureEvent)>,
    ) -> (CaptureState, Vec<CaptureEffect>) {
        run_with(start, events, CTX)
    }

    fn appended(effects: &[CaptureEffect]) -> Vec<StoredSegment> {
        effects
            .iter()
            .filter_map(|e| match e {
                CaptureEffect::Append(segment) => Some(segment.clone()),
                _ => None,
            })
            .collect()
    }

    fn scoped(settings: DesktopActivitySettings) -> CaptureState {
        initial_capture_state(settings, Some("u1:w1".into()), None)
    }

    #[test]
    fn detect_opens_extends_in_memory_and_switches() {
        let (state, effects) = run(
            scoped(on()),
            vec![
                (T0, detect(editor())),
                (T0 + 5_000.0, detect(editor())),
                (T0 + 2.0 * MIN, detect(editor())),
                (T0 + 3.0 * MIN, CaptureEvent::Heartbeat),
                (T0 + 5.0 * MIN, detect(chat())),
            ],
        );
        // Opening and the heartbeat persist; extending does not; switching closes and opens.
        assert_eq!(
            effects.iter().map(CaptureEffect::kind).collect::<Vec<_>>(),
            [
                "persist-open",
                "persist-open",
                "append",
                "clear-open",
                "persist-open"
            ]
        );
        assert_eq!(
            appended(&effects),
            vec![StoredSegment {
                scope: "u1:w1".into(),
                source: ActivitySource::Desktop,
                start: T0,
                end: T0 + 5.0 * MIN,
                key: "com.example.editor".into(),
                name: "Editor".into(),
                label: None,
                afk: false,
            }]
        );
        assert_eq!(state.open.as_ref().unwrap().key, "com.example.chat");
        assert_eq!(state.open.as_ref().unwrap().start, T0 + 5.0 * MIN);
    }

    #[test]
    fn detect_closes_on_null_on_this_app_and_on_the_lock_screen() {
        let targets = vec![
            None,
            Some(target("com.trebeljahr.trackyourtime", "Track Your Time")),
            Some(FrontmostTarget {
                key: "anything".into(),
                name: "Me".into(),
                title: None,
                pid: Some(4242),
            }),
            Some(target("com.apple.loginwindow", "loginwindow")),
            Some(target("LockApp.exe", "LockApp")),
        ];
        for t in targets {
            let (state, effects) = run(
                scoped(on()),
                vec![(T0, detect(editor())), (T0 + MIN, CaptureEvent::Detect(t))],
            );
            assert_eq!(state.open, None);
            assert_eq!(appended(&effects)[0].end, T0 + MIN);
        }
    }

    #[test]
    fn detect_records_nothing_while_off_without_a_scope_or_unavailable() {
        let cases = [
            (scoped(default_activity_settings()), CTX),
            (initial_capture_state(on(), None, None), CTX),
            (
                scoped(on()),
                CaptureContext {
                    available: false,
                    ..CTX
                },
            ),
        ];
        for (state, ctx) in cases {
            let (state, effects) = run_with(state, vec![(T0, detect(editor()))], ctx);
            assert_eq!(state.open, None);
            assert!(effects.is_empty());
        }
    }

    #[test]
    fn detect_closes_a_stale_segment_at_last_seen_before_looking_at_the_new_detection() {
        let (_, effects) = run(
            scoped(on()),
            vec![
                (T0, detect(editor())),
                (T0 + MIN, detect(editor())),
                (T0 + MIN + STALE_AFTER_MS + 1.0, detect(editor())),
            ],
        );
        assert_eq!(appended(&effects)[0].end, T0 + MIN);
    }

    #[test]
    fn detect_keeps_a_title_only_when_titles_are_on_and_available_here() {
        let titled = FrontmostTarget {
            title: Some("  report.md  — Editor ".into()),
            ..editor()
        };
        let with_titles = DesktopActivitySettings {
            store_titles: true,
            ..on()
        };
        let events = || {
            vec![
                (T0, detect(titled.clone())),
                (T0 + MIN, CaptureEvent::Detect(None)),
            ]
        };
        let (_, kept) = run(scoped(with_titles.clone()), events());
        assert_eq!(
            appended(&kept)[0].label.as_deref(),
            Some("report.md — Editor")
        );
        let (_, macos) = run_with(
            scoped(with_titles),
            events(),
            CaptureContext {
                titles_available: false,
                ..CTX
            },
        );
        assert_eq!(appended(&macos)[0].label, None);
        let (_, off) = run(scoped(on()), events());
        assert_eq!(appended(&off)[0].label, None);
    }

    #[test]
    fn heartbeat_never_opens_a_segment() {
        let (state, effects) = run(scoped(on()), vec![(T0, CaptureEvent::Heartbeat)]);
        assert_eq!(state.open, None);
        assert!(effects.is_empty());
    }

    #[test]
    fn heartbeat_refreshes_and_persists_a_live_segment() {
        let (state, effects) = run(
            scoped(on()),
            vec![(T0, detect(editor())), (T0 + MIN, CaptureEvent::Heartbeat)],
        );
        assert_eq!(state.open.as_ref().unwrap().last_seen, T0 + MIN);
        assert_eq!(
            effects.last(),
            Some(&CaptureEffect::PersistOpen(state.open.clone().unwrap()))
        );
    }

    #[test]
    fn heartbeat_closes_a_stale_segment_at_last_seen_not_at_now() {
        let (state, effects) = run(
            scoped(on()),
            vec![
                (T0, detect(editor())),
                (T0 + 2.0 * MIN, detect(editor())),
                (T0 + 60.0 * MIN, CaptureEvent::Heartbeat),
            ],
        );
        assert_eq!(state.open, None);
        assert_eq!(appended(&effects)[0].end, T0 + 2.0 * MIN);
    }

    fn presence(state: PresenceState, idle_seconds: f64) -> CaptureEvent {
        CaptureEvent::Presence {
            state,
            idle_seconds,
        }
    }

    #[test]
    fn presence_backdates_the_close_to_when_input_stopped() {
        let (state, effects) = run(
            scoped(on()),
            vec![
                (T0, detect(editor())),
                (T0 + 2.0 * MIN, presence(PresenceState::Idle, 30.0)),
                (T0 + 3.0 * MIN, presence(PresenceState::Idle, 120.0)),
                (T0 + 3.0 * MIN + 5_000.0, detect(editor())),
            ],
        );
        assert_eq!(appended(&effects)[0].end, T0 + MIN);
        // While idle, detections open nothing.
        assert_eq!(state.open, None);
        let (back, _) = run(
            state,
            vec![
                (T0 + 40.0 * MIN, presence(PresenceState::Active, 0.0)),
                (T0 + 40.0 * MIN + 5_000.0, detect(editor())),
            ],
        );
        assert_eq!(back.open.unwrap().start, T0 + 40.0 * MIN + 5_000.0);
    }

    #[test]
    fn presence_closes_at_now_on_lock_and_opens_nothing_after_unlock_until_input() {
        let (locked, effects) = run(
            scoped(on()),
            vec![
                (T0, detect(editor())),
                (T0 + 2.0 * MIN, presence(PresenceState::Locked, 1.0)),
            ],
        );
        assert_eq!(appended(&effects)[0].end, T0 + 2.0 * MIN);
        // Unlocked: the monitor reports "idle" until someone types.
        let (resumed, _) = run(
            locked,
            vec![
                (T0 + 70.0 * MIN, presence(PresenceState::Idle, 20.0)),
                (T0 + 70.0 * MIN + 5_000.0, detect(editor())),
            ],
        );
        assert_eq!(resumed.open, None);
        let (typed, _) = run(
            resumed,
            vec![
                (T0 + 71.0 * MIN, presence(PresenceState::Active, 0.0)),
                (T0 + 71.0 * MIN + 5_000.0, detect(editor())),
            ],
        );
        assert_eq!(typed.open.unwrap().start, T0 + 71.0 * MIN + 5_000.0);
    }

    #[test]
    fn settings_write_the_open_segment_under_the_settings_current_at_close() {
        let (state, effects) = run(
            scoped(on()),
            vec![
                (T0, detect(chat())),
                (
                    T0 + 5.0 * MIN,
                    CaptureEvent::Settings(DesktopActivitySettings {
                        excluded_apps: vec!["com.example.chat".into()],
                        ..on()
                    }),
                ),
            ],
        );
        assert!(appended(&effects).is_empty());
        assert_eq!(state.open, None);
        assert!(effects
            .iter()
            .any(|e| matches!(e, CaptureEffect::PurgeApps(p) if p[0] == "com.example.chat")));
    }

    #[test]
    fn settings_purge_only_for_newly_added_patterns() {
        let with = DesktopActivitySettings {
            excluded_apps: vec!["com.example.chat".into()],
            ..on()
        };
        let (_, effects) = run(
            scoped(with.clone()),
            vec![(T0, CaptureEvent::Settings(with))],
        );
        assert!(!effects
            .iter()
            .any(|e| matches!(e, CaptureEffect::PurgeApps(_))));
    }

    #[test]
    fn settings_strip_stored_labels_and_close_the_open_one_without_its_label_when_titles_go_off() {
        let with_titles = DesktopActivitySettings {
            store_titles: true,
            ..on()
        };
        let (_, effects) = run(
            scoped(with_titles),
            vec![
                (
                    T0,
                    detect(FrontmostTarget {
                        title: Some("secret.txt".into()),
                        ..editor()
                    }),
                ),
                (T0 + 5.0 * MIN, CaptureEvent::Settings(on())),
            ],
        );
        assert!(effects.contains(&CaptureEffect::StripLabels));
        let segment = &appended(&effects)[0];
        assert_eq!(segment.end, T0 + 5.0 * MIN);
        assert_eq!(segment.label, None);
    }

    #[test]
    fn settings_close_at_now_when_capture_is_turned_off_and_prune_on_a_retention_change() {
        let (state, effects) = run(
            scoped(on()),
            vec![
                (T0, detect(editor())),
                (
                    T0 + 5.0 * MIN,
                    CaptureEvent::Settings(DesktopActivitySettings {
                        retention_days: 3.0,
                        ..default_activity_settings()
                    }),
                ),
            ],
        );
        assert_eq!(appended(&effects)[0].end, T0 + 5.0 * MIN);
        assert_eq!(state.open, None);
        assert!(effects.contains(&CaptureEffect::Prune));
        assert!(effects.contains(&CaptureEffect::SaveState));
    }

    fn scope(user: &str, workspace: &str) -> CaptureEvent {
        CaptureEvent::Scope {
            user_id: user.into(),
            workspace_id: workspace.into(),
        }
    }

    #[test]
    fn scope_sweeps_other_accounts_and_keeps_the_same_persons_workspaces() {
        let (state, effects) = run(
            scoped(on()),
            vec![(T0, detect(editor())), (T0 + 5.0 * MIN, scope("u1", "w2"))],
        );
        assert_eq!(appended(&effects)[0].scope, "u1:w1");
        assert!(effects.contains(&CaptureEffect::SweepScopes("u1:".into())));
        assert_eq!(state.scope.as_deref(), Some("u1:w2"));
        assert_eq!(state.open, None);
    }

    #[test]
    fn scope_never_writes_another_accounts_open_segment() {
        let (state, effects) = run(
            scoped(on()),
            vec![(T0, detect(editor())), (T0 + 5.0 * MIN, scope("u2", "w9"))],
        );
        assert!(appended(&effects).is_empty());
        assert!(effects.contains(&CaptureEffect::SweepScopes("u2:".into())));
        assert_eq!(state.scope.as_deref(), Some("u2:w9"));
    }

    #[test]
    fn scope_does_nothing_for_the_same_scope() {
        let (_, effects) = run(scoped(on()), vec![(T0, scope("u1", "w1"))]);
        assert!(effects.is_empty());
    }

    #[test]
    fn forget_drops_everything_and_the_scope_but_keeps_the_settings() {
        let settings = DesktopActivitySettings {
            excluded_apps: vec!["com.example.*".into()],
            retention_days: 30.0,
            ..on()
        };
        let (state, effects) = run(
            scoped(settings.clone()),
            vec![
                (T0, detect(target("org.other", "Other"))),
                (T0 + MIN, CaptureEvent::Forget),
            ],
        );
        assert!(appended(&effects).is_empty());
        assert!(effects.contains(&CaptureEffect::Wipe));
        assert_eq!(state.scope, None);
        assert_eq!(state.open, None);
        assert_eq!(state.settings, settings);
    }

    #[test]
    fn wipe_keeps_the_scope() {
        let (state, _) = run(
            scoped(on()),
            vec![(T0, detect(editor())), (T0 + MIN, CaptureEvent::Wipe)],
        );
        assert_eq!(state.scope.as_deref(), Some("u1:w1"));
        assert_eq!(state.open, None);
    }

    fn open_at(scope: &str) -> OpenSegment {
        OpenSegment {
            scope: scope.into(),
            key: "com.example.editor".into(),
            name: "Editor".into(),
            label: None,
            start: T0,
            last_seen: T0 + MIN,
        }
    }

    #[test]
    fn boot_closes_a_stale_open_segment_at_last_seen_and_keeps_a_fresh_one() {
        let open = open_at("u1:w1");
        let stale = step(
            &initial_capture_state(on(), Some("u1:w1".into()), Some(open.clone())),
            &CaptureEvent::Boot,
            T0 + 10.0 * MIN,
            &CTX,
        );
        assert_eq!(appended(&stale.effects)[0].end, T0 + MIN);
        assert_eq!(stale.state.open, None);
        let fresh = step(
            &initial_capture_state(on(), Some("u1:w1".into()), Some(open.clone())),
            &CaptureEvent::Boot,
            T0 + 2.0 * MIN,
            &CTX,
        );
        assert!(fresh.effects.is_empty());
        assert_eq!(fresh.state.open, Some(open));
    }

    #[test]
    fn boot_closes_an_open_segment_capture_no_longer_covers() {
        let off = step(
            &initial_capture_state(
                default_activity_settings(),
                Some("u1:w1".into()),
                Some(open_at("u1:w1")),
            ),
            &CaptureEvent::Boot,
            T0 + MIN,
            &CTX,
        );
        assert_eq!(off.state.open, None);
        assert_eq!(appended(&off.effects)[0].end, T0 + MIN);
    }

    #[test]
    fn boot_never_writes_an_open_segment_left_under_another_scope() {
        for scope in [Some("u1:w1".to_string()), None] {
            let result = step(
                &initial_capture_state(on(), scope, Some(open_at("u2:w1"))),
                &CaptureEvent::Boot,
                T0 + MIN,
                &CTX,
            );
            assert_eq!(result.state.open, None);
            assert!(appended(&result.effects).is_empty());
            assert!(result.effects.contains(&CaptureEffect::ClearOpen));
        }
    }
}
