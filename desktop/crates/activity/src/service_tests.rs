//! `service.test.ts` and `autopilot.test.ts`: the service against a temp
//! directory, the fake source and a pinned clock, driven through the same
//! test hook the e2e suite uses.

use std::cell::{RefCell, RefMut};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tyt_wire::{
    DesktopActivityAcceptCheck, DesktopActivityAcceptRefusal, DesktopActivityPaused,
    DesktopActivitySupport, DesktopActivityUnavailableReason, DesktopAutopilotAction,
    DesktopAutopilotHistoryEntry, DesktopAutopilotPlan, DesktopAutopilotRunning, DesktopFilingVia,
    False,
};

use crate::autopilot::{AppliedResult, Written, AUTOPILOT_PAUSE_MS, HOLD_BREAK_MS, SETTLE_MS};
use crate::core::{filing_key_of, ActivityInterval};
use crate::distribution::{ActivityCaptureMechanism, ActivityCaptureSupport};
use crate::ipc_parse::{
    CheckAcceptInput, HoldRequest, PlanInput, RuleInput, Scope, SettingsPatch, SuggestionsInput,
};
use crate::keys::FrontmostTarget;
use crate::model::PresenceState;
use crate::platform_source::Spawns;
use crate::protection::SharedCodec;
use crate::service::{ActivityService, ActivityServiceOptions, ProtectionStatusFn, SourceEvent};
use crate::source_fake::FakeFrontmostSource;
use crate::test_hook::{ActivityTestHook, HookClock, HookHost};

pub(crate) struct LocalHost {
    pub service: RefCell<ActivityService>,
    events: Arc<Mutex<Vec<SourceEvent>>>,
}

impl HookHost for LocalHost {
    fn with_service<R>(&self, f: impl FnOnce(&mut ActivityService) -> R) -> R {
        f(&mut self.service.borrow_mut())
    }
    fn settle(&self) {
        loop {
            let batch: Vec<SourceEvent> = std::mem::take(&mut *self.events.lock().unwrap());
            if batch.is_empty() {
                return;
            }
            for event in batch {
                self.service.borrow_mut().source_event(event).unwrap();
            }
        }
    }
}

pub(crate) struct Harness {
    pub user_data: PathBuf,
    pub clock: Arc<HookClock>,
    titles_available: bool,
    pub hook: ActivityTestHook<LocalHost>,
}

pub(crate) fn service_for(
    user_data: &Path,
    clock: Arc<HookClock>,
    fake: Arc<FakeFrontmostSource>,
    titles_available: bool,
    codec: Option<SharedCodec>,
    protection_status: Option<ProtectionStatusFn>,
) -> (ActivityService, Arc<Mutex<Vec<SourceEvent>>>) {
    let events: Arc<Mutex<Vec<SourceEvent>>> = Arc::default();
    let sink = events.clone();
    let service = ActivityService::new(ActivityServiceOptions {
        user_data: user_data.to_path_buf(),
        codec,
        protection_status,
        support: ActivityCaptureSupport::Supported(ActivityCaptureMechanism::MacosLsappinfo),
        titles_available,
        source: Some(fake),
        self_pid: 1,
        now: Arc::new(move || clock.now()),
        on_changed: Arc::new(|| {}),
        deliver: Arc::new(move |event| sink.lock().unwrap().push(event)),
    });
    (service, events)
}

impl Harness {
    pub fn new(user_data: &Path, titles_available: bool) -> Self {
        let clock = Arc::new(HookClock::default());
        clock.set(Some(T0));
        let hook = Self::make_hook(user_data, clock.clone(), titles_available);
        Harness {
            user_data: user_data.to_path_buf(),
            clock,
            titles_available,
            hook,
        }
    }

    fn make_hook(
        user_data: &Path,
        clock: Arc<HookClock>,
        titles_available: bool,
    ) -> ActivityTestHook<LocalHost> {
        let fake = Arc::new(FakeFrontmostSource::new());
        let (service, events) = service_for(
            user_data,
            clock.clone(),
            fake.clone(),
            titles_available,
            None,
            None,
        );
        let spawns: Spawns = Arc::default();
        ActivityTestHook {
            host: LocalHost {
                service: RefCell::new(service),
                events,
            },
            fake,
            spawns,
            clock,
        }
    }

    /// A restart: a new service over the same folder.
    pub fn boot(&mut self) {
        self.hook = Self::make_hook(&self.user_data, self.clock.clone(), self.titles_available);
    }

