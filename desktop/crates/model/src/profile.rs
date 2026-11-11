//! Where the app keeps its profile: desktop settings, window state, the
//! encrypted session, activity, the updater id and the single-instance lock.
//! Ported from `electron/src/profile.ts`.
//!
//! The Tauri build keeps the Electron build's directory, by name, under the
//! same base (`~/Library/Application Support`, `%APPDATA%`, `~/.config`), so
//! an update from the Electron build finds every file where it left it.
//! Never derive it from the bundle identifier or the product name: changing
//! either would silently move every installed app to an empty profile and
//! strand the time queued in the old one.
//!
//! An unpackaged (debug) run gets its own profile, so `dev:desktop` never
//! shares the installed app's lock or data. A headless run (tests, agents)
//! gets its own profile too, unless one is named explicitly: headless swaps
//! the OS keychain for a fixed in-process key, so the installed app's
//! `session.bin` does not decrypt there — and the secure store deletes a
//! ciphertext that does not decrypt. An agent verifying a build on the
//! default profile would otherwise sign the person who installed the app out.

use std::path::{Path, PathBuf};

pub const PACKAGED_PROFILE_NAME: &str = "trackyourtime";
pub const UNPACKAGED_PROFILE_NAME: &str = "trackyourtime-dev";
pub const HEADLESS_PROFILE_SUFFIX: &str = "-headless";
/// Moves the profile (and the lock). The e2e harness uses it.
pub const USER_DATA_DIR_ENV: &str = "TRACKYOURTIME_USER_DATA_DIR";

pub fn user_data_dir(
    app_data: &Path,
    is_packaged: bool,
    headless: bool,
    override_dir: Option<&str>,
) -> PathBuf {
    if let Some(dir) = override_dir.filter(|d| !d.is_empty()) {
        let path = PathBuf::from(dir);
        return if path.is_absolute() {
            path
        } else {
            std::env::current_dir()
                .map(|cwd| cwd.join(&path))
                .unwrap_or(path)
        };
    }
    let name = if is_packaged {
        PACKAGED_PROFILE_NAME
    } else {
        UNPACKAGED_PROFILE_NAME
    };
    let name = if headless {
        format!("{name}{HEADLESS_PROFILE_SUFFIX}")
    } else {
        name.to_string()
    };
    app_data.join(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "/Users/me/Library/Application Support";

    #[test]
    fn pins_the_packaged_profile_by_name() {
        assert_eq!(
            user_data_dir(Path::new(BASE), true, false, None),
            Path::new(BASE).join("trackyourtime")
        );
    }

    #[test]
    fn keeps_an_unpackaged_run_out_of_the_installed_profile() {
        assert_eq!(
            user_data_dir(Path::new(BASE), false, false, None),
            Path::new(BASE).join("trackyourtime-dev")
        );
    }

    #[test]
    fn honours_an_explicit_override_either_way() {
        for packaged in [true, false] {
            for headless in [true, false] {
                assert_eq!(
                    user_data_dir(Path::new(BASE), packaged, headless, Some("/tmp/e2e")),
                    Path::new("/tmp/e2e")
                );
            }
        }
        assert_eq!(
            user_data_dir(Path::new(BASE), true, false, Some("")),
            Path::new(BASE).join("trackyourtime")
        );
    }

    #[test]
    fn never_lets_a_headless_run_open_the_installed_profile() {
        assert_eq!(
            user_data_dir(Path::new(BASE), true, true, None),
            Path::new(BASE).join("trackyourtime-headless")
        );
        assert_eq!(
            user_data_dir(Path::new(BASE), false, true, None),
            Path::new(BASE).join("trackyourtime-dev-headless")
        );
    }
}
