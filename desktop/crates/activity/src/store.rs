//! Where captured activity lives: `userData/activity/`, on this computer only
//! (`store.ts`).
//!
//! ```text
//!   state.json                 settings, scope, rules, dismissals and the
//!                              timer Autopilot owns (atomic)
//!   open.json                  the open segment; absent when none is open
//!   segments/YYYY-MM-DD.jsonl  closed segments, one JSON line each, filed
//!                              under the UTC day of their start
//! ```
//!
//! Directory 0700 and files 0600. Optional account-derived AES-GCM
//! encryption covers settings, segments, titles, rules and dismissals.
//! Protected stores stay locked without their key; an unavailable OS keychain
//! never causes a plaintext fallback. Nothing here opens a connection; the
//! only way activity leaves the device is as an entry the person accepted,
//! which the renderer creates.
//!
//! The files are the Electron build's, read and written in place: the same
//! names, the same JSON (numbers as `JSON.stringify` writes them), the same
//! modes. An existing install keeps its history across the move to Tauri.
//!
//! `state.json` carries `v`. A newer build's format locks the store: nothing
//! is written, moved or deleted, capture stays off, and Settings says why —
//! the same rule as the offline queue's envelope. An unreadable `state.json`
//! is copied aside before the defaults replace it.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use serde_json::Value;
use tyt_wire::{DesktopActivityApp, DesktopActivitySettings, DesktopFilingVia};

use crate::autopilot::{AutopilotPause, OwnedTimer};
use crate::core::{ActivityInterval, ActivityRule, ActivitySource};
use crate::js;
use crate::model::{OpenSegment, StoredSegment};
use crate::protection::{
    make_private_dir, read_utf8, remove_all, write_atomic, SharedCodec, ACTIVITY_PROTECTION_FILE,
    ACTIVITY_PROTECTION_REQUIRED,
};
use crate::settings::{default_activity_settings, parse_activity_settings};

pub const ACTIVITY_FORMAT_VERSION: f64 = 1.0;
pub const ACTIVITY_DIR: &str = "activity";

const STATE_FILE: &str = "state.json";
const OPEN_FILE: &str = "open.json";
const SEGMENTS_DIR: &str = "segments";
const DAY_MS: f64 = 86_400_000.0;
/// A line longer than this is not one this app wrote.
const MAX_LINE_LENGTH: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreStatus {
    Ok,
    NewerFormat,
    Locked,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StoredRule {
    pub scope: String,
    pub created_at: f64,
    pub rule: ActivityRule,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StoredDismissal<'a> {
    pub scope: &'a str,
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, PartialEq)]
struct Dismissal {
    scope: String,
    start: f64,
    end: f64,
}

#[derive(Debug, Clone, PartialEq)]
struct StateFile {
    settings: DesktopActivitySettings,
    scope: Option<String>,
    rules: Vec<StoredRule>,
    dismissals: Vec<Dismissal>,
    /// Absent in a file from before Autopilot (outer None), else a value or null.
    autopilot_owned: Option<Option<OwnedTimer>>,
    /// Absent in a file from before the pause.
    autopilot_pause: Option<Option<AutopilotPause>>,
}

fn default_state() -> StateFile {
    StateFile {
        settings: default_activity_settings(),
        scope: None,
        rules: Vec::new(),
        dismissals: Vec::new(),
        autopilot_owned: None,
        autopilot_pause: None,
    }
}

// ── serialization, as JSON.stringify writes it ───────────────────────

struct Num(f64);
impl Serialize for Num {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        js::serialize_number(&self.0, serializer)
    }
}

/// `DesktopActivitySettings` in the order `parseActivitySettings` builds it.
pub struct DiskSettings<'a>(pub &'a DesktopActivitySettings);
impl Serialize for DiskSettings<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let s = self.0;
        let mut out = serializer.serialize_struct("Settings", 6)?;
        out.serialize_field("enabled", &s.enabled)?;
        out.serialize_field("storeTitles", &s.store_titles)?;
        out.serialize_field("excludedApps", &s.excluded_apps)?;
        out.serialize_field("retentionDays", &Num(s.retention_days))?;
        out.serialize_field("autopilot", &s.autopilot)?;
        out.serialize_field("autopilotStartMinutes", &Num(s.autopilot_start_minutes))?;
        out.end()
    }
}

struct DiskRule<'a>(&'a StoredRule);
impl Serialize for DiskRule<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let stored = self.0;
        let rule = &stored.rule;
        let mut out = serializer.serialize_struct("Rule", 9)?;
        out.serialize_field("scope", &stored.scope)?;
        out.serialize_field("id", &rule.id)?;
        out.serialize_field("pattern", &rule.pattern)?;
        out.serialize_field("createdAt", &Num(stored.created_at))?;
        if let Some(description) = &rule.description {
            out.serialize_field("description", description)?;
        }
        if let Some(project_id) = &rule.project_id {
            out.serialize_field("projectId", project_id)?;
        }
        if let Some(task_id) = &rule.task_id {
            out.serialize_field("taskId", task_id)?;
        }
        if let Some(tag_ids) = &rule.tag_ids {
            out.serialize_field("tagIds", tag_ids)?;
        }
        if let Some(billable) = &rule.billable {
            out.serialize_field("billable", billable)?;
        }
        out.end()
    }
}

