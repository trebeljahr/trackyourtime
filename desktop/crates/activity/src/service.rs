//! Desktop activity capture, assembled (`service.ts`): the store, the state
//! machine, one source, and the operations the bridge offers. No shell
//! dependency — the bridge, the idle monitor and pushes are wired in
//! [`crate::install`] — so the whole service runs under `cargo test` against
//! a temp directory and the fake source.
//!
//! Every mutation takes `&mut self`, and the controller holds the service
//! behind one lock: a detection, a heartbeat and a settings change arriving
//! together must not each read "no open segment" and each open one (the
//! TypeScript's `serial()` queue).
//!
//! Capture never starts on its own. The source runs only while the person
//! turned capture on, an account is known, the channel supports it, the
//! store is this build's format, and they are neither idle nor locked
//! ([`should_capture`]). Nothing here turns `enabled` on except
//! [`ActivityService::update_settings`], which only the renderer calls.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tyt_wire::{
    DesktopActivityAcceptCheck, DesktopActivityAcceptRefusal, DesktopActivityPaused,
    DesktopActivityProtection, DesktopActivityRule, DesktopActivitySnapshot,
    DesktopActivitySuggestion, DesktopActivitySupport, DesktopActivityUnavailableReason,
    DesktopAutopilotHistoryEntry, DesktopAutopilotPlan, DesktopAutopilotState,
};

use crate::autopilot::{
    account_of_scope, random_uuid, AppliedResult, AutopilotController, AutopilotPause,
    AutopilotSink, HoldInput, OwnedTimer, PlanContext, AUTOPILOT_PAUSE_MS, AUTOPILOT_WINDOW_MS,
};
use crate::core::{host_matches_any, ActivityInterval, ActivityRule, ActivitySegment};
use crate::distribution::ActivityCaptureSupport;
use crate::ipc_parse::{
    CheckAcceptInput, HoldRequest, PlanInput, RuleInput, Scope, SettingsPatch, SuggestionsInput,
};
use crate::keys::FrontmostTarget;
use crate::model::{
    initial_capture_state, should_capture, step, CaptureContext, CaptureEffect, CaptureEvent,
    CaptureState, PresenceState, StoredSegment,
};
use crate::protection::SharedCodec;
use crate::settings::{parse_activity_settings, settings_value};
use crate::source::{FrontmostSource, SourceFailure, SourceKind, SourceListener};
use crate::store::{ActivityStore, Clock, Rewrite, StoreFiles, StoreStatus};
use crate::suggest::{
    accept_range, check_accept, compose_suggestions, live_accepted, names_of, recent_apps, refused,
    with_open_segment, AcceptedSpan, ComposeInput,
};

/// What the vault reports about encryption, for the snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProtectionStatus {
    pub encrypted: bool,
    pub locked: bool,
    pub trusted: bool,
    pub can_trust: bool,
}

pub type ProtectionStatusFn = Arc<dyn Fn() -> ProtectionStatus + Send + Sync>;

#[derive(Debug, Clone, PartialEq)]
pub enum SourceEventKind {
    Target(Option<FrontmostTarget>),
    Failure(Option<SourceFailure>),
}

/// What a source said, addressed to the service (and run) that started it.
/// Sources answer from their own threads; the owner hands each event back
/// to [`ActivityService::source_event`] under the service's lock, which is
/// the TypeScript's `void serial(…)` around every listener call.
#[derive(Debug, Clone, PartialEq)]
pub struct SourceEvent {
    pub service: u64,
    pub run: u64,
    pub kind: SourceEventKind,
}

pub type Deliver = Arc<dyn Fn(SourceEvent) + Send + Sync>;

pub struct ActivityServiceOptions {
    pub user_data: PathBuf,
    pub codec: Option<SharedCodec>,
    pub protection_status: Option<ProtectionStatusFn>,
    pub support: ActivityCaptureSupport,
    /// Whether this OS can record window titles after any required permission.
    pub titles_available: bool,
    /// None when the channel is unsupported: there is nothing to start.
    pub source: Option<Arc<dyn FrontmostSource>>,
    pub self_pid: i64,
    pub now: Clock,
    /// Called after any change a snapshot would show (the controller throttles it).
    pub on_changed: Arc<dyn Fn() + Send + Sync>,
    pub deliver: Deliver,
}

static NEXT_INSTANCE: AtomicU64 = AtomicU64::new(1);

