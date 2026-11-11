//! Settings → Desktop: per-device preferences the shell owns, in
//! `<userData>/desktop-settings.json`. Ported from
//! `electron/src/desktop-settings.ts`; the file is read and written in the
//! same place and shape, so an existing install keeps its choices.
//!
//! Not the account's preferences (`settings.update`): whether this laptop
//! opens at login or what chord it binds says nothing about the person's
//! phone. And the shell needs them before any page has loaded — the shortcuts
//! and the tray exist from launch, signed in or not.
//!
//! Everything here is pure (the file half takes a directory), so parsing and
//! the patch rules are unit-tested without the OS.

use std::fs;
use std::io;
use std::path::Path;

use serde_json::{Map, Value};
use tyt_wire::{
    DesktopSettings, DesktopShortcutAction, DesktopShortcutBindings, DesktopShortcutProblem,
    DesktopShortcutStatus,
};

use crate::accelerator::{accelerator_chord, duplicate_shortcut_action, normalize_accelerator};
use crate::timer_menu::js::slice_utf16;

pub const DESKTOP_SETTINGS_FILE: &str = "desktop-settings.json";

/// The defaults, per platform.
///
/// `closeHides` is on for Windows, where the notification-area icon is always
/// there to bring the window back, and off for Linux: GNOME without the
/// AppIndicator extension shows no tray icon at all, and the shell cannot tell
/// whether one is visible — hiding the only window there leaves an app nobody
/// can reach. On macOS the close button always hides (the Dock brings it back)
/// and the value is ignored.
pub fn default_desktop_settings(platform: &str) -> DesktopSettings {
    DesktopSettings {
        open_at_login: false,
        show_in_tray: true,
        close_hides: platform == "win32",
        running_badge: false,
        shortcuts: DesktopShortcutBindings::defaults(),
    }
}

fn apply_booleans(settings: &mut DesktopSettings, data: &Map<String, Value>) {
    if let Some(Value::Bool(v)) = data.get("openAtLogin") {
        settings.open_at_login = *v;
    }
    if let Some(Value::Bool(v)) = data.get("showInTray") {
        settings.show_in_tray = *v;
    }
    if let Some(Value::Bool(v)) = data.get("closeHides") {
        settings.close_hides = *v;
    }
    if let Some(Value::Bool(v)) = data.get("runningBadge") {
        settings.running_badge = *v;
    }
}

/// A stored file, read leniently: every well-formed field is kept and anything
/// else falls back to its default. A binding the grammar refuses, or one that
/// repeats an earlier action's chord, is dropped to null rather than handed to
/// the registrar.
pub fn parse_desktop_settings(raw: Option<&str>, platform: &str) -> DesktopSettings {
    let mut settings = default_desktop_settings(platform);
    let Some(raw) = raw else { return settings };
    let Ok(Value::Object(data)) = serde_json::from_str::<Value>(raw) else {
        return settings;
    };

    apply_booleans(&mut settings, &data);
    if let Some(Value::Object(stored)) = data.get("shortcuts") {
        let mut bindings = settings.shortcuts.clone();
        for action in DesktopShortcutAction::ALL {
            let Some(value) = stored.get(action.as_str()) else {
                continue;
            };
            bindings.set(action, value.as_str().and_then(normalize_accelerator));
        }
        // The earlier action in registry order keeps a repeated chord.
        let mut chords: Vec<String> = Vec::new();
        for action in DesktopShortcutAction::ALL {
            let Some(bound) = bindings.get(action) else {
                continue;
            };
            match accelerator_chord(bound, platform) {
                Some(chord) if !chords.contains(&chord) => chords.push(chord),
                _ => bindings.set(action, None),
            }
        }
        settings.shortcuts = bindings;
    }
    settings
}

#[derive(Debug, Clone, PartialEq)]
pub struct SettingsPatchResult {
    pub next: DesktopSettings,
    /// Bindings the patch asked for and did not get; nothing about them was saved.
    pub refused: Vec<DesktopShortcutStatus>,
}