struct DiskDismissal<'a>(&'a Dismissal);
impl Serialize for DiskDismissal<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut out = serializer.serialize_struct("Dismissal", 3)?;
        out.serialize_field("scope", &self.0.scope)?;
        out.serialize_field("start", &Num(self.0.start))?;
        out.serialize_field("end", &Num(self.0.end))?;
        out.end()
    }
}

impl Serialize for StateFile {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut out = serializer.serialize_struct("State", 7)?;
        out.serialize_field("v", &Num(ACTIVITY_FORMAT_VERSION))?;
        out.serialize_field("settings", &DiskSettings(&self.settings))?;
        out.serialize_field("scope", &self.scope)?;
        out.serialize_field(
            "rules",
            &self.rules.iter().map(DiskRule).collect::<Vec<_>>(),
        )?;
        out.serialize_field(
            "dismissals",
            &self
                .dismissals
                .iter()
                .map(DiskDismissal)
                .collect::<Vec<_>>(),
        )?;
        if let Some(owned) = &self.autopilot_owned {
            out.serialize_field("autopilotOwned", owned)?;
        }
        if let Some(pause) = &self.autopilot_pause {
            out.serialize_field("autopilotPause", pause)?;
        }
        out.end()
    }
}

/// `JSON.stringify({ v: 1, settings: DEFAULT_ACTIVITY_SETTINGS, scope: null, rules: [], dismissals: [] })`.
pub fn default_state_json() -> String {
    serde_json::to_string(&default_state()).expect("state serializes")
}

// ── parsing what is stored ───────────────────────────────────────────

fn non_empty_str(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// `label === undefined || typeof label === "string"`: absent is fine, a
/// string is fine, anything else (null included) rejects the row.
fn optional_string(value: Option<&Value>) -> Result<Option<String>, ()> {
    match value {
        None => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(()),
    }
}

pub fn parse_stored_segment(value: &Value) -> Option<StoredSegment> {
    let record = value.as_object()?;
    let scope = record.get("scope")?.as_str()?;
    let key = non_empty_str(record.get("key"))?;
    let start = js::finite(record.get("start"))?;
    let end = js::finite(record.get("end"))?;
    if end < start {
        return None;
    }
    let label = optional_string(record.get("label")).ok()?;
    Some(StoredSegment {
        scope: scope.to_string(),
        source: ActivitySource::Desktop,
        start,
        end,
        key: key.to_string(),
        name: non_empty_str(record.get("name")).unwrap_or(key).to_string(),
        label,
        afk: false,
    })
}

pub fn parse_open_segment(value: &Value) -> Option<OpenSegment> {
    let record = value.as_object()?;
    let scope = record.get("scope")?.as_str()?;
    let key = non_empty_str(record.get("key"))?;
    let start = js::finite(record.get("start"))?;
    let last_seen = js::finite(record.get("lastSeen"))?;
    if last_seen < start {
        return None;
    }
    let label = optional_string(record.get("label")).ok()?;
    Some(OpenSegment {
        scope: scope.to_string(),
        key: key.to_string(),
        name: non_empty_str(record.get("name")).unwrap_or(key).to_string(),
        label,
        start,
        last_seen,
    })
}

fn parse_rule(value: &Value) -> Option<StoredRule> {
    let record = value.as_object()?;
    let scope = record.get("scope")?.as_str()?;
    let id = record.get("id")?.as_str()?;
    let pattern = non_empty_str(record.get("pattern"))?;
    let nullable_id = |name: &str| match record.get(name) {
        Some(Value::String(text)) => Some(Some(text.clone())),
        Some(Value::Null) => Some(None),
        _ => None,
    };
    Some(StoredRule {
        scope: scope.to_string(),
        created_at: js::finite(record.get("createdAt")).unwrap_or(0.0),
        rule: ActivityRule {
            id: id.to_string(),
            pattern: pattern.to_string(),
            description: record
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string),
            project_id: nullable_id("projectId"),
            task_id: nullable_id("taskId"),
            tag_ids: record.get("tagIds").and_then(Value::as_array).map(|tags| {
                tags.iter()
                    .filter_map(|t| t.as_str().map(str::to_string))
                    .collect()
            }),
            billable: record.get("billable").and_then(Value::as_bool),
        },
    })
}

fn parse_dismissal(value: &Value) -> Option<Dismissal> {
    let record = value.as_object()?;
    let scope = record.get("scope")?.as_str()?;
    let start = js::finite(record.get("start"))?;
    let end = js::finite(record.get("end"))?;
    if end <= start {
        return None;
    }
    Some(Dismissal {
        scope: scope.to_string(),
        start,
        end,
    })
}

pub fn parse_owned_timer(value: Option<&Value>) -> Option<OwnedTimer> {
    let record = value?.as_object()?;
    let scope = non_empty_str(record.get("scope"))?;
    let start = js::finite(record.get("start"))?;
    let filing_key = non_empty_str(record.get("filingKey"))?;
    let log_id = non_empty_str(record.get("logId"))?;
    let via = match record.get("via").and_then(Value::as_str) {
        Some("rule") => DesktopFilingVia::Rule,
        Some("learned") => DesktopFilingVia::Learned,
        _ => return None,
    };
    let app = record
        .get("app")
        .and_then(Value::as_object)
        .and_then(|app| {
            let key = non_empty_str(app.get("key"))?;
            Some(DesktopActivityApp {
                key: key.to_string(),
                name: non_empty_str(app.get("name")).unwrap_or(key).to_string(),
            })
        });
    Some(OwnedTimer {
        scope: scope.to_string(),
        start,
        filing_key: filing_key.to_string(),
        app,
        via,
        log_id: log_id.to_string(),
    })
}

