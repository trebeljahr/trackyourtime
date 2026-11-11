//! On-disk compatibility with the Electron build. An existing install keeps
//! its profile, so the Rust store must read what the TypeScript store and
//! codec wrote and write the same bytes for the same operations.
//! `fixtures/ts-store` was written by the Electron build's own store
//! (electron/src/activity/store.ts and protection.ts, removed on 2026-11-12
//! when the shell moved to Tauri); it stays committed as the record of that
//! format. The reverse check (a Rust-written folder opened by the TypeScript)
//! passed before the TypeScript was removed and has nothing to run against
//! now.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use tyt_activity::autopilot::{AutopilotPause, OwnedTimer};
use tyt_activity::core::{ActivityInterval, ActivityRule, ActivitySource};
use tyt_activity::model::{OpenSegment, StoredSegment};
use tyt_activity::protection::{
    activity_account, base64url_decode, create_activity_codec, verify_activity_protection,
};
use tyt_activity::settings::default_activity_settings;
use tyt_activity::store::{ActivityStore, Clock, StoreFiles, StoreStatus};
use tyt_wire::{DesktopActivityApp, DesktopActivitySettings, DesktopFilingVia};

const SCOPE: &str = "user-1:workspace-1";
/// `Date.UTC(2026, 9, 18, 23, 50, 0)`.
const T0: f64 = 1_792_367_400_000.0;
const MIN: f64 = 60_000.0;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

fn expected() -> Value {
    serde_json::from_str(&fs::read_to_string(fixtures().join("ts-store/expected.json")).unwrap())
        .unwrap()
}

fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap().flatten() {
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

fn clock() -> Clock {
    Arc::new(|| T0)
}

/// JSON equality with numbers compared as f64.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|other| same(v, other)))
        }
        _ => a == b,
    }
}

fn as_json(files: &StoreFiles) -> Value {
    json!({ "state": files.state, "open": files.open, "segments": files.segments })
}

#[test]
fn reads_a_plain_folder_the_typescript_wrote() {
    let dir = tempfile::tempdir().unwrap();
    copy_tree(&fixtures().join("ts-store/plain"), dir.path());
    let mut store = ActivityStore::open(dir.path(), clock(), None);
    assert_eq!(store.status(), StoreStatus::Ok);
    let files = as_json(&store.files());
    assert!(
        same(&files, &expected()["plain"]),
        "{files}\n{}",
        expected()["plain"]
    );

    let settings = store.settings();
    assert!(settings.enabled && settings.store_titles && settings.autopilot);
    assert_eq!(settings.retention_days, 30.0);
    assert_eq!(settings.autopilot_start_minutes, 10.0);
    assert_eq!(store.scope().as_deref(), Some(SCOPE));
    assert_eq!(
        store.all_segments(SCOPE)[0].label.as_deref(),
        Some("Café — Grüße 😀")
    );
    assert_eq!(store.read_open().unwrap().last_seen, T0 + 28.0 * MIN);
    let rules = store.rules(SCOPE);
    assert_eq!(rules[0].task_id, Some(None));
    assert_eq!(rules[1].project_id, Some(None));
    assert_eq!(
        store.dismissals(SCOPE),
        [ActivityInterval {
            start: T0 + 2.0 * MIN,
            end: T0 + 3.0 * MIN
        }]
    );
    assert_eq!(store.autopilot_owned().unwrap().log_id, "log-1");
    assert_eq!(store.autopilot_pause().unwrap().until, T0 + 60.0 * MIN);
}

#[test]
fn reads_and_extends_an_encrypted_folder_the_typescript_wrote() {
    let expected = expected();
    let dir = tempfile::tempdir().unwrap();
    copy_tree(&fixtures().join("ts-store/encrypted"), dir.path());
    let key = base64url_decode(expected["key"].as_str().unwrap()).unwrap();
    let account = activity_account("user-1", "https://api.example.test");
    assert_eq!(account, expected["account"]);
    let codec = create_activity_codec(&key, &account).unwrap();
    verify_activity_protection(dir.path(), &codec, false).unwrap();

    // Without the key nothing opens.
    let locked = ActivityStore::open(dir.path(), clock(), None);
    assert_eq!(locked.status(), StoreStatus::Locked);
    assert_eq!(locked.files().state, Value::Null);

    let mut store = ActivityStore::open(dir.path(), clock(), Some(codec.clone()));
    let files = store.files();
    assert!(same(&files.state, &expected["encrypted"]["state"]));
    assert!(same(&files.open, &expected["encrypted"]["open"]));
    let before = expected["encrypted"]["segments"].as_array().unwrap();
    assert!(same(
        &Value::Array(files.segments[..before.len()].to_vec()),
        &Value::Array(before.clone())
    ));
    assert_eq!(
        store.all_segments(SCOPE).len() as u64,
        expected["encryptedSegmentsAfterAppend"].as_u64().unwrap()
    );

    // The Rust codec's own writes verify beside the TypeScript's.
    store
        .append(StoredSegment {
            scope: SCOPE.into(),
            source: ActivitySource::Desktop,
            start: T0 + 50.0 * MIN,
            end: T0 + 51.0 * MIN,
            key: "rust.app".into(),
            name: "Rust".into(),
            label: Some("written in Rust".into()),
            afk: false,
        })
        .unwrap();
    store.save_state(store.settings(), store.scope()).unwrap();
    verify_activity_protection(dir.path(), &codec, false).unwrap();
    assert_eq!(
        ActivityStore::open(dir.path(), clock(), Some(codec))
            .all_segments(SCOPE)
            .len(),
        4
    );
}

