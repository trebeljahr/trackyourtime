//! Presentation shared by the desktop tray and Raycast's native menu, ported
//! from `packages/shared/src/timer-menu.ts`: the minute-precision clock, the
//! one-line names, the summary and control sections both hosts draw, and the
//! lease files through which Raycast and the desktop app agree that only one
//! of them shows a menu bar item (`raycast_menu.rs`).

#[path = "js_text.rs"]
pub(crate) mod js;

use serde_json::Value;

use js::{js_round, js_trim, js_trim_end, safe_integer};

/// `~/Library/Application Support/dev.trackyourtime/menu-bar/raycast-menu.json`.
pub const RAYCAST_MENU_LEASE_PARTS: [&str; 5] = [
    "Library",
    "Application Support",
    "dev.trackyourtime",
    "menu-bar",
    "raycast-menu.json",
];
/// `~/Library/Application Support/dev.trackyourtime/menu-bar/desktop-menu.json`.
pub const DESKTOP_MENU_LEASE_PARTS: [&str; 5] = [
    "Library",
    "Application Support",
    "dev.trackyourtime",
    "menu-bar",
    "desktop-menu.json",
];
pub const RAYCAST_MENU_POLL_MS: u64 = 500;

/// The owner pid of a Raycast lease that claims the menu bar, or `None`.
///
/// A command can unload while its native item remains. Ownership lasts until
/// it explicitly hides the item or its Raycast host exits, never a timer
/// expiry.
pub fn raycast_menu_visible(value: &Value) -> Option<i64> {
    let lease = value.as_object()?;
    if lease.get("version").and_then(Value::as_f64) != Some(1.0) {
        return None;
    }
    if lease.get("visible") != Some(&Value::Bool(true)) {
        return None;
    }
    let pid = safe_integer(lease.get("ownerPid")?)?;
    (pid > 0).then_some(pid)
}

/// Minute precision keeps an unloaded Raycast item from showing frozen seconds.
pub fn timer_menu_clock(seconds: f64) -> String {
    let total = if seconds.is_finite() {
        (seconds / 60.0).floor().max(0.0)
    } else {
        0.0
    };
    if total == 0.0 {
        return "<1m".to_string();
    }
    let total = total as u64;
    let hours = total / 60;
    let minutes = total % 60;
    if hours == 0 {
        format!("{minutes}m")
    } else {
        format!("{hours}h {minutes:02}m")
    }
}

/// Native menus grow to fit text. Keep names on one short line.
pub fn timer_menu_text(text: &str) -> String {
    let trimmed = js_trim(text);
    // `split(/\r?\n/, 1)[0]`: up to the first line feed, without its \r.
    let first = match trimmed.find('\n') {
        Some(index) => trimmed[..index]
            .strip_suffix('\r')
            .unwrap_or(&trimmed[..index]),
        None => trimmed,
    };
    let line = js_trim(first);
    let chars: Vec<char> = line.chars().collect();
    if chars.len() > 48 {
        let head: String = chars[..47].iter().collect();
        format!("{}…", js_trim_end(&head))
    } else {
        line.to_string()
    }
}