impl AutopilotSink for ActivityStore {
    fn save_owned(&mut self, owned: Option<&OwnedTimer>) -> Result<(), String> {
        self.save_autopilot_owned(owned.cloned())
    }
    fn save_pause(&mut self, pause: Option<&AutopilotPause>) -> Result<(), String> {
        self.save_autopilot_pause(pause.cloned())
    }
}

pub struct ActivityService {
    instance: u64,
    store: ActivityStore,
    source: Option<Arc<dyn FrontmostSource>>,
    support: ActivityCaptureSupport,
    titles_available: bool,
    support_override: Option<DesktopActivitySupport>,
    runtime_failure: Option<SourceFailure>,
    source_running: bool,
    source_run: u64,
    accepted: Vec<AcceptedSpan>,
    disposed: bool,
    state: CaptureState,
    autopilot: AutopilotController,
    self_pid: i64,
    now: Clock,
    on_changed: Arc<dyn Fn() + Send + Sync>,
    deliver: Deliver,
    protection_status: Option<ProtectionStatusFn>,
}

fn warn(context: &str, error: &str) {
    eprintln!("[activity] {context}: {error}");
}

impl ActivityService {
    pub fn new(options: ActivityServiceOptions) -> Self {
        let store = ActivityStore::open(&options.user_data, options.now.clone(), options.codec);
        let state = initial_capture_state(store.settings(), store.scope(), store.read_open());
        let autopilot = AutopilotController::new(store.autopilot_owned(), store.autopilot_pause());
        let mut service = ActivityService {
            instance: NEXT_INSTANCE.fetch_add(1, Ordering::SeqCst),
            store,
            source: options.source,
            support: options.support,
            titles_available: options.titles_available,
            support_override: None,
            runtime_failure: None,
            source_running: false,
            source_run: 0,
            accepted: Vec::new(),
            disposed: false,
            state,
            autopilot,
            self_pid: options.self_pid,
            now: options.now,
            on_changed: options.on_changed,
            deliver: options.deliver,
            protection_status: options.protection_status,
        };
        let boot = (|| {
            service.apply(CaptureEvent::Boot)?;
            let (now, days) = (service.now(), service.state.settings.retention_days);
            service.store.prune(now, days).map(|_| ())
        })();
        if let Err(error) = boot {
            warn("boot failed", &error);
        }
        service
    }

    pub fn instance(&self) -> u64 {
        self.instance
    }

    fn now(&self) -> f64 {
        (self.now)()
    }

    fn changed(&self) {
        (self.on_changed)();
    }

    // ── support ─────────────────────────────────────────────────────

    fn channel_support(&self) -> DesktopActivitySupport {
        if let Some(support) = &self.support_override {
            return support.clone();
        }
        match self.support {
            ActivityCaptureSupport::Unsupported(reason) => {
                DesktopActivitySupport::unsupported(reason, None)
            }
            ActivityCaptureSupport::Supported(_) => DesktopActivitySupport::supported(),
        }
    }

    fn current_support(&self) -> DesktopActivitySupport {
        match self.store.status() {
            StoreStatus::Locked => {
                return DesktopActivitySupport::unsupported(
                    DesktopActivityUnavailableReason::EncryptedLocked,
                    None,
                )
            }
            StoreStatus::NewerFormat => {
                return DesktopActivitySupport::unsupported(
                    DesktopActivityUnavailableReason::NewerFormat,
                    None,
                )
            }
            StoreStatus::Ok => {}
        }
        let base = self.channel_support();
        if !base.is_supported() {
            return base;
        }
        if let Some(failure) = &self.runtime_failure {
            return DesktopActivitySupport::unsupported(
                failure.reason.wire(),
                failure.hint.clone(),
            );
        }
        base
    }

    fn ctx(&self) -> CaptureContext {
        CaptureContext {
            available: self.store.status() == StoreStatus::Ok
                && self.channel_support().is_supported()
                && self.source.is_some(),
            titles_available: self.titles_available,
            self_pid: self.self_pid,
        }
    }

    // ── applying a step ─────────────────────────────────────────────

