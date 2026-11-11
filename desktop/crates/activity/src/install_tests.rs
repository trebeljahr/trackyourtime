//! The controller as the shell and the e2e suite drive it
//! (`e2e/desktop/activity.spec.ts`, `autopilot.spec.ts`), headless: every
//! call goes through `call` / `test_call` with JSON, exactly as the bridge
//! would send it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tyt_wire::{channels, DesktopActivitySnapshot, DesktopIdlePayload};

use crate::install::{ActivityController, ActivityHost, ActivityOptions};

#[derive(Default)]
struct Recorder {
    pushes: AtomicUsize,
    last: Mutex<Option<DesktopActivitySnapshot>>,
}

impl ActivityHost for Recorder {
    fn changed(&self, snapshot: &DesktopActivitySnapshot) {
        self.pushes.fetch_add(1, Ordering::SeqCst);
        *self.last.lock().unwrap() = Some(snapshot.clone());
    }
}

fn options(
    dir: &std::path::Path,
    headless: bool,
    platform: &str,
    channel: &str,
) -> ActivityOptions {
    ActivityOptions {
        headless,
        platform: platform.into(),
        channel: channel.into(),
        env: HashMap::new(),
        user_data: dir.to_path_buf(),
        encryption: None,
        titles_permitted: Arc::new(|| false),
        parent_pid: 1,
    }
}

fn headless(dir: &std::path::Path) -> (ActivityController, Arc<Recorder>) {
    let host = Arc::new(Recorder::default());
    let controller =
        ActivityController::install(options(dir, true, "darwin", "unpackaged"), host.clone());
    (controller, host)
}

const MIN: f64 = 60_000.0;
/// Yesterday-ish and fixed: 2026-10-18T10:00:00Z.
const T0: f64 = 1_792_317_600_000.0;

fn call(controller: &ActivityController, channel: &str, arg: Value) -> Value {
    controller.call(channel, vec![arg]).unwrap()
}

fn hook(controller: &ActivityController, method: &str, args: Value) -> Value {
    controller.test_call(method, args).unwrap()
}

/// `target` in front from `from` for `minutes`, one detection a minute at the pinned clock.
fn front_for(controller: &ActivityController, target: Value, from: f64, minutes: u32) {
    hook(controller, "setFrontmost", target);
    for minute in 0..=minutes {
        hook(controller, "setNow", json!(from + f64::from(minute) * MIN));
        hook(controller, "tick", Value::Null);
    }
}

fn nothing_at(controller: &ActivityController, at: f64) {
    hook(controller, "setFrontmost", Value::Null);
    hook(controller, "setNow", json!(at));
    hook(controller, "tick", Value::Null);
}

fn suggestions(controller: &ActivityController, from: f64, to: f64) -> Vec<Value> {
    call(
        controller,
        channels::ACTIVITY_SUGGESTIONS,
        json!({ "from": from, "to": to, "tracked": [] }),
    )
    .as_array()
    .cloned()
    .unwrap()
}

