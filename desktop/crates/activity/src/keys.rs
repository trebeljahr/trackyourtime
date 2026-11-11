//! What an application is called in stored activity (`keys.ts`).
//!
//! A key is what time is attributed to and what "Never record" and filing
//! rules match against, through core's host globs. Those globs were written
//! for hostnames: `normalizeHostPattern` cuts at the first `/` and drops a
//! trailing `:<digits>`, so an exe path or a WM_CLASS with a colon in it would
//! be matched against half of itself. [`to_activity_key`] removes both
//! characters (and `\`, and whitespace runs), which is what lets
//! `com.jetbrains.*` work unchanged.

use crate::js;

/// The longest key or name kept.
pub const ACTIVITY_KEY_MAX_LENGTH: usize = 200;

/// `raw.trim().toLowerCase().replace(/[/:\\\s]+/g, "-").slice(0, 200)`.
pub fn to_activity_key(raw: &str) -> String {
    let lowered = js::lower(js::trim(raw));
    let mut out = String::with_capacity(lowered.len());
    let mut in_run = false;
    for c in lowered.chars() {
        if c == '/' || c == ':' || c == '\\' || js::is_js_whitespace(c) {
            if !in_run {
                out.push('-');
                in_run = true;
            }
        } else {
            out.push(c);
            in_run = false;
        }
    }
    js::slice_utf16(&out, ACTIVITY_KEY_MAX_LENGTH).to_string()
}

/// A "Never record" or filing-rule pattern, in the same shape as the keys it
/// is matched against. A typed `Track Your Time.exe` must become
/// `track-your-time.exe`, as the key does; kept as core's host pattern it
/// would keep its spaces and never match anything. `*` survives, so globs
/// still work.
pub fn to_activity_pattern(raw: &str) -> String {
    let mut key = to_activity_key(raw);
    if key.ends_with('.') {
        key.pop();
    }
    key
}

/// Never recorded, whatever the settings say: this app itself (time spent in
/// the tracker is not work to suggest), and the lock screen and screen saver
/// on each OS, which are the machine standing in for nobody.
pub const BUILT_IN_NEVER_RECORD: &[&str] = &[
    "com.ricoslabs.trackyourtime",
    // The bundle id before 2026-09-22, for a copy built before the move.
    "com.trebeljahr.trackyourtime",
    "track-your-time.exe",
    "trackyourtime",
    "trackyourtime.exe",
    "com.apple.loginwindow",
    "com.apple.screensaver.engine",
    "com.apple.screensaver",
    "lockapp.exe",
    "logonui.exe",
];

/// What a source saw in front, before this app's own rules are applied.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FrontmostTarget {
    /// Bundle id, exe basename or WM_CLASS class, as the OS spells it.
    pub key: String,
    /// A name a person recognises.
    pub name: String,
    /// The window title, only ever read where titles are on.
    pub title: Option<String>,
    pub pid: Option<i64>,
}

/// A target this app may record, keyed and trimmed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DescribedTarget {
    pub key: String,
    pub name: String,
    pub label: Option<String>,
}

pub fn is_built_in_never_record(key: &str, pid: Option<i64>, self_pid: i64) -> bool {
    if pid == Some(self_pid) {
        return true;
    }
    BUILT_IN_NEVER_RECORD.contains(&key)
}

pub fn clean_name(name: &str, fallback: &str) -> String {
    let collapsed = js::collapse_whitespace(name);
    let trimmed = js::slice_utf16(js::trim(&collapsed), ACTIVITY_KEY_MAX_LENGTH);
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lowercases_and_replaces_the_characters_cores_globs_cut_at() {
        assert_eq!(
            to_activity_key("  com.JetBrains.IntelliJ "),
            "com.jetbrains.intellij"
        );
        assert_eq!(
            to_activity_key("C:\\Program Files\\App\\app.exe"),
            "c-program-files-app-app.exe"
        );
        assert_eq!(to_activity_key("Gnome-terminal"), "gnome-terminal");
        assert_eq!(to_activity_key("host:8080/x"), "host-8080-x");
        assert_eq!(to_activity_key(&"x".repeat(500)).len(), 200);
    }

    #[test]
    fn shapes_a_typed_pattern_like_the_key_it_must_match_keeping_globs() {
        assert_eq!(
            to_activity_pattern("Track Your Time.exe"),
            to_activity_key("Track Your Time.exe")
        );
        assert_eq!(to_activity_pattern(" COM.JetBrains.* "), "com.jetbrains.*");
        assert_eq!(
            to_activity_pattern("exe-My Tool"),
            to_activity_key("exe-My Tool")
        );
    }

    #[test]
    fn lists_this_app_and_the_lock_screens_as_never_recorded() {
        for key in [
            "com.ricoslabs.trackyourtime",
            "com.trebeljahr.trackyourtime",
            "com.apple.loginwindow",
            "lockapp.exe",
            "logonui.exe",
        ] {
            assert!(BUILT_IN_NEVER_RECORD.contains(&key), "{key}");
            assert_eq!(to_activity_key(key), key);
        }
    }

    #[test]
    fn names_are_trimmed_and_fall_back() {
        assert_eq!(
            clean_name("  Visual   Studio\tCode ", "k"),
            "Visual Studio Code"
        );
        assert_eq!(clean_name("   ", "k"), "k");
    }
}