    fn apply_effect(&mut self, effect: CaptureEffect) -> Result<(), String> {
        match effect {
            CaptureEffect::Append(segment) => self.store.append(segment),
            CaptureEffect::PersistOpen(open) => self.store.write_open(Some(&open)),
            CaptureEffect::ClearOpen => self.store.write_open(None),
            CaptureEffect::PurgeApps(patterns) => self
                .store
                .rewrite_segments(&mut |s| {
                    if host_matches_any(&patterns, &s.key) {
                        Rewrite::Delete
                    } else {
                        Rewrite::Keep
                    }
                })
                .map(|_| ()),
            CaptureEffect::StripLabels => self
                .store
                .rewrite_segments(&mut |s| match s.label {
                    None => Rewrite::Keep,
                    Some(_) => Rewrite::Replace(StoredSegment {
                        label: None,
                        ..s.clone()
                    }),
                })
                .map(|_| ()),
            CaptureEffect::SweepScopes(prefix) => {
                self.store.sweep_scopes(&prefix)?;
                // Holds, what was learned and the log belong to the previous
                // scope. A pause belongs to the person, so their other
                // workspace keeps it.
                self.autopilot.reset(Some(&prefix), &mut self.store)
            }
            CaptureEffect::Wipe => {
                self.store.wipe()?;
                self.accepted.clear();
                // "Delete all activity now" keeps the scope, and with it the
                // pause; a sign-out (`forget`) has already cleared the scope,
                // so it ends.
                let keep = self.state.scope.as_deref().map(account_of_scope);
                self.autopilot.reset(keep.as_deref(), &mut self.store)
            }
            CaptureEffect::Prune => {
                let (now, days) = (self.now(), self.state.settings.retention_days);
                self.store.prune(now, days).map(|_| ())
            }
            CaptureEffect::SaveState => self
                .store
                .save_state(self.state.settings.clone(), self.state.scope.clone()),
        }
    }

    fn sync_source(&mut self) {
        let Some(source) = self.source.clone() else {
            return;
        };
        let want = !self.disposed && should_capture(&self.state, &self.ctx());
        source.set_titles(self.state.settings.store_titles && self.titles_available);
        if want && !self.source_running {
            self.source_running = true;
            self.source_run += 1;
            let (service, run) = (self.instance, self.source_run);
            let (on_target, on_failure) = (self.deliver.clone(), self.deliver.clone());
            // Answers from a run that has since been stopped are dropped
            // where they are handled (`source_event`).
            source.start(SourceListener {
                target: Arc::new(move |target| {
                    on_target(SourceEvent {
                        service,
                        run,
                        kind: SourceEventKind::Target(target),
                    })
                }),
                failure: Arc::new(move |failure| {
                    on_failure(SourceEvent {
                        service,
                        run,
                        kind: SourceEventKind::Failure(failure),
                    })
                }),
            });
        } else if !want && self.source_running {
            self.source_running = false;
            self.runtime_failure = None;
            source.stop();
        }
    }

    fn apply(&mut self, event: CaptureEvent) -> Result<(), String> {
        if self.disposed {
            return Ok(());
        }
        let (idle, locked) = (self.state.idle, self.state.locked);
        let result = step(&self.state, &event, self.now(), &self.ctx());
        self.state = result.state;
        let had_effects = !result.effects.is_empty();
        for effect in result.effects {
            self.apply_effect(effect)?;
        }
        self.sync_source();
        if had_effects || idle != self.state.idle || locked != self.state.locked {
            self.changed();
        }
        Ok(())
    }

    /// One answer from the source, if it is still this service's current run.
    pub fn source_event(&mut self, event: SourceEvent) -> Result<(), String> {
        if event.service != self.instance || !self.source_running || event.run != self.source_run {
            return Ok(());
        }
        match event.kind {
            SourceEventKind::Target(target) => self.apply(CaptureEvent::Detect(target)),
            SourceEventKind::Failure(failure) => {
                let before = self.runtime_failure.as_ref().map(|f| f.reason);
                self.runtime_failure = failure.clone();
                // A source that cannot answer cannot vouch for the open segment.
                if failure.is_some() {
                    self.apply(CaptureEvent::Detect(None))?;
                }
                if before != failure.as_ref().map(|f| f.reason) {
                    self.changed();
                }
                Ok(())
            }
        }
    }

    // ── snapshot ────────────────────────────────────────────────────

    fn scope_segments(&mut self, scope: &str) -> Vec<StoredSegment> {
        let now = self.now();
        let stored = self.store.all_segments(scope);
        with_open_segment(stored, self.state.open.as_ref(), scope, now)
    }

    /// Autopilot can act: switched on, and capture is on for an account on a supported channel.
    fn autopilot_active(&self) -> bool {
        self.state.settings.autopilot
            && self.state.settings.enabled
            && self.state.scope.is_some()
            && self.store.status() == StoreStatus::Ok
            && self.current_support().is_supported()
    }

    fn autopilot_state(&self, at: f64) -> DesktopAutopilotState {
        self.autopilot
            .state(self.state.scope.as_deref(), self.autopilot_active(), at)
    }