/// Apply what the renderer sent. It crossed the bridge, so every field is
/// checked: booleans must be booleans, actions must exist, accelerators must
/// parse and must not repeat another action's chord. Clearing a binding
/// (null) always succeeds and is applied before any new binding, so moving a
/// chord from one action to another in one patch works.
///
/// Takes the raw JSON, as the TypeScript took `unknown`. Shortcut entries are
/// visited in the map's iteration order, which is alphabetical unless
/// serde_json's `preserve_order` is on; it only matters when one patch binds
/// two actions to the same chord, which the renderer never sends (it sends
/// one action per patch).
pub fn apply_settings_patch(
    current: &DesktopSettings,
    patch: &Value,
    platform: &str,
) -> SettingsPatchResult {
    let mut next = current.clone();
    let mut refused = Vec::new();
    let Value::Object(patch) = patch else {
        return SettingsPatchResult { next, refused };
    };

    apply_booleans(&mut next, patch);

    if let Some(Value::Object(shortcuts)) = patch.get("shortcuts") {
        let entries: Vec<(DesktopShortcutAction, &Value)> = shortcuts
            .iter()
            .filter_map(|(key, value)| {
                DesktopShortcutAction::parse(key).map(|action| (action, value))
            })
            .collect();
        for (action, value) in &entries {
            if value.is_null() {
                next.shortcuts.set(*action, None);
            }
        }
        for (action, value) in entries {
            if value.is_null() {
                continue;
            }
            let Some(accelerator) = value.as_str().and_then(normalize_accelerator) else {
                refused.push(DesktopShortcutStatus {
                    action,
                    accelerator: value.as_str().map(|s| slice_utf16(s, 80)),
                    registered: false,
                    problem: Some(DesktopShortcutProblem::Invalid),
                    conflicts_with: None,
                });
                continue;
            };
            if let Some(holder) =
                duplicate_shortcut_action(&next.shortcuts, action, &accelerator, platform)
            {
                refused.push(DesktopShortcutStatus {
                    action,
                    accelerator: Some(accelerator),
                    registered: false,
                    problem: Some(DesktopShortcutProblem::Duplicate),
                    conflicts_with: Some(holder),
                });
                continue;
            }
            next.shortcuts.set(action, Some(accelerator));
        }
    }
    SettingsPatchResult { next, refused }
}

pub fn read_desktop_settings(user_data: &Path, platform: &str) -> DesktopSettings {
    let raw = fs::read_to_string(user_data.join(DESKTOP_SETTINGS_FILE)).ok();
    parse_desktop_settings(raw.as_deref(), platform)
}