#[test]
fn fake_capture_becomes_a_suggestion_and_add_files_it() {
    let dir = tempfile::tempdir().unwrap();
    let (controller, _host) = headless(dir.path());

    // Headless: the fake source, and nothing spawned — ever.
    assert_eq!(hook(&controller, "sourceKind", Value::Null), "fake");
    assert_eq!(hook(&controller, "spawns", Value::Null), json!([]));

    // Off by default; on through the bridge, then whose activity it is.
    let snapshot = call(
        &controller,
        channels::ACTIVITY_SETTINGS,
        json!({ "enabled": true }),
    );
    assert_eq!(snapshot["settings"]["enabled"], true);
    assert_eq!(snapshot["scoped"], false);
    assert_eq!(
        call(
            &controller,
            channels::ACTIVITY_SCOPE,
            json!({ "userId": "u1", "workspaceId": "w1" })
        ),
        Value::Null
    );
    assert_eq!(
        call(&controller, channels::ACTIVITY_SNAPSHOT, Value::Null)["scoped"],
        true
    );
    assert_eq!(hook(&controller, "capturing", Value::Null), true);

    // 25 minutes of Editor, 2 of Chat, then nothing.
    front_for(
        &controller,
        json!({ "key": "com.example.editor", "name": "Editor" }),
        T0,
        25,
    );
    front_for(
        &controller,
        json!({ "key": "com.example.chat", "name": "Chat" }),
        T0 + 25.0 * MIN,
        2,
    );
    nothing_at(&controller, T0 + 27.0 * MIN);

    let cards = suggestions(&controller, T0 - 60.0 * MIN, T0 + 120.0 * MIN);
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0]["start"], json!(T0 as i64));
    assert_eq!(cards[0]["topApps"][0]["name"], "Editor");

    let check = call(
        &controller,
        channels::ACTIVITY_CHECK_ACCEPT,
        json!({ "start": cards[0]["start"], "end": cards[0]["end"], "edited": false, "tracked": [] }),
    );
    assert_eq!(check["ok"], true);
    call(
        &controller,
        channels::ACTIVITY_ACCEPTED,
        json!({ "start": check["start"], "end": check["end"] }),
    );
    assert!(suggestions(&controller, T0 - 60.0 * MIN, T0 + 120.0 * MIN).is_empty());

    // A second block is dismissed; activity after it surfaces on its own.
    let t1 = T0 + 60.0 * MIN;
    front_for(
        &controller,
        json!({ "key": "com.example.editor", "name": "Editor" }),
        t1,
        15,
    );
    nothing_at(&controller, t1 + 15.0 * MIN);
    let cards = suggestions(&controller, t1 - MIN, t1 + 120.0 * MIN);
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0]["start"], json!(t1 as i64));
    assert_eq!(
        call(
            &controller,
            channels::ACTIVITY_DISMISS,
            json!({ "start": cards[0]["start"], "end": cards[0]["end"] })
        ),
        true
    );
    assert!(suggestions(&controller, t1 - MIN, t1 + 120.0 * MIN).is_empty());

    let t2 = t1 + 30.0 * MIN;
    front_for(
        &controller,
        json!({ "key": "com.example.chat", "name": "Chat" }),
        t2,
        10,
    );
    nothing_at(&controller, t2 + 10.0 * MIN);
    let cards = suggestions(&controller, t1 - MIN, t1 + 120.0 * MIN);
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0]["start"], json!(t2 as i64));
    assert_eq!(cards[0]["topApps"][0]["name"], "Chat");

    // Sign-out forgets everything recorded for this account; the settings stay.
    call(&controller, channels::ACTIVITY_FORGET, Value::Null);
    let files = hook(&controller, "files", Value::Null);
    assert_eq!(files["state"]["scope"], Value::Null);
    assert_eq!(files["state"]["rules"], json!([]));
    assert_eq!(files["state"]["dismissals"], json!([]));
    assert_eq!(files["open"], Value::Null);
    assert_eq!(files["segments"], json!([]));
    assert_eq!(files["state"]["settings"]["enabled"], true);

    assert_eq!(hook(&controller, "spawns", Value::Null), json!([]));
    controller.dispose();
}

#[test]
fn settings_controls_reach_what_is_stored_and_an_unsupported_channel_refuses() {
    let dir = tempfile::tempdir().unwrap();
    let (controller, _host) = headless(dir.path());
    call(
        &controller,
        channels::ACTIVITY_SCOPE,
        json!({ "userId": "u1", "workspaceId": "w1" }),
    );
    call(
        &controller,
        channels::ACTIVITY_SETTINGS,
        json!({ "enabled": true }),
    );
    hook(&controller, "setTitlesAvailable", json!(true));
    call(
        &controller,
        channels::ACTIVITY_SETTINGS,
        json!({ "storeTitles": true }),
    );

    let t0 = T0 - 60.0 * MIN;
    front_for(
        &controller,
        json!({ "key": "com.example.editor", "name": "Editor", "title": "Budget.xlsx" }),
        t0,
        5,
    );
    front_for(
        &controller,
        json!({ "key": "com.example.chat", "name": "Chat" }),
        t0 + 5.0 * MIN,
        3,
    );
    nothing_at(&controller, t0 + 8.0 * MIN);
    let segments = || {
        hook(&controller, "files", Value::Null)["segments"]
            .as_array()
            .cloned()
            .unwrap()
    };
    assert_eq!(
        segments()
            .iter()
            .find(|s| s["key"] == "com.example.editor")
            .unwrap()["label"],
        "Budget.xlsx"
    );

    // Titles off deletes the titles already stored.
    call(
        &controller,
        channels::ACTIVITY_SETTINGS,
        json!({ "storeTitles": false }),
    );
    assert!(segments().iter().all(|s| s.get("label").is_none()));

    // Never record Chat: its rows go too.
    let snapshot = call(
        &controller,
        channels::ACTIVITY_SETTINGS,
        json!({ "excludedApps": ["com.example.chat"] }),
    );
    assert_eq!(
        snapshot["settings"]["excludedApps"],
        json!(["com.example.chat"])
    );
    assert_eq!(
        segments()
            .iter()
            .map(|s| s["key"].clone())
            .collect::<Vec<_>>(),
        [json!("com.example.editor")]
    );

    // Delete all.
    call(&controller, channels::ACTIVITY_WIPE, Value::Null);
    assert!(segments().is_empty());

    // A channel that must not record: the reason, and the refusal.
    hook(
        &controller,
        "setSupport",
        json!({ "supported": false, "reason": "store", "hint": null }),
    );
    let snapshot = call(&controller, channels::ACTIVITY_SNAPSHOT, Value::Null);
    assert_eq!(
        snapshot["support"],
        json!({ "supported": false, "reason": "store", "hint": null })
    );
    // The stored switch is untouched (the page shows it off); nothing records.
    assert_eq!(snapshot["recording"], false);
    assert_eq!(hook(&controller, "capturing", Value::Null), false);
    assert_eq!(
        call(
            &controller,
            channels::ACTIVITY_SETTINGS,
            json!({ "enabled": true })
        )["settings"]["enabled"],
        false
    );
    assert_eq!(hook(&controller, "spawns", Value::Null), json!([]));
}