    pub fn snapshot(&mut self) -> DesktopActivitySnapshot {
        let scope = self.state.scope.clone();
        let segments = match &scope {
            Some(scope) => self.scope_segments(scope),
            None => Vec::new(),
        };
        let support = self.current_support();
        let armed = self.state.settings.enabled && support.is_supported() && scope.is_some();
        // After an unlock nothing records until input is seen, so that reads as idle.
        let paused = if !armed {
            None
        } else if self.state.locked {
            Some(DesktopActivityPaused::Locked)
        } else if self.state.idle || self.state.awaiting_input {
            Some(DesktopActivityPaused::Idle)
        } else {
            None
        };
        let protection = self.protection_status.as_ref().map(|status| {
            let s = status();
            DesktopActivityProtection {
                encrypted: s.encrypted,
                locked: s.locked,
                trusted: Some(s.trusted),
                can_trust: Some(s.can_trust),
            }
        });
        let stored_segments = scope
            .as_deref()
            .map_or(0, |scope| self.store.count_segments(scope) as u64);
        let rules = scope
            .as_deref()
            .map(|scope| self.store.rules(scope))
            .unwrap_or_default();
        let now = self.now();
        DesktopActivitySnapshot {
            protection,
            titles_permission_required: None,
            settings: self.state.settings.clone(),
            support,
            titles_available: self.titles_available,
            scoped: scope.is_some(),
            recording: armed && paused.is_none(),
            paused,
            stored_segments,
            recent_apps: recent_apps(&segments),
            rules,
            autopilot: self.autopilot_state(now),
        }
    }

    fn compose(
        &mut self,
        scope: &str,
        from: f64,
        to: f64,
        tracked: &[ActivityInterval],
    ) -> Vec<DesktopActivitySuggestion> {
        let at = self.now();
        self.accepted = live_accepted(&self.accepted, at);
        let all = self.scope_segments(scope);
        let segments: Vec<StoredSegment> = all
            .iter()
            .filter(|s| s.end > from && s.start < to)
            .cloned()
            .collect();
        let names = names_of(&all);
        let mut holes = tracked.to_vec();
        holes.extend(self.store.dismissals(scope));
        holes.extend(self.accepted.iter().map(|a| ActivityInterval {
            start: a.start,
            end: a.end,
        }));
        let rules = self.store.rules(scope);
        compose_suggestions(ComposeInput {
            segments: &segments,
            names: &names,
            from,
            to,
            holes: &holes,
            rules: &rules,
        })
    }

    /// The scope, when the store can serve it.
    fn usable_scope(&self) -> Option<String> {
        self.state
            .scope
            .clone()
            .filter(|_| self.store.status() == StoreStatus::Ok)
    }

    // ── the bridge ──────────────────────────────────────────────────

    pub fn update_settings(
        &mut self,
        patch: &SettingsPatch,
    ) -> Result<DesktopActivitySnapshot, String> {
        if self.store.status() != StoreStatus::Ok {
            return Ok(self.snapshot());
        }
        let mut merged = self.state.settings.clone();
        if let Some(v) = patch.enabled {
            merged.enabled = v;
        }
        if let Some(v) = patch.store_titles {
            merged.store_titles = v;
        }
        if let Some(v) = &patch.excluded_apps {
            merged.excluded_apps = v.clone();
        }
        if let Some(v) = patch.retention_days {
            merged.retention_days = v;
        }
        if let Some(v) = patch.autopilot {
            merged.autopilot = v;
        }
        if let Some(v) = patch.autopilot_start_minutes {
            merged.autopilot_start_minutes = v;
        }
        let mut next = parse_activity_settings(Some(&settings_value(&merged)));
        // The renderer disables both switches where they cannot work; the
        // shell refuses them too, so no caller can switch capture on for a
        // channel that must not record (the stores, Snap, Flatpak, Wayland)
        // or store titles an OS cannot give. Turning off always works.
        if !self.channel_support().is_supported() {
            next.enabled = false;
        }
        if !self.titles_available {
            next.store_titles = false;
        }
        let autopilot_was_on = self.state.settings.autopilot;
        self.apply(CaptureEvent::Settings(next))?;
        // Switched off: a pause has nothing left to hold back, and switching
        // it on again later means "start now".
        if autopilot_was_on && !self.state.settings.autopilot {
            if let Some(scope) = self.state.scope.clone() {
                self.autopilot.pause(&scope, None, &mut self.store)?;
            }
        }
        Ok(self.snapshot())
    }

