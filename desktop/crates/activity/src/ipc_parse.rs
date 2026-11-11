//! Every activity bridge payload, narrowed before it reaches the store
//! (`ipc-parse.ts`).
//!
//! The shell already refuses a caller outside the app's own origin; this is
//! the second half — a renderer bug, or a page that should never have had
//! the bridge, cannot write an unbounded array, a NaN or a scope with no user
//! in it. Each parser answers the value or None; a None is answered with a
//! refusal, never an error across the bridge.

use serde_json::{Map, Value};
use tyt_wire::{DesktopAutopilotHistoryEntry, DesktopAutopilotRunning};

use crate::autopilot::{AppliedResult, Written};
use crate::core::ActivityInterval;
use crate::js;
use crate::keys::to_activity_pattern;
use crate::settings::{clamp_retention_days, clean_app_list, clean_autopilot_start_minutes};

pub const MAX_RANGE_MS: f64 = 8.0 * 86_400_000.0;
pub const MAX_TRACKED_INTERVALS: usize = 5000;
pub const MAX_ID_LENGTH: usize = 64;
pub const MAX_PATTERN_LENGTH: usize = 200;
/// The entry schema's own limits (`packages/shared/src/schemas.ts`).
pub const MAX_DESCRIPTION_LENGTH: usize = 500;
pub const MAX_TAG_IDS: usize = 20;
/// How many entries one `learn` may carry: two weeks of a very busy person.
pub const MAX_HISTORY_ENTRIES: usize = 3000;
/// A token is a UUID; a log id too.
pub const MAX_TOKEN_LENGTH: usize = 64;
/// A filing key is JSON of a description and two ids.
pub const MAX_FILING_KEY_LENGTH: usize = MAX_DESCRIPTION_LENGTH * 2 + MAX_ID_LENGTH * 2 + 16;