pub fn parse_autopilot_pause(value: Option<&Value>) -> Option<AutopilotPause> {
    let record = value?.as_object()?;
    let account = record.get("account")?.as_str()?;
    // `<userId>:`, exactly as `account_prefix_of` writes it: /^[^:]+:$/.
    let body = account.strip_suffix(':')?;
    if body.is_empty() || body.contains(':') {
        return None;
    }
    let until = js::finite(record.get("until"))?;
    Some(AutopilotPause {
        account: account.to_string(),
        until,
    })
}

/// `new Date(epochMs).toISOString().slice(0, 10)` + `.jsonl`.
pub fn day_file_of(epoch_ms: f64) -> Result<String, String> {
    js::iso_date(epoch_ms)
        .map(|day| format!("{day}.jsonl"))
        .ok_or_else(|| "Invalid time value".to_string())
}

/// `/^(\d{4})-(\d{2})-(\d{2})\.jsonl$/`.
fn day_file_parts(file: &str) -> Option<(f64, f64, f64)> {
    let stem = file.strip_suffix(".jsonl")?;
    let bytes = stem.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let digits = |range: std::ops::Range<usize>| -> Option<f64> {
        let part = &stem[range];
        part.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| part.parse::<f64>().ok())
            .flatten()
    };
    Some((digits(0..4)?, digits(5..7)?, digits(8..10)?))
}

fn is_day_file(file: &str) -> bool {
    day_file_parts(file).is_some()
}

fn day_start_of(file: &str) -> Option<f64> {
    let (year, month, day) = day_file_parts(file)?;
    Some(js::date_utc(year, month - 1.0, day))
}

/// What a rewrite does with one segment. `Keep` is the TypeScript's "return
/// the same object", which is how a file that did not change is not rewritten.
pub enum Rewrite {
    Keep,
    Replace(StoredSegment),
    Delete,
}

/// Raw contents, for the headless test hook.
#[derive(Debug, Clone, PartialEq)]
pub struct StoreFiles {
    pub state: Value,
    pub open: Value,
    pub segments: Vec<Value>,
}

pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;

pub struct ActivityStore {
    status: StoreStatus,
    pub dir: PathBuf,
    segments_dir: PathBuf,
    state_path: PathBuf,
    open_path: PathBuf,
    codec: Option<SharedCodec>,
    state: StateFile,
    cache: Option<Vec<StoredSegment>>,
}