    pub fn set_scope(&mut self, scope: &Scope) -> Result<(), String> {
        // A newer build's folder: its own build runs the sweep when it next sees a change.
        if self.store.status() != StoreStatus::Ok {
            return Ok(());
        }
        if self.state.scope.as_deref()
            != Some(format!("{}:{}", scope.user_id, scope.workspace_id).as_str())
        {
            self.accepted.clear();
        }
        self.apply(CaptureEvent::Scope {
            user_id: scope.user_id.clone(),
            workspace_id: scope.workspace_id.clone(),
        })
    }

    pub fn forget(&mut self) -> Result<(), String> {
        self.accepted.clear();
        self.apply(CaptureEvent::Forget)
    }

    pub fn wipe(&mut self) -> Result<DesktopActivitySnapshot, String> {
        self.apply(CaptureEvent::Wipe)?;
        Ok(self.snapshot())
    }

    pub fn suggestions(
        &mut self,
        input: &SuggestionsInput,
    ) -> Option<Vec<DesktopActivitySuggestion>> {
        let scope = self.usable_scope()?;
        Some(self.compose(&scope, input.from, input.to, &input.tracked))
    }

    pub fn check_accept(&mut self, input: &CheckAcceptInput) -> DesktopActivityAcceptCheck {
        let Some(scope) = self.usable_scope() else {
            return refused(DesktopActivityAcceptRefusal::NoScope);
        };
        if !(input.end > input.start) {
            return refused(DesktopActivityAcceptRefusal::BadRange);
        }
        let (from, to) = accept_range(input.start, input.end, self.now());
        if !(to > from) {
            return refused(DesktopActivityAcceptRefusal::AlreadyTracked);
        }
        let rebuilt = self.compose(&scope, from, to, &input.tracked);
        check_accept(input.start, input.end, input.edited, &rebuilt)
    }

    pub fn mark_accepted(&mut self, span: ActivityInterval) {
        let now = self.now();
        self.accepted = live_accepted(&self.accepted, now);
        self.accepted.push(AcceptedSpan {
            start: span.start,
            end: span.end,
            at: now,
        });
        self.changed();
    }

    pub fn dismiss(&mut self, span: ActivityInterval) -> Result<bool, String> {
        let Some(scope) = self.usable_scope() else {
            return Ok(false);
        };
        self.store.add_dismissal(&scope, span)?;
        self.changed();
        Ok(true)
    }

    pub fn add_rule(&mut self, input: &RuleInput) -> Result<Vec<DesktopActivityRule>, String> {
        let Some(scope) = self.usable_scope() else {
            return Ok(Vec::new());
        };
        let rule = ActivityRule {
            id: random_uuid(),
            pattern: input.pattern.clone(),
            description: input.description.clone(),
            project_id: input.project_id.clone(),
            task_id: input.task_id.clone(),
            tag_ids: input.tag_ids.clone(),
            billable: input.billable,
        };
        let now = self.now();
        self.store.put_rule(&scope, rule, now)?;
        self.changed();
        Ok(self.store.rules(&scope))
    }

    pub fn remove_rule(&mut self, id: &str) -> Result<Vec<DesktopActivityRule>, String> {
        let Some(scope) = self.usable_scope() else {
            return Ok(Vec::new());
        };
        self.store.delete_rule(&scope, id)?;
        self.changed();
        Ok(self.store.rules(&scope))
    }

    /// The current rules, for a refused rule edit.
    pub fn rules(&mut self) -> Vec<DesktopActivityRule> {
        self.snapshot().rules
    }

    // ── Autopilot ───────────────────────────────────────────────────

    pub fn autopilot_learn(&mut self, history: &[DesktopAutopilotHistoryEntry]) {
        let Some(scope) = self.usable_scope() else {
            return;
        };
        let now = self.now();
        let before = self.autopilot_state(now);
        let segments: Vec<ActivitySegment> = self
            .scope_segments(&scope)
            .iter()
            .map(StoredSegment::as_core)
            .collect();
        self.autopilot.learn(&scope, history, &segments);
        if self.autopilot_state(now) != before {
            self.changed();
        }
    }