/// `formatDurationShort` from `packages/shared/src/duration.ts`, English (the
/// tray passes no locale): `1h 5m`, `5m`, `42s`.
pub fn format_duration_short(seconds: f64) -> String {
    let total = js_round(seconds.abs());
    let sign = if seconds < 0.0 { "-" } else { "" };
    let hours = (total / 3600.0).floor();
    let minutes = ((total % 3600.0) / 60.0).floor();
    if hours > 0.0 {
        return format!("{sign}{hours}h {minutes}m");
    }
    if minutes > 0.0 {
        return format!("{sign}{minutes}m");
    }
    format!("{sign}{total}s")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimerMenuLabels {
    pub stop: String,
    pub edit: String,
    pub start_timer: String,
    pub no_timer: String,
    /// Translated sentence with a literal `{duration}` placeholder.
    pub running_for: String,
}

impl Default for TimerMenuLabels {
    /// `TIMER_MENU_LABELS`.
    fn default() -> Self {
        TimerMenuLabels {
            stop: "Stop Timer".into(),
            edit: "Edit Timer…".into(),
            start_timer: "Start Timer".into(),
            no_timer: "No timer running".into(),
            running_for: "Running for {duration}".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TimerMenuRow {
    Name { title: String, tooltip: String },
    Timing { title: String },
    Stop { title: String },
    Edit { title: String },
    Start { title: String },
}

impl TimerMenuRow {
    /// `row.kind` in the TypeScript union.
    pub fn kind(&self) -> &'static str {
        match self {
            TimerMenuRow::Name { .. } => "name",
            TimerMenuRow::Timing { .. } => "timing",
            TimerMenuRow::Stop { .. } => "stop",
            TimerMenuRow::Edit { .. } => "edit",
            TimerMenuRow::Start { .. } => "start",
        }
    }

    pub fn title(&self) -> &str {
        match self {
            TimerMenuRow::Name { title, .. }
            | TimerMenuRow::Timing { title }
            | TimerMenuRow::Stop { title }
            | TimerMenuRow::Edit { title }
            | TimerMenuRow::Start { title } => title,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimerMenuSection {
    pub title: Option<String>,
    pub rows: Vec<TimerMenuRow>,
}

/// The running timer as the menu names it.
#[derive(Debug, Clone, PartialEq)]
pub struct TimerMenuRunning {
    pub label: String,
    pub elapsed_sec: f64,
}

/// Both hosts draw these same summary and control sections, then add their own tools.
pub fn timer_menu_sections(
    running: Option<&TimerMenuRunning>,
    labels: &TimerMenuLabels,
) -> Vec<TimerMenuSection> {
    let Some(running) = running else {
        return vec![TimerMenuSection {
            title: Some(labels.no_timer.clone()),
            rows: vec![TimerMenuRow::Start {
                title: labels.start_timer.clone(),
            }],
        }];
    };
    vec![
        TimerMenuSection {
            title: None,
            rows: vec![
                TimerMenuRow::Name {
                    title: timer_menu_text(&running.label),
                    tooltip: running.label.clone(),
                },
                TimerMenuRow::Timing {
                    // `String.replace` with a string pattern: the first occurrence only.
                    title: labels.running_for.replacen(
                        "{duration}",
                        &format_duration_short(running.elapsed_sec),
                        1,
                    ),
                },
            ],
        },
        TimerMenuSection {
            title: None,
            rows: vec![
                TimerMenuRow::Stop {
                    title: labels.stop.clone(),
                },
                TimerMenuRow::Edit {
                    title: labels.edit.clone(),
                },
            ],
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clock_has_minute_precision() {
        assert_eq!(timer_menu_clock(0.0), "<1m");
        assert_eq!(timer_menu_clock(59.9), "<1m");
        assert_eq!(timer_menu_clock(125.0), "2m");
        assert_eq!(timer_menu_clock(3700.0), "1h 01m");
        assert_eq!(timer_menu_clock(-5.0), "<1m");
        assert_eq!(timer_menu_clock(f64::NAN), "<1m");
    }

    #[test]
    fn text_keeps_one_short_line() {
        assert_eq!(timer_menu_text("  one\r\ntwo  "), "one");
        assert_eq!(timer_menu_text(&"x".repeat(48)), "x".repeat(48));
        let long = format!("{} tail", "a".repeat(46));
        assert_eq!(timer_menu_text(&long), format!("{}…", "a".repeat(46)));
    }

    #[test]
    fn sections_for_idle_and_running() {
        let labels = TimerMenuLabels::default();
        let idle = timer_menu_sections(None, &labels);
        assert_eq!(idle[0].title.as_deref(), Some("No timer running"));
        assert_eq!(idle[0].rows[0].kind(), "start");
        let running = TimerMenuRunning {
            label: "Write".into(),
            elapsed_sec: 125.0,
        };
        let sections = timer_menu_sections(Some(&running), &labels);
        assert_eq!(sections[0].rows[1].title(), "Running for 2m");
        assert_eq!(
            sections[1]
                .rows
                .iter()
                .map(TimerMenuRow::kind)
                .collect::<Vec<_>>(),
            ["stop", "edit"]
        );
    }

    #[test]
    fn duration_short_matches_shared() {
        assert_eq!(format_duration_short(125.0), "2m");
        assert_eq!(format_duration_short(3700.0), "1h 1m");
        assert_eq!(format_duration_short(42.4), "42s");
        assert_eq!(format_duration_short(-90.0), "-1m");
    }

    #[test]
    fn lease_needs_version_visible_and_a_safe_pid() {
        assert_eq!(
            raycast_menu_visible(&json!({"version": 1, "visible": true, "ownerPid": 42})),
            Some(42)
        );
        assert_eq!(
            raycast_menu_visible(&json!({"version": 1, "visible": true, "ownerPid": -1})),
            None
        );
        assert_eq!(
            raycast_menu_visible(&json!({"version": 1, "visible": false, "ownerPid": 42})),
            None
        );
        assert_eq!(
            raycast_menu_visible(&json!({"version": 2, "visible": true, "ownerPid": 42})),
            None
        );
        assert_eq!(
            raycast_menu_visible(&json!({"version": 1, "visible": true, "ownerPid": 1.5})),
            None
        );
        assert_eq!(raycast_menu_visible(&json!(null)), None);
    }
}