/// `JSON.stringify(settings, null, 2)` plus a newline, written to a temporary
/// file and renamed into place, as the Electron build did.
pub fn write_desktop_settings(user_data: &Path, settings: &DesktopSettings) -> io::Result<()> {
    let target = user_data.join(DESKTOP_SETTINGS_FILE);
    fs::create_dir_all(user_data)?;
    let temp = user_data.join(format!(
        "{DESKTOP_SETTINGS_FILE}.{}.tmp",
        std::process::id()
    ));
    let mut text = serde_json::to_string_pretty(settings).map_err(io::Error::other)?;
    text.push('\n');
    fs::write(&temp, text)?;
    fs::rename(&temp, &target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(value: Value, platform: &str) -> DesktopSettings {
        parse_desktop_settings(Some(&value.to_string()), platform)
    }

    #[test]
    fn binds_only_the_toggle_and_hides_on_close_only_where_a_tray_is_certain() {
        for platform in ["darwin", "win32", "linux"] {
            let settings = default_desktop_settings(platform);
            assert_eq!(
                settings.shortcuts.toggle_timer.as_deref(),
                Some("CommandOrControl+Alt+Shift+Space")
            );
            let bound: Vec<_> = DesktopShortcutAction::ALL
                .into_iter()
                .filter(|a| settings.shortcuts.get(*a).is_some())
                .collect();
            assert_eq!(bound, [DesktopShortcutAction::ToggleTimer]);
            assert!(!settings.open_at_login);
            assert!(!settings.running_badge);
            assert!(settings.show_in_tray);
        }
        assert!(default_desktop_settings("win32").close_hides);
        assert!(!default_desktop_settings("linux").close_hides);
    }

    #[test]
    fn falls_back_to_defaults_for_a_missing_corrupt_or_foreign_file() {
        let defaults = default_desktop_settings("darwin");
        assert_eq!(parse_desktop_settings(None, "darwin"), defaults);
        assert_eq!(parse_desktop_settings(Some("{nope"), "darwin"), defaults);
        assert_eq!(parse_desktop_settings(Some("[1,2]"), "darwin"), defaults);
        assert_eq!(parse(json!({"openAtLogin": "yes"}), "darwin"), defaults);
    }

    #[test]
    fn keeps_a_cleared_default_normalises_bindings_and_drops_ones_that_would_throw() {
        let parsed = parse(
            json!({
                "openAtLogin": true,
                "shortcuts": {"toggle-timer": null, "new-timer": "ctrl+shift+n", "open-palette": "Cmd+Banana", "unknown": "F13"}
            }),
            "linux",
        );
        assert!(parsed.open_at_login);
        assert_eq!(parsed.shortcuts.toggle_timer, None);
        assert_eq!(
            parsed.shortcuts.new_timer.as_deref(),
            Some("Control+Shift+N")
        );
        assert_eq!(parsed.shortcuts.open_palette, None);
        let value = serde_json::to_value(&parsed.shortcuts).unwrap();
        assert!(value.get("unknown").is_none());
    }

    #[test]
    fn gives_a_repeated_chord_to_the_earlier_action_only() {
        let parsed = parse(
            json!({"shortcuts": {"toggle-timer": "Command+K", "open-palette": "CommandOrControl+K"}}),
            "darwin",
        );
        assert_eq!(parsed.shortcuts.toggle_timer.as_deref(), Some("Command+K"));
        assert_eq!(parsed.shortcuts.open_palette, None);
        // On Windows the same two strings are different keys.
        let win = parse(
            json!({"shortcuts": {"toggle-timer": "Super+K", "open-palette": "CommandOrControl+K"}}),
            "win32",
        );
        assert_eq!(
            win.shortcuts.open_palette.as_deref(),
            Some("CommandOrControl+K")
        );
    }

    #[test]
    fn applies_booleans_and_ignores_anything_that_is_not_one() {
        let base = default_desktop_settings("darwin");
        let SettingsPatchResult { next, .. } = apply_settings_patch(
            &base,
            &json!({"openAtLogin": true, "showInTray": "no", "runningBadge": 1}),
            "darwin",
        );
        assert!(next.open_at_login);
        assert!(next.show_in_tray);
        assert!(!next.running_badge);
        assert!(!base.open_at_login, "the current settings are not mutated");
    }

    #[test]
    fn refuses_an_invalid_accelerator_without_saving_it() {
        let base = default_desktop_settings("darwin");
        let result = apply_settings_patch(
            &base,
            &json!({"shortcuts": {"new-timer": "Shift+A"}}),
            "darwin",
        );
        assert_eq!(result.next.shortcuts.new_timer, None);
        assert_eq!(
            serde_json::to_value(&result.refused).unwrap(),
            json!([{"action": "new-timer", "accelerator": "Shift+A", "registered": false, "problem": "invalid"}])
        );
        let number = apply_settings_patch(&base, &json!({"shortcuts": {"new-timer": 5}}), "darwin");
        assert_eq!(number.refused[0].accelerator, None);
    }

    #[test]
    fn refuses_a_chord_another_action_holds_naming_it() {
        let base = default_desktop_settings("darwin");
        let result = apply_settings_patch(
            &base,
            &json!({"shortcuts": {"open-palette": "Command+Alt+Shift+Space"}}),
            "darwin",
        );
        assert_eq!(result.next.shortcuts.open_palette, None);
        assert_eq!(
            result.refused[0].problem,
            Some(DesktopShortcutProblem::Duplicate)
        );
        assert_eq!(
            result.refused[0].conflicts_with,
            Some(DesktopShortcutAction::ToggleTimer)
        );
    }

    #[test]
    fn moves_a_chord_between_actions_in_one_patch_clearing_first() {
        let base = default_desktop_settings("darwin");
        let result = apply_settings_patch(
            &base,
            &json!({"shortcuts": {"open-palette": "CommandOrControl+Alt+Shift+Space", "toggle-timer": null}}),
            "darwin",
        );
        assert!(result.refused.is_empty());
        assert_eq!(result.next.shortcuts.toggle_timer, None);
        assert_eq!(
            result.next.shortcuts.open_palette.as_deref(),
            Some("CommandOrControl+Alt+Shift+Space")
        );
    }

    #[test]
    fn ignores_unknown_actions_and_non_object_patches() {
        let base = default_desktop_settings("darwin");
        assert_eq!(
            apply_settings_patch(&base, &json!({"shortcuts": {"nope": "F13"}}), "darwin").next,
            base
        );
        assert_eq!(
            apply_settings_patch(&base, &json!("openAtLogin"), "darwin").next,
            base
        );
    }

    #[test]
    fn writes_the_file_the_electron_build_wrote() {
        let dir = tempfile::tempdir().unwrap();
        let mut settings = default_desktop_settings("darwin");
        settings.shortcuts.new_timer = Some("Control+Alt+N".into());
        write_desktop_settings(dir.path(), &settings).unwrap();
        let text = fs::read_to_string(dir.path().join(DESKTOP_SETTINGS_FILE)).unwrap();
        assert_eq!(
            text,
            "{\n  \"openAtLogin\": false,\n  \"showInTray\": true,\n  \"closeHides\": false,\n  \"runningBadge\": false,\n  \"shortcuts\": {\n    \"toggle-timer\": \"CommandOrControl+Alt+Shift+Space\",\n    \"new-timer\": \"Control+Alt+N\",\n    \"toggle-window\": null,\n    \"open-palette\": null\n  }\n}\n"
        );
        assert_eq!(read_desktop_settings(dir.path(), "darwin"), settings);
        assert_eq!(
            fs::read_dir(dir.path()).unwrap().count(),
            1,
            "no temporary file left behind"
        );
    }
}