    pub fn svc(&self) -> RefMut<'_, ActivityService> {
        self.hook.host.service.borrow_mut()
    }

    pub fn now(&self) -> f64 {
        self.clock.now()
    }

    /// `target` in front from `from` to `to`, a detection every 30 s, and a
    /// heartbeat each minute when `heartbeat`.
    pub fn stay(&self, target: Option<FrontmostTarget>, from: f64, to: f64, heartbeat: bool) {
        self.hook.set_frontmost(target);
        let mut at = from;
        while at <= to {
            self.hook.set_now(Some(at));
            self.hook.tick();
            if heartbeat && (at - from) % MIN == 0.0 {
                self.hook.heartbeat().unwrap();
            }
            at += 30_000.0;
        }
    }

    pub fn segments(&self) -> Vec<Value> {
        self.hook.files().segments
    }

    pub fn set_scope(&self, user: &str, workspace: &str) {
        self.svc()
            .set_scope(&Scope {
                user_id: user.into(),
                workspace_id: workspace.into(),
            })
            .unwrap();
    }

    pub fn settings(&self, patch: SettingsPatch) -> tyt_wire::DesktopActivitySnapshot {
        self.svc().update_settings(&patch).unwrap()
    }
}

pub(crate) const MIN: f64 = 60_000.0;
/// `Date.UTC(2026, 8, 22, 9, 0, 0)`.
pub(crate) const T0: f64 = 1_790_067_600_000.0;

pub(crate) fn app(key: &str, name: &str) -> Option<FrontmostTarget> {
    Some(FrontmostTarget {
        key: key.into(),
        name: name.into(),
        title: None,
        pid: None,
    })
}

fn titled(key: &str, name: &str, title: &str) -> Option<FrontmostTarget> {
    Some(FrontmostTarget {
        key: key.into(),
        name: name.into(),
        title: Some(title.into()),
        pid: None,
    })
}

fn enabled() -> SettingsPatch {
    SettingsPatch {
        enabled: Some(true),
        ..Default::default()
    }
}

fn store_unsupported() -> DesktopActivitySupport {
    DesktopActivitySupport::unsupported(DesktopActivityUnavailableReason::Store, None)
}

fn key_of(segment: &Value) -> String {
    segment["key"].as_str().unwrap().to_string()
}

// ── service.test.ts ──────────────────────────────────────────────────

mod service {
    use super::*;