    pub fn autopilot_plan(&mut self, input: &PlanInput) -> Result<DesktopAutopilotPlan, String> {
        let Some(scope) = self.usable_scope() else {
            return Ok(DesktopAutopilotPlan::None);
        };
        let at = self.now();
        self.accepted = live_accepted(&self.accepted, at);
        let all = self.scope_segments(&scope);
        let before = self.autopilot_state(at);
        let segments: Vec<ActivitySegment> = all
            .iter()
            .filter(|s| s.end > at - AUTOPILOT_WINDOW_MS)
            .map(StoredSegment::as_core)
            .collect();
        let names = names_of(&all);
        let rules = self.store.rules(&scope);
        let mut holes = input.tracked.clone();
        holes.extend(self.store.dismissals(&scope));
        holes.extend(self.accepted.iter().map(|a| ActivityInterval {
            start: a.start,
            end: a.end,
        }));
        let active = self.autopilot_active();
        let plan = self.autopilot.plan(
            PlanContext {
                scope: &scope,
                now: at,
                settings: &self.state.settings,
                active,
                segments: &segments,
                names: &names,
                rules: &rules,
                holes: &holes,
                running: input.running.as_ref(),
            },
            &mut self.store,
        )?;
        if self.autopilot_state(at) != before {
            self.changed();
        }
        Ok(plan)
    }

    pub fn autopilot_applied(&mut self, result: &AppliedResult) -> Result<(), String> {
        let now = self.now();
        if self.autopilot.applied(result, now, &mut self.store)? {
            self.changed();
        }
        Ok(())
    }

    pub fn autopilot_hold(&mut self, input: &HoldRequest) -> Result<(), String> {
        let Some(scope) = self.usable_scope() else {
            return Ok(());
        };
        let hold = HoldInput {
            filing_key: input.filing_key.clone(),
            app_key: input.app_key.clone(),
            log_id: input.log_id.clone(),
        };
        let now = self.now();
        self.autopilot.hold(&scope, &hold, now, &mut self.store)?;
        // An undone start: that time is accounted for, so it is neither
        // started again nor offered as a suggestion.
        if let Some(dismiss) = input.dismiss {
            self.store.add_dismissal(&scope, dismiss)?;
        }
        self.changed();
        Ok(())
    }

    /// Pause for [`AUTOPILOT_PAUSE_MS`] while Autopilot is active, or resume.
    pub fn autopilot_pause(&mut self, paused: bool) -> Result<(), String> {
        let Some(scope) = self.usable_scope() else {
            return Ok(());
        };
        if paused {
            // Nothing to pause while it is off; the tray offers it only while on.
            if !self.autopilot_active() {
                return Ok(());
            }
            let until = self.now() + AUTOPILOT_PAUSE_MS;
            self.autopilot.pause(&scope, Some(until), &mut self.store)?;
        } else {
            self.autopilot.pause(&scope, None, &mut self.store)?;
        }
        self.changed();
        Ok(())
    }

    // ── driven by the controller ────────────────────────────────────

    pub fn heartbeat(&mut self) -> Result<(), String> {
        self.apply(CaptureEvent::Heartbeat)
    }

    pub fn presence(&mut self, state: PresenceState, idle_seconds: f64) -> Result<(), String> {
        self.apply(CaptureEvent::Presence {
            state,
            idle_seconds,
        })
    }

    pub fn prune(&mut self) -> Result<(), String> {
        let (now, days) = (self.now(), self.state.settings.retention_days);
        if self.store.prune(now, days)? > 0 {
            self.changed();
        }
        Ok(())
    }

    /// Persist the open segment and stop the source; used on quit. Idempotent.
    pub fn dispose(&mut self) {
        if self.disposed {
            return;
        }
        // The open segment keeps its lastSeen, so the next launch closes it
        // there — the time the app was not running was not spent in the app.
        if let Some(open) = &self.state.open {
            if let Err(error) = self.store.write_open(Some(open)) {
                warn("could not keep the open segment", &error);
            }
        }
        self.disposed = true;
        if self.source_running {
            if let Some(source) = &self.source {
                source.stop();
            }
        }
        self.source_running = false;
    }

    // ── test seams (the headless hook) ──────────────────────────────

    pub fn source_kind(&self) -> Option<SourceKind> {
        self.source.as_ref().map(|s| s.kind())
    }

    pub fn set_support_override(
        &mut self,
        support: Option<DesktopActivitySupport>,
    ) -> Result<(), String> {
        self.support_override = support;
        self.apply(CaptureEvent::Detect(None))?;
        self.changed();
        Ok(())
    }

    pub fn set_titles_available(&mut self, on: bool) {
        self.titles_available = on;
        self.sync_source();
        self.changed();
    }

    pub fn files(&self) -> StoreFiles {
        self.store.files()
    }
}
