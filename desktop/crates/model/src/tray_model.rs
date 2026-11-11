//! What the tray draws, as data: the menu, the macOS title, the tooltip and
//! which icon. Ported from `electron/src/tray-model.ts`. The shell turns this
//! into tray objects; headless runs expose it to specs instead of creating a
//! tray. Pure, so unit-tested.
//!
//! The renderer publishes `DesktopTimerState` and owns every decision about
//! the timer; this file only lays it out and computes the ticking clock from
//! `startedAt`, so the title moves without a message per second.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tyt_wire::{
    DesktopNotice, DesktopNoticeKind, DesktopRecent, DesktopRunningTimer, DesktopTimerState,
    DesktopTrayAutopilot, DesktopTrayLabels,
};

use crate::timer_menu::js::{finite_number, js_trim, parse_iso_ms, slice_utf16};
use crate::timer_menu::{
    timer_menu_clock, timer_menu_sections, timer_menu_text, TimerMenuLabels, TimerMenuRow,
    TimerMenuRunning,
};

/// English, for the moments no renderer has published labels yet: before the
/// first page load, or signed out on the first launch. The last labels a
/// renderer sent are remembered on disk (`tray-labels.json`, the desktop
/// controller), so a German person sees English here only on a first launch.
pub fn fallback_tray_labels() -> DesktopTrayLabels {
    let menu = TimerMenuLabels::default();
    DesktopTrayLabels {
        stop: menu.stop,
        edit: menu.edit,
        running_for: menu.running_for,
        no_timer: menu.no_timer,
        start_timer: menu.start_timer,
        recent_heading: "Continue".into(),
        open: "Open Track Your Time".into(),
        compact_timer: "Open compact timer".into(),
        settings: "Settings…".into(),
        quit: "Quit Track Your Time".into(),
        no_description: "(no description)".into(),
        idle_tooltip: "Track Your Time".into(),
        unsent: String::new(),
        quit_unsent_title: "Some changes have not been sent yet".into(),
        quit_unsent_body:
            "They are kept on this computer and sent the next time Track Your Time starts.".into(),
        quit_unsent_button: "Quit".into(),
        running_badge: "Timer running".into(),
        restart_to_update: "Restart to update".into(),
        autopilot_pause: "Pause Autopilot for an hour".into(),
        autopilot_resume: "Resume Autopilot".into(),
        autopilot_paused: String::new(),
    }
}

/// Put before a timer Autopilot opened, wherever the tray names it: the macOS
/// title, the tooltip and the menu's heading. A glyph rather than a word, so
/// the menu bar stays short and no catalog has to agree on it.
pub const AUTOPILOT_MARK: &str = "✦";

pub const MAX_TRAY_RECENTS: usize = 5;
const MAX_TEXT: usize = 200;

fn text(value: Option<&Value>, fallback: &str) -> String {
    match value {
        Some(Value::String(s)) => slice_utf16(s, MAX_TEXT),
        _ => fallback.to_string(),
    }
}

fn nullable_text(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(s)) => Some(slice_utf16(s, MAX_TEXT)),
        _ => None,
    }
}