    #[test]
    fn is_off_by_default_and_never_starts_capture_on_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let h = Harness::new(dir.path(), true);
        let snapshot = h.svc().snapshot();
        assert!(!snapshot.settings.enabled);
        assert!(!snapshot.recording);
        // Even with an account, nothing records until the person turns it on.
        h.set_scope("u1", "w1");
        h.stay(
            app("com.example.editor", "Editor"),
            T0,
            T0 + 5.0 * MIN,
            true,
        );
        assert!(!h.hook.capturing());
        assert!(h.segments().is_empty());
        assert_eq!(h.hook.files().open, Value::Null);
    }

    #[test]
    fn needs_a_scope_as_well_as_the_switch() {
        let dir = tempfile::tempdir().unwrap();
        let h = Harness::new(dir.path(), true);
        h.settings(enabled());
        assert!(!h.hook.capturing());
        h.set_scope("u1", "w1");
        assert!(h.hook.capturing());
    }

    #[test]
    fn records_suggests_with_names_and_honours_dismissals_and_accepts() {
        let dir = tempfile::tempdir().unwrap();
        let h = Harness::new(dir.path(), true);
        h.set_scope("u1", "w1");
        h.settings(enabled());
        h.stay(
            app("com.example.editor", "Editor"),
            T0,
            T0 + 25.0 * MIN,
            true,
        );
        h.stay(
            app("com.example.chat", "Chat"),
            T0 + 25.0 * MIN + 30_000.0,
            T0 + 27.0 * MIN,
            true,
        );
        h.hook.set_frontmost(None);
        h.hook.set_now(Some(T0 + 27.0 * MIN + 30_000.0));
        h.hook.tick();

        let range = SuggestionsInput {
            from: T0 - 60.0 * MIN,
            to: T0 + 60.0 * MIN,
            tracked: vec![],
        };
        let suggestions = h.svc().suggestions(&range).unwrap();
        assert_eq!(suggestions.len(), 1);
        assert_eq!(suggestions[0].top_apps[0].name, "Editor");
        assert_eq!(suggestions[0].start, T0);

        let snapshot = h.svc().snapshot();
        assert_eq!(
            snapshot
                .recent_apps
                .iter()
                .map(|a| a.name.as_str())
                .collect::<Vec<_>>(),
            ["Chat", "Editor"]
        );
        assert!(snapshot.stored_segments >= 2);

        let end = T0 + 27.0 * MIN + 30_000.0;
        let check = h.svc().check_accept(&CheckAcceptInput {
            start: T0,
            end,
            edited: false,
            tracked: vec![],
        });
        assert!(matches!(check, DesktopActivityAcceptCheck::Ok { .. }));
        h.svc().mark_accepted(ActivityInterval { start: T0, end });
        assert_eq!(h.svc().suggestions(&range).unwrap(), vec![]);
        assert_eq!(
            h.svc().check_accept(&CheckAcceptInput {
                start: T0,
                end: T0 + 10.0 * MIN,
                edited: false,
                tracked: vec![]
            }),
            DesktopActivityAcceptCheck::Refused {
                ok: False,
                reason: DesktopActivityAcceptRefusal::AlreadyTracked
            }
        );
    }

    #[test]
    fn purges_an_app_that_is_excluded_and_strips_titles_when_they_go_off() {
        let dir = tempfile::tempdir().unwrap();
        let h = Harness::new(dir.path(), true);
        h.set_scope("u1", "w1");
        h.settings(SettingsPatch {
            enabled: Some(true),
            store_titles: Some(true),
            ..Default::default()
        });
        h.stay(
            titled("com.example.chat", "Chat", "DM with Sam"),
            T0,
            T0 + 3.0 * MIN,
            true,
        );
        h.stay(
            titled("com.example.editor", "Editor", "notes.md"),
            T0 + 3.0 * MIN + 30_000.0,
            T0 + 6.0 * MIN,
            true,
        );
        let chat = h
            .segments()
            .into_iter()
            .find(|s| key_of(s) == "com.example.chat")
            .unwrap();
        assert_eq!(chat["label"], "DM with Sam");

        h.settings(SettingsPatch {
            excluded_apps: Some(vec!["com.example.chat".into()]),
            ..Default::default()
        });
        assert!(!h.segments().iter().any(|s| key_of(s) == "com.example.chat"));

        h.settings(SettingsPatch {
            store_titles: Some(false),
            ..Default::default()
        });
        assert!(h.segments().iter().all(|s| s.get("label").is_none()));
        assert!(h
            .segments()
            .iter()
            .any(|s| key_of(s) == "com.example.editor"));
    }

    #[test]
    fn keeps_the_same_persons_other_workspace_drops_another_account_and_forgets_on_sign_out() {
        let dir = tempfile::tempdir().unwrap();
        let h = Harness::new(dir.path(), true);
        h.set_scope("u1", "w1");
        h.settings(enabled());
        h.stay(app("a", "A"), T0, T0 + 2.0 * MIN, true);
        h.set_scope("u1", "w2");
        h.stay(app("b", "B"), T0 + 3.0 * MIN, T0 + 5.0 * MIN, true);
        h.set_scope("u1", "w1");
        let mut scopes: Vec<String> = h
            .segments()
            .iter()
            .map(|s| s["scope"].as_str().unwrap().to_string())
            .collect();
        scopes.sort();
        scopes.dedup();
        assert_eq!(scopes, ["u1:w1", "u1:w2"]);

        h.set_scope("u2", "w1");
        assert!(h.segments().is_empty());

        h.stay(app("c", "C"), T0 + 6.0 * MIN, T0 + 8.0 * MIN, true);
        h.svc()
            .add_rule(&RuleInput {
                pattern: "c".into(),
                ..Default::default()
            })
            .unwrap();
        h.svc()
            .dismiss(ActivityInterval {
                start: T0,
                end: T0 + MIN,
            })
            .unwrap();
        h.svc().forget().unwrap();
        let files = h.hook.files();
        assert!(files.segments.is_empty());
        assert_eq!(files.open, Value::Null);
        assert_eq!(files.state["scope"], Value::Null);
        assert_eq!(files.state["rules"], Value::Array(vec![]));
        assert_eq!(files.state["dismissals"], Value::Array(vec![]));
        // Device preferences stay; capture simply has nobody to record for.
        assert_eq!(files.state["settings"]["enabled"], true);
        assert!(!h.hook.capturing());
    }

    #[test]
    fn pauses_on_idle_and_lock_and_stops_on_an_unsupported_channel() {
        let dir = tempfile::tempdir().unwrap();
        let h = Harness::new(dir.path(), true);
        h.set_scope("u1", "w1");
        h.settings(enabled());
        h.stay(app("a", "A"), T0, T0 + 2.0 * MIN, true);
        h.hook.set_now(Some(T0 + 2.0 * MIN + 10_000.0));
        h.hook.idle(PresenceState::Idle, Some(90.0)).unwrap();
        assert!(!h.hook.capturing());
        assert!(!h.svc().snapshot().recording);
        assert_eq!(
            h.segments()[0]["end"],
            T0 as i64 + 2 * 60_000 + 10_000 - 90_000
        );

        h.hook.idle(PresenceState::Active, None).unwrap();
        assert!(h.hook.capturing());

        h.hook.set_support(Some(store_unsupported())).unwrap();
        assert!(!h.hook.capturing());
        assert_eq!(h.svc().snapshot().support, store_unsupported());
    }

    #[test]
    fn closes_a_segment_left_open_by_a_previous_run_at_its_last_seen() {
        let dir = tempfile::tempdir().unwrap();
        let mut h = Harness::new(dir.path(), true);
        h.set_scope("u1", "w1");
        h.settings(enabled());
        h.stay(app("a", "A"), T0, T0 + 2.0 * MIN, true);
        h.svc().dispose();
        assert_ne!(h.hook.files().open, Value::Null);

        h.clock.set(Some(T0 + 60.0 * MIN));
        h.boot();
        assert_eq!(h.hook.files().open, Value::Null);
        assert_eq!(h.segments()[0]["end"], T0 as i64 + 2 * 60_000);
    }

    #[test]
    fn refuses_to_switch_capture_on_where_the_channel_must_not_record() {
        let dir = tempfile::tempdir().unwrap();
        let h = Harness::new(dir.path(), true);
        h.set_scope("u1", "w1");
        h.hook.set_support(Some(store_unsupported())).unwrap();
        let refused = h.settings(enabled());
        assert!(!refused.settings.enabled);
        assert!(!h.hook.capturing());
        assert_ne!(h.hook.files().state["settings"]["enabled"], true);

        // Everything else on the card still saves there.
        assert_eq!(
            h.settings(SettingsPatch {
                retention_days: Some(30.0),
                ..Default::default()
            })
            .settings
            .retention_days,
            30.0
        );

        h.hook.set_support(None).unwrap();
        assert!(h.settings(enabled()).settings.enabled);
        assert!(h.hook.capturing());
    }

    #[test]
    fn refuses_window_titles_on_an_os_that_cannot_give_them() {
        let dir = tempfile::tempdir().unwrap();
        let h = Harness::new(dir.path(), true);
        h.hook.set_titles_available(false);
        let snapshot = h.settings(SettingsPatch {
            enabled: Some(true),
            store_titles: Some(true),
            ..Default::default()
        });
        assert!(snapshot.settings.enabled);
        assert!(!snapshot.settings.store_titles);
        assert!(!snapshot.titles_available);

        h.hook.set_titles_available(true);
        assert!(
            h.settings(SettingsPatch {
                store_titles: Some(true),
                ..Default::default()
            })
            .settings
            .store_titles
        );
    }

    #[test]
    fn says_why_an_enabled_capture_is_not_recording() {
        let dir = tempfile::tempdir().unwrap();
        let h = Harness::new(dir.path(), true);
        h.settings(enabled());
        // No account yet: not a pause, there is nothing to record for.
        assert_eq!(h.svc().snapshot().paused, None);
        h.set_scope("u1", "w1");
        let snapshot = h.svc().snapshot();
        assert!(snapshot.recording);
        assert_eq!(snapshot.paused, None);

        h.hook.idle(PresenceState::Idle, Some(120.0)).unwrap();
        let snapshot = h.svc().snapshot();
        assert!(!snapshot.recording);
        assert_eq!(snapshot.paused, Some(DesktopActivityPaused::Idle));

        h.hook.idle(PresenceState::Locked, None).unwrap();
        assert_eq!(
            h.svc().snapshot().paused,
            Some(DesktopActivityPaused::Locked)
        );

        // Unlocked, but no input yet: nothing records, and it reads as idle.
        h.hook.idle(PresenceState::Idle, Some(30.0)).unwrap();
        let snapshot = h.svc().snapshot();
        assert!(!snapshot.recording);
        assert_eq!(snapshot.paused, Some(DesktopActivityPaused::Idle));

        h.hook.idle(PresenceState::Active, None).unwrap();
        assert!(h.svc().snapshot().recording);

        h.settings(SettingsPatch {
            enabled: Some(false),
            ..Default::default()
        });
        assert_eq!(h.svc().snapshot().paused, None);
    }
}

