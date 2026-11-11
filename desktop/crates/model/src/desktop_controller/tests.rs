//! The desktop controller against a recording platform: what e2e/desktop's
//! tray, shell and compact specs drive through the test hook, plus the
//! non-headless paths those specs cannot reach (a real tray, real
//! notifications, the badge, the jump list, the close button).

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tyt_wire::{channels, DesktopShortcutAction, DesktopUpdateDisabledReason};

use super::recording::{Recording, RecordingPlatform, SharedWindow};
use super::*;
use crate::login_item::MemoryLoginItem;
use crate::updater_controller::{MemoryUpdaterBackend, MemoryUpdaterCounts};
use crate::updater_model::UpdaterPolicy;

const START: &str = "2026-09-17T10:00:00.000Z";
const T0: i64 = 1_789_639_200_000;

struct Harness {
    controller: DesktopController,
    record: Arc<Mutex<Recording>>,
    window: Option<SharedWindow>,
    clock: Arc<AtomicI64>,
    dir: tempfile::TempDir,
    updater: Option<Arc<Mutex<MemoryUpdaterCounts>>>,
}

struct Setup {
    headless: bool,
    platform: &'static str,
    is_packaged: bool,
    policy: UpdaterPolicy,
    windowless: bool,
}

impl Default for Setup {
    fn default() -> Self {
        Setup {
            headless: true,
            platform: "darwin",
            is_packaged: true,
            policy: UpdaterPolicy::Disabled(DesktopUpdateDisabledReason::NoFeed),
            windowless: false,
        }
    }
}

fn build(setup: Setup, dir: tempfile::TempDir) -> Harness {
    let clock = Arc::new(AtomicI64::new(T0));
    let shared_clock = clock.clone();
    let platform = if setup.windowless {
        RecordingPlatform::windowless()
    } else {
        RecordingPlatform::new()
    };
    let record = platform.record.clone();
    let window = platform.window.clone();
    let backend = MemoryUpdaterBackend::new();
    let counts = backend.counts.clone();
    let enabled = setup.policy.enabled() && !setup.headless;
    let options = DesktopOptions {
        headless: setup.headless,
        platform: setup.platform.into(),
        user_data: dir.path().to_path_buf(),
        is_packaged: setup.is_packaged,
        exec_path: "C:\\Program Files\\Track Your Time\\Track Your Time.exe".into(),
        current_version: "0.1.0".into(),
        updater_policy: setup.policy,
        default_window_mode: DesktopWindowMode::Full,
        clock: Arc::new(move || shared_clock.load(Ordering::SeqCst)),
    };
    let controller = DesktopController::new(
        options,
        Box::new(platform),
        Box::new(MemoryLoginItem::default()),
        Box::new(move || -> Box<dyn UpdaterBackend> {
            assert!(
                enabled,
                "the updater loads only when updates are on and the run is not headless"
            );
            Box::new(backend)
        }),
    );
    Harness {
        controller,
        record,
        window,
        clock,
        dir,
        updater: enabled.then_some(counts),
    }
}

fn harness(setup: Setup) -> Harness {
    build(setup, tempfile::tempdir().unwrap())
}

fn headless() -> Harness {
    harness(Setup::default())
}

impl Harness {
    fn hook(&self, method: &str, arg: Value) -> Value {
        self.controller.test_call(method, arg).unwrap()
    }

    fn call(&self, channel: &str, arg: Value) -> Value {
        self.controller.call(channel, vec![arg]).unwrap()
    }

    fn record(&self) -> std::sync::MutexGuard<'_, Recording> {
        self.record.lock().unwrap()
    }

    fn set_now(&self, now: i64) {
        self.clock.store(now, Ordering::SeqCst);
    }

    fn publish(&self, state: Value) {
        self.call(channels::DESKTOP_PUBLISH_STATE, state);
    }

    fn tray_ids(&self) -> Vec<String> {
        self.hook("trayMenu", Value::Null)
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["type"] == "item")
            .map(|item| item["id"].as_str().unwrap().to_string())
            .collect()
    }

    fn registered(&self) -> Vec<String> {
        let mut list: Vec<String> =
            serde_json::from_value(self.hook("registered", Value::Null)).unwrap();
        list.sort();
        list
    }

    fn update_settings(&self, patch: Value) -> Value {
        self.call(channels::DESKTOP_SETTINGS_UPDATE, patch)
    }

    fn commands(&self) -> Vec<Value> {
        self.hook("commands", Value::Null)
            .as_array()
            .unwrap()
            .clone()
    }

    fn reveals(&self) -> u64 {
        self.hook("reveals", Value::Null).as_u64().unwrap()
    }
}

fn signed_in(extra: Value) -> Value {
    let mut state = json!({
        "signedIn": true,
        "running": null,
        "recents": [{"key": "k1", "label": "Tray recent", "hint": null}],
        "unsent": 0,
        "labels": {},
    });
    if let (Value::Object(base), Value::Object(extra)) = (&mut state, extra) {
        base.extend(extra);
    }
    state
}

fn running() -> Value {
    signed_in(
        json!({"running": {"description": "Tray recent", "startedAt": START, "projectName": null, "projectColor": null}}),
    )
}