/// The TypeScript fixture's operations, through the Rust store.
fn write_like_the_fixture(user_data: &Path) {
    let mut store = ActivityStore::open(user_data, clock(), None);
    store
        .save_state(
            DesktopActivitySettings {
                enabled: true,
                store_titles: true,
                excluded_apps: vec!["com.example.never".into()],
                retention_days: 30.0,
                autopilot: true,
                autopilot_start_minutes: 10.0,
            },
            Some(SCOPE.into()),
        )
        .unwrap();
    let segment =
        |scope: &str, start: f64, end: f64, key: &str, name: &str, label: Option<&str>| {
            StoredSegment {
                scope: scope.into(),
                source: ActivitySource::Desktop,
                start,
                end,
                key: key.into(),
                name: name.into(),
                label: label.map(str::to_string),
                afk: false,
            }
        };
    store
        .append(segment(
            SCOPE,
            T0,
            T0 + 5.0 * MIN,
            "com.figma.desktop",
            "Figma",
            Some("Café — Grüße 😀"),
        ))
        .unwrap();
    store
        .append(segment(
            SCOPE,
            T0 + 5.0 * MIN,
            T0 + 25.0 * MIN,
            "com.microsoft.vscode",
            "Code",
            None,
        ))
        .unwrap();
    store
        .append(segment(
            "user-1:workspace-2",
            T0 + 30.0 * MIN,
            T0 + 31.0 * MIN,
            "a.b",
            "A",
            None,
        ))
        .unwrap();
    store
        .write_open(Some(&OpenSegment {
            scope: SCOPE.into(),
            key: "com.google.chrome".into(),
            name: "Chrome".into(),
            label: Some("Docs".into()),
            start: T0 + 26.0 * MIN,
            last_seen: T0 + 28.0 * MIN,
        }))
        .unwrap();
    store
        .put_rule(
            SCOPE,
            ActivityRule {
                id: "rule-1".into(),
                pattern: "com.figma.*".into(),
                description: Some("Website redesign".into()),
                project_id: Some(Some("p-web".into())),
                task_id: Some(None),
                tag_ids: Some(vec!["t1".into()]),
                billable: Some(true),
            },
            T0,
        )
        .unwrap();
    store
        .put_rule(
            SCOPE,
            ActivityRule {
                id: "rule-2".into(),
                pattern: "com.microsoft.vscode".into(),
                description: None,
                project_id: Some(None),
                task_id: None,
                tag_ids: None,
                billable: None,
            },
            T0 + 1.0,
        )
        .unwrap();
    store
        .add_dismissal(
            SCOPE,
            ActivityInterval {
                start: T0 + 2.0 * MIN,
                end: T0 + 3.0 * MIN,
            },
        )
        .unwrap();
    store
        .save_autopilot_owned(Some(OwnedTimer {
            scope: SCOPE.into(),
            start: T0 + 5.0 * MIN,
            filing_key: r#"["website redesign","p-web",null]"#.into(),
            app: Some(DesktopActivityApp {
                key: "com.figma.desktop".into(),
                name: "Figma".into(),
            }),
            via: DesktopFilingVia::Rule,
            log_id: "log-1".into(),
        }))
        .unwrap();
    store
        .save_autopilot_pause(Some(AutopilotPause {
            account: "user-1:".into(),
            until: T0 + 60.0 * MIN,
        }))
        .unwrap();
}

#[test]
fn writes_the_same_bytes_as_the_typescript_for_the_same_operations() {
    let dir = tempfile::tempdir().unwrap();
    write_like_the_fixture(dir.path());
    let ours = dir.path().join("activity");
    let theirs = fixtures().join("ts-store/plain/activity");
    for file in [
        "segments/2026-10-18.jsonl",
        "segments/2026-10-19.jsonl",
        "open.json",
    ] {
        assert_eq!(
            fs::read_to_string(ours.join(file)).unwrap(),
            fs::read_to_string(theirs.join(file)).unwrap(),
            "{file}"
        );
    }
    // state.json: the same JSON. Key order inside a rule follows how the
    // TypeScript built the object, which differs by code path even there.
    let read = |path: PathBuf| -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    };
    assert_eq!(
        read(ours.join("state.json")),
        read(theirs.join("state.json"))
    );
    assert!(fs::read_to_string(ours.join("state.json"))
        .unwrap()
        .ends_with('\n'));
}

#[test]
fn the_default_state_matches_what_protect_writes_for_an_emptied_folder() {
    // protection.ts replaces a `{v:2, protectionRequired}` marker with
    // JSON.stringify({ v: 1, settings: DEFAULT_ACTIVITY_SETTINGS, … }).
    let dir = tempfile::tempdir().unwrap();
    let mut store = ActivityStore::open(dir.path(), clock(), None);
    store.save_state(default_activity_settings(), None).unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("activity/state.json")).unwrap(),
        "{\"v\":1,\"settings\":{\"enabled\":false,\"storeTitles\":false,\"excludedApps\":[],\"retentionDays\":14,\"autopilot\":false,\"autopilotStartMinutes\":5},\"scope\":null,\"rules\":[],\"dismissals\":[]}\n"
    );
}