// ── autopilot.test.ts ────────────────────────────────────────────────

mod autopilot {
    use super::*;

    /// `Date.UTC(2026, 9, 19, 9, 0, 0)`.
    const T0: f64 = 1_792_400_400_000.0;

    fn figma() -> Option<FrontmostTarget> {
        app("com.figma.desktop", "Figma")
    }
    fn code() -> Option<FrontmostTarget> {
        app("com.microsoft.vscode", "Code")
    }
    fn chrome() -> Option<FrontmostTarget> {
        app("com.google.chrome", "Chrome")
    }

    fn website() -> Written {
        Written {
            description: "Website redesign".into(),
            project_id: Some("p-web".into()),
            task_id: None,
        }
    }
    fn api() -> Written {
        Written {
            description: "API work".into(),
            project_id: Some("p-api".into()),
            task_id: None,
        }
    }
    fn key(w: &Written) -> String {
        filing_key_of(
            Some(&w.description),
            w.project_id.as_deref(),
            w.task_id.as_deref(),
        )
    }
    fn running(start: f64, w: &Written) -> Option<DesktopAutopilotRunning> {
        Some(DesktopAutopilotRunning {
            start,
            description: w.description.clone(),
            project_id: w.project_id.clone(),
            task_id: w.task_id.clone(),
        })
    }