#[test]
fn headless_registers_only_the_default_and_nothing_with_the_os() {
    let h = headless();
    assert_eq!(h.registered(), ["CommandOrControl+Alt+Shift+Space"]);
    assert!(h.record().registered.is_empty());
    assert!(h.record().tray_updates.is_empty(), "no tray icon headless");
    assert_eq!(h.tray_ids(), ["open", "quit"]);
}

#[test]
fn the_toggle_shortcut_shows_the_app_signed_out_and_toggles_signed_in_without_a_window() {
    let h = headless();
    h.hook("trigger", json!("toggle-timer"));
    assert_eq!(h.reveals(), 1, "signed out: nobody to ask, show the app");
    assert!(h.commands().is_empty());

    h.publish(signed_in(json!({})));
    h.hook("trigger", json!("toggle-timer"));
    h.hook("trigger", json!("toggle-timer"));
    assert_eq!(
        h.reveals(),
        1,
        "neither press showed or asked for the window"
    );
    assert_eq!(
        h.commands(),
        [json!({"kind": "toggle"}), json!({"kind": "toggle"})]
    );
    assert_eq!(
        h.record().emitted_on(channels::DESKTOP_COMMAND).len(),
        2,
        "and they reached the renderer"
    );
    assert_eq!(h.record().reveals, 0, "headless never shows the window");
    h.hook("trigger", json!("bogus"));
    assert_eq!(h.commands().len(), 2);
}

#[test]
fn new_timer_and_the_palette_reveal_and_ask_the_renderer_only_signed_in() {
    let h = headless();
    h.hook("trigger", json!("new-timer"));
    h.hook("trigger", json!("open-palette"));
    assert_eq!(h.reveals(), 2);
    assert!(h.commands().is_empty());
    h.publish(signed_in(json!({})));
    h.controller.trigger(DesktopShortcutAction::NewTimer);
    h.controller.trigger(DesktopShortcutAction::OpenPalette);
    assert_eq!(
        h.commands(),
        [json!({"kind": "compose"}), json!({"kind": "open-palette"})]
    );
}

#[test]
fn the_tray_offers_recents_and_continue_sends_the_key() {
    let h = headless();
    h.publish(signed_in(json!({})));
    let menu = h.hook("trayMenu", Value::Null);
    let item = menu
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["label"] == "Tray recent")
        .unwrap()
        .clone();
    assert_eq!(
        item,
        json!({"type": "item", "id": "continue:k1", "label": "Tray recent", "enabled": true})
    );
    assert!(!h.tray_ids().contains(&"stop".to_string()));
    h.hook("clickTray", json!("continue:k1"));
    assert_eq!(h.commands(), [json!({"kind": "continue", "key": "k1"})]);

    h.publish(running());
    assert!(h.tray_ids().contains(&"stop".to_string()));
    h.set_now(T0 + 125_000);
    assert_eq!(
        h.hook("trayTooltip", Value::Null),
        json!("Tray recent — 2m")
    );
    assert_eq!(h.hook("trayTitle", json!(T0 + 3_700_000)), json!("1h 01m"));
    h.hook("clickTray", json!("stop"));
    assert_eq!(h.commands().last().unwrap(), &json!({"kind": "stop"}));
}

#[test]
fn the_state_hook_reports_what_the_parser_kept() {
    let h = headless();
    assert_eq!(h.hook("state", Value::Null), Value::Null);
    h.publish(running());
    let state = h.hook("state", Value::Null);
    assert_eq!(state["running"]["description"], "Tray recent");
    assert_eq!(state["autopilot"], Value::Null);
    assert!(
        state.as_object().unwrap().contains_key("autopilot"),
        "present and null, as parseTimerState wrote it"
    );
    h.publish(json!({"signedIn": false}));
    assert_eq!(h.hook("state", Value::Null)["running"], Value::Null);
    h.publish(json!("garbage"));
    assert_eq!(
        h.hook("state", Value::Null)["signedIn"],
        false,
        "a malformed payload is ignored"
    );
}

#[test]
fn menu_items_reach_the_renderer_and_the_window() {
    let h = headless();
    h.publish(signed_in(json!({})));
    h.hook("clickTray", json!("start"));
    h.hook("clickTray", json!("edit"));
    h.hook("clickTray", json!("settings"));
    assert_eq!(
        h.commands(),
        [
            json!({"kind": "compose"}),
            json!({"kind": "compose"}),
            json!({"kind": "open-settings"})
        ]
    );
    assert_eq!(h.reveals(), 3);
    h.hook("clickTray", json!("autopilot-pause"));
    h.hook("clickTray", json!("autopilot-resume"));
    assert_eq!(
        h.record().autopilot_pauses,
        [true, false],
        "the pause goes straight to Autopilot"
    );
    h.hook("clickTray", json!("quit"));
    assert_eq!(h.record().quits, 1);
}

