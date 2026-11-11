//! Auto-update as logic with no updater in it: which copies update
//! themselves, what the status is after each updater event, and the staged
//! rollout decision. Ported from `electron/src/updater-model.ts`, plus the
//! rollout check electron-updater 6.8.9 made itself (`AppUpdater.isStagingMatch`
//! and `getOrCreateStagingUserId`), which the Tauri updater does not have.
//! `updater_controller.rs` is the state machine over these.
//!
//! Two rules fail quietly if broken:
//!
//!   - **Only direct downloads update themselves.** A store or a package
//!     manager owns the files; an in-app updater there either cannot write
//!     (the MAS sandbox, MSIX, a read-only squashfs, Flatpak's /app) or
//!     fights the manager (`distribution::self_updates`). A build without an
//!     update feed does not check either: an unsigned test build must not
//!     replace itself with a release.
//!
//!   - **Never a forced restart.** A download installs when the person quits.
//!     The only call that installs and relaunches is in
//!     `UpdateController::restart`, and the only callers of that are the
//!     "Restart to update" button and tray item. A restart the person did not
//!     ask for loses whatever they were typing; the offline queue survives
//!     it, a half-filled form does not.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tyt_wire::{DesktopUpdateDisabledReason, DesktopUpdateStatus};

use crate::distribution::DistributionChannel;
use crate::timer_menu::js::{is_js_whitespace, js_round, js_trim_start};

/// How often a running app looks for a new release.
pub const UPDATE_CHECK_INTERVAL_MS: i64 = 6 * 60 * 60 * 1000;
/// The first check waits for the window and the socket, not the network race at launch.
pub const FIRST_CHECK_DELAY_MS: i64 = 30_000;
/// Set to 1 on a managed machine to keep the app from updating itself.
pub const DISABLE_UPDATES_ENV: &str = "TRACKYOURTIME_DISABLE_UPDATES";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdaterPolicy {
    Enabled,
    Disabled(DesktopUpdateDisabledReason),
}

impl UpdaterPolicy {
    pub fn enabled(self) -> bool {
        self == UpdaterPolicy::Enabled
    }
}

/// `has_feed`: whether this build carries an update feed (the Tauri
/// updater's endpoints and public key in its config, where Electron looked
/// for `app-update.yml`).
pub fn updater_policy(
    channel: DistributionChannel,
    has_feed: bool,
    env: &HashMap<String, String>,
) -> UpdaterPolicy {
    use DesktopUpdateDisabledReason as Reason;
    match channel {
        DistributionChannel::Unpackaged => return UpdaterPolicy::Disabled(Reason::Unpackaged),
        DistributionChannel::MacAppStore | DistributionChannel::WindowsStore => {
            return UpdaterPolicy::Disabled(Reason::Store)
        }
        DistributionChannel::Snap | DistributionChannel::Flatpak => {
            return UpdaterPolicy::Disabled(Reason::Sandbox)
        }
        DistributionChannel::LinuxPackage => {
            return UpdaterPolicy::Disabled(Reason::PackageManager)
        }
        DistributionChannel::MacDirect
        | DistributionChannel::WindowsDirect
        | DistributionChannel::AppImage => {}
    }
    if env.get(DISABLE_UPDATES_ENV).map(String::as_str) == Some("1") {
        return UpdaterPolicy::Disabled(Reason::TurnedOff);
    }
    if !has_feed {
        return UpdaterPolicy::Disabled(Reason::NoFeed);
    }
    UpdaterPolicy::Enabled
}

/// What the updater reports, reduced to what the status needs. Serialized as
/// the test hook's `update.dispatch` receives it: `{kind: "available",
/// version}`, `{kind: "progress", percent}`, …
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum UpdaterEvent {
    Checking,
    Available { version: String },
    NotAvailable,
    Progress { percent: f64 },
    Downloaded { version: String },
    Error,
}

fn last_checked(status: &DesktopUpdateStatus) -> Option<String> {
    match status {
        DesktopUpdateStatus::Idle { last_checked_at }
        | DesktopUpdateStatus::Checking { last_checked_at }
        | DesktopUpdateStatus::Error { last_checked_at } => last_checked_at.clone(),
        _ => None,
    }
}