    fn harness(dir: &Path) -> Harness {
        let h = Harness::new(dir, false);
        h.clock.set(Some(T0));
        h
    }

    fn stay(h: &Harness, target: Option<FrontmostTarget>, from: f64, to: f64) {
        h.stay(target, from, to, false);
    }

    fn plan(
        h: &Harness,
        running: Option<DesktopAutopilotRunning>,
        tracked: Vec<ActivityInterval>,
    ) -> DesktopAutopilotPlan {
        h.svc()
            .autopilot_plan(&PlanInput { running, tracked })
            .unwrap()
    }

    fn set_up(h: &Harness) {
        h.set_scope("u1", "w1");
        h.settings(SettingsPatch {
            enabled: Some(true),
            autopilot: Some(true),
            ..Default::default()
        });
        let w = website();
        h.svc()
            .add_rule(&RuleInput {
                pattern: "com.figma.desktop".into(),
                description: Some(w.description.clone()),
                project_id: Some(w.project_id.clone()),
                ..Default::default()
            })
            .unwrap();
        let a = api();
        h.svc()
            .add_rule(&RuleInput {
                pattern: "com.microsoft.vscode".into(),
                description: Some(a.description.clone()),
                project_id: Some(a.project_id.clone()),
                ..Default::default()
            })
            .unwrap();
    }

    fn start_token(plan: &DesktopAutopilotPlan) -> (String, f64) {
        match plan {
            DesktopAutopilotPlan::Start { token, at, .. } => (token.clone(), *at),
            other => panic!("expected a start, got {other:?}"),
        }
    }

    fn applied(h: &Harness, token: &str, written: Option<Written>) {
        h.svc()
            .autopilot_applied(&AppliedResult {
                token: token.into(),
                ok: true,
                written,
            })
            .unwrap();
    }

    #[test]
    fn is_off_by_default_and_does_nothing_while_off() {
        let dir = tempfile::tempdir().unwrap();
        let h = harness(dir.path());
        h.set_scope("u1", "w1");
        h.settings(enabled());
        h.svc()
            .add_rule(&RuleInput {
                pattern: "com.figma.desktop".into(),
                description: Some("Website redesign".into()),
                ..Default::default()
            })
            .unwrap();
        stay(&h, figma(), T0, T0 + 10.0 * MIN);
        let snapshot = h.svc().snapshot();
        assert!(!snapshot.settings.autopilot);
        assert!(!snapshot.autopilot.active);
        assert_eq!(plan(&h, None, vec![]), DesktopAutopilotPlan::None);
    }

    #[test]
    fn needs_capture_on_as_well() {
        let dir = tempfile::tempdir().unwrap();
        let h = harness(dir.path());
        h.set_scope("u1", "w1");
        h.settings(SettingsPatch {
            autopilot: Some(true),
            ..Default::default()
        });
        assert!(!h.svc().snapshot().autopilot.active);
    }

    #[test]
    fn watches_then_starts_a_filed_apps_timer_dated_to_its_first_minute() {
        let dir = tempfile::tempdir().unwrap();
        let h = harness(dir.path());
        set_up(&h);
        stay(&h, figma(), T0, T0 + 3.0 * MIN);
        assert_eq!(plan(&h, None, vec![]), DesktopAutopilotPlan::None);
        let watched = h.svc().snapshot().autopilot.watch.unwrap();
        assert_eq!(watched.app.name, "Figma");
        assert_eq!(
            watched.filing.unwrap().fields.description.as_deref(),
            Some("Website redesign")
        );

        stay(&h, figma(), T0 + 3.0 * MIN + 30_000.0, T0 + 6.0 * MIN);
        match plan(&h, None, vec![]) {
            DesktopAutopilotPlan::Start {
                at, app, filing, ..
            } => {
                assert_eq!(at, T0);
                assert_eq!(app.name, "Figma");
                assert_eq!(filing.via, DesktopFilingVia::Rule);
                assert_eq!(filing.key, key(&website()));
            }
            other => panic!("expected a start, got {other:?}"),
        }
    }

