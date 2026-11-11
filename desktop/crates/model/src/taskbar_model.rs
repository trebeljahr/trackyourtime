//! The Windows taskbar's jump-list tasks, and the launch arguments they
//! pass. Ported from `electron/src/taskbar-model.ts`.
//!
//! Launcher tasks remain usable when Windows has put the tray icon in the
//! overflow area, where many people never look: "Open" and "Compact timer"
//! are one right-click on the taskbar button away.

use serde::Serialize;
use tyt_wire::DesktopWindowMode;

pub const FULL_WINDOW_ARG: &str = "--full-window";
pub const COMPACT_TIMER_ARG: &str = "--compact-timer";

/// One jump-list task, with the fields Electron's `app.setUserTasks` took.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserTask {
    pub program: String,
    pub arguments: String,
    pub title: String,
    pub description: String,
    pub icon_path: String,
    pub icon_index: u32,
}

/// The two tasks for a packaged Windows build, or `None` everywhere else:
/// tests and development never change the native taskbar.
pub fn windows_user_tasks(
    platform: &str,
    is_packaged: bool,
    headless: bool,
    exec_path: &str,
    open_label: &str,
    compact_label: &str,
) -> Option<Vec<UserTask>> {
    if platform != "win32" || !is_packaged || headless {
        return None;
    }
    let task = |arguments: &str, label: &str| UserTask {
        program: exec_path.to_string(),
        arguments: arguments.to_string(),
        title: label.to_string(),
        description: label.to_string(),
        icon_path: exec_path.to_string(),
        icon_index: 0,
    };
    Some(vec![
        task(FULL_WINDOW_ARG, open_label),
        task(COMPACT_TIMER_ARG, compact_label),
    ])
}

/// The window mode a launch (or a second launch) asked for by argument.
pub fn requested_window_mode<S: AsRef<str>>(argv: &[S]) -> Option<DesktopWindowMode> {
    if argv.iter().any(|arg| arg.as_ref() == FULL_WINDOW_ARG) {
        return Some(DesktopWindowMode::Full);
    }
    argv.iter()
        .any(|arg| arg.as_ref() == COMPACT_TIMER_ARG)
        .then_some(DesktopWindowMode::Compact)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXEC: &str = "C:\\Program Files\\Track Your Time\\Track Your Time.exe";

    #[test]
    fn gives_packaged_windows_two_explicit_recovery_tasks_without_relying_on_the_tray() {
        let tasks =
            windows_user_tasks("win32", true, false, EXEC, "Open app", "Compact timer").unwrap();
        assert_eq!(tasks[0].program, EXEC);
        assert_eq!(
            tasks
                .iter()
                .map(|t| (
                    t.title.as_str(),
                    requested_window_mode(&[t.arguments.as_str()])
                ))
                .collect::<Vec<_>>(),
            [
                ("Open app", Some(DesktopWindowMode::Full)),
                ("Compact timer", Some(DesktopWindowMode::Compact))
            ]
        );
    }

    #[test]
    fn never_changes_native_taskbar_tasks_in_tests_development_or_other_platforms() {
        assert_eq!(
            windows_user_tasks("win32", true, true, EXEC, "a", "b"),
            None
        );
        assert_eq!(
            windows_user_tasks("win32", false, false, EXEC, "a", "b"),
            None
        );
        assert_eq!(
            windows_user_tasks("linux", true, false, EXEC, "a", "b"),
            None
        );
        assert_eq!(
            windows_user_tasks("darwin", true, false, EXEC, "a", "b"),
            None
        );
        assert_eq!(requested_window_mode(&["--compact-timer=unexpected"]), None);
    }
}