/// The next status. A downloaded update stays "ready" through later checks
/// and their errors: it is still on disk and still installs on quit, and a
/// failed check six hours later must not take the button away. A newer
/// download replaces it.
pub fn next_update_status(
    status: &DesktopUpdateStatus,
    event: &UpdaterEvent,
    now_iso: &str,
) -> DesktopUpdateStatus {
    match status {
        DesktopUpdateStatus::Disabled { .. } => return status.clone(),
        DesktopUpdateStatus::Ready { .. } => {
            return match event {
                UpdaterEvent::Downloaded { version } => DesktopUpdateStatus::Ready {
                    version: version.clone(),
                },
                _ => status.clone(),
            }
        }
        _ => {}
    }
    match event {
        UpdaterEvent::Checking => match status {
            DesktopUpdateStatus::Downloading { .. } => status.clone(),
            _ => DesktopUpdateStatus::Checking {
                last_checked_at: last_checked(status),
            },
        },
        UpdaterEvent::Available { version } => DesktopUpdateStatus::Downloading {
            version: version.clone(),
            percent: None,
        },
        UpdaterEvent::NotAvailable => DesktopUpdateStatus::Idle {
            last_checked_at: Some(now_iso.to_string()),
        },
        UpdaterEvent::Progress { percent } => match status {
            DesktopUpdateStatus::Downloading { version, .. } => DesktopUpdateStatus::Downloading {
                version: version.clone(),
                percent: Some(js_round(*percent).clamp(0.0, 100.0)),
            },
            _ => status.clone(),
        },
        UpdaterEvent::Downloaded { version } => DesktopUpdateStatus::Ready {
            version: version.clone(),
        },
        UpdaterEvent::Error => DesktopUpdateStatus::Error {
            last_checked_at: match status {
                DesktopUpdateStatus::Downloading { .. } => None,
                _ => last_checked(status),
            },
        },
    }
}

/// Whether a new check may start: never on top of one in flight or a download.
pub fn may_check(status: &DesktopUpdateStatus) -> bool {
    matches!(
        status,
        DesktopUpdateStatus::Idle { .. }
            | DesktopUpdateStatus::Error { .. }
            | DesktopUpdateStatus::Ready { .. }
    )
}

// ---------------------------------------------------------------------------
// Staged rollout
// ---------------------------------------------------------------------------
//
// A release can be offered to part of the installs first (docs/deploy.md →
// "Staged rollout"): the feed carries `stagingPercentage`, and each install
// compares it with a random id it created once in `<userData>/.updaterId`.
// electron-updater did both; this is its decision, byte for byte, so an
// install keeps the bucket it had: the same file, read the same way, hashed
// to the same number. `userData` is pinned by name (profile.rs), which is what
// keeps the id stable across updates. The shell reads `stagingPercentage`
// from the Tauri feed (`latest.json`) and hands the raw JSON value to
// `UpdateController::found`. `pnpm desktop:rollout` writes it; `100` removes it.

pub const UPDATER_ID_FILE: &str = ".updaterId";

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

/// builder-util-runtime's `UUID.check` for a string: the 8-4-4-4-12 hex
/// shape, compared lower-cased. Nothing is trimmed, so a trailing newline
/// makes the file invalid (electron-updater wrote none).
pub fn is_valid_staging_id(id: &str) -> bool {
    let lower = id.to_lowercase();
    let bytes = lower.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(i, &b)| match i {
        8 | 13 | 18 | 23 => b == b'-',
        _ => hex_value(b).is_some(),
    })
}

/// `UUID.parse(id).readUInt32BE(12)`: the last four bytes as a big-endian
/// number. `UUID.parse` looks every pair up in a lower-case table and stores 0
/// for a pair it does not know, so an upper-case id (which `UUID.check`
/// accepts) hashes its upper-case pairs to 0 here too.
fn staging_value(id: &str) -> u32 {
    let units: Vec<u16> = id.encode_utf16().collect();
    let mut bytes = [0u8; 16];
    let mut j = 0;
    for (i, byte) in bytes.iter_mut().enumerate() {
        let pair = (units.get(j).copied(), units.get(j + 1).copied());
        j += 2;
        *byte = match pair {
            (Some(hi), Some(lo)) if hi < 128 && lo < 128 => {
                match (hex_value(hi as u8), hex_value(lo as u8)) {
                    (Some(hi), Some(lo)) => hi * 16 + lo,
                    _ => 0,
                }
            }
            _ => 0,
        };
        if matches!(i, 3 | 5 | 7 | 9) {
            j += 1;
        }
    }
    u32::from_be_bytes([bytes[12], bytes[13], bytes[14], bytes[15]])
}