    #[test]
    fn owns_the_timer_once_the_write_is_reported_and_switches_it_later() {
        let dir = tempfile::tempdir().unwrap();
        let h = harness(dir.path());
        set_up(&h);
        stay(&h, figma(), T0, T0 + 6.0 * MIN);
        let (token, _) = start_token(&plan(&h, None, vec![]));
        applied(&h, &token, Some(website()));
        let snapshot = h.svc().snapshot();
        assert_eq!(snapshot.autopilot.owned.unwrap().start, T0);
        assert_eq!(
            snapshot.autopilot.log[0].kind,
            DesktopAutopilotAction::Start
        );

        stay(&h, figma(), T0 + 6.0 * MIN + 30_000.0, T0 + 20.0 * MIN);
        stay(&h, code(), T0 + 20.0 * MIN + 30_000.0, T0 + 31.0 * MIN);
        match plan(&h, running(T0, &website()), vec![]) {
            DesktopAutopilotPlan::Switch { at, filing, .. } => {
                assert_eq!(filing.key, key(&api()));
                // The first minute of Code: the detection at 20:30.
                assert_eq!(at, T0 + 20.0 * MIN + 30_000.0);
            }
            other => panic!("expected a switch, got {other:?}"),
        }
    }

    #[test]
    fn does_not_read_a_lagging_renderer_as_a_stop_by_hand() {
        let dir = tempfile::tempdir().unwrap();
        let h = harness(dir.path());
        set_up(&h);
        stay(&h, figma(), T0, T0 + 6.0 * MIN);
        let (token, _) = start_token(&plan(&h, None, vec![]));
        applied(&h, &token, Some(website()));
        // The running entry has not shown up yet: nothing is decided or held.
        assert_eq!(plan(&h, None, vec![]), DesktopAutopilotPlan::None);
        assert!(h.svc().snapshot().autopilot.owned.is_some());
        assert_eq!(
            plan(&h, running(T0, &website()), vec![]),
            DesktopAutopilotPlan::None
        );
        assert!(h.svc().snapshot().autopilot.owned.is_some());
    }

    #[test]
    fn a_timer_edited_by_hand_is_the_persons() {
        let dir = tempfile::tempdir().unwrap();
        let h = harness(dir.path());
        set_up(&h);
        stay(&h, figma(), T0, T0 + 6.0 * MIN);
        let (token, _) = start_token(&plan(&h, None, vec![]));
        applied(&h, &token, Some(website()));
        plan(&h, running(T0, &website()), vec![]);
        let call = Written {
            description: "Client call".into(),
            ..website()
        };
        plan(&h, running(T0, &call), vec![]);
        assert!(h.svc().snapshot().autopilot.owned.is_none());
        stay(&h, code(), T0 + 6.0 * MIN + 30_000.0, T0 + 20.0 * MIN);
        assert_eq!(
            plan(&h, running(T0, &call), vec![]),
            DesktopAutopilotPlan::None
        );
    }

    #[test]
    fn a_timer_stopped_by_hand_is_not_restarted_until_a_break() {
        let dir = tempfile::tempdir().unwrap();
        let h = harness(dir.path());
        set_up(&h);
        stay(&h, figma(), T0, T0 + 6.0 * MIN);
        let (token, _) = start_token(&plan(&h, None, vec![]));
        applied(&h, &token, Some(website()));
        plan(&h, running(T0, &website()), vec![]);
        // Stopped by hand at 6:00; Figma stays in front.
        let tracked = vec![ActivityInterval {
            start: T0,
            end: T0 + 6.0 * MIN,
        }];
        stay(&h, figma(), T0 + 6.0 * MIN + 30_000.0, T0 + 16.0 * MIN);
        h.clock.set(Some(T0 + 16.0 * MIN + SETTLE_MS));
        assert_eq!(plan(&h, None, tracked.clone()), DesktopAutopilotPlan::None);
        assert!(h.svc().snapshot().autopilot.watch.unwrap().held);

        // A break, then Figma again: it starts.
        let back = T0 + 16.0 * MIN + HOLD_BREAK_MS + MIN;
        stay(&h, figma(), back, back + 6.0 * MIN);
        let (_, at) = start_token(&plan(&h, None, tracked));
        assert_eq!(at, back);
    }