#[test]
fn a_notification_is_recorded_while_hidden_and_its_click_opens_the_prompt() {
    let h = headless();
    let notice = json!({"kind": "runaway", "title": "Still running", "body": "“Forgot to stop” is still running.", "tag": "runaway"});
    assert_eq!(
        h.call(channels::DESKTOP_NOTIFY, notice.clone()),
        json!(true)
    );
    assert_eq!(h.hook("notifications", Value::Null), json!([notice]));
    let before = h.reveals();
    h.hook("clickNotification", json!(0));
    assert_eq!(h.reveals(), before + 1);
    assert_eq!(
        h.commands(),
        [json!({"kind": "open-prompt", "prompt": "runaway"})]
    );
    h.hook("clickNotification", json!(5));
    assert_eq!(h.reveals(), before + 1, "no such notice");

    // A window in front gets no notification: the prompt is already on screen.
    h.hook("pretendFocused", json!(true));
    assert_eq!(
        h.call(
            channels::DESKTOP_NOTIFY,
            json!({"kind": "idle", "title": "In front", "body": "", "tag": "idle"})
        ),
        json!(false)
    );
    h.hook("pretendFocused", json!(false));
    assert_eq!(
        h.call(
            channels::DESKTOP_NOTIFY,
            json!({"kind": "other", "title": "x"})
        ),
        json!(false)
    );
    assert!(
        h.record().notifications.is_empty(),
        "nothing posted to the OS headless"
    );
}

#[test]
fn the_running_badge_follows_its_setting_and_the_timer_and_the_login_item_stays_in_memory() {
    let h = headless();
    h.publish(running());
    assert_eq!(h.hook("badge", Value::Null), json!(false));
    let update = h.update_settings(json!({"runningBadge": true, "openAtLogin": true}));
    assert_eq!(update["snapshot"]["loginItem"], "enabled");
    assert_eq!(update["snapshot"]["settings"]["openAtLogin"], true);
    assert_eq!(update["refused"], json!([]));
    assert_eq!(h.hook("badge", Value::Null), json!(true));
    h.publish(signed_in(json!({})));
    assert_eq!(h.hook("badge", Value::Null), json!(false));
    assert!(
        h.record().badge.is_empty(),
        "no badge reaches the Dock headless"
    );
    assert_eq!(
        h.record()
            .emitted_on(channels::DESKTOP_SETTINGS_CHANGED)
            .len(),
        1
    );
}