#[test]
fn autopilot_starts_and_is_reported_through_the_bridge() {
    let dir = tempfile::tempdir().unwrap();
    let (controller, _host) = headless(dir.path());
    call(
        &controller,
        channels::ACTIVITY_SCOPE,
        json!({ "userId": "u1", "workspaceId": "w1" }),
    );
    call(
        &controller,
        channels::ACTIVITY_SETTINGS,
        json!({ "enabled": true, "autopilot": true, "autopilotStartMinutes": 3 }),
    );
    let rules = call(
        &controller,
        channels::ACTIVITY_RULE_ADD,
        json!({ "pattern": "com.figma.desktop", "description": "Website redesign", "projectId": "p-web" }),
    );
    assert_eq!(rules.as_array().unwrap().len(), 1);
    front_for(
        &controller,
        json!({ "key": "com.figma.desktop", "name": "Figma" }),
        T0,
        4,
    );
    let plan = call(
        &controller,
        channels::ACTIVITY_AUTOPILOT_PLAN,
        json!({ "running": null, "tracked": [] }),
    );
    assert_eq!(plan["kind"], "start");
    assert_eq!(plan["at"], json!(T0 as i64));
    assert_eq!(
        plan["app"],
        json!({ "key": "com.figma.desktop", "name": "Figma" })
    );
    call(
        &controller,
        channels::ACTIVITY_AUTOPILOT_APPLIED,
        json!({ "token": plan["token"], "ok": true, "written": { "description": "Website redesign", "projectId": "p-web", "taskId": null } }),
    );
    let state = &call(&controller, channels::ACTIVITY_SNAPSHOT, Value::Null)["autopilot"];
    assert_eq!(state["owned"]["start"], json!(T0 as i64));
    assert_eq!(state["log"][0]["kind"], "start");

    // The tray's pause, and the refusals the renderer can send.
    controller.pause_autopilot(true);
    assert!(
        call(&controller, channels::ACTIVITY_SNAPSHOT, Value::Null)["autopilot"]["pausedUntil"]
            .is_number()
    );
    controller.pause_autopilot(false);
    assert_eq!(
        call(&controller, channels::ACTIVITY_SNAPSHOT, Value::Null)["autopilot"]["pausedUntil"],
        Value::Null
    );
    assert_eq!(
        call(
            &controller,
            channels::ACTIVITY_AUTOPILOT_PLAN,
            json!({ "tracked": [] })
        ),
        json!({ "kind": "none" })
    );
    assert_eq!(
        call(
            &controller,
            channels::ACTIVITY_CHECK_ACCEPT,
            json!({ "start": 1 })
        ),
        json!({ "ok": false, "reason": "bad-range" })
    );
    assert_eq!(
        call(&controller, channels::ACTIVITY_SUGGESTIONS, json!({})),
        Value::Null
    );
    assert_eq!(
        call(
            &controller,
            channels::ACTIVITY_DISMISS,
            json!({ "start": 2, "end": 1 })
        ),
        false
    );
    assert_eq!(
        call(
            &controller,
            channels::ACTIVITY_RULE_ADD,
            json!({ "pattern": "" })
        )
        .as_array()
        .unwrap()
        .len(),
        1
    );
}

