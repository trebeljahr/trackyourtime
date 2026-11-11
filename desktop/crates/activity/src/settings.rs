//! The capture switches (`settings.ts`). Device preferences, in
//! `userData/activity/state.json`: whether this computer records which app is
//! in front is a decision about this computer, so they outlive a sign-out.
//! Capture is OFF until somebody turns it on — nothing in this crate ever
//! turns it on by itself — and so is Autopilot, which also needs capture on
//! to do anything.

use serde_json::Value;
use tyt_wire::DesktopActivitySettings;

use crate::core::{AUTOPILOT_START_MINUTE_CHOICES, DEFAULT_AUTOPILOT_START_MINUTES};
use crate::js;
use crate::keys::to_activity_pattern;

pub const DEFAULT_RETENTION_DAYS: f64 = 14.0;
pub const MIN_RETENTION_DAYS: f64 = 1.0;
pub const MAX_RETENTION_DAYS: f64 = 90.0;
/// How many "Never record" patterns are kept.
pub const MAX_EXCLUDED_APPS: usize = 200;

pub fn default_activity_settings() -> DesktopActivitySettings {
    DesktopActivitySettings {
        enabled: false,
        store_titles: false,
        excluded_apps: Vec::new(),
        retention_days: DEFAULT_RETENTION_DAYS,
        autopilot: false,
        autopilot_start_minutes: DEFAULT_AUTOPILOT_START_MINUTES,
    }
}

/// One of the offered thresholds; anything else is the default.
pub fn clean_autopilot_start_minutes(value: Option<&Value>) -> f64 {
    match value.and_then(Value::as_f64) {
        Some(minutes) if AUTOPILOT_START_MINUTE_CHOICES.contains(&minutes) => minutes,
        _ => DEFAULT_AUTOPILOT_START_MINUTES,
    }
}

pub fn clamp_retention_days(value: f64) -> f64 {
    if value.is_finite() {
        MAX_RETENTION_DAYS.min(MIN_RETENTION_DAYS.max(js::round(value)))
    } else {
        DEFAULT_RETENTION_DAYS
    }
}

/// Key-shaped ([`to_activity_pattern`]), de-duplicated patterns; empty and
/// over-long ones dropped.
pub fn clean_app_list(values: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in values {
        let Some(text) = value.as_str() else { continue };
        if js::utf16_len(text) > 200 {
            continue;
        }
        let pattern = to_activity_pattern(text);
        if !pattern.is_empty() && !out.contains(&pattern) {
            out.push(pattern);
        }
        if out.len() >= MAX_EXCLUDED_APPS {
            break;
        }
    }
    out
}

/// Narrow whatever is stored; anything unreadable falls back to the default.
pub fn parse_activity_settings(value: Option<&Value>) -> DesktopActivitySettings {
    let Some(record) = value.and_then(Value::as_object) else {
        return default_activity_settings();
    };
    DesktopActivitySettings {
        enabled: record.get("enabled") == Some(&Value::Bool(true)),
        store_titles: record.get("storeTitles") == Some(&Value::Bool(true)),
        excluded_apps: record
            .get("excludedApps")
            .and_then(Value::as_array)
            .map(|a| clean_app_list(a))
            .unwrap_or_default(),
        retention_days: match record.get("retentionDays").and_then(Value::as_f64) {
            Some(days) => clamp_retention_days(days),
            None => DEFAULT_RETENTION_DAYS,
        },
        // Absent in a state.json from before Autopilot: off, like capture itself.
        autopilot: record.get("autopilot") == Some(&Value::Bool(true)),
        autopilot_start_minutes: clean_autopilot_start_minutes(record.get("autopilotStartMinutes")),
    }
}

/// `<userId>:<workspaceId>`, the key every stored row carries.
pub fn activity_scope_of(user_id: &str, workspace_id: &str) -> String {
    format!("{user_id}:{workspace_id}")
}

/// The prefix every scope of one account starts with.
pub fn account_prefix_of(user_id: &str) -> String {
    format!("{user_id}:")
}

/// The settings as JSON, for `parse_activity_settings` round trips.
pub fn settings_value(settings: &DesktopActivitySettings) -> Value {
    serde_json::to_value(settings).expect("settings serialize")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unreadable_settings_fall_back_to_the_defaults() {
        assert_eq!(parse_activity_settings(None), default_activity_settings());
        assert_eq!(
            parse_activity_settings(Some(&json!([]))),
            default_activity_settings()
        );
        let parsed = parse_activity_settings(Some(
            &json!({"enabled": true, "retentionDays": 900, "autopilotStartMinutes": 7}),
        ));
        assert!(parsed.enabled);
        assert_eq!(parsed.retention_days, 90.0);
        assert_eq!(parsed.autopilot_start_minutes, 5.0);
        assert!(!parsed.autopilot);
    }

    #[test]
    fn retention_rounds_like_math_round() {
        assert_eq!(clamp_retention_days(2.5), 3.0);
        assert_eq!(clamp_retention_days(0.2), 1.0);
        assert_eq!(clamp_retention_days(f64::NAN), DEFAULT_RETENTION_DAYS);
    }
}