#[test]
fn settings_rebind_refuse_a_taken_chord_clear_persist_and_relaunch() {
    let h = headless();
    // Recording suspends every registration so the press reaches the page.
    h.call(channels::DESKTOP_SUSPEND_SHORTCUTS, json!(true));
    assert!(h.registered().is_empty());
    let changed = h.record().emitted_on(channels::DESKTOP_SETTINGS_CHANGED);
    assert_eq!(changed.last().unwrap()["shortcutsSuspended"], true);
    h.update_settings(json!({"shortcuts": {"new-timer": "ctrl+alt+n"}}));
    assert!(h.registered().is_empty(), "kept while suspended");
    h.call(channels::DESKTOP_SUSPEND_SHORTCUTS, json!(false));
    assert_eq!(
        h.registered(),
        ["CommandOrControl+Alt+Shift+Space", "Control+Alt+N"]
    );

    // A chord another application holds is saved but reported, not swallowed.
    h.hook("takeChord", json!("Control+Alt+K"));
    let taken = h.update_settings(json!({"shortcuts": {"open-palette": "Control+Alt+K"}}));
    let status = taken["snapshot"]["shortcuts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["action"] == "open-palette")
        .unwrap()
        .clone();
    assert_eq!(
        status,
        json!({"action": "open-palette", "accelerator": "Control+Alt+K", "registered": false, "problem": "taken"})
    );
    assert!(!h.registered().contains(&"Control+Alt+K".to_string()));

    // A duplicate and an invalid chord are refused and not saved.
    let refused = h.update_settings(
        json!({"shortcuts": {"toggle-window": "Control+Alt+N", "new-timer": "Shift+A"}}),
    );
    let problems: Vec<_> = refused["refused"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["problem"].clone())
        .collect();
    assert_eq!(problems.len(), 2);
    assert!(problems.contains(&json!("duplicate")) && problems.contains(&json!("invalid")));

    // Rebind it to a free chord, then run it: the palette opens in the window.
    h.update_settings(json!({"shortcuts": {"open-palette": "Control+Alt+P"}}));
    assert!(h.registered().contains(&"Control+Alt+P".to_string()));
    h.publish(signed_in(json!({})));
    h.hook("trigger", json!("open-palette"));
    assert_eq!(
        h.commands().last().unwrap(),
        &json!({"kind": "open-palette"})
    );

    // Clearing the default unregisters it.
    h.update_settings(json!({"shortcuts": {"toggle-timer": null}}));
    assert!(!h
        .registered()
        .contains(&"CommandOrControl+Alt+Shift+Space".to_string()));

    let stored: Value = serde_json::from_str(
        &fs::read_to_string(h.dir.path().join("desktop-settings.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        stored["shortcuts"],
        json!({"toggle-timer": null, "new-timer": "Control+Alt+N", "toggle-window": null, "open-palette": "Control+Alt+P"})
    );

    // A relaunch registers what was saved, before any page asks.
    let Harness {
        controller, dir, ..
    } = h;
    drop(controller);
    let relaunched = build(Setup::default(), dir);
    assert_eq!(relaunched.registered(), ["Control+Alt+N", "Control+Alt+P"]);
}

#[test]
fn a_suspension_ends_on_its_own_after_a_minute_or_when_the_renderer_resets() {
    let h = headless();
    h.call(channels::DESKTOP_SUSPEND_SHORTCUTS, json!(true));
    h.controller.tick(T0 + SUSPEND_LIMIT_MS - 1);
    assert!(h.registered().is_empty());
    h.controller.tick(T0 + SUSPEND_LIMIT_MS);
    assert_eq!(h.registered(), ["CommandOrControl+Alt+Shift+Space"]);
    assert_eq!(
        h.record()
            .emitted_on(channels::DESKTOP_SETTINGS_CHANGED)
            .last()
            .unwrap()["shortcutsSuspended"],
        false
    );

    h.call(channels::DESKTOP_SUSPEND_SHORTCUTS, json!(true));
    h.controller.renderer_reset();
    assert_eq!(
        h.registered(),
        ["CommandOrControl+Alt+Shift+Space"],
        "a reload cannot finish recording"
    );
    let broadcasts = h
        .record()
        .emitted_on(channels::DESKTOP_SETTINGS_CHANGED)
        .len();
    h.controller.renderer_reset();
    assert_eq!(
        h.record()
            .emitted_on(channels::DESKTOP_SETTINGS_CHANGED)
            .len(),
        broadcasts,
        "nothing to resume"
    );
}

#[test]
fn an_update_waits_for_the_person_restart_in_the_tray_and_settings_never_on_its_own() {
    let h = headless();
    h.publish(signed_in(json!({})));
    assert_eq!(
        h.call(channels::UPDATE_GET_STATUS, Value::Null)["status"],
        json!({"kind": "idle", "lastCheckedAt": null})
    );
    h.call(channels::UPDATE_CHECK, Value::Null);
    assert_eq!(h.hook("update.checks", Value::Null), json!(1));
    assert!(!h.tray_ids().contains(&"restart-to-update".to_string()));

    h.hook(
        "update.dispatch",
        json!({"kind": "available", "version": "9.9.9"}),
    );
    assert_eq!(
        h.hook("update.snapshot", Value::Null)["status"],
        json!({"kind": "downloading", "version": "9.9.9", "percent": null})
    );
    h.hook(
        "update.dispatch",
        json!({"kind": "downloaded", "version": "9.9.9"}),
    );
    assert!(h.tray_ids().contains(&"restart-to-update".to_string()));
    let pushed = h.record().emitted_on(channels::UPDATE_STATUS_CHANGED);
    assert_eq!(
        pushed.last().unwrap()["status"],
        json!({"kind": "ready", "version": "9.9.9"})
    );

    // Downloaded, announced, and nothing restarted, however long it waits.
    h.controller.tick(T0 + 24 * 3_600_000);
    assert_eq!(h.hook("update.installs", Value::Null), json!(0));
    assert_eq!(
        h.hook("update.checks", Value::Null),
        json!(1),
        "no timer checks headless"
    );

    // The tray item and the button each install exactly once when clicked.
    h.hook("clickTray", json!("restart-to-update"));
    assert_eq!(h.hook("update.installs", Value::Null), json!(1));
    assert_eq!(h.call(channels::UPDATE_RESTART, Value::Null), json!(true));
    assert_eq!(h.hook("update.installs", Value::Null), json!(2));
    assert!(h
        .controller
        .test_call("update.dispatch", json!({"kind": "nope"}))
        .unwrap_err()
        .starts_with("Invalid updater event"));
}

#[test]
fn quitting_with_unsent_changes_names_them_once_and_never_during_shutdown() {
    let h = headless();
    h.publish(signed_in(json!({
        "unsent": 2,
        "labels": {"quitUnsentTitle": "2 changes are not sent yet", "quitUnsentBody": "They stay on this computer."}
    })));
    h.hook("beforeQuit", Value::Null);
    h.controller.before_quit();
    assert_eq!(
        h.hook("quitNotices", Value::Null),
        json!([{"title": "2 changes are not sent yet", "body": "They stay on this computer."}])
    );

    let quiet = headless();
    quiet.publish(signed_in(json!({"unsent": 2})));
    quiet.controller.system_shutdown();
    quiet.controller.before_quit();
    assert_eq!(quiet.hook("quitNotices", Value::Null), json!([]));

    let nothing = headless();
    nothing.publish(signed_in(json!({"unsent": 0})));
    nothing.controller.before_quit();
    assert_eq!(nothing.hook("quitNotices", Value::Null), json!([]));

    let shown = harness(Setup {
        headless: false,
        ..Setup::default()
    });
    shown.publish(signed_in(json!({"unsent": 1})));
    shown.controller.before_quit();
    assert_eq!(shown.record().quit_notices.len(), 1);
    assert_eq!(shown.record().quit_notices[0].2, "Quit");
}

#[test]
fn the_test_hook_exists_only_headless() {
    let h = harness(Setup {
        headless: false,
        ..Setup::default()
    });
    assert!(h.controller.test_call("state", Value::Null).is_err());
    assert!(headless()
        .controller
        .test_call("nope", Value::Null)
        .is_err());
}

#[test]
fn unknown_channels_are_refused() {
    let h = headless();
    assert_eq!(
        h.controller.call("desktop:nope", vec![]).unwrap_err(),
        "No handler registered for 'desktop:nope'"
    );
}

#[test]
fn a_real_tray_is_drawn_from_state_and_redrawn_only_when_something_changed() {
    let h = harness(Setup {
        headless: false,
        ..Setup::default()
    });
    {
        let record = h.record();
        let first = &record.tray_updates[0];
        assert!(first.create);
        assert_eq!(first.icon, Some((TrayIconVariant::Idle, "tray-mac.png")));
        assert_eq!(first.title.as_deref(), Some(""));
        assert_eq!(first.tooltip.as_deref(), Some("Track Your Time"));
        let ids: Vec<_> = record
            .tray
            .as_ref()
            .unwrap()
            .menu
            .iter()
            .filter_map(|i| match i {
                TrayMenuItem::Item { id, .. } => Some(id.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(ids, ["open", "quit"]);
    }
    h.publish(running());
    assert_eq!(h.record().tray.as_ref().unwrap().icon_file, "tray-mac.png");
    assert_eq!(h.record().tray.as_ref().unwrap().title, "<1m");
    assert!(h.controller.wants_tick(), "a running clock ticks");

    h.controller.tick(T0 + 125_000);
    assert_eq!(h.record().tray.as_ref().unwrap().title, "2m");
    assert_eq!(
        h.record().tray.as_ref().unwrap().tooltip,
        "Tray recent — 2m"
    );
    let updates = h.record().tray_updates.len();
    h.controller.tick(T0 + 126_000);
    assert_eq!(
        h.record().tray_updates.len(),
        updates,
        "nothing moved, nothing redrawn"
    );
    assert_eq!(
        h.record().tray_updates.iter().filter(|u| u.create).count(),
        1
    );
}

#[test]
fn windows_and_linux_carry_the_clock_in_the_tooltip_only() {
    for platform in ["linux", "win32"] {
        let h = harness(Setup {
            headless: false,
            platform,
            ..Setup::default()
        });
        h.publish(running());
        let record = h.record();
        assert!(
            record.tray_updates.iter().all(|u| u.title.is_none()),
            "{platform}"
        );
        let icon = if platform == "win32" {
            "tray-running.ico"
        } else {
            "tray-running.png"
        };
        assert_eq!(record.tray.as_ref().unwrap().icon_file, icon);
    }
}

#[test]
fn raycast_and_the_tray_setting_take_the_tray_down() {
    let h = harness(Setup {
        headless: false,
        ..Setup::default()
    });
    h.controller.raycast_menu_changed(true);
    assert_eq!(h.record().tray_destroys, 1);
    assert!(h.record().tray.is_none());
    h.controller.raycast_menu_changed(false);
    assert!(h.record().tray_updates.last().unwrap().create, "recreated");
    h.update_settings(json!({"showInTray": false}));
    assert_eq!(h.record().tray_destroys, 2);
    assert_eq!(h.hook_menu_if_any(), None);
}

impl Harness {
    /// Non-headless: what the tray shows, or None without one.
    fn hook_menu_if_any(&self) -> Option<Vec<TrayMenuItem>> {
        self.record().tray.as_ref().map(|t| t.menu.clone())
    }
}

#[test]
fn hook_tray_menu_is_null_with_the_tray_off() {
    let h = headless();
    h.update_settings(json!({"showInTray": false}));
    assert_eq!(h.hook("trayMenu", Value::Null), Value::Null);
}

#[test]
fn real_notifications_replace_by_tag_post_only_when_not_in_front_and_click_by_tag() {
    let h = harness(Setup {
        headless: false,
        ..Setup::default()
    });
    h.publish(signed_in(json!({})));
    let idle = json!({"kind": "idle", "title": "Away", "body": "24 min"});
    assert_eq!(h.call(channels::DESKTOP_NOTIFY, idle.clone()), json!(true));
    assert_eq!(h.call(channels::DESKTOP_NOTIFY, idle.clone()), json!(true));
    assert_eq!(h.record().notifications.len(), 2);
    assert_eq!(
        h.record().closed_notifications,
        ["idle"],
        "a tag replaces the earlier notice"
    );

    h.controller.notification_clicked("idle");
    assert_eq!(h.record().reveals, 1);
    let sent = h.record().emitted_on(channels::DESKTOP_COMMAND);
    assert_eq!(
        sent.last().unwrap(),
        &json!({"kind": "open-prompt", "prompt": "idle"})
    );
    // Revealed: visible and focused now, so the next one is not posted.
    assert_eq!(h.call(channels::DESKTOP_NOTIFY, idle.clone()), json!(false));
    h.window.as_ref().unwrap().get().minimized = true;
    assert_eq!(
        h.call(channels::DESKTOP_NOTIFY, idle.clone()),
        json!(true),
        "a minimized window is not in front"
    );

    h.controller.notification_closed("idle");
    h.controller.notification_clicked("idle");
    assert_eq!(
        h.record().reveals,
        1,
        "a closed notification has nothing to open"
    );

    h.window.as_ref().unwrap().get().visible = false;
    h.record().notifications_unsupported = true;
    assert_eq!(h.call(channels::DESKTOP_NOTIFY, idle), json!(false));
}

#[test]
fn a_real_badge_is_set_once_per_change_with_the_label() {
    let h = harness(Setup {
        headless: false,
        platform: "win32",
        ..Setup::default()
    });
    h.update_settings(json!({"runningBadge": true}));
    h.publish(running());
    h.publish(running());
    h.publish(signed_in(json!({})));
    assert_eq!(
        h.record().badge,
        [(true, "Timer running".to_string()), (false, String::new())]
    );
}

#[test]
fn toggle_window_hides_a_window_in_front_and_reveals_otherwise() {
    let h = harness(Setup {
        headless: false,
        ..Setup::default()
    });
    h.controller.trigger(DesktopShortcutAction::ToggleWindow);
    assert_eq!(h.record().reveals, 1);
    h.controller.trigger(DesktopShortcutAction::ToggleWindow);
    assert_eq!(h.record().hides, 1);
    h.controller.trigger(DesktopShortcutAction::ToggleWindow);
    assert_eq!(h.record().reveals, 2);
}

#[test]
fn a_real_registrar_reports_taken_and_invalid_chords() {
    let h = harness(Setup {
        headless: false,
        ..Setup::default()
    });
    assert_eq!(
        h.record().accelerators(),
        ["CommandOrControl+Alt+Shift+Space"]
    );
    h.record().taken.push("Control+Alt+K".into());
    h.record().unparseable.push("Control+Alt+P".into());
    let update = h.update_settings(
        json!({"shortcuts": {"open-palette": "Control+Alt+K", "new-timer": "Control+Alt+P"}}),
    );
    let problems: Vec<_> = update["snapshot"]["shortcuts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s["action"].clone(), s["problem"].clone()))
        .collect();
    assert!(problems.contains(&(json!("open-palette"), json!("taken"))));
    assert!(problems.contains(&(json!("new-timer"), json!("invalid"))));
    h.controller.will_quit();
    assert!(h.record().registered.is_empty(), "released at quit");
    assert!(h.record().tray.is_none());
}

#[test]
fn hide_on_close_and_hidden_launch_follow_the_platform_and_the_settings() {
    let mac = harness(Setup {
        headless: false,
        platform: "darwin",
        ..Setup::default()
    });
    assert!(mac.controller.hide_on_close());
    assert!(
        !mac.controller.launch_hidden(&["/app", "--hidden"]),
        "a Mac opens its window at login"
    );

    let win = harness(Setup {
        headless: false,
        platform: "win32",
        ..Setup::default()
    });
    assert!(win.controller.hide_on_close());
    assert!(win.controller.launch_hidden(&["/app", "--hidden"]));
    assert!(!win.controller.launch_hidden(&["/app"]));

    let linux = harness(Setup {
        headless: false,
        platform: "linux",
        ..Setup::default()
    });
    assert!(!linux.controller.hide_on_close());
    assert!(!linux.controller.launch_hidden(&["--hidden"]));
    linux.update_settings(json!({"closeHides": true}));
    assert!(linux.controller.hide_on_close());
    assert!(linux.controller.launch_hidden(&["--hidden"]));
    linux.update_settings(json!({"showInTray": false}));
    assert!(!linux.controller.hide_on_close());
}

#[test]
fn the_close_button_hides_until_the_app_quits_or_an_update_restarts_it() {
    let h = harness(Setup {
        headless: false,
        policy: UpdaterPolicy::Enabled,
        ..Setup::default()
    });
    assert_eq!(
        h.controller.window_close_requested(),
        CloseDecision::Hide {
            leave_fullscreen_first: false
        }
    );
    h.window.as_ref().unwrap().get().fullscreen = true;
    assert_eq!(
        h.controller.window_close_requested(),
        CloseDecision::Hide {
            leave_fullscreen_first: true
        }
    );
    h.controller.update_downloaded("0.2.0");
    h.controller.click_tray("restart-to-update");
    assert_eq!(h.updater.as_ref().unwrap().lock().unwrap().installs, 1);
    assert_eq!(
        h.controller.window_close_requested(),
        CloseDecision::Close,
        "Squirrel closes windows before quitting"
    );

    let quitting = harness(Setup {
        headless: false,
        platform: "win32",
        ..Setup::default()
    });
    quitting.controller.before_quit();
    assert_eq!(
        quitting.controller.window_close_requested(),
        CloseDecision::Close
    );
    let linux = harness(Setup {
        headless: false,
        platform: "linux",
        ..Setup::default()
    });
    assert_eq!(
        linux.controller.window_close_requested(),
        CloseDecision::Close,
        "no tray host to bring it back"
    );
}

#[test]
fn window_modes_through_the_bridge_and_the_tray() {
    let h = headless();
    assert_eq!(
        h.controller
            .call(channels::WINDOW_MODE, vec![json!("bogus")])
            .unwrap_err(),
        "Invalid desktop window mode"
    );
    assert_eq!(
        h.controller
            .call(channels::WINDOW_PIN, vec![json!("x")])
            .unwrap_err(),
        "Invalid desktop pin preference"
    );
    assert_eq!(
        h.call(channels::WINDOW_GET, Value::Null),
        json!({"mode": "full", "alwaysOnTop": false})
    );

    // Signed out, compact is a preference only: auth screens get the full app.
    assert_eq!(
        h.call(channels::WINDOW_MODE, json!("compact")),
        json!({"mode": "full", "alwaysOnTop": false})
    );
    h.publish(signed_in(json!({})));
    assert_eq!(h.call(channels::WINDOW_GET, Value::Null)["mode"], "compact");
    let window = h.window.as_ref().unwrap();
    assert_eq!(window.get().rect.width, 380.0);
    assert!(!window.get().visible, "no window is shown headless");
    let changed = h.record().emitted_on(channels::WINDOW_CHANGED);
    assert_eq!(
        changed.last().unwrap(),
        &json!({"mode": "compact", "alwaysOnTop": false})
    );

    h.hook("clickTray", json!("open"));
    assert_eq!(h.call(channels::WINDOW_GET, Value::Null)["mode"], "full");
    h.hook("clickTray", json!("compact"));
    assert_eq!(
        h.call(channels::WINDOW_PIN, json!(true)),
        json!({"mode": "compact", "alwaysOnTop": true})
    );
    assert!(
        !window.get().always_on_top,
        "headless never pins a real window"
    );
    let saved: Value =
        serde_json::from_str(&fs::read_to_string(h.dir.path().join("window-state.json")).unwrap())
            .unwrap();
    assert_eq!(saved["mode"], "compact");
    assert_eq!(saved["alwaysOnTop"], true);

    // A relaunch restores the preference once a signed-in renderer says so.
    let Harness {
        controller, dir, ..
    } = h;
    drop(controller);
    let relaunched = build(Setup::default(), dir);
    assert_eq!(
        relaunched.call(channels::WINDOW_GET, Value::Null)["mode"],
        "full"
    );
    relaunched.publish(signed_in(json!({})));
    assert_eq!(
        relaunched.call(channels::WINDOW_GET, Value::Null)["mode"],
        "compact"
    );
}

#[test]
fn without_a_window_the_bridge_reports_the_full_app() {
    let h = harness(Setup {
        windowless: true,
        ..Setup::default()
    });
    assert_eq!(
        h.call(channels::WINDOW_MODE, json!("compact")),
        json!({"mode": "full", "alwaysOnTop": false})
    );
    assert_eq!(
        h.call(channels::WINDOW_PIN, json!(true)),
        json!({"mode": "full", "alwaysOnTop": false})
    );
}

#[test]
fn window_bounds_are_saved_after_the_moves_settle() {
    let h = headless();
    h.window.as_ref().unwrap().get().rect = Rect {
        x: 50.0,
        y: 60.0,
        width: 1000.0,
        height: 700.0,
    };
    h.controller.window_changed();
    h.controller.tick(T0 + WINDOW_SAVE_DELAY_MS - 1);
    assert!(!h.dir.path().join("window-state.json").exists());
    h.controller.tick(T0 + WINDOW_SAVE_DELAY_MS);
    let saved: Value =
        serde_json::from_str(&fs::read_to_string(h.dir.path().join("window-state.json")).unwrap())
            .unwrap();
    assert_eq!(
        saved["bounds"],
        json!({"x": 50, "y": 60, "width": 1000, "height": 700})
    );
}

#[test]
fn a_second_launch_shows_the_window_unless_it_came_from_the_login_item() {
    let h = harness(Setup {
        headless: false,
        ..Setup::default()
    });
    h.publish(signed_in(json!({})));
    h.controller.second_instance(&["/app", "--hidden"]);
    assert_eq!(h.record().reveals, 0);
    h.controller.second_instance(&["/app", "--compact-timer"]);
    assert_eq!(h.record().reveals, 1);
    assert_eq!(
        h.controller.window_snapshot().mode,
        DesktopWindowMode::Compact
    );
    h.controller.launched(&["--full-window"]);
    assert_eq!(h.controller.window_snapshot().mode, DesktopWindowMode::Full);
}

#[test]
fn labels_persist_so_the_next_launch_names_the_tray_before_sign_in() {
    let h = headless();
    h.publish(json!({"signedIn": false, "labels": {"open": "Track Your Time öffnen", "quit": "Track Your Time beenden"}}));
    let file = h.dir.path().join(LABELS_FILE);
    let stored: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(stored["open"], "Track Your Time öffnen");
    let Harness {
        controller, dir, ..
    } = h;
    drop(controller);
    let relaunched = build(Setup::default(), dir);
    let labels: Vec<_> = relaunched
        .hook("trayMenu", Value::Null)
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|i| i["label"].as_str().map(str::to_string))
        .collect();
    assert_eq!(
        labels,
        ["Track Your Time öffnen", "Track Your Time beenden"]
    );
}

#[test]
fn windows_jump_list_tasks_are_set_once_per_labels_and_only_in_a_packaged_windows_app() {
    let h = harness(Setup {
        headless: false,
        platform: "win32",
        ..Setup::default()
    });
    assert_eq!(h.record().user_tasks.len(), 1);
    assert_eq!(h.record().user_tasks[0][1].arguments, "--compact-timer");
    h.publish(signed_in(json!({})));
    assert_eq!(h.record().user_tasks.len(), 1, "the same labels");
    h.publish(signed_in(json!({"labels": {"open": "Öffnen"}})));
    assert_eq!(h.record().user_tasks.len(), 2);
    assert_eq!(h.record().user_tasks[1][0].title, "Öffnen");

    for setup in [
        Setup {
            headless: true,
            platform: "win32",
            ..Setup::default()
        },
        Setup {
            headless: false,
            platform: "win32",
            is_packaged: false,
            ..Setup::default()
        },
        Setup {
            headless: false,
            platform: "darwin",
            ..Setup::default()
        },
    ] {
        assert!(harness(setup).record().user_tasks.is_empty());
    }
}

#[test]
fn a_real_updater_checks_on_schedule_honours_the_rollout_and_installs_on_quit() {
    let dir = tempfile::tempdir().unwrap();
    // Bucket ≈ 0.3118 (updater_model's tests).
    fs::write(
        dir.path().join(".updaterId"),
        "6ba7b812-9dad-51d1-80b4-00c04fd430c8",
    )
    .unwrap();
    let h = build(
        Setup {
            headless: false,
            policy: UpdaterPolicy::Enabled,
            ..Setup::default()
        },
        dir,
    );
    let counts = h.updater.clone().unwrap();
    assert_eq!(counts.lock().unwrap().checks, 0);
    h.controller.tick(T0 + 30_000);
    assert_eq!(
        counts.lock().unwrap().checks,
        1,
        "the first check 30 s after launch"
    );

    h.controller.update_found("0.2.0", Some(&json!(25)));
    assert_eq!(
        h.controller.update_snapshot().status,
        tyt_wire::DesktopUpdateStatus::Idle {
            last_checked_at: Some("2026-09-17T10:00:00.000Z".into())
        }
    );
    assert_eq!(
        counts.lock().unwrap().downloads,
        0,
        "outside this install's bucket"
    );

    h.call(channels::UPDATE_CHECK, Value::Null);
    h.controller.update_found("0.2.0", Some(&json!(50)));
    assert_eq!(counts.lock().unwrap().downloads, 1);
    h.controller.update_progress(41.6);
    assert_eq!(
        h.controller.update_snapshot().status,
        tyt_wire::DesktopUpdateStatus::Downloading {
            version: "0.2.0".into(),
            percent: Some(42.0)
        }
    );
    h.controller.update_downloaded("0.2.0");
    let menu = h.hook_menu_if_any().unwrap();
    assert!(menu
        .iter()
        .any(|item| matches!(item, TrayMenuItem::Item { id, .. } if id == "restart-to-update")));
    assert_eq!(counts.lock().unwrap().installs, 0);

    h.controller.will_quit();
    assert_eq!(
        counts.lock().unwrap().quit_installs,
        1,
        "a download installs when the person quits"
    );
    assert_eq!(
        counts.lock().unwrap().installs,
        0,
        "and never restarts by itself"
    );
}

#[test]
fn a_disabled_updater_never_loads() {
    let h = harness(Setup {
        headless: false,
        policy: UpdaterPolicy::Disabled(DesktopUpdateDisabledReason::Store),
        ..Setup::default()
    });
    assert_eq!(
        h.call(channels::UPDATE_CHECK, Value::Null)["status"],
        json!({"kind": "disabled", "reason": "store"})
    );
    assert_eq!(h.call(channels::UPDATE_RESTART, Value::Null), json!(false));
    h.controller.update_found("9.9.9", None);
    assert_eq!(
        h.controller.update_snapshot().status,
        tyt_wire::DesktopUpdateStatus::Disabled {
            reason: DesktopUpdateDisabledReason::Store
        }
    );
}

#[test]
fn an_autopilot_pause_keeps_an_idle_tray_ticking_until_it_runs_out() {
    let h = harness(Setup {
        headless: false,
        ..Setup::default()
    });
    h.publish(signed_in(
        json!({"autopilot": {"pausedUntil": T0 + 60_000}, "labels": {"autopilotPaused": "Paused"}}),
    ));
    assert!(h.controller.wants_tick());
    let has = |id: &str| {
        h.hook_menu_if_any()
            .unwrap()
            .iter()
            .any(|item| matches!(item, TrayMenuItem::Item { id: i, .. } if i == id))
    };
    assert!(has("autopilot-resume"));
    h.set_now(T0 + 60_000);
    h.controller.tick(T0 + 60_000);
    assert!(
        has("autopilot-pause"),
        "the menu swaps Resume back to Pause by itself"
    );
    assert!(!h.controller.wants_tick());
}