fn is_hex_colour(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// Every key of the labels, as the wire spells it, with a setter.
fn label_slots(labels: &mut DesktopTrayLabels) -> [(&'static str, &mut String); 21] {
    [
        ("stop", &mut labels.stop),
        ("edit", &mut labels.edit),
        ("runningFor", &mut labels.running_for),
        ("noTimer", &mut labels.no_timer),
        ("startTimer", &mut labels.start_timer),
        ("recentHeading", &mut labels.recent_heading),
        ("open", &mut labels.open),
        ("compactTimer", &mut labels.compact_timer),
        ("settings", &mut labels.settings),
        ("quit", &mut labels.quit),
        ("noDescription", &mut labels.no_description),
        ("idleTooltip", &mut labels.idle_tooltip),
        ("unsent", &mut labels.unsent),
        ("quitUnsentTitle", &mut labels.quit_unsent_title),
        ("quitUnsentBody", &mut labels.quit_unsent_body),
        ("quitUnsentButton", &mut labels.quit_unsent_button),
        ("runningBadge", &mut labels.running_badge),
        ("restartToUpdate", &mut labels.restart_to_update),
        ("autopilotPause", &mut labels.autopilot_pause),
        ("autopilotResume", &mut labels.autopilot_resume),
        ("autopilotPaused", &mut labels.autopilot_paused),
    ]
}

/// Labels from the renderer (or `tray-labels.json`): every known key that is
/// a string, cut to 600 code units; anything else keeps its English fallback.
pub fn parse_tray_labels(value: &Value) -> DesktopTrayLabels {
    let mut labels = fallback_tray_labels();
    let Value::Object(map) = value else {
        return labels;
    };
    for (key, slot) in label_slots(&mut labels) {
        // Longer than a tray label: the quit notice's body is a sentence.
        if let Some(Value::String(candidate)) = map.get(key) {
            *slot = slice_utf16(candidate, 600);
        }
    }
    labels
}

/// The renderer's payload, checked field by field: it crossed the bridge.
pub fn parse_timer_state(value: &Value) -> Option<DesktopTimerState> {
    let Value::Object(map) = value else {
        return None;
    };
    let Some(Value::Bool(signed_in)) = map.get("signedIn") else {
        return None;
    };
    let signed_in = *signed_in;

    let mut running = None;
    if let Some(Value::Object(entry)) = map.get("running") {
        let started_at = text(entry.get("startedAt"), "");
        if parse_iso_ms(&started_at).is_some() {
            let colour = nullable_text(entry.get("projectColor")).filter(|c| is_hex_colour(c));
            running = Some(DesktopRunningTimer {
                description: text(entry.get("description"), ""),
                started_at,
                project_name: nullable_text(entry.get("projectName")),
                project_color: colour,
                autopilot: (entry.get("autopilot") == Some(&Value::Bool(true))).then_some(true),
            });
        }
    }
    let mut autopilot = None;
    if let Some(Value::Object(pilot)) = map.get("autopilot") {
        autopilot = Some(DesktopTrayAutopilot {
            paused_until: pilot.get("pausedUntil").and_then(finite_number),
        });
    }
    let mut recents = Vec::new();
    if let Some(Value::Array(items)) = map.get("recents") {
        for item in items {
            if recents.len() >= MAX_TRAY_RECENTS {
                break;
            }
            let Value::Object(item) = item else { continue };
            let Some(Value::String(key)) = item.get("key") else {
                continue;
            };
            if key.is_empty() {
                continue;
            }
            recents.push(DesktopRecent {
                key: slice_utf16(key, 500),
                label: text(item.get("label"), ""),
                hint: nullable_text(item.get("hint")),
            });
        }
    }
    let unsent = map
        .get("unsent")
        .and_then(finite_number)
        .map(|n| n.floor().max(0.0) as u64)
        .unwrap_or(0);
    Some(DesktopTimerState {
        signed_in,
        running: if signed_in { running } else { None },
        recents: if signed_in { recents } else { Vec::new() },
        unsent,
        autopilot: if signed_in { autopilot } else { None },
        labels: parse_tray_labels(map.get("labels").unwrap_or(&Value::Null)),
    })
}

/// `m:ss` under an hour, `h:mm` from there — the menu bar has little room.
pub fn tray_clock(elapsed_sec: f64) -> String {
    let total = if elapsed_sec.is_finite() {
        elapsed_sec.floor().max(0.0) as u64
    } else {
        0
    };
    let hours = total / 3600;
    let minutes = (total % 3600) / 60;
    let seconds = total % 60;
    if hours == 0 {
        format!("{minutes}:{seconds:02}")
    } else {
        format!("{hours}:{minutes:02}")
    }
}

pub fn elapsed_sec_at(started_at: &str, now_ms: f64) -> f64 {
    match parse_iso_ms(started_at) {
        Some(start) => ((now_ms - start) / 1000.0).max(0.0),
        None => 0.0,
    }
}

/// What the running entry is called: description, else project, else the placeholder.
pub fn running_label(state: &DesktopTimerState) -> String {
    let Some(running) = &state.running else {
        return String::new();
    };
    let description = js_trim(&running.description);
    if !description.is_empty() {
        return description.to_string();
    }
    running
        .project_name
        .clone()
        .unwrap_or_else(|| state.labels.no_description.clone())
}

/// `✦ ` before anything that names a timer Autopilot opened, nothing otherwise.
fn autopilot_prefix(state: &DesktopTimerState) -> String {
    match &state.running {
        Some(running) if running.autopilot == Some(true) => format!("{AUTOPILOT_MARK} "),
        _ => String::new(),
    }
}

/// Whether Autopilot is paused at `now_ms`; a pause that has run out reads as none.
pub fn autopilot_paused_at(state: Option<&DesktopTimerState>, now_ms: f64) -> bool {
    let until = state
        .and_then(|s| s.autopilot.as_ref())
        .and_then(|a| a.paused_until);
    until.is_some_and(|until| until > now_ms)
}

/// One row of the tray menu, as the TypeScript union serialized it:
/// `{type: "item", id, label, enabled}`, `{type: "heading", label}`,
/// `{type: "separator"}`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TrayMenuItem {
    Item {
        id: String,
        label: String,
        enabled: bool,
    },
    Heading {
        label: String,
    },
    Separator,
}

impl TrayMenuItem {
    fn item(id: impl Into<String>, label: impl Into<String>) -> Self {
        TrayMenuItem::Item {
            id: id.into(),
            label: label.into(),
            enabled: true,
        }
    }

    fn heading(label: impl Into<String>) -> Self {
        TrayMenuItem::Heading {
            label: label.into(),
        }
    }
}

/// Running summary with Stop and Edit; idle Start and up to five recents.
/// Autopilot's pause or resume while it is on, the unsent count when non-zero,
/// Open, Settings, Quit. Signed out (or before any state arrived): Open and
/// Quit.
///
/// With a downloaded update, "Restart to update" sits above Quit in either
/// menu: the person picks the moment, the app never restarts by itself.
///
/// Item ids are what a click hands back: `stop`, `edit`, `start`,
/// `continue:<key>`, `autopilot-pause`, `autopilot-resume`, `open`,
/// `compact`, `settings`, `restart-to-update`, `quit`.
pub fn tray_menu_model(
    state: Option<&DesktopTimerState>,
    update_ready: bool,
    now_ms: f64,
) -> Vec<TrayMenuItem> {
    let fallback;
    let labels = match state {
        Some(state) => &state.labels,
        None => {
            fallback = fallback_tray_labels();
            &fallback
        }
    };
    let restart: Vec<TrayMenuItem> = if update_ready {
        vec![TrayMenuItem::item(
            "restart-to-update",
            &labels.restart_to_update,
        )]
    } else {
        vec![]
    };
    let state = match state {
        Some(state) if state.signed_in => state,
        _ => {
            let mut items = vec![
                TrayMenuItem::item("open", &labels.open),
                TrayMenuItem::Separator,
            ];
            items.extend(restart);
            items.push(TrayMenuItem::item("quit", &labels.quit));
            return items;
        }
    };

    let mut items: Vec<TrayMenuItem> = Vec::new();
    let menu_labels = TimerMenuLabels {
        stop: labels.stop.clone(),
        edit: labels.edit.clone(),
        start_timer: labels.start_timer.clone(),
        no_timer: labels.no_timer.clone(),
        running_for: labels.running_for.clone(),
    };
    let running = state.running.as_ref().map(|running| TimerMenuRunning {
        label: format!("{}{}", autopilot_prefix(state), running_label(state)),
        elapsed_sec: elapsed_sec_at(&running.started_at, now_ms),
    });
    for section in timer_menu_sections(running.as_ref(), &menu_labels) {
        if let Some(title) = section.title {
            items.push(TrayMenuItem::heading(title));
        }
        for row in section.rows {
            match row {
                TimerMenuRow::Timing { title } => items.push(TrayMenuItem::heading(title)),
                TimerMenuRow::Name { title, .. } => items.push(TrayMenuItem::item("edit", title)),
                other => {
                    let id = other.kind();
                    items.push(TrayMenuItem::item(id, other.title()));
                }
            }
        }
        items.push(TrayMenuItem::Separator);
    }
    if state.running.is_none() && !state.recents.is_empty() {
        items.push(TrayMenuItem::heading(&labels.recent_heading));
        for recent in &state.recents {
            let label = if js_trim(&recent.label).is_empty() {
                &labels.no_description
            } else {
                &recent.label
            };
            let text = match recent.hint.as_deref() {
                Some(hint) if !hint.is_empty() => format!("{label} — {hint}"),
                _ => label.clone(),
            };
            items.push(TrayMenuItem::item(
                format!("continue:{}", recent.key),
                timer_menu_text(&text),
            ));
        }
        items.push(TrayMenuItem::Separator);
    }
    if state.autopilot.is_some() {
        items.push(TrayMenuItem::Separator);
        if autopilot_paused_at(Some(state), now_ms) {
            if !labels.autopilot_paused.is_empty() {
                items.push(TrayMenuItem::heading(&labels.autopilot_paused));
            }
            items.push(TrayMenuItem::item(
                "autopilot-resume",
                &labels.autopilot_resume,
            ));
        } else {
            items.push(TrayMenuItem::item(
                "autopilot-pause",
                &labels.autopilot_pause,
            ));
        }
    }
    if state.unsent > 0 && !labels.unsent.is_empty() {
        items.push(TrayMenuItem::Separator);
        items.push(TrayMenuItem::heading(&labels.unsent));
    }
    items.push(TrayMenuItem::Separator);
    items.push(TrayMenuItem::item("open", &labels.open));
    items.push(TrayMenuItem::item("compact", &labels.compact_timer));
    items.push(TrayMenuItem::item("settings", &labels.settings));
    items.push(TrayMenuItem::Separator);
    items.extend(restart);
    items.push(TrayMenuItem::item("quit", &labels.quit));

    // No separator first, and none right after another (in the unfiltered list).
    let keep: Vec<bool> = (0..items.len())
        .map(|i| {
            items[i] != TrayMenuItem::Separator
                || (i > 0 && items[i - 1] != TrayMenuItem::Separator)
        })
        .collect();
    items
        .into_iter()
        .zip(keep)
        .filter_map(|(item, keep)| keep.then_some(item))
        .collect()
}

/// The text beside the macOS menu bar icon: the clock while running, nothing
/// when idle (Raycast's defaults), and [`AUTOPILOT_MARK`] before the clock of
/// a timer Autopilot opened. A tray title exists only on macOS.
pub fn tray_title(state: Option<&DesktopTimerState>, now_ms: f64, platform: &str) -> String {
    let Some(state) = state else {
        return String::new();
    };
    let Some(running) = &state.running else {
        return String::new();
    };
    if platform != "darwin" {
        return String::new();
    }
    format!(
        "{}{}",
        autopilot_prefix(state),
        timer_menu_clock(elapsed_sec_at(&running.started_at, now_ms))
    )
}

/// Windows and Linux carry the clock (and the Autopilot mark) in the tooltip instead.
pub fn tray_tooltip(state: Option<&DesktopTimerState>, now_ms: f64) -> String {
    let Some(state) = state else {
        return fallback_tray_labels().idle_tooltip;
    };
    let Some(running) = &state.running else {
        return state.labels.idle_tooltip.clone();
    };
    format!(
        "{}{} — {}",
        autopilot_prefix(state),
        running_label(state),
        timer_menu_clock(elapsed_sec_at(&running.started_at, now_ms))
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrayIconVariant {
    Idle,
    Running,
}

pub fn tray_icon_variant(state: Option<&DesktopTimerState>) -> TrayIconVariant {
    if state.is_some_and(|s| s.running.is_some()) {
        TrayIconVariant::Running
    } else {
        TrayIconVariant::Idle
    }
}

/// The icon file for a platform, beside the bundle under `tray/`
/// (`scripts/icons-brand.mjs` writes them).
pub fn tray_icon_file(platform: &str, variant: TrayIconVariant) -> &'static str {
    let running = variant == TrayIconVariant::Running;
    match platform {
        "darwin" => "tray-mac.png",
        "win32" if running => "tray-running.ico",
        "win32" => "tray.ico",
        _ if running => "tray-running.png",
        _ => "tray.png",
    }
}

/// The Windows taskbar overlay for a running timer, beside the tray icons.
pub const OVERLAY_RUNNING_FILE: &str = "overlay-running.png";

/// A notice from the renderer, checked; `None` when malformed.
pub fn parse_notice(value: &Value) -> Option<DesktopNotice> {
    let Value::Object(map) = value else {
        return None;
    };
    let (kind, kind_name) = match map.get("kind").and_then(Value::as_str) {
        Some("idle") => (DesktopNoticeKind::Idle, "idle"),
        Some("runaway") => (DesktopNoticeKind::Runaway, "runaway"),
        Some("autopilot") => (DesktopNoticeKind::Autopilot, "autopilot"),
        _ => return None,
    };
    let title = js_trim(&text(map.get("title"), "")).to_string();
    if title.is_empty() {
        return None;
    }
    Some(DesktopNotice {
        kind,
        title,
        body: text(map.get("body"), ""),
        tag: slice_utf16(&text(map.get("tag"), kind_name), 100),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const START: &str = "2026-09-17T10:00:00.000Z";
    const START_MS: f64 = 1_789_639_200_000.0;

    fn at(sec: f64) -> f64 {
        START_MS + sec * 1000.0
    }

    fn running() -> DesktopTimerState {
        DesktopTimerState {
            signed_in: true,
            running: Some(DesktopRunningTimer {
                description: "Write the plan".into(),
                started_at: START.into(),
                project_name: Some("Desktop".into()),
                project_color: Some("#4f46e5".into()),
                autopilot: None,
            }),
            recents: vec![
                DesktopRecent {
                    key: "k1".into(),
                    label: "Review".into(),
                    hint: Some("Client — Project".into()),
                },
                DesktopRecent {
                    key: "k2".into(),
                    label: "".into(),
                    hint: None,
                },
            ],
            unsent: 2,
            autopilot: None,
            labels: DesktopTrayLabels {
                unsent: "2 unsent changes".into(),
                stop: "Stoppen".into(),
                ..fallback_tray_labels()
            },
        }
    }

    fn ids(items: &[TrayMenuItem]) -> Vec<String> {
        items
            .iter()
            .filter_map(|item| match item {
                TrayMenuItem::Item { id, .. } => Some(id.clone()),
                _ => None,
            })
            .collect()
    }

    fn outline(items: &[TrayMenuItem]) -> Vec<String> {
        items
            .iter()
            .map(|item| match item {
                TrayMenuItem::Item { id, .. } => id.clone(),
                TrayMenuItem::Heading { label } => format!("# {label}"),
                TrayMenuItem::Separator => "---".into(),
            })
            .collect()
    }

    fn has_label(items: &[TrayMenuItem], wanted: &str) -> bool {
        items
            .iter()
            .any(|item| matches!(item, TrayMenuItem::Item { label, .. } if label == wanted))
    }

    #[test]
    fn tray_clock_is_m_ss_under_an_hour_and_h_mm_from_an_hour() {
        assert_eq!(tray_clock(0.0), "0:00");
        assert_eq!(tray_clock(65.9), "1:05");
        assert_eq!(tray_clock(3599.0), "59:59");
        assert_eq!(tray_clock(3600.0), "1:00");
        assert_eq!(tray_clock((3 * 3600 + 7 * 60 + 59) as f64), "3:07");
        assert_eq!(tray_clock(-5.0), "0:00");
    }

    #[test]
    fn signed_out_or_before_any_state_open_and_quit_only() {
        let signed_out = DesktopTimerState {
            signed_in: false,
            ..running()
        };
        for state in [None, Some(&signed_out)] {
            assert_eq!(
                ids(&tray_menu_model(state, false, at(0.0))),
                ["open", "quit"]
            );
        }
    }

    #[test]
    fn running_matching_summary_and_controls_without_idle_start_choices() {
        let state = running();
        let model = tray_menu_model(Some(&state), false, at(125.0));
        assert_eq!(
            outline(&model),
            [
                "edit",
                "# Running for 2m",
                "---",
                "stop",
                "edit",
                "---",
                "# 2 unsent changes",
                "---",
                "open",
                "compact",
                "settings",
                "---",
                "quit"
            ]
        );
        assert!(matches!(&model[0], TrayMenuItem::Item { label, .. } if label == "Write the plan"));
        assert!(has_label(&model, "Stoppen"));
        let idle = DesktopTimerState {
            running: None,
            ..running()
        };
        let idle_model = tray_menu_model(Some(&idle), false, at(0.0));
        assert!(has_label(&idle_model, "Review — Client — Project"));
        assert!(has_label(&idle_model, "(no description)"));
    }

    #[test]
    fn offers_restart_to_update_above_quit_only_once_an_update_is_downloaded() {
        let state = running();
        assert!(!ids(&tray_menu_model(Some(&state), false, at(0.0)))
            .contains(&"restart-to-update".to_string()));
        let ready = ids(&tray_menu_model(Some(&state), true, at(0.0)));
        assert_eq!(ready[ready.len() - 2..], ["restart-to-update", "quit"]);
        assert_eq!(
            ids(&tray_menu_model(None, true, at(0.0))),
            ["open", "restart-to-update", "quit"]
        );
        let german = DesktopTimerState {
            labels: DesktopTrayLabels {
                restart_to_update: "Neu starten".into(),
                ..running().labels
            },
            ..running()
        };
        assert!(has_label(
            &tray_menu_model(Some(&german), true, at(0.0)),
            "Neu starten"
        ));
    }

    #[test]
    fn offers_to_pause_autopilot_while_it_is_on_and_to_resume_it_while_paused() {
        let off = DesktopTimerState {
            unsent: 0,
            ..running()
        };
        assert!(!outline(&tray_menu_model(Some(&off), false, at(0.0)))
            .iter()
            .any(|id| id.starts_with("autopilot-")));

        let on = DesktopTimerState {
            autopilot: Some(DesktopTrayAutopilot { paused_until: None }),
            ..off.clone()
        };
        assert!(outline(&tray_menu_model(Some(&on), false, at(0.0)))
            .contains(&"autopilot-pause".to_string()));

        let paused = DesktopTimerState {
            autopilot: Some(DesktopTrayAutopilot {
                paused_until: Some(at(3600.0)),
            }),
            labels: DesktopTrayLabels {
                autopilot_paused: "Autopilot paused until 11:00".into(),
                autopilot_resume: "Fortsetzen".into(),
                ..on.labels.clone()
            },
            ..on
        };
        let during = outline(&tray_menu_model(Some(&paused), false, at(60.0)));
        assert!(during.contains(&"# Autopilot paused until 11:00".to_string()));
        assert!(during.contains(&"autopilot-resume".to_string()));
        assert!(
            has_label(
                &tray_menu_model(Some(&paused), false, at(60.0)),
                "Fortsetzen"
            ),
            "labels come from the payload"
        );
        // A pause that has run out is no pause, whatever the payload last said.
        let after = outline(&tray_menu_model(Some(&paused), false, at(3600.0)));
        assert!(after.contains(&"autopilot-pause".to_string()));
        assert!(!after.contains(&"# Autopilot paused until 11:00".to_string()));
    }

    #[test]
    fn marks_a_timer_autopilot_opened_in_the_menu_heading() {
        let mut owned = running();
        owned.running.as_mut().unwrap().autopilot = Some(true);
        assert!(
            matches!(&tray_menu_model(Some(&owned), false, at(0.0))[0], TrayMenuItem::Item { label, .. } if label == "✦ Write the plan")
        );
        let plain = running();
        assert!(
            matches!(&tray_menu_model(Some(&plain), false, at(0.0))[0], TrayMenuItem::Item { label, .. } if label == "Write the plan")
        );
    }

    #[test]
    fn idle_with_nothing_queued_no_stop_and_no_unsent_line() {
        let state = DesktopTimerState {
            running: None,
            unsent: 0,
            ..running()
        };
        let model = tray_menu_model(Some(&state), false, at(0.0));
        assert!(!ids(&model).contains(&"stop".to_string()));
        assert_eq!(
            model
                .iter()
                .filter(|item| matches!(item, TrayMenuItem::Heading { .. }))
                .count(),
            2
        );
    }

    #[test]
    fn menu_items_serialize_like_the_typescript_union() {
        assert_eq!(
            serde_json::to_value(TrayMenuItem::item("open", "Open")).unwrap(),
            json!({"type": "item", "id": "open", "label": "Open", "enabled": true})
        );
        assert_eq!(
            serde_json::to_value(TrayMenuItem::heading("H")).unwrap(),
            json!({"type": "heading", "label": "H"})
        );
        assert_eq!(
            serde_json::to_value(TrayMenuItem::Separator).unwrap(),
            json!({"type": "separator"})
        );
    }

    #[test]
    fn ticks_the_macos_title_from_started_at_and_leaves_it_empty_when_idle() {
        let state = running();
        assert_eq!(tray_title(Some(&state), at(125.0), "darwin"), "2m");
        assert_eq!(tray_title(Some(&state), at(125.0), "win32"), "");
        let idle = DesktopTimerState {
            running: None,
            ..running()
        };
        assert_eq!(tray_title(Some(&idle), at(125.0), "darwin"), "");
    }

    #[test]
    fn marks_a_timer_autopilot_opened_in_the_macos_title_and_every_tooltip() {
        let mut owned = running();
        owned.running.as_mut().unwrap().autopilot = Some(true);
        assert_eq!(tray_title(Some(&owned), at(125.0), "darwin"), "✦ 2m");
        assert_eq!(tray_title(Some(&owned), at(125.0), "linux"), "");
        assert_eq!(
            tray_tooltip(Some(&owned), at(3700.0)),
            "✦ Write the plan — 1h 01m"
        );
        let idle = DesktopTimerState {
            running: None,
            ..owned
        };
        assert_eq!(tray_tooltip(Some(&idle), at(1.0)), "Track Your Time");
    }

    #[test]
    fn puts_the_clock_and_the_entry_in_the_tooltip() {
        assert_eq!(
            tray_tooltip(Some(&running()), at(3700.0)),
            "Write the plan — 1h 01m"
        );
        assert_eq!(tray_tooltip(None, at(0.0)), "Track Your Time");
        let mut no_description = running();
        no_description.running.as_mut().unwrap().description = "  ".into();
        assert_eq!(
            tray_tooltip(Some(&no_description), at(1.0)),
            "Desktop — <1m"
        );
    }

    #[test]
    fn picks_a_per_platform_icon_file() {
        assert_eq!(
            tray_icon_file("darwin", TrayIconVariant::Idle),
            "tray-mac.png"
        );
        assert_eq!(
            tray_icon_file("win32", TrayIconVariant::Running),
            "tray-running.ico"
        );
        assert_eq!(
            tray_icon_file("linux", TrayIconVariant::Running),
            "tray-running.png"
        );
        assert_eq!(
            tray_icon_variant(Some(&running())),
            TrayIconVariant::Running
        );
        assert_eq!(tray_icon_variant(None), TrayIconVariant::Idle);
    }

    #[test]
    fn refuses_a_payload_without_signed_in() {
        assert_eq!(parse_timer_state(&json!({"running": null})), None);
        assert_eq!(parse_timer_state(&json!("x")), None);
    }

    #[test]
    fn drops_a_running_entry_with_a_bad_start_a_bad_colour_extra_recents_and_foreign_labels() {
        let recents: Vec<Value> = (0..9)
            .map(|i| json!({"key": format!("k{i}"), "label": format!("r{i}"), "hint": null}))
            .collect();
        let parsed = parse_timer_state(&json!({
            "signedIn": true,
            "running": {"description": "x", "startedAt": "yesterday", "projectName": null, "projectColor": null},
            "recents": recents,
            "unsent": 3.7,
            "labels": {"stop": "Stop!", "evil": "<script>"},
        }))
        .unwrap();
        assert_eq!(parsed.running, None);
        assert_eq!(parsed.recents.len(), 5);
        assert_eq!(parsed.unsent, 3);
        assert_eq!(parsed.labels.stop, "Stop!");
        assert!(serde_json::to_value(&parsed.labels)
            .unwrap()
            .get("evil")
            .is_none());
        let colour = parse_timer_state(&json!({
            "signedIn": true,
            "running": {"description": "", "startedAt": START, "projectName": "P", "projectColor": "red; x"},
        }))
        .unwrap();
        assert_eq!(colour.running.unwrap().project_color, None);
    }

    #[test]
    fn signed_out_carries_no_timer_recents_or_autopilot() {
        let mut payload = serde_json::to_value(running()).unwrap();
        payload["signedIn"] = json!(false);
        payload["autopilot"] = json!({"pausedUntil": 5});
        let parsed = parse_timer_state(&payload).unwrap();
        assert_eq!(parsed.running, None);
        assert!(parsed.recents.is_empty());
        assert_eq!(parsed.autopilot, None);
    }

    #[test]
    fn reads_the_autopilot_mark_and_pause_and_nothing_else_in_their_place() {
        let mut payload = serde_json::to_value(running()).unwrap();
        payload["running"]["autopilot"] = json!(true);
        payload["autopilot"] = json!({"pausedUntil": at(60.0)});
        let parsed = parse_timer_state(&payload).unwrap();
        assert_eq!(parsed.running.as_ref().unwrap().autopilot, Some(true));
        assert_eq!(
            parsed.autopilot,
            Some(DesktopTrayAutopilot {
                paused_until: Some(at(60.0))
            })
        );

        let mut odd_payload = serde_json::to_value(running()).unwrap();
        odd_payload["running"]["autopilot"] = json!("yes");
        odd_payload["autopilot"] = json!({"pausedUntil": "soon"});
        let odd = parse_timer_state(&odd_payload).unwrap();
        assert_eq!(odd.running.as_ref().unwrap().autopilot, None);
        assert_eq!(
            odd.autopilot,
            Some(DesktopTrayAutopilot { paused_until: None })
        );

        let mut flag = serde_json::to_value(running()).unwrap();
        flag["autopilot"] = json!(true);
        assert_eq!(parse_timer_state(&flag).unwrap().autopilot, None);

        assert!(!autopilot_paused_at(Some(&odd), at(0.0)));
        assert!(autopilot_paused_at(Some(&parsed), at(59.0)));
        assert!(!autopilot_paused_at(Some(&parsed), at(60.0)));
    }

    #[test]
    fn needs_a_known_kind_and_a_title() {
        assert_eq!(parse_notice(&json!({"kind": "other", "title": "x"})), None);
        assert_eq!(parse_notice(&json!({"kind": "idle", "title": " "})), None);
        assert_eq!(
            parse_notice(&json!({"kind": "idle", "title": "Away", "body": "24 min"})),
            Some(DesktopNotice {
                kind: DesktopNoticeKind::Idle,
                title: "Away".into(),
                body: "24 min".into(),
                tag: "idle".into()
            })
        );
    }

    #[test]
    fn labels_fall_back_per_key() {
        let labels = parse_tray_labels(&json!({"open": "Öffnen", "quit": 5}));
        assert_eq!(labels.open, "Öffnen");
        assert_eq!(labels.quit, "Quit Track Your Time");
        assert_eq!(parse_tray_labels(&json!(null)), fallback_tray_labels());
    }
}