#[test]
fn pushes_are_throttled_to_one_per_window() {
    let dir = tempfile::tempdir().unwrap();
    let (controller, host) = headless(dir.path());
    call(
        &controller,
        channels::ACTIVITY_SCOPE,
        json!({ "userId": "u1", "workspaceId": "w1" }),
    );
    for i in 0..5 {
        call(
            &controller,
            channels::ACTIVITY_RULE_ADD,
            json!({ "pattern": format!("app{i}") }),
        );
    }
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(host.pushes.load(Ordering::SeqCst), 1);
    std::thread::sleep(Duration::from_millis(2_200));
    assert_eq!(
        host.pushes.load(Ordering::SeqCst),
        2,
        "the changes inside the window are pushed once, after it"
    );
    assert_eq!(host.last.lock().unwrap().as_ref().unwrap().rules.len(), 5);
}

#[test]
fn headless_ignores_idle_samples_from_the_shell() {
    let dir = tempfile::tempdir().unwrap();
    let (controller, _host) = headless(dir.path());
    call(
        &controller,
        channels::ACTIVITY_SCOPE,
        json!({ "userId": "u1", "workspaceId": "w1" }),
    );
    call(
        &controller,
        channels::ACTIVITY_SETTINGS,
        json!({ "enabled": true }),
    );
    controller.idle(&DesktopIdlePayload {
        state: "locked".into(),
        idle_seconds: 999,
    });
    assert_eq!(
        call(&controller, channels::ACTIVITY_SNAPSHOT, Value::Null)["recording"],
        true
    );
    hook(&controller, "idle", json!(["idle"]));
    assert_eq!(
        call(&controller, channels::ACTIVITY_SNAPSHOT, Value::Null)["paused"],
        "idle"
    );
    hook(&controller, "idle", json!({ "state": "active" }));
    assert_eq!(
        call(&controller, channels::ACTIVITY_SNAPSHOT, Value::Null)["recording"],
        true
    );
}

#[test]
fn a_store_build_spawns_nothing_and_has_no_test_hook() {
    let dir = tempfile::tempdir().unwrap();
    let host = Arc::new(Recorder::default());
    let controller =
        ActivityController::install(options(dir.path(), false, "darwin", "mac-app-store"), host);
    assert!(controller.test_call("spawns", Value::Null).is_err());
    let snapshot = call(&controller, channels::ACTIVITY_SNAPSHOT, Value::Null);
    assert_eq!(
        snapshot["support"],
        json!({ "supported": false, "reason": "store", "hint": null })
    );
    // macOS titles need the Screen Recording grant the shell reports.
    let snapshot = call(
        &controller,
        channels::ACTIVITY_SETTINGS,
        json!({ "storeTitles": true }),
    );
    assert_eq!(snapshot["titlesPermissionRequired"], true);
    assert_eq!(snapshot["settings"]["storeTitles"], false);
    controller.idle(&DesktopIdlePayload {
        state: "idle".into(),
        idle_seconds: 30,
    });
}

#[test]
fn answers_only_its_own_channels_and_closes_on_dispose() {
    assert!(ActivityController::handles(channels::ACTIVITY_SNAPSHOT));
    assert!(ActivityController::handles(
        channels::ACTIVITY_AUTOPILOT_PAUSE
    ));
    assert!(!ActivityController::handles(channels::ACTIVITY_CHANGED));
    assert!(!ActivityController::handles(channels::DESKTOP_NOTIFY));
    assert!(!ActivityController::handles("activity:unknown"));
    let every: Vec<&str> = channels::ALL
        .iter()
        .copied()
        .filter(|c| ActivityController::handles(c))
        .collect();
    assert_eq!(every.len(), 18);

    let dir = tempfile::tempdir().unwrap();
    let (controller, _host) = headless(dir.path());
    assert!(controller.call("activity:unknown", vec![]).is_err());
    controller.dispose();
    controller.dispose();
    assert_eq!(
        controller
            .call(channels::ACTIVITY_LOCK, vec![])
            .unwrap_err(),
        "Activity vault is closed"
    );
}

#[test]
fn the_controller_can_live_in_shared_shell_state() {
    fn shared<T: Send + Sync + 'static>() {}
    shared::<ActivityController>();
}