/// `Partial<DesktopActivitySettings>`: only the keys the caller sent.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SettingsPatch {
    pub enabled: Option<bool>,
    pub store_titles: Option<bool>,
    pub excluded_apps: Option<Vec<String>>,
    pub retention_days: Option<f64>,
    pub autopilot: Option<bool>,
    pub autopilot_start_minutes: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scope {
    pub user_id: String,
    pub workspace_id: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SuggestionsInput {
    pub from: f64,
    pub to: f64,
    pub tracked: Vec<ActivityInterval>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CheckAcceptInput {
    pub start: f64,
    pub end: f64,
    pub edited: bool,
    pub tracked: Vec<ActivityInterval>,
}

/// `Omit<DesktopActivityRule, "id">`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RuleInput {
    pub pattern: String,
    pub description: Option<String>,
    pub project_id: Option<Option<String>>,
    pub task_id: Option<Option<String>>,
    pub tag_ids: Option<Vec<String>>,
    pub billable: Option<bool>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlanInput {
    pub running: Option<DesktopAutopilotRunning>,
    pub tracked: Vec<ActivityInterval>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct HoldRequest {
    pub filing_key: Option<String>,
    pub app_key: Option<String>,
    pub dismiss: Option<ActivityInterval>,
    pub log_id: Option<String>,
}

fn record(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn is_id(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| (1..=MAX_ID_LENGTH).contains(&js::utf16_len(s)))
}

fn is_token(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| (1..=MAX_TOKEN_LENGTH).contains(&js::utf16_len(s)))
}

fn finite(value: Option<&Value>) -> Option<f64> {
    js::finite(value)
}

/// `value === null || isId(value)`, as `Option<Option<String>>`: None when invalid.
fn nullable_id(value: Option<&Value>) -> Option<Option<String>> {
    match value {
        Some(Value::Null) => Some(None),
        Some(v) if is_id(v) => Some(v.as_str().map(str::to_string)),
        _ => None,
    }
}

fn description(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|s| js::utf16_len(s) <= MAX_DESCRIPTION_LENGTH)
        .map(str::to_string)
}

pub fn parse_settings_patch(value: &Value) -> Option<SettingsPatch> {
    let record = record(value)?;
    Some(SettingsPatch {
        enabled: record.get("enabled").and_then(Value::as_bool),
        store_titles: record.get("storeTitles").and_then(Value::as_bool),
        excluded_apps: record
            .get("excludedApps")
            .and_then(Value::as_array)
            .map(|apps| clean_app_list(apps)),
        retention_days: finite(record.get("retentionDays")).map(clamp_retention_days),
        autopilot: record.get("autopilot").and_then(Value::as_bool),
        autopilot_start_minutes: finite(record.get("autopilotStartMinutes"))
            .map(|minutes| clean_autopilot_start_minutes(Some(&Value::from(minutes)))),
    })
}

pub fn parse_scope(value: &Value) -> Option<Scope> {
    let record = record(value)?;
    let (user, workspace) = (record.get("userId")?, record.get("workspaceId")?);
    if !is_id(user) || !is_id(workspace) {
        return None;
    }
    let user_id = user.as_str()?;
    // The scope is `<userId>:<workspaceId>`, and the account sweep matches `<userId>:`.
    if user_id.contains(':') {
        return None;
    }
    Some(Scope {
        user_id: user_id.to_string(),
        workspace_id: workspace.as_str()?.to_string(),
    })
}

pub fn parse_interval(value: &Value) -> Option<ActivityInterval> {
    let record = record(value)?;
    let start = finite(record.get("start"))?;
    let end = finite(record.get("end"))?;
    (end > start).then_some(ActivityInterval { start, end })
}

fn parse_tracked(value: Option<&Value>) -> Option<Vec<ActivityInterval>> {
    let items = value?.as_array()?;
    if items.len() > MAX_TRACKED_INTERVALS {
        return None;
    }
    items.iter().map(parse_interval).collect()
}

pub fn parse_suggestions_input(value: &Value) -> Option<SuggestionsInput> {
    let record = record(value)?;
    let from = finite(record.get("from"))?;
    let to = finite(record.get("to"))?;
    if !(to > from) || to - from > MAX_RANGE_MS {
        return None;
    }
    Some(SuggestionsInput {
        from,
        to,
        tracked: parse_tracked(record.get("tracked"))?,
    })
}

pub fn parse_check_accept_input(value: &Value) -> Option<CheckAcceptInput> {
    let record = record(value)?;
    let edited = record.get("edited")?.as_bool()?;
    let span = parse_interval(value)?;
    if span.end - span.start > MAX_RANGE_MS {
        return None;
    }
    Some(CheckAcceptInput {
        start: span.start,
        end: span.end,
        edited,
        tracked: parse_tracked(record.get("tracked"))?,
    })
}

pub fn parse_rule_input(value: &Value) -> Option<RuleInput> {
    let record = record(value)?;
    let raw = record.get("pattern")?.as_str()?;
    if js::utf16_len(raw) > MAX_PATTERN_LENGTH {
        return None;
    }
    let pattern = to_activity_pattern(raw);
    if pattern.is_empty() {
        return None;
    }
    let mut rule = RuleInput {
        pattern,
        ..Default::default()
    };
    if let Some(value) = record.get("description") {
        rule.description = Some(description(Some(value))?);
    }
    if let Some(value) = record.get("projectId") {
        rule.project_id = Some(nullable_id(Some(value))?);
    }
    if let Some(value) = record.get("taskId") {
        rule.task_id = Some(nullable_id(Some(value))?);
    }
    if let Some(value) = record.get("tagIds") {
        let tags = value.as_array()?;
        if tags.len() > MAX_TAG_IDS || !tags.iter().all(is_id) {
            return None;
        }
        let mut unique: Vec<String> = Vec::new();
        for tag in tags.iter().filter_map(Value::as_str) {
            if !unique.iter().any(|t| t == tag) {
                unique.push(tag.to_string());
            }
        }
        rule.tag_ids = Some(unique);
    }
    if let Some(value) = record.get("billable") {
        rule.billable = Some(value.as_bool()?);
    }
    Some(rule)
}

pub fn parse_rule_id(value: &Value) -> Option<String> {
    is_id(value)
        .then(|| value.as_str().map(str::to_string))
        .flatten()
}

/// `running`: `null`, or a running entry; anything else (absent included) refuses the plan.
fn parse_running(value: Option<&Value>) -> Option<Option<DesktopAutopilotRunning>> {
    let value = value?;
    if value.is_null() {
        return Some(None);
    }
    let record = record(value)?;
    let start = finite(record.get("start"))?;
    let description = description(record.get("description"))?;
    let project_id = nullable_id(record.get("projectId"))?;
    let task_id = nullable_id(record.get("taskId"))?;
    Some(Some(DesktopAutopilotRunning {
        start,
        description,
        project_id,
        task_id,
    }))
}

pub fn parse_autopilot_plan_input(value: &Value) -> Option<PlanInput> {
    let record = record(value)?;
    let running = parse_running(record.get("running"))?;
    Some(PlanInput {
        running,
        tracked: parse_tracked(record.get("tracked"))?,
    })
}

pub fn parse_autopilot_history(value: &Value) -> Option<Vec<DesktopAutopilotHistoryEntry>> {
    let items = value.as_array()?;
    if items.len() > MAX_HISTORY_ENTRIES {
        return None;
    }
    items
        .iter()
        .map(|item| {
            let span = parse_interval(item)?;
            let record = record(item)?;
            let description = description(record.get("description"))?;
            let project_id = nullable_id(record.get("projectId"))?;
            let task_id = nullable_id(record.get("taskId"))?;
            let billable = record.get("billable")?.as_bool()?;
            let tags = record.get("tagIds")?.as_array()?;
            if tags.len() > MAX_TAG_IDS || !tags.iter().all(is_id) {
                return None;
            }
            Some(DesktopAutopilotHistoryEntry {
                start: span.start,
                end: span.end,
                description,
                project_id,
                task_id,
                tag_ids: tags
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect(),
                billable,
            })
        })
        .collect()
}

pub fn parse_autopilot_applied(value: &Value) -> Option<AppliedResult> {
    let record = record(value)?;
    let token = record
        .get("token")
        .filter(|t| is_token(t))?
        .as_str()?
        .to_string();
    let ok = record.get("ok")?.as_bool()?;
    let Some(written) = record.get("written") else {
        return Some(AppliedResult {
            token,
            ok,
            written: None,
        });
    };
    let written = self::record(written)?;
    let description = description(written.get("description"))?;
    let project_id = nullable_id(written.get("projectId"))?;
    let task_id = nullable_id(written.get("taskId"))?;
    Some(AppliedResult {
        token,
        ok,
        written: Some(Written {
            description,
            project_id,
            task_id,
        }),
    })
}

pub fn parse_autopilot_hold(value: &Value) -> Option<HoldRequest> {
    let record = record(value)?;
    let mut out = HoldRequest::default();
    if let Some(value) = record.get("filingKey") {
        let key = value.as_str()?;
        if key.is_empty() || js::utf16_len(key) > MAX_FILING_KEY_LENGTH {
            return None;
        }
        out.filing_key = Some(key.to_string());
    }
    if let Some(value) = record.get("appKey") {
        let raw = value.as_str()?;
        if js::utf16_len(raw) > MAX_PATTERN_LENGTH {
            return None;
        }
        let key = to_activity_pattern(raw);
        if key.is_empty() {
            return None;
        }
        out.app_key = Some(key);
    }
    if let Some(value) = record.get("dismiss") {
        let span = parse_interval(value)?;
        if span.end - span.start > MAX_RANGE_MS {
            return None;
        }
        out.dismiss = Some(span);
    }
    if let Some(value) = record.get("logId") {
        if !is_token(value) {
            return None;
        }
        out.log_id = value.as_str().map(str::to_string);
    }
    Some(out)
}

pub fn parse_autopilot_pause(value: &Value) -> Option<bool> {
    record(value)?.get("paused")?.as_bool()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn narrows_a_settings_patch_and_ignores_unknown_keys() {
        assert_eq!(
            parse_settings_patch(
                &json!({"enabled": true, "retentionDays": 900, "excludedApps": ["Com.Example.Chat", "", 3], "extra": 1})
            ),
            Some(SettingsPatch {
                enabled: Some(true),
                retention_days: Some(90.0),
                excluded_apps: Some(vec!["com.example.chat".into()]),
                ..Default::default()
            })
        );
        assert_eq!(
            parse_settings_patch(&json!({"enabled": "yes"})),
            Some(SettingsPatch::default())
        );
        for bad in [Value::Null, json!([]), json!("x"), json!(5)] {
            assert_eq!(parse_settings_patch(&bad), None);
        }
    }

    #[test]
    fn shapes_typed_patterns_like_keys_so_a_name_with_spaces_still_matches() {
        assert_eq!(
            parse_settings_patch(
                &json!({"excludedApps": ["Track Your Time.exe", "C:\\Tools\\x.exe"]})
            ),
            Some(SettingsPatch {
                excluded_apps: Some(vec!["track-your-time.exe".into(), "c-tools-x.exe".into()]),
                ..Default::default()
            })
        );
        assert_eq!(
            parse_rule_input(&json!({"pattern": "My Editor"}))
                .unwrap()
                .pattern,
            "my-editor"
        );
    }

    #[test]
    fn refuses_empty_long_or_colon_carrying_scope_ids() {
        assert_eq!(
            parse_scope(&json!({"userId": "u1", "workspaceId": "w1"})),
            Some(Scope {
                user_id: "u1".into(),
                workspace_id: "w1".into()
            })
        );
        for bad in [
            Value::Null,
            json!({"userId": "", "workspaceId": "w"}),
            json!({"userId": "u", "workspaceId": ""}),
            json!({"userId": "x".repeat(65), "workspaceId": "w"}),
            json!({"userId": "u:1", "workspaceId": "w"}),
            json!({"userId": 1, "workspaceId": "w"}),
        ] {
            assert_eq!(parse_scope(&bad), None, "{bad}");
        }
    }

    #[test]
    fn needs_finite_forward_intervals() {
        assert_eq!(
            parse_interval(&json!({"start": 1, "end": 2})),
            Some(ActivityInterval {
                start: 1.0,
                end: 2.0
            })
        );
        for bad in [
            json!({"start": 2, "end": 2}),
            json!({"start": "1", "end": 2}),
            json!({"start": 1}),
        ] {
            assert_eq!(parse_interval(&bad), None);
        }
    }

    #[test]
    fn bounds_the_suggestion_range_and_the_tracked_list() {
        assert!(parse_suggestions_input(
            &json!({"from": 0, "to": 10, "tracked": [{"start": 1, "end": 2}]})
        )
        .is_some());
        assert_eq!(
            parse_suggestions_input(&json!({"from": 0, "to": MAX_RANGE_MS + 1.0, "tracked": []})),
            None
        );
        assert_eq!(
            parse_suggestions_input(&json!({"from": 10, "to": 0, "tracked": []})),
            None
        );
        assert_eq!(
            parse_suggestions_input(
                &json!({"from": 0, "to": 10, "tracked": [{"start": 2, "end": 1}]})
            ),
            None
        );
        let many: Vec<Value> = (0..=MAX_TRACKED_INTERVALS)
            .map(|i| json!({"start": i, "end": i + 1}))
            .collect();
        assert_eq!(
            parse_suggestions_input(&json!({"from": 0, "to": 10, "tracked": many})),
            None
        );
        assert_eq!(parse_suggestions_input(&json!({"from": 0, "to": 10})), None);
    }

    #[test]
    fn needs_edited_to_be_a_boolean_on_an_accept_check() {
        assert!(parse_check_accept_input(
            &json!({"start": 1, "end": 2, "edited": false, "tracked": []})
        )
        .is_some());
        assert_eq!(
            parse_check_accept_input(&json!({"start": 1, "end": 2, "tracked": []})),
            None
        );
    }

    #[test]
    fn normalises_rule_patterns_and_bounds_every_field() {
        assert_eq!(
            parse_rule_input(
                &json!({"pattern": " COM.Example.* ", "projectId": null, "tagIds": ["t", "t"], "billable": true})
            ),
            Some(RuleInput {
                pattern: "com.example.*".into(),
                project_id: Some(None),
                tag_ids: Some(vec!["t".into()]),
                billable: Some(true),
                ..Default::default()
            })
        );
        let tags: Vec<String> = (0..21).map(|i| format!("t{i}")).collect();
        for bad in [
            json!({"pattern": ""}),
            json!({"pattern": "   "}),
            json!({"pattern": "x".repeat(201)}),
            json!({"pattern": "a", "description": "x".repeat(501)}),
            json!({"pattern": "a", "projectId": ""}),
            json!({"pattern": "a", "tagIds": tags}),
            json!({"pattern": "a", "billable": "yes"}),
        ] {
            assert_eq!(parse_rule_input(&bad), None, "{bad}");
        }
        assert_eq!(parse_rule_id(&json!("r1")).as_deref(), Some("r1"));
        assert_eq!(parse_rule_id(&json!("")), None);
    }

    #[test]
    fn narrows_plan_input() {
        assert_eq!(
            parse_autopilot_plan_input(&json!({"running": null, "tracked": []})),
            Some(PlanInput {
                running: None,
                tracked: vec![]
            })
        );
        assert_eq!(
            parse_autopilot_plan_input(&json!({"running": {"start": 1}, "tracked": []})),
            None
        );
        assert_eq!(
            parse_autopilot_plan_input(
                &json!({"running": null, "tracked": [{"start": 2, "end": 1}]})
            ),
            None
        );
        assert_eq!(parse_autopilot_plan_input(&json!({"tracked": []})), None);
        assert_eq!(parse_autopilot_plan_input(&Value::Null), None);
    }

    #[test]
    fn narrows_history_applied_and_hold() {
        assert_eq!(
            parse_autopilot_history(
                &json!([{"start": 1, "end": 2, "description": "x", "projectId": null, "taskId": null, "tagIds": ["t"], "billable": true}])
            ),
            Some(vec![DesktopAutopilotHistoryEntry {
                start: 1.0,
                end: 2.0,
                description: "x".into(),
                project_id: None,
                task_id: None,
                tag_ids: vec!["t".into()],
                billable: true,
            }])
        );
        assert_eq!(
            parse_autopilot_history(&json!([{"start": 1, "end": 2, "description": "x"}])),
            None
        );
        assert_eq!(
            parse_autopilot_applied(&json!({"token": "a", "ok": true})),
            Some(AppliedResult {
                token: "a".into(),
                ok: true,
                written: None
            })
        );
        assert_eq!(
            parse_autopilot_applied(&json!({"token": "", "ok": true})),
            None
        );
        assert_eq!(
            parse_autopilot_applied(
                &json!({"token": "a", "ok": true, "written": {"description": 1}})
            ),
            None
        );
        assert_eq!(
            parse_autopilot_hold(&json!({"appKey": " Com.Example.App "})),
            Some(HoldRequest {
                app_key: Some("com.example.app".into()),
                ..Default::default()
            })
        );
        assert_eq!(
            parse_autopilot_hold(&json!({"dismiss": {"start": 2, "end": 1}})),
            None
        );
    }

    #[test]
    fn narrows_a_pause() {
        assert_eq!(parse_autopilot_pause(&json!({"paused": true})), Some(true));
        assert_eq!(
            parse_autopilot_pause(&json!({"paused": false})),
            Some(false)
        );
        assert_eq!(parse_autopilot_pause(&json!({"paused": "yes"})), None);
        // Main picks the length.
        assert_eq!(
            parse_autopilot_pause(&json!({"paused": true, "until": 1})),
            Some(true)
        );
        assert_eq!(parse_autopilot_pause(&Value::Null), None);
    }
}
