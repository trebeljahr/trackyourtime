//! First launch after an update from the Electron build: hand the
//! localStorage it kept (`legacy::chromium_local_storage`) to the WebView.
//!
//! The keys travel in the bridge's initialization script, which runs before
//! any page script, so the offline queue is in place before the app reads it.
//! The page writes only keys it does not already have, marks localStorage and
//! sessionStorage, and reports back (`migration:done`); only then is the
//! profile marked, so a launch that died before the page loaded migrates on
//! the next one. The Chromium files are left where they are.

use std::collections::BTreeMap;
use std::path::Path;

pub const MARKER_FILE: &str = "electron-local-storage-migrated.json";
/// Also set in the page's localStorage, so a second page load in the same
/// run (and any later run) never writes the old values again.
pub const STORAGE_MARKER: &str = "trackyourtime.desktop.electron-migrated";

pub fn pending(profile: &Path) -> Option<BTreeMap<String, String>> {
    if profile.join(MARKER_FILE).exists() {
        return None;
    }
    match crate::legacy::chromium_local_storage(profile) {
        Ok(Some(data)) if !data.is_empty() => Some(data),
        Ok(_) => {
            mark_done(profile, 0);
            None
        }
        Err(error) => {
            // Leave the marker off: the next launch tries again, and nothing
            // was written anywhere.
            eprintln!("[migrate] could not read the Electron localStorage: {error}");
            None
        }
    }
}

pub fn mark_done(profile: &Path, keys: usize) {
    let body = serde_json::json!({ "schema": 1, "keys": keys }).to_string();
    if let Err(error) = tyt_model::secure_store::write_private_atomic(
        profile,
        &profile.join(MARKER_FILE),
        body.as_bytes(),
    ) {
        eprintln!("[migrate] could not mark the migration done: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusty_leveldb::{Options, DB};

    #[test]
    fn migrates_once_and_marks_the_profile() {
        let profile = tempfile::tempdir().unwrap();
        let dir = profile.path().join("Local Storage/leveldb");
        std::fs::create_dir_all(&dir).unwrap();
        {
            let mut db = DB::open(&dir, Options::default()).unwrap();
            db.put(b"_app://-\0\x01locale", b"\x01de").unwrap();
            db.flush().unwrap();
        }
        let data = pending(profile.path()).unwrap();
        assert_eq!(data.get("locale").map(String::as_str), Some("de"));
        // Not marked until the page confirms.
        assert!(pending(profile.path()).is_some());
        mark_done(profile.path(), data.len());
        assert!(pending(profile.path()).is_none());
    }

    #[test]
    fn a_profile_without_electron_data_is_marked_at_once() {
        let profile = tempfile::tempdir().unwrap();
        assert!(pending(profile.path()).is_none());
        assert!(profile.path().join(MARKER_FILE).exists());
    }
}