    #[test]
    fn undo_holds_the_filing_and_treats_the_span_as_accounted_for() {
        let dir = tempfile::tempdir().unwrap();
        let h = harness(dir.path());
        set_up(&h);
        stay(&h, figma(), T0, T0 + 6.0 * MIN);
        let start = plan(&h, None, vec![]);
        let (token, _) = start_token(&start);
        let filing_key = match &start {
            DesktopAutopilotPlan::Start { filing, .. } => filing.key.clone(),
            _ => unreachable!(),
        };
        applied(&h, &token, Some(website()));
        let log_id = h.svc().snapshot().autopilot.log[0].id.clone();
        let dismiss = ActivityInterval {
            start: T0,
            end: h.now(),
        };
        h.svc()
            .autopilot_hold(&HoldRequest {
                filing_key: Some(filing_key),
                dismiss: Some(dismiss),
                log_id: Some(log_id),
                app_key: None,
            })
            .unwrap();
        let snapshot = h.svc().snapshot();
        assert!(snapshot.autopilot.owned.is_none());
        assert!(snapshot.autopilot.log[0].undone);
        stay(&h, figma(), T0 + 6.0 * MIN + 30_000.0, T0 + 14.0 * MIN);
        h.clock.set(Some(h.now() + SETTLE_MS));
        assert_eq!(plan(&h, None, vec![]), DesktopAutopilotPlan::None);
        assert_eq!(
            h.svc().suggestions(&SuggestionsInput {
                from: T0,
                to: T0 + 6.0 * MIN,
                tracked: vec![]
            }),
            Some(vec![])
        );
    }

    #[test]
    fn an_unknown_app_is_only_watched_and_not_work_holds_it() {
        let dir = tempfile::tempdir().unwrap();
        let h = harness(dir.path());
        set_up(&h);
        stay(&h, chrome(), T0, T0 + 10.0 * MIN);
        assert_eq!(plan(&h, None, vec![]), DesktopAutopilotPlan::None);
        let watched = h.svc().snapshot().autopilot.watch.unwrap();
        assert_eq!(watched.app.key, "com.google.chrome");
        assert_eq!(watched.filing, None);
        h.svc()
            .autopilot_hold(&HoldRequest {
                app_key: Some("com.google.chrome".into()),
                ..Default::default()
            })
            .unwrap();
        plan(&h, None, vec![]);
        assert!(h.svc().snapshot().autopilot.watch.unwrap().held);
    }

    #[test]
    fn learns_from_the_persons_entries() {
        let dir = tempfile::tempdir().unwrap();
        let h = harness(dir.path());
        h.set_scope("u1", "w1");
        h.settings(SettingsPatch {
            enabled: Some(true),
            autopilot: Some(true),
            ..Default::default()
        });
        stay(&h, chrome(), T0, T0 + 30.0 * MIN);
        h.svc().autopilot_learn(&[DesktopAutopilotHistoryEntry {
            start: T0,
            end: T0 + 30.0 * MIN,
            description: "Research".into(),
            project_id: Some("p-r".into()),
            task_id: None,
            tag_ids: vec![],
            billable: false,
        }]);
        assert_eq!(h.svc().snapshot().autopilot.learned_apps, 1);
        let later = T0 + 60.0 * MIN;
        stay(&h, chrome(), later, later + 6.0 * MIN);
        match plan(
            &h,
            None,
            vec![ActivityInterval {
                start: T0,
                end: T0 + 30.0 * MIN,
            }],
        ) {
            DesktopAutopilotPlan::Start { at, filing, .. } => {
                assert_eq!(filing.via, DesktopFilingVia::Learned);
                assert_eq!(at, later);
            }
            other => panic!("expected a start, got {other:?}"),
        }
    }

    #[test]
    fn keeps_its_timer_across_a_restart_and_forgets_it_on_sign_out() {
        let dir = tempfile::tempdir().unwrap();
        let mut h = harness(dir.path());
        set_up(&h);
        stay(&h, figma(), T0, T0 + 6.0 * MIN);
        let (token, _) = start_token(&plan(&h, None, vec![]));
        applied(&h, &token, Some(website()));
        h.svc().dispose();
        h.boot();
        assert_eq!(
            h.svc().snapshot().autopilot.owned.map(|o| o.start),
            Some(T0)
        );
        h.svc().forget().unwrap();
        assert!(h.svc().snapshot().autopilot.owned.is_none());
    }

