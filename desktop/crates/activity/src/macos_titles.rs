//! Window titles on macOS (`macos-titles.ts`): metadata only. Core Graphics
//! does not request permission or capture pixels, and the reader runs only
//! while the shell says Screen Recording is granted — checked before the run
//! and again after it, so a grant revoked mid-read discards the answer.

use std::sync::Arc;

use serde_json::Value;

use crate::source::ProcessRunner;
use crate::source_macos::TitleReader;

/// The JXA script, byte for byte the TypeScript's `MACOS_TITLE_SCRIPT`.
pub const MACOS_TITLE_SCRIPT: &str = include_str!("macos-title.js");
pub const OSASCRIPT: &str = "/usr/bin/osascript";
const MAX_TITLE: usize = 2000;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

pub type Permitted = Arc<dyn Fn() -> bool + Send + Sync>;

pub struct MacosTitleReader {
    runner: Arc<dyn ProcessRunner>,
    permitted: Permitted,
}

impl MacosTitleReader {
    pub fn new(runner: Arc<dyn ProcessRunner>, permitted: Permitted) -> Self {
        MacosTitleReader { runner, permitted }
    }
}

/// What the script printed: a bounded, non-blank JSON string, else None.
pub fn parse_title_output(stdout: &str) -> Option<String> {
    match serde_json::from_str::<Value>(stdout) {
        Ok(Value::String(title)) if !crate::js::trim(&title).is_empty() => {
            Some(crate::js::slice_utf16(&title, MAX_TITLE).to_string())
        }
        _ => None,
    }
}

impl TitleReader for MacosTitleReader {
    fn read(&self, pid: i64, done: Box<dyn FnOnce(Option<String>) + Send>) {
        if !(self.permitted)() || pid <= 0 || pid > MAX_SAFE_INTEGER {
            done(None);
            return;
        }
        let permitted = self.permitted.clone();
        let args = vec![
            "-l".to_string(),
            "JavaScript".into(),
            "-e".into(),
            MACOS_TITLE_SCRIPT.into(),
            pid.to_string(),
        ];
        self.runner.run(
            OSASCRIPT,
            &args,
            &[],
            Box::new(move |result| {
                if result.code != Some(0) || !permitted() {
                    done(None);
                    return;
                }
                done(parse_title_output(&result.stdout));
            }),
        );
    }
}