fn number_text(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e21 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

impl ActivityStore {
    pub fn open(user_data: &Path, clock: Clock, codec: Option<SharedCodec>) -> Self {
        let dir = user_data.join(ACTIVITY_DIR);
        let segments_dir = dir.join(SEGMENTS_DIR);
        let state_path = dir.join(STATE_FILE);
        let open_path = dir.join(OPEN_FILE);

        let protected = dir.join(ACTIVITY_PROTECTION_FILE).exists()
            || user_data.join(ACTIVITY_PROTECTION_REQUIRED).exists();
        let mut status = if protected && codec.is_none() {
            StoreStatus::Locked
        } else {
            StoreStatus::Ok
        };
        let mut state = default_state();

        // ── load state.json ──
        let raw = if status == StoreStatus::Locked {
            None
        } else {
            read_utf8(&state_path).ok().and_then(|text| match &codec {
                Some(codec) => codec.decode(&text, STATE_FILE).ok(),
                None => Some(text),
            })
        };
        if let Some(raw) = raw {
            let parsed: Option<Value> = serde_json::from_str(&raw).ok();
            let record = parsed.as_ref().and_then(Value::as_object);
            let version = record.map(|r| r.get("v"));
            match (record, version) {
                (Some(record), Some(Some(v)))
                    if v.as_f64()
                        .is_some_and(|v| v.is_finite() && v > ACTIVITY_FORMAT_VERSION) =>
                {
                    // A newer build's folder: read what can be shown, touch nothing.
                    status = StoreStatus::NewerFormat;
                    let mut settings = parse_activity_settings(record.get("settings"));
                    settings.enabled = false;
                    state = StateFile {
                        settings,
                        ..default_state()
                    };
                }
                (Some(record), Some(v))
                    if v.is_none()
                        || v.and_then(Value::as_f64) == Some(ACTIVITY_FORMAT_VERSION) =>
                {
                    let list = |name: &str| record.get(name).and_then(Value::as_array);
                    state = StateFile {
                        settings: parse_activity_settings(record.get("settings")),
                        scope: non_empty_str(record.get("scope")).map(str::to_string),
                        rules: list("rules")
                            .map(|rules| rules.iter().filter_map(parse_rule).collect())
                            .unwrap_or_default(),
                        dismissals: list("dismissals")
                            .map(|items| items.iter().filter_map(parse_dismissal).collect())
                            .unwrap_or_default(),
                        autopilot_owned: Some(parse_owned_timer(record.get("autopilotOwned"))),
                        autopilot_pause: Some(parse_autopilot_pause(record.get("autopilotPause"))),
                    };
                }
                _ => {
                    // Unreadable: kept aside for whoever wants to look, then defaults.
                    let mut aside = state_path.as_os_str().to_owned();
                    aside.push(format!(".corrupt.{}", number_text(clock())));
                    let _ = fs::copy(&state_path, PathBuf::from(aside));
                }
            }
        }

        ActivityStore {
            status,
            dir,
            segments_dir,
            state_path,
            open_path,
            codec,
            state,
            cache: None,
        }
    }

    pub fn status(&self) -> StoreStatus {
        self.status
    }

    fn locked(&self) -> bool {
        self.status != StoreStatus::Ok
    }

    fn encode(&self, text: &str, file: &str) -> Result<String, String> {
        match &self.codec {
            Some(codec) => codec.encode(text, file),
            None => Ok(text.to_string()),
        }
    }

    fn decode(&self, text: &str, file: &str) -> Result<String, String> {
        match &self.codec {
            Some(codec) => codec.decode(text, file),
            None => Ok(text.to_string()),
        }
    }

    fn ensure_dirs(&self) -> Result<(), String> {
        make_private_dir(&self.segments_dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Windows: POSIX modes do not apply.
            let _ = fs::set_permissions(&self.dir, fs::Permissions::from_mode(0o700));
            let _ = fs::set_permissions(&self.segments_dir, fs::Permissions::from_mode(0o700));
        }
        Ok(())
    }

    /// Recovery copies must not retain excluded apps or stripped titles after
    /// a later privacy change. They are temporary crash recovery, not backups.
    fn discard_migration_backup(&self) -> Result<(), String> {
        if self.codec.is_none() {
            return Ok(());
        }
        remove_all(&self.dir.join("migration-backup.bin"))?;
        if let Ok(entries) = fs::read_dir(&self.segments_dir) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().contains(".torn.") {
                    remove_all(&entry.path())?;
                }
            }
        }
        if let Ok(entries) = fs::read_dir(&self.dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with("state.json.corrupt.") || name.starts_with("open.json.corrupt.")
                {
                    remove_all(&entry.path())?;
                }
            }
        }
        Ok(())
    }

    fn save_state_file(&self) -> Result<(), String> {
        if self.locked() {
            return Ok(());
        }
        self.ensure_dirs()?;
        self.discard_migration_backup()?;
        let json = serde_json::to_string(&self.state).expect("state serializes");
        write_atomic(
            &self.state_path,
            format!("{}\n", self.encode(&json, STATE_FILE)?).as_bytes(),
        )
    }

    pub fn settings(&self) -> DesktopActivitySettings {
        self.state.settings.clone()
    }

    pub fn scope(&self) -> Option<String> {
        self.state.scope.clone()
    }

    /// Writes settings and scope together (one file).
    pub fn save_state(
        &mut self,
        settings: DesktopActivitySettings,
        scope: Option<String>,
    ) -> Result<(), String> {
        if self.locked() {
            return Ok(());
        }
        self.state.settings = settings;
        self.state.scope = scope;
        self.save_state_file()
    }

    pub fn rules(&self, scope: &str) -> Vec<ActivityRule> {
        self.state
            .rules
            .iter()
            .filter(|r| r.scope == scope)
            .map(|r| r.rule.clone())
            .collect()
    }

    /// Replaces any rule of the scope with the same pattern (or id).
    pub fn put_rule(
        &mut self,
        scope: &str,
        rule: ActivityRule,
        created_at: f64,
    ) -> Result<(), String> {
        if self.locked() {
            return Ok(());
        }
        self.state.rules.retain(|stored| {
            !(stored.scope == scope
                && (stored.rule.pattern == rule.pattern || stored.rule.id == rule.id))
        });
        self.state.rules.push(StoredRule {
            scope: scope.to_string(),
            created_at,
            rule,
        });
        self.save_state_file()
    }

    pub fn delete_rule(&mut self, scope: &str, id: &str) -> Result<(), String> {
        if self.locked() {
            return Ok(());
        }
        self.state
            .rules
            .retain(|r| !(r.scope == scope && r.rule.id == id));
        self.save_state_file()
    }

    pub fn dismissals(&self, scope: &str) -> Vec<ActivityInterval> {
        self.state
            .dismissals
            .iter()
            .filter(|d| d.scope == scope)
            .map(|d| ActivityInterval {
                start: d.start,
                end: d.end,
            })
            .collect()
    }

    pub fn add_dismissal(&mut self, scope: &str, span: ActivityInterval) -> Result<(), String> {
        if self.locked() {
            return Ok(());
        }
        self.state.dismissals.push(Dismissal {
            scope: scope.to_string(),
            start: span.start,
            end: span.end,
        });
        self.save_state_file()
    }

    /// The running timer Autopilot opened, so a restart still knows it is Autopilot's.
    pub fn autopilot_owned(&self) -> Option<OwnedTimer> {
        self.state.autopilot_owned.clone().flatten()
    }

    pub fn save_autopilot_owned(&mut self, owned: Option<OwnedTimer>) -> Result<(), String> {
        if self.locked() {
            return Ok(());
        }
        self.state.autopilot_owned = Some(owned);
        self.save_state_file()
    }

    /// "Pause Autopilot for an hour", so a restart inside that hour stays paused.
    pub fn autopilot_pause(&self) -> Option<AutopilotPause> {
        self.state.autopilot_pause.clone().flatten()
    }

    pub fn save_autopilot_pause(&mut self, pause: Option<AutopilotPause>) -> Result<(), String> {
        if self.locked() {
            return Ok(());
        }
        self.state.autopilot_pause = Some(pause);
        self.save_state_file()
    }

    pub fn read_open(&self) -> Option<OpenSegment> {
        if self.locked() {
            return None;
        }
        let text = read_utf8(&self.open_path).ok()?;
        let value: Value = serde_json::from_str(&self.decode(&text, OPEN_FILE).ok()?).ok()?;
        parse_open_segment(&value)
    }

    pub fn write_open(&self, open: Option<&OpenSegment>) -> Result<(), String> {
        if self.locked() {
            return Ok(());
        }
        self.discard_migration_backup()?;
        let Some(open) = open else {
            return remove_all(&self.open_path);
        };
        self.ensure_dirs()?;
        let json = serde_json::to_string(open).expect("open segment serializes");
        write_atomic(
            &self.open_path,
            format!("{}\n", self.encode(&json, OPEN_FILE)?).as_bytes(),
        )
    }

    pub fn append(&mut self, segment: StoredSegment) -> Result<(), String> {
        if self.locked() {
            return Ok(());
        }
        self.discard_migration_backup()?;
        self.ensure_dirs()?;
        let file = day_file_of(segment.start)?;
        let line = self.encode(
            &serde_json::to_string(&segment).expect("segment serializes"),
            &format!("{SEGMENTS_DIR}/{file}"),
        )?;
        append_private(
            &self.segments_dir.join(&file),
            format!("{line}\n").as_bytes(),
        )?;
        if let Some(cache) = &mut self.cache {
            cache.push(segment);
        }
        Ok(())
    }

    fn day_files(&self) -> Vec<String> {
        let Ok(entries) = fs::read_dir(&self.segments_dir) else {
            return Vec::new();
        };
        let mut files: Vec<String> = entries
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| is_day_file(name))
            .collect();
        files.sort_by(|a, b| js::cmp_strings(a, b));
        files
    }

    fn read_day_file(&self, file: &str) -> Vec<StoredSegment> {
        if self.locked() {
            return Vec::new();
        }
        let Ok(text) = read_utf8(&self.segments_dir.join(file)) else {
            return Vec::new();
        };
        let name = format!("{SEGMENTS_DIR}/{file}");
        let mut out = Vec::new();
        for line in text.split('\n') {
            if line.is_empty() || js::utf16_len(line) > MAX_LINE_LENGTH {
                continue;
            }
            // A torn last line from a crash mid-append: skipped, never fatal.
            let Ok(plain) = self.decode(line, &name) else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&plain) else {
                continue;
            };
            if let Some(segment) = parse_stored_segment(&value) {
                out.push(segment);
            }
        }
        out
    }

    fn load_all(&mut self) -> &[StoredSegment] {
        if self.locked() {
            return &[];
        }
        if self.cache.is_none() {
            let all = self
                .day_files()
                .iter()
                .flat_map(|file| self.read_day_file(file))
                .collect();
            self.cache = Some(all);
        }
        self.cache.as_deref().unwrap_or_default()
    }

    fn write_day_file(&self, file: &str, segments: &[StoredSegment]) -> Result<(), String> {
        let target = self.segments_dir.join(file);
        self.discard_migration_backup()?;
        if segments.is_empty() {
            return remove_all(&target);
        }
        let name = format!("{SEGMENTS_DIR}/{file}");
        let mut text = String::new();
        for segment in segments {
            text.push_str(&self.encode(
                &serde_json::to_string(segment).expect("segment serializes"),
                &name,
            )?);
            text.push('\n');
        }
        write_atomic(&target, text.as_bytes())
    }

    fn rewrite_files(
        &mut self,
        files: &[String],
        map: &mut dyn FnMut(&StoredSegment) -> Rewrite,
    ) -> Result<usize, String> {
        if self.locked() {
            return Ok(0);
        }
        let mut changed = 0;
        let result = (|| {
            for file in files {
                let before = self.read_day_file(file);
                let mut after = Vec::with_capacity(before.len());
                let mut file_changed = false;
                for segment in before {
                    match map(&segment) {
                        Rewrite::Keep => after.push(segment),
                        Rewrite::Replace(next) => {
                            file_changed = true;
                            changed += 1;
                            after.push(next);
                        }
                        Rewrite::Delete => {
                            file_changed = true;
                            changed += 1;
                        }
                    }
                }
                if file_changed {
                    self.write_day_file(file, &after)?;
                }
            }
            Ok(changed)
        })();
        self.cache = None;
        result
    }

    /// The scope's segments overlapping `[from, to)`.
    pub fn segments(&mut self, scope: &str, from: f64, to: f64) -> Vec<StoredSegment> {
        self.load_all()
            .iter()
            .filter(|s| s.scope == scope && s.end > from && s.start < to)
            .cloned()
            .collect()
    }

    /// Every stored segment of the scope, oldest file first.
    pub fn all_segments(&mut self, scope: &str) -> Vec<StoredSegment> {
        self.load_all()
            .iter()
            .filter(|s| s.scope == scope)
            .cloned()
            .collect()
    }

    /// How many segments the scope has stored.
    pub fn count_segments(&mut self, scope: &str) -> usize {
        self.load_all().iter().filter(|s| s.scope == scope).count()
    }

    /// Map every stored segment. Returns how many changed.
    pub fn rewrite_segments(
        &mut self,
        map: &mut dyn FnMut(&StoredSegment) -> Rewrite,
    ) -> Result<usize, String> {
        let files = self.day_files();
        self.rewrite_files(&files, map)
    }

    /// Delete every segment, rule and dismissal whose scope does not start with `keep_prefix`.
    pub fn sweep_scopes(&mut self, keep_prefix: &str) -> Result<(), String> {
        if self.locked() {
            return Ok(());
        }
        let files = self.day_files();
        self.rewrite_files(&files, &mut |s| {
            if s.scope.starts_with(keep_prefix) {
                Rewrite::Keep
            } else {
                Rewrite::Delete
            }
        })?;
        self.state
            .rules
            .retain(|r| r.scope.starts_with(keep_prefix));
        self.state
            .dismissals
            .retain(|d| d.scope.starts_with(keep_prefix));
        let owned = self
            .state
            .autopilot_owned
            .clone()
            .flatten()
            .filter(|o| o.scope.starts_with(keep_prefix));
        self.state.autopilot_owned = Some(owned);
        let pause = self
            .state
            .autopilot_pause
            .clone()
            .flatten()
            .filter(|p| p.account == keep_prefix);
        self.state.autopilot_pause = Some(pause);
        self.save_state_file()
    }

    /// Delete every segment, rule, dismissal and the open segment.
    pub fn wipe(&mut self) -> Result<(), String> {
        if self.locked() {
            return Ok(());
        }
        remove_all(&self.segments_dir)?;
        remove_all(&self.open_path)?;
        self.cache = None;
        self.state.rules.clear();
        self.state.dismissals.clear();
        self.state.autopilot_owned = Some(None);
        self.save_state_file()
    }

    /// Delete what ended before the retention window. Returns how many segments went.
    pub fn prune(&mut self, now: f64, retention_days: f64) -> Result<usize, String> {
        if self.locked() {
            return Ok(0);
        }
        let cutoff = now - retention_days * DAY_MS;
        // Only files that start before the cutoff can hold anything to prune.
        let older: Vec<String> = self
            .day_files()
            .into_iter()
            .filter(|file| day_start_of(file).unwrap_or(0.0) < cutoff)
            .collect();
        let removed = self.rewrite_files(&older, &mut |s| {
            if s.end < cutoff {
                Rewrite::Delete
            } else {
                Rewrite::Keep
            }
        })?;
        let before = self.state.dismissals.len();
        self.state.dismissals.retain(|d| d.end >= cutoff);
        if self.state.dismissals.len() != before {
            self.save_state_file()?;
        }
        Ok(removed)
    }

    /// Raw contents, for the headless test hook.
    pub fn files(&self) -> StoreFiles {
        let read_json = |target: &Path, name: &str| -> Value {
            if self.locked() {
                return Value::Null;
            }
            read_utf8(target)
                .ok()
                .and_then(|text| self.decode(&text, name).ok())
                .and_then(|plain| serde_json::from_str(&plain).ok())
                .unwrap_or(Value::Null)
        };
        let segments = self
            .day_files()
            .iter()
            .flat_map(|file| self.read_day_file(file))
            .map(|segment| {
                let mut value = serde_json::to_value(&segment).expect("segment serializes");
                js::normalize_numbers(&mut value);
                value
            })
            .collect();
        StoreFiles {
            state: read_json(&self.state_path, STATE_FILE),
            open: read_json(&self.open_path, OPEN_FILE),
            segments,
        }
    }
}

