//! Files the page hands to the download manager: every CSV, PDF and invoice
//! export (`lib/download.ts`, an `<a download href=blob:>`). Without a
//! handler the system WebView cancels them silently.
//!
//! They go to the Downloads folder under the name the page suggests (made
//! unique, " (1)" and so on), like a browser with "ask where to save" off.
//! Headless runs save into `<profile>/downloads` instead and record each one
//! for the e2e channel (`downloads`).

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static PENDING: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);
static FINISHED: Mutex<Vec<Value>> = Mutex::new(Vec::new());

fn unique(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|candidate| !candidate.exists())
        .unwrap()
}

/// `DownloadEvent::Requested`: where the file goes.
pub fn requested(url: &str, destination: &mut PathBuf, headless: bool, profile: &Path) {
    if headless {
        let name = destination
            .file_name()
            .map(|n| n.to_os_string())
            .unwrap_or_else(|| "download".into());
        let dir = profile.join("downloads");
        let _ = std::fs::create_dir_all(&dir);
        *destination = unique(dir.join(name));
    }
    PENDING
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(url.to_string(), destination.clone());
}

/// `DownloadEvent::Finished`. macOS reports no path, so the one chosen at
/// `requested` is used.
pub fn finished(url: &str, path: Option<PathBuf>, success: bool) {
    let chosen = PENDING
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .remove(url);
    let path = path.or(chosen);
    let file = path
        .as_ref()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().into_owned());
    FINISHED.lock().unwrap().push(json!({
        "file": file,
        "state": if success { "completed" } else { "interrupted" },
        "path": path.map(|p| p.to_string_lossy().into_owned()),
    }));
}

#[allow(dead_code)]
pub fn recorded() -> Vec<Value> {
    FINISHED.lock().unwrap().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headless_saves_into_the_profile_under_a_unique_name() {
        let profile = tempfile::tempdir().unwrap();
        let mut first = PathBuf::from("/Users/x/Downloads/report.csv");
        requested("blob:app://-/1", &mut first, true, profile.path());
        assert_eq!(first, profile.path().join("downloads/report.csv"));
        std::fs::write(&first, "a").unwrap();
        let mut second = PathBuf::from("/Users/x/Downloads/report.csv");
        requested("blob:app://-/2", &mut second, true, profile.path());
        assert_eq!(second, profile.path().join("downloads/report (1).csv"));
        finished("blob:app://-/1", None, true);
        assert!(recorded()
            .iter()
            .any(|d| d["file"] == "report.csv" && d["state"] == "completed"));
    }
}