    #[test]
    fn an_unknown_token_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let h = harness(dir.path());
        set_up(&h);
        applied(&h, "nope", None);
        assert!(h.svc().snapshot().autopilot.log.is_empty());
    }

    fn paused_until(h: &Harness) -> Option<f64> {
        h.svc().snapshot().autopilot.paused_until
    }

    #[test]
    fn a_pause_holds_every_decision_back_for_an_hour_then_autopilot_carries_on() {
        let dir = tempfile::tempdir().unwrap();
        let h = harness(dir.path());
        set_up(&h);
        stay(&h, figma(), T0, T0 + 3.0 * MIN);
        plan(&h, None, vec![]);
        assert!(h.svc().snapshot().autopilot.watch.is_some());

        h.svc().autopilot_pause(true).unwrap();
        let until = T0 + 3.0 * MIN + AUTOPILOT_PAUSE_MS;
        assert_eq!(paused_until(&h), Some(until));
        assert!(
            h.svc().snapshot().autopilot.watch.is_none(),
            "nothing is being watched while paused"
        );

        stay(&h, figma(), T0 + 3.0 * MIN + 30_000.0, T0 + 30.0 * MIN);
        assert_eq!(plan(&h, None, vec![]), DesktopAutopilotPlan::None);
        assert!(h.svc().snapshot().autopilot.watch.is_none());

        // The hour is up: the pause reads as none, and the work in front starts.
        stay(&h, figma(), T0 + 30.0 * MIN + 30_000.0, until + MIN);
        assert_eq!(paused_until(&h), None);
        start_token(&plan(&h, None, vec![]));
    }

    #[test]
    fn a_pause_leaves_autopilots_own_timer_running_and_its_own_and_still_notices_a_stop_by_hand() {
        let dir = tempfile::tempdir().unwrap();
        let h = harness(dir.path());
        set_up(&h);
        stay(&h, figma(), T0, T0 + 6.0 * MIN);
        let (token, _) = start_token(&plan(&h, None, vec![]));
        applied(&h, &token, Some(website()));
        plan(&h, running(T0, &website()), vec![]);
        h.svc().autopilot_pause(true).unwrap();

        // Code for long enough to switch: paused, it does not.
        stay(&h, code(), T0 + 6.0 * MIN + 30_000.0, T0 + 20.0 * MIN);
        assert_eq!(
            plan(&h, running(T0, &website()), vec![]),
            DesktopAutopilotPlan::None
        );
        assert_eq!(
            h.svc().snapshot().autopilot.owned.map(|o| o.start),
            Some(T0)
        );

        // Stopped by hand while paused: no longer Autopilot's.
        assert_eq!(
            plan(
                &h,
                None,
                vec![ActivityInterval {
                    start: T0,
                    end: T0 + 20.0 * MIN
                }]
            ),
            DesktopAutopilotPlan::None
        );
        assert!(h.svc().snapshot().autopilot.owned.is_none());
    }

    #[test]
    fn resume_ends_a_pause_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let h = harness(dir.path());
        set_up(&h);
        stay(&h, figma(), T0, T0 + 6.0 * MIN);
        h.svc().autopilot_pause(true).unwrap();
        assert_eq!(plan(&h, None, vec![]), DesktopAutopilotPlan::None);
        h.svc().autopilot_pause(false).unwrap();
        assert_eq!(paused_until(&h), None);
        start_token(&plan(&h, None, vec![]));
    }

    #[test]
    fn a_pause_is_not_offered_while_autopilot_is_off() {
        let dir = tempfile::tempdir().unwrap();
        let h = harness(dir.path());
        h.set_scope("u1", "w1");
        h.settings(enabled());
        h.svc().autopilot_pause(true).unwrap();
        h.settings(SettingsPatch {
            autopilot: Some(true),
            ..Default::default()
        });
        assert_eq!(paused_until(&h), None);
    }

    #[test]
    fn a_pause_survives_a_restart_a_workspace_switch_and_delete_all_activity() {
        let dir = tempfile::tempdir().unwrap();
        let mut h = harness(dir.path());
        set_up(&h);
        h.svc().autopilot_pause(true).unwrap();
        let until = h.now() + AUTOPILOT_PAUSE_MS;
        h.svc().dispose();
        h.boot();
        assert_eq!(paused_until(&h), Some(until));
        h.set_scope("u1", "w2");
        assert_eq!(
            paused_until(&h),
            Some(until),
            "the pause is the person's, not the workspace's"
        );
        h.svc().wipe().unwrap();
        assert_eq!(paused_until(&h), Some(until));
    }

    #[test]
    fn a_pause_ends_on_sign_out_on_another_account_and_when_autopilot_is_switched_off() {
        let dir = tempfile::tempdir().unwrap();
        let h = harness(dir.path());
        set_up(&h);
        h.svc().autopilot_pause(true).unwrap();
        h.svc().forget().unwrap();
        h.set_scope("u1", "w1");
        assert_eq!(
            paused_until(&h),
            None,
            "a sign-out ends it for good, not only while signed out"
        );

        h.svc().autopilot_pause(true).unwrap();
        h.set_scope("u2", "w9");
        h.set_scope("u1", "w1");
        assert_eq!(paused_until(&h), None);

        h.svc().autopilot_pause(true).unwrap();
        assert!(paused_until(&h).is_some());
        h.settings(SettingsPatch {
            autopilot: Some(false),
            ..Default::default()
        });
        h.settings(SettingsPatch {
            autopilot: Some(true),
            ..Default::default()
        });
        assert_eq!(paused_until(&h), None, "switching it back on means now");
    }
}