/// `appendFileSync(target, data, { mode: 0o600 })`.
fn append_private(target: &Path, content: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(target).map_err(|e| e.to_string())?;
    file.write_all(content).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: f64 = 86_400_000.0;
    /// `Date.UTC(2026, 8, 22, 23, 30, 0)`.
    const T0: f64 = 1_790_119_800_000.0;

    fn segment() -> StoredSegment {
        StoredSegment {
            scope: "u1:w1".into(),
            source: ActivitySource::Desktop,
            start: T0,
            end: T0 + 10.0 * 60_000.0,
            key: "com.example.editor".into(),
            name: "Editor".into(),
            label: None,
            afk: false,
        }
    }

    fn rule(id: &str, pattern: &str) -> ActivityRule {
        ActivityRule {
            id: id.into(),
            pattern: pattern.into(),
            description: None,
            project_id: None,
            task_id: None,
            tag_ids: None,
            billable: None,
        }
    }

    fn clock() -> Clock {
        Arc::new(|| 1234.0)
    }

    struct Dir(tempfile::TempDir);
    impl Dir {
        fn new() -> Self {
            Dir(tempfile::tempdir().unwrap())
        }
        fn user_data(&self) -> &Path {
            self.0.path()
        }
        fn activity(&self) -> PathBuf {
            self.0.path().join(ACTIVITY_DIR)
        }
        fn segments(&self) -> PathBuf {
            self.activity().join("segments")
        }
        fn store(&self) -> ActivityStore {
            ActivityStore::open(self.user_data(), clock(), None)
        }
    }

    fn list(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn appends_and_reads_across_utc_days_by_scope_and_range() {
        let dir = Dir::new();
        let mut store = dir.store();
        store.append(segment()).unwrap();
        store
            .append(StoredSegment {
                start: T0 + DAY,
                end: T0 + DAY + 60_000.0,
                ..segment()
            })
            .unwrap();
        store
            .append(StoredSegment {
                scope: "u2:w1".into(),
                ..segment()
            })
            .unwrap();
        let mut expected = vec![day_file_of(T0).unwrap(), day_file_of(T0 + DAY).unwrap()];
        expected.sort();
        assert_eq!(list(&dir.segments()), expected);

        let mut again = dir.store();
        assert_eq!(again.all_segments("u1:w1").len(), 2);
        assert_eq!(
            again
                .segments("u1:w1", T0 + 5.0 * 60_000.0, T0 + 6.0 * 60_000.0)
                .len(),
            1
        );
        assert_eq!(again.segments("u1:w1", T0 + DAY - 1.0, T0 + DAY).len(), 0);
    }

    #[test]
    fn skips_a_torn_line() {
        let dir = Dir::new();
        let mut store = dir.store();
        store.append(segment()).unwrap();
        append_private(
            &dir.segments().join(day_file_of(T0).unwrap()),
            br#"{"scope":"u1:w1","start":"#,
        )
        .unwrap();
        store
            .append(StoredSegment {
                start: T0 + 60_000.0,
                ..segment()
            })
            .unwrap();
        assert_eq!(dir.store().all_segments("u1:w1").len(), 1);
    }

    #[test]
    fn rewrites_by_predicate_atomically_and_deletes_emptied_files() {
        let dir = Dir::new();
        let mut store = dir.store();
        store
            .append(StoredSegment {
                label: Some("secret".into()),
                ..segment()
            })
            .unwrap();
        store
            .append(StoredSegment {
                key: "com.example.chat".into(),
                start: T0 + DAY,
                end: T0 + DAY + 60_000.0,
                ..segment()
            })
            .unwrap();
        let changed = store
            .rewrite_segments(&mut |s| {
                if s.key == "com.example.chat" {
                    Rewrite::Delete
                } else {
                    Rewrite::Keep
                }
            })
            .unwrap();
        assert_eq!(changed, 1);
        assert_eq!(list(&dir.segments()), vec![day_file_of(T0).unwrap()]);
        store
            .rewrite_segments(&mut |s| match s.label {
                None => Rewrite::Keep,
                Some(_) => Rewrite::Replace(StoredSegment {
                    label: None,
                    ..s.clone()
                }),
            })
            .unwrap();
        assert_eq!(store.all_segments("u1:w1")[0].label, None);
        assert!(!list(&dir.segments()).iter().any(|f| f.ends_with(".tmp")));
    }

    #[test]
    fn prunes_by_retention_trims_dismissals_and_keeps_rules() {
        let dir = Dir::new();
        let now = T0 + 20.0 * DAY;
        let mut store = dir.store();
        store.append(segment()).unwrap();
        store
            .append(StoredSegment {
                start: now - DAY,
                end: now - DAY + 60_000.0,
                ..segment()
            })
            .unwrap();
        store
            .add_dismissal(
                "u1:w1",
                ActivityInterval {
                    start: T0,
                    end: T0 + 1000.0,
                },
            )
            .unwrap();
        store
            .put_rule("u1:w1", rule("r1", "com.example.*"), T0)
            .unwrap();
        assert_eq!(store.prune(now, 14.0).unwrap(), 1);
        assert_eq!(store.all_segments("u1:w1").len(), 1);
        assert!(store.dismissals("u1:w1").is_empty());
        assert_eq!(store.rules("u1:w1").len(), 1);
    }

    #[test]
    fn sweeps_other_accounts_and_keeps_the_same_persons_workspaces() {
        let dir = Dir::new();
        let mut store = dir.store();
        store.append(segment()).unwrap();
        store
            .append(StoredSegment {
                scope: "u1:w2".into(),
                ..segment()
            })
            .unwrap();
        store
            .append(StoredSegment {
                scope: "u2:w1".into(),
                ..segment()
            })
            .unwrap();
        store.put_rule("u2:w1", rule("r", "x"), 0.0).unwrap();
        store
            .add_dismissal(
                "u2:w1",
                ActivityInterval {
                    start: 1.0,
                    end: 2.0,
                },
            )
            .unwrap();
        store.sweep_scopes("u1:").unwrap();
        let mut scopes: Vec<String> = store
            .files()
            .segments
            .iter()
            .map(|s| s["scope"].as_str().unwrap().to_string())
            .collect();
        scopes.sort();
        assert_eq!(scopes, ["u1:w1", "u1:w2"]);
        assert!(store.rules("u2:w1").is_empty());
        assert!(store.dismissals("u2:w1").is_empty());
    }

    #[test]
    fn replaces_a_rule_with_the_same_pattern() {
        let dir = Dir::new();
        let mut store = dir.store();
        store
            .put_rule(
                "u1:w1",
                ActivityRule {
                    description: Some("Old".into()),
                    ..rule("a", "com.example.*")
                },
                1.0,
            )
            .unwrap();
        store
            .put_rule(
                "u1:w1",
                ActivityRule {
                    description: Some("New".into()),
                    ..rule("b", "com.example.*")
                },
                2.0,
            )
            .unwrap();
        assert_eq!(
            store.rules("u1:w1"),
            vec![ActivityRule {
                description: Some("New".into()),
                ..rule("b", "com.example.*")
            }]
        );
    }

    #[test]
    fn wipes_segments_rules_dismissals_and_the_open_segment_keeping_settings_and_scope() {
        let dir = Dir::new();
        let mut store = dir.store();
        let settings = DesktopActivitySettings {
            enabled: true,
            retention_days: 30.0,
            ..default_activity_settings()
        };
        store
            .save_state(settings.clone(), Some("u1:w1".into()))
            .unwrap();
        store.append(segment()).unwrap();
        let open = OpenSegment {
            scope: "u1:w1".into(),
            key: "k".into(),
            name: "K".into(),
            label: None,
            start: T0,
            last_seen: T0,
        };
        store.write_open(Some(&open)).unwrap();
        store.put_rule("u1:w1", rule("r", "k"), 0.0).unwrap();
        store.wipe().unwrap();
        let mut again = dir.store();
        assert!(again.all_segments("u1:w1").is_empty());
        assert_eq!(again.read_open(), None);
        assert!(again.rules("u1:w1").is_empty());
        assert_eq!(again.settings(), settings);
        assert_eq!(again.scope().as_deref(), Some("u1:w1"));
    }

    #[test]
    fn locks_on_a_newer_format_and_writes_nothing_at_all() {
        let dir = Dir::new();
        fs::create_dir_all(dir.segments()).unwrap();
        let newer = r#"{"v":2,"settings":{"enabled":true,"retentionDays":5},"scope":"u1:w1"}"#;
        fs::write(dir.activity().join("state.json"), newer).unwrap();
        let line = format!("{}\n", serde_json::to_string(&segment()).unwrap());
        fs::write(dir.segments().join(day_file_of(T0).unwrap()), &line).unwrap();

        let mut store = dir.store();
        assert_eq!(store.status(), StoreStatus::NewerFormat);
        assert!(!store.settings().enabled);
        store
            .save_state(
                DesktopActivitySettings {
                    enabled: true,
                    ..default_activity_settings()
                },
                Some("u9:w9".into()),
            )
            .unwrap();
        store
            .append(StoredSegment {
                start: T0 + DAY,
                end: T0 + DAY + 1.0,
                ..segment()
            })
            .unwrap();
        let open = OpenSegment {
            scope: "u1:w1".into(),
            key: "k".into(),
            name: "K".into(),
            label: None,
            start: T0,
            last_seen: T0,
        };
        store.write_open(Some(&open)).unwrap();
        store.put_rule("u1:w1", rule("r", "k"), 0.0).unwrap();
        store.sweep_scopes("u9:").unwrap();
        store.wipe().unwrap();
        store.prune(T0 + 100.0 * DAY, 1.0).unwrap();

        assert_eq!(
            fs::read_to_string(dir.activity().join("state.json")).unwrap(),
            newer
        );
        assert_eq!(list(&dir.segments()), vec![day_file_of(T0).unwrap()]);
        assert_eq!(list(&dir.activity()), ["segments", "state.json"]);
    }

    #[test]
    fn copies_an_unreadable_state_json_aside_and_starts_from_the_defaults() {
        let dir = Dir::new();
        fs::create_dir_all(dir.activity()).unwrap();
        fs::write(dir.activity().join("state.json"), "{not json").unwrap();
        let store = dir.store();
        assert_eq!(store.status(), StoreStatus::Ok);
        assert_eq!(store.settings(), default_activity_settings());
        assert_eq!(
            fs::read_to_string(dir.activity().join("state.json.corrupt.1234")).unwrap(),
            "{not json"
        );
    }

    #[cfg(unix)]
    #[test]
    fn keeps_the_folder_0700_and_its_files_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = Dir::new();
        let mut store = dir.store();
        store
            .save_state(default_activity_settings(), Some("u1:w1".into()))
            .unwrap();
        store.append(segment()).unwrap();
        let open = OpenSegment {
            scope: "u1:w1".into(),
            key: "k".into(),
            name: "K".into(),
            label: None,
            start: T0,
            last_seen: T0,
        };
        store.write_open(Some(&open)).unwrap();
        let mode = |target: PathBuf| fs::metadata(target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(dir.activity()), 0o700);
        assert_eq!(mode(dir.segments()), 0o700);
        assert_eq!(mode(dir.activity().join("state.json")), 0o600);
        assert_eq!(mode(dir.activity().join("open.json")), 0o600);
        assert_eq!(mode(dir.segments().join(day_file_of(T0).unwrap())), 0o600);
    }

    #[test]
    fn writes_json_the_way_json_stringify_does() {
        let dir = Dir::new();
        let mut store = dir.store();
        store.save_state(default_activity_settings(), None).unwrap();
        assert_eq!(
            fs::read_to_string(dir.activity().join("state.json")).unwrap(),
            format!("{}\n", default_state_json())
        );
        assert_eq!(
            default_state_json(),
            r#"{"v":1,"settings":{"enabled":false,"storeTitles":false,"excludedApps":[],"retentionDays":14,"autopilot":false,"autopilotStartMinutes":5},"scope":null,"rules":[],"dismissals":[]}"#
        );
        store
            .append(StoredSegment {
                label: Some("Budget.xlsx".into()),
                ..segment()
            })
            .unwrap();
        assert_eq!(
            fs::read_to_string(dir.segments().join(day_file_of(T0).unwrap())).unwrap(),
            "{\"scope\":\"u1:w1\",\"source\":\"desktop\",\"start\":1790119800000,\"end\":1790120400000,\"key\":\"com.example.editor\",\"name\":\"Editor\",\"label\":\"Budget.xlsx\",\"afk\":false}\n"
        );
    }

    #[test]
    fn parses_a_stored_pause_strictly() {
        let pause = |v: Value| parse_autopilot_pause(Some(&v));
        assert_eq!(
            pause(serde_json::json!({"account": "u1:", "until": 5})),
            Some(AutopilotPause {
                account: "u1:".into(),
                until: 5.0
            })
        );
        assert_eq!(
            pause(serde_json::json!({"account": "u1:w1", "until": 5})),
            None
        );
        assert_eq!(
            pause(serde_json::json!({"account": "u1:", "until": "later"})),
            None
        );
        assert_eq!(parse_autopilot_pause(None), None);
    }
}