/// Where this install falls in a rollout, from 0 to 1.
pub fn staging_bucket(id: &str) -> f64 {
    f64::from(staging_value(id)) / f64::from(u32::MAX)
}

/// `Number.prototype.toString()` (radix 10), for the parseInt below.
fn js_number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        };
    }
    let sign = if x < 0.0 { "-" } else { "" };
    // Rust's `{:e}` is the shortest round-trip digits, as JavaScript uses.
    let formatted = format!("{:e}", x.abs());
    let (mantissa, exponent) = formatted.split_once('e').expect("exponent form");
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i64;
    let n = exponent.parse::<i64>().expect("exponent") + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e = if e >= 0 {
            format!("+{e}")
        } else {
            e.to_string()
        };
        if k == 1 {
            format!("{digits}e{e}")
        } else {
            format!("{}.{}e{e}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
}

/// `String(value)` for what JSON can hold.
fn js_to_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_to_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `parseInt(value, 10)`: leading whitespace, an optional sign, then the
/// longest run of digits; NaN when there is none.
fn js_parse_int(value: &Value) -> f64 {
    let text = js_to_string(value);
    let rest = js_trim_start(&text);
    debug_assert!(!rest.starts_with(is_js_whitespace));
    let (sign, rest) = match rest.as_bytes().first() {
        Some(b'-') => (-1.0, &rest[1..]),
        Some(b'+') => (1.0, &rest[1..]),
        _ => (1.0, rest),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return f64::NAN;
    }
    sign * digits.parse::<f64>().unwrap_or(f64::NAN)
}

/// electron-updater's `isStagingMatch`: no percentage (or one that does not
/// parse) offers the release to everybody; otherwise this install takes it
/// when its bucket is below `parseInt(stagingPercentage) / 100`.
pub fn is_staging_match(staging_percentage: Option<&Value>, staging_user_id: &str) -> bool {
    let Some(raw) = staging_percentage.filter(|v| !v.is_null()) else {
        return true;
    };
    let percentage = js_parse_int(raw);
    if percentage.is_nan() {
        return true;
    }
    staging_bucket(staging_user_id) < percentage / 100.0
}

/// A new id in the shape electron-updater wrote: a version-5 UUID, lower-case.
/// electron-updater hashed 4096 random bytes with SHA-1 under the OID
/// namespace; the bits it kept are as random as the 16 drawn here, and only
/// the shape is ever checked.
pub fn new_staging_user_id() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        // No OS randomness: still a valid, if predictable, id.
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        bytes.copy_from_slice(&seed.to_le_bytes());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// `getOrCreateStagingUserId`: the id in `<userData>/.updaterId` when it is
/// valid, else a new one, written there (no newline, parent created). A write
/// that fails still returns the id for this run.
pub fn read_or_create_staging_user_id(user_data: &Path) -> String {
    let file = user_data.join(UPDATER_ID_FILE);
    match fs::read_to_string(&file) {
        Ok(id) if is_valid_staging_id(&id) => return id,
        Ok(id) => eprintln!("[updater] Staging user id file exists, but content was invalid: {id}"),
        Err(error) if error.kind() != io::ErrorKind::NotFound => {
            eprintln!("[updater] Couldn't read staging user ID, creating a blank one: {error}")
        }
        Err(_) => {}
    }
    let id = new_staging_user_id();
    let written = fs::create_dir_all(user_data).and_then(|_| fs::write(&file, &id));
    if let Err(error) = written {
        eprintln!("[updater] Couldn't write out staging user ID: {error}");
    }
    id
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use DesktopUpdateDisabledReason as Reason;

    const NOW: &str = "2026-09-17T10:00:00.000Z";

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    const ALL_CHANNELS: [DistributionChannel; 9] = [
        DistributionChannel::MacAppStore,
        DistributionChannel::MacDirect,
        DistributionChannel::WindowsStore,
        DistributionChannel::WindowsDirect,
        DistributionChannel::Snap,
        DistributionChannel::Flatpak,
        DistributionChannel::AppImage,
        DistributionChannel::LinuxPackage,
        DistributionChannel::Unpackaged,
    ];

    #[test]
    fn updates_only_the_three_direct_downloads_and_only_with_a_feed() {
        for channel in [
            DistributionChannel::MacDirect,
            DistributionChannel::WindowsDirect,
            DistributionChannel::AppImage,
        ] {
            assert_eq!(
                updater_policy(channel, true, &env(&[])),
                UpdaterPolicy::Enabled,
                "{channel:?}"
            );
            assert_eq!(
                updater_policy(channel, false, &env(&[])),
                UpdaterPolicy::Disabled(Reason::NoFeed),
                "{channel:?}"
            );
        }
    }

    #[test]
    fn leaves_every_store_sandbox_and_package_manager_alone_feed_or_not() {
        let expected = [
            (DistributionChannel::MacAppStore, Reason::Store),
            (DistributionChannel::WindowsStore, Reason::Store),
            (DistributionChannel::Snap, Reason::Sandbox),
            (DistributionChannel::Flatpak, Reason::Sandbox),
            (DistributionChannel::LinuxPackage, Reason::PackageManager),
            (DistributionChannel::Unpackaged, Reason::Unpackaged),
        ];
        for (channel, reason) in expected {
            // A deb, rpm or snap build may carry the feed too, so the feed
            // alone must never switch updates on.
            assert_eq!(
                updater_policy(channel, true, &env(&[])),
                UpdaterPolicy::Disabled(reason),
                "{channel:?}"
            );
        }
    }

    #[test]
    fn agrees_with_self_updates_for_every_channel() {
        for channel in ALL_CHANNELS {
            assert_eq!(
                updater_policy(channel, true, &env(&[])).enabled(),
                crate::distribution::self_updates(channel),
                "{channel:?}"
            );
        }
    }

    #[test]
    fn can_be_turned_off_on_a_managed_machine() {
        assert_eq!(
            updater_policy(
                DistributionChannel::MacDirect,
                true,
                &env(&[(DISABLE_UPDATES_ENV, "1")])
            ),
            UpdaterPolicy::Disabled(Reason::TurnedOff)
        );
        assert_eq!(
            updater_policy(
                DistributionChannel::MacDirect,
                true,
                &env(&[(DISABLE_UPDATES_ENV, "0")])
            ),
            UpdaterPolicy::Enabled
        );
    }

    fn idle() -> DesktopUpdateStatus {
        DesktopUpdateStatus::Idle {
            last_checked_at: None,
        }
    }

    #[test]
    fn walks_check_download_ready() {
        let mut status = next_update_status(&idle(), &UpdaterEvent::Checking, NOW);
        assert_eq!(
            status,
            DesktopUpdateStatus::Checking {
                last_checked_at: None
            }
        );
        status = next_update_status(
            &status,
            &UpdaterEvent::Available {
                version: "0.1.1".into(),
            },
            NOW,
        );
        assert_eq!(
            status,
            DesktopUpdateStatus::Downloading {
                version: "0.1.1".into(),
                percent: None
            }
        );
        status = next_update_status(&status, &UpdaterEvent::Progress { percent: 41.6 }, NOW);
        assert_eq!(
            status,
            DesktopUpdateStatus::Downloading {
                version: "0.1.1".into(),
                percent: Some(42.0)
            }
        );
        status = next_update_status(
            &status,
            &UpdaterEvent::Downloaded {
                version: "0.1.1".into(),
            },
            NOW,
        );
        assert_eq!(
            status,
            DesktopUpdateStatus::Ready {
                version: "0.1.1".into()
            }
        );
    }

    #[test]
    fn records_when_a_check_found_nothing() {
        let status = next_update_status(
            &DesktopUpdateStatus::Checking {
                last_checked_at: None,
            },
            &UpdaterEvent::NotAvailable,
            NOW,
        );
        assert_eq!(
            status,
            DesktopUpdateStatus::Idle {
                last_checked_at: Some(NOW.into())
            }
        );
    }

    #[test]
    fn keeps_a_downloaded_update_through_later_checks_and_their_errors() {
        let ready = DesktopUpdateStatus::Ready {
            version: "0.1.1".into(),
        };
        for event in [
            UpdaterEvent::Checking,
            UpdaterEvent::NotAvailable,
            UpdaterEvent::Error,
            UpdaterEvent::Available {
                version: "0.1.2".into(),
            },
        ] {
            assert_eq!(next_update_status(&ready, &event, NOW), ready, "{event:?}");
        }
        assert_eq!(
            next_update_status(
                &ready,
                &UpdaterEvent::Downloaded {
                    version: "0.1.2".into()
                },
                NOW
            ),
            DesktopUpdateStatus::Ready {
                version: "0.1.2".into()
            }
        );
    }

    #[test]
    fn does_not_let_a_check_interrupt_a_download() {
        let downloading = DesktopUpdateStatus::Downloading {
            version: "0.1.1".into(),
            percent: Some(10.0),
        };
        assert_eq!(
            next_update_status(&downloading, &UpdaterEvent::Checking, NOW),
            downloading
        );
        assert!(!may_check(&downloading));
        assert!(!may_check(&DesktopUpdateStatus::Checking {
            last_checked_at: None
        }));
        assert!(may_check(&DesktopUpdateStatus::Error {
            last_checked_at: None
        }));
    }

    #[test]
    fn never_leaves_disabled() {
        let disabled = DesktopUpdateStatus::Disabled {
            reason: Reason::Store,
        };
        assert_eq!(
            next_update_status(
                &disabled,
                &UpdaterEvent::Downloaded {
                    version: "9.9.9".into()
                },
                NOW
            ),
            disabled
        );
    }

    #[test]
    fn progress_is_clamped_and_an_error_mid_download_forgets_the_check_time() {
        let downloading = DesktopUpdateStatus::Downloading {
            version: "1".into(),
            percent: None,
        };
        assert_eq!(
            next_update_status(
                &downloading,
                &UpdaterEvent::Progress { percent: 140.0 },
                NOW
            ),
            DesktopUpdateStatus::Downloading {
                version: "1".into(),
                percent: Some(100.0)
            }
        );
        assert_eq!(
            next_update_status(&downloading, &UpdaterEvent::Error, NOW),
            DesktopUpdateStatus::Error {
                last_checked_at: None
            }
        );
        let checked = DesktopUpdateStatus::Checking {
            last_checked_at: Some(NOW.into()),
        };
        assert_eq!(
            next_update_status(&checked, &UpdaterEvent::Error, NOW),
            DesktopUpdateStatus::Error {
                last_checked_at: Some(NOW.into())
            }
        );
        assert_eq!(
            next_update_status(&idle(), &UpdaterEvent::Progress { percent: 5.0 }, NOW),
            idle()
        );
    }

    #[test]
    fn events_read_the_test_hook_shapes() {
        let event: UpdaterEvent =
            serde_json::from_value(json!({"kind": "available", "version": "9.9.9"})).unwrap();
        assert_eq!(
            event,
            UpdaterEvent::Available {
                version: "9.9.9".into()
            }
        );
        let event: UpdaterEvent = serde_json::from_value(json!({"kind": "not-available"})).unwrap();
        assert_eq!(event, UpdaterEvent::NotAvailable);
        assert!(serde_json::from_value::<UpdaterEvent>(json!({"kind": "nope"})).is_err());
    }

    // Staged rollout — the numbers below are what builder-util-runtime 9.7's
    // UUID.parse(id).readUInt32BE(12) / 0xffffffff gives for these ids.

    #[test]
    fn hashes_an_id_to_its_last_four_bytes() {
        assert_eq!(staging_value("00000000-0000-0000-0000-000000000000"), 0);
        assert_eq!(
            staging_value("6ba7b812-9dad-51d1-80b4-00c04fd430c8"),
            0x4fd4_30c8
        );
        assert_eq!(
            staging_value("6ba7b812-9dad-51d1-80b4-0000ffffffff"),
            u32::MAX
        );
        assert_eq!(staging_bucket("6ba7b812-9dad-51d1-80b4-0000ffffffff"), 1.0);
        // Upper-case pairs are not in UUID.parse's table and read as 0.
        assert_eq!(
            staging_value("6BA7B812-9DAD-51D1-80B4-00C04FD430C8"),
            0x0000_3000
        );
    }

    #[test]
    fn validates_like_uuid_check() {
        assert!(is_valid_staging_id("6ba7b812-9dad-51d1-80b4-00c04fd430c8"));
        assert!(is_valid_staging_id("6BA7B812-9DAD-51D1-80B4-00C04FD430C8"));
        assert!(is_valid_staging_id("00000000-0000-0000-0000-000000000000"));
        assert!(!is_valid_staging_id(
            "6ba7b812-9dad-51d1-80b4-00c04fd430c8\n"
        ));
        assert!(!is_valid_staging_id("6ba7b8129dad51d180b400c04fd430c8"));
        assert!(!is_valid_staging_id("6ba7b812-9dad-51d1-80b4-00c04fd430cg"));
    }

    #[test]
    fn decides_a_rollout_like_is_staging_match() {
        // Bucket 0x4fd430c8 / 0xffffffff ≈ 0.3118.
        let id = "6ba7b812-9dad-51d1-80b4-00c04fd430c8";
        assert!(is_staging_match(None, id), "no percentage: everybody");
        assert!(is_staging_match(Some(&json!(null)), id));
        assert!(is_staging_match(Some(&json!("soon")), id), "NaN: everybody");
        assert!(is_staging_match(Some(&json!(true)), id));
        assert!(!is_staging_match(Some(&json!(25)), id));
        assert!(!is_staging_match(Some(&json!(31)), id));
        assert!(is_staging_match(Some(&json!(32)), id));
        assert!(
            is_staging_match(Some(&json!("32%")), id),
            "parseInt reads the leading digits"
        );
        assert!(
            !is_staging_match(Some(&json!(31.9)), id),
            "parseInt truncates"
        );
        assert!(
            !is_staging_match(Some(&json!(0)), id),
            "0 halts the rollout"
        );
        assert!(!is_staging_match(Some(&json!(-5)), id));
        assert!(is_staging_match(
            Some(&json!(100)),
            "6ba7b812-9dad-51d1-80b4-0000fffffffe"
        ));
        assert!(
            !is_staging_match(Some(&json!(100)), "6ba7b812-9dad-51d1-80b4-0000ffffffff"),
            "an explicit 100 excludes one id in 2^32"
        );
        // String(1e21) is "1e+21", which parseInt reads as 1.
        assert!(!is_staging_match(Some(&json!(1e21)), id));
        assert!(
            is_staging_match(Some(&json!([40])), id),
            "String([40]) is \"40\""
        );
    }

    #[test]
    fn prints_numbers_like_javascript() {
        assert_eq!(js_number_to_string(25.0), "25");
        assert_eq!(js_number_to_string(31.9), "31.9");
        assert_eq!(js_number_to_string(-0.5), "-0.5");
        assert_eq!(js_number_to_string(1e21), "1e+21");
        assert_eq!(js_number_to_string(1.5e-7), "1.5e-7");
        assert_eq!(js_number_to_string(0.000001), "0.000001");
        assert_eq!(
            js_number_to_string(123456789012345680000.0),
            "123456789012345680000"
        );
    }

    #[test]
    fn keeps_an_existing_id_and_creates_one_only_when_missing_or_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(UPDATER_ID_FILE);
        fs::write(&file, "6ba7b812-9dad-51d1-80b4-00c04fd430c8").unwrap();
        assert_eq!(
            read_or_create_staging_user_id(dir.path()),
            "6ba7b812-9dad-51d1-80b4-00c04fd430c8"
        );

        fs::write(&file, "garbage").unwrap();
        let replaced = read_or_create_staging_user_id(dir.path());
        assert!(is_valid_staging_id(&replaced));
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            replaced,
            "written without a newline"
        );

        let fresh_dir = tempfile::tempdir().unwrap();
        let nested = fresh_dir.path().join("profile");
        let created = read_or_create_staging_user_id(&nested);
        assert_eq!(
            read_or_create_staging_user_id(&nested),
            created,
            "stable once written"
        );
        assert_eq!(&created[14..15], "5", "version 5");
        assert!(
            matches!(&created[19..20], "8" | "9" | "a" | "b"),
            "RFC 4122 variant"
        );
    }
}
