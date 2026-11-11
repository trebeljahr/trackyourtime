//! The JSON that crosses the desktop bridge, as Rust types.
//!
//! A field-for-field mirror of `packages/shared/src/desktop-bridge.ts` and
//! `packages/shared/src/desktop-shortcuts.ts`. The TypeScript file is the
//! contract the renderer compiles against; this crate is the same contract
//! for the native shell. `tests/contract.rs` reads the TypeScript source and
//! fails when a channel name or a top-level type is added on one side only.
//!
//! Conventions, so every type reads the same way:
//! - `#[serde(rename_all = "camelCase")]` everywhere; the wire is JS.
//! - `foo?: T` in TypeScript is `Option<T>` with `default` and
//!   `skip_serializing_if = "Option::is_none"`.
//! - `foo: T | null` is a plain `Option<T>` that serializes as `null`.
//! - Discriminated unions are `#[serde(tag = "kind")]` enums.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// ---------------------------------------------------------------------------
// Shortcuts (desktop-shortcuts.ts)
// ---------------------------------------------------------------------------

/// Every action a global shortcut can run, in the order Settings lists them.
pub const DESKTOP_SHORTCUT_ACTIONS: [&str; 4] =
    ["toggle-timer", "new-timer", "toggle-window", "open-palette"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum DesktopShortcutAction {
    #[serde(rename = "toggle-timer")]
    ToggleTimer,
    #[serde(rename = "new-timer")]
    NewTimer,
    #[serde(rename = "toggle-window")]
    ToggleWindow,
    #[serde(rename = "open-palette")]
    OpenPalette,
}

impl DesktopShortcutAction {
    pub const ALL: [DesktopShortcutAction; 4] = [
        DesktopShortcutAction::ToggleTimer,
        DesktopShortcutAction::NewTimer,
        DesktopShortcutAction::ToggleWindow,
        DesktopShortcutAction::OpenPalette,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            DesktopShortcutAction::ToggleTimer => "toggle-timer",
            DesktopShortcutAction::NewTimer => "new-timer",
            DesktopShortcutAction::ToggleWindow => "toggle-window",
            DesktopShortcutAction::OpenPalette => "open-palette",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|action| action.as_str() == value)
    }
}

/// `Record<DesktopShortcutAction, string | null>`. Serialized with every key
/// present, as the TypeScript record requires.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesktopShortcutBindings {
    #[serde(rename = "toggle-timer")]
    pub toggle_timer: Option<String>,
    #[serde(rename = "new-timer")]
    pub new_timer: Option<String>,
    #[serde(rename = "toggle-window")]
    pub toggle_window: Option<String>,
    #[serde(rename = "open-palette")]
    pub open_palette: Option<String>,
}

impl DesktopShortcutBindings {
    /// `DEFAULT_DESKTOP_SHORTCUTS`: exactly one default, and it is the toggle.
    pub fn defaults() -> Self {
        DesktopShortcutBindings {
            toggle_timer: Some("CommandOrControl+Alt+Shift+Space".into()),
            new_timer: None,
            toggle_window: None,
            open_palette: None,
        }
    }

    pub fn get(&self, action: DesktopShortcutAction) -> Option<&str> {
        match action {
            DesktopShortcutAction::ToggleTimer => self.toggle_timer.as_deref(),
            DesktopShortcutAction::NewTimer => self.new_timer.as_deref(),
            DesktopShortcutAction::ToggleWindow => self.toggle_window.as_deref(),
            DesktopShortcutAction::OpenPalette => self.open_palette.as_deref(),
        }
    }

    pub fn set(&mut self, action: DesktopShortcutAction, value: Option<String>) {
        match action {
            DesktopShortcutAction::ToggleTimer => self.toggle_timer = value,
            DesktopShortcutAction::NewTimer => self.new_timer = value,
            DesktopShortcutAction::ToggleWindow => self.toggle_window = value,
            DesktopShortcutAction::OpenPalette => self.open_palette = value,
        }
    }
}

impl Default for DesktopShortcutBindings {
    fn default() -> Self {
        Self::defaults()
    }
}

// ---------------------------------------------------------------------------
// Idle and the secure store
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopIdlePayload {
    /// "active" | "idle" | "locked" | "unknown".
    pub state: String,
    pub idle_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSecureStoreStatus {
    pub persistent: bool,
    pub backend: String,
}

// ---------------------------------------------------------------------------
// Tray state the renderer publishes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTimerState {
    pub signed_in: bool,
    pub running: Option<DesktopRunningTimer>,
    pub recents: Vec<DesktopRecent>,
    pub unsent: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autopilot: Option<DesktopTrayAutopilot>,
    pub labels: DesktopTrayLabels,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTrayAutopilot {
    pub paused_until: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRunningTimer {
    pub description: String,
    pub started_at: String,
    pub project_name: Option<String>,
    pub project_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autopilot: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRecent {
    pub key: String,
    pub label: String,
    pub hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopTrayLabels {
    pub stop: String,
    pub edit: String,
    pub running_for: String,
    pub no_timer: String,
    pub start_timer: String,
    pub recent_heading: String,
    pub open: String,
    pub compact_timer: String,
    pub settings: String,
    pub quit: String,
    pub no_description: String,
    pub idle_tooltip: String,
    pub unsent: String,
    pub quit_unsent_title: String,
    pub quit_unsent_body: String,
    pub quit_unsent_button: String,
    pub running_badge: String,
    pub restart_to_update: String,
    pub autopilot_pause: String,
    pub autopilot_resume: String,
    pub autopilot_paused: String,
}

// ---------------------------------------------------------------------------
// Commands, notices, desktop settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesktopNoticeKind {
    Idle,
    Runaway,
    Autopilot,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum DesktopCommand {
    Stop,
    Toggle,
    Continue { key: String },
    Compose,
    OpenPalette,
    OpenSettings,
    OpenPrompt { prompt: DesktopNoticeKind },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotice {
    pub kind: DesktopNoticeKind,
    pub title: String,
    pub body: String,
    pub tag: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    pub open_at_login: bool,
    pub show_in_tray: bool,
    pub close_hides: bool,
    pub running_badge: bool,
    pub shortcuts: DesktopShortcutBindings,
}

/// `Partial<Omit<DesktopSettings, "shortcuts">> & { shortcuts?: Partial<…> }`.
/// Shortcut values are `Option<Option<String>>`: absent, `null`, or a string.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_at_login: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_in_tray: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub close_hides: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub running_badge: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortcuts: Option<BTreeMap<String, Option<String>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesktopShortcutProblem {
    Invalid,
    Duplicate,
    Taken,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopShortcutStatus {
    pub action: DesktopShortcutAction,
    pub accelerator: Option<String>,
    pub registered: bool,
    pub problem: Option<DesktopShortcutProblem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflicts_with: Option<DesktopShortcutAction>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopLoginItemStatus {
    Enabled,
    Disabled,
    RequiresApproval,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettingsCapabilities {
    pub close_hides: bool,
    pub running_badge: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettingsSnapshot {
    pub settings: DesktopSettings,
    pub shortcuts: Vec<DesktopShortcutStatus>,
    pub shortcuts_suspended: bool,
    pub login_item: DesktopLoginItemStatus,
    pub capabilities: DesktopSettingsCapabilities,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettingsUpdate {
    pub snapshot: DesktopSettingsSnapshot,
    pub refused: Vec<DesktopShortcutStatus>,
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopUpdateDisabledReason {
    Store,
    Sandbox,
    PackageManager,
    NoFeed,
    Unpackaged,
    TurnedOff,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum DesktopUpdateStatus {
    Disabled {
        reason: DesktopUpdateDisabledReason,
    },
    Idle {
        #[serde(rename = "lastCheckedAt")]
        last_checked_at: Option<String>,
    },
    Checking {
        #[serde(rename = "lastCheckedAt")]
        last_checked_at: Option<String>,
    },
    Downloading {
        version: String,
        percent: Option<f64>,
    },
    Ready {
        version: String,
    },
    Error {
        #[serde(rename = "lastCheckedAt")]
        last_checked_at: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateSnapshot {
    pub current_version: String,
    pub status: DesktopUpdateStatus,
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesktopWindowMode {
    Full,
    Compact,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWindowSnapshot {
    pub mode: DesktopWindowMode,
    pub always_on_top: bool,
}

// ---------------------------------------------------------------------------
// Activity capture and Autopilot
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopActivityUnavailableReason {
    Store,
    LinuxSandbox,
    Wayland,
    UnsupportedPlatform,
    ToolMissing,
    BlockedByPolicy,
    SourceFailed,
    NewerFormat,
    EncryptedLocked,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivitySettings {
    pub enabled: bool,
    pub store_titles: bool,
    pub excluded_apps: Vec<String>,
    pub retention_days: f64,
    pub autopilot: bool,
    pub autopilot_start_minutes: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityApp {
    pub key: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityRule {
    pub id: String,
    pub pattern: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// `projectId?: string | null`: absent, null, or a value.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    pub project_id: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    pub task_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub billable: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityInterval {
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DesktopActivitySupport {
    Supported {
        supported: True,
    },
    Unsupported {
        supported: False,
        reason: DesktopActivityUnavailableReason,
        hint: Option<String>,
    },
}

/// A boolean that is always `true` on the wire (for untagged unions).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct True;
/// A boolean that is always `false` on the wire (for untagged unions).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct False;

macro_rules! literal_bool {
    ($ty:ident, $value:expr) => {
        impl Serialize for $ty {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_bool($value)
            }
        }
        impl<'de> Deserialize<'de> for $ty {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let value = bool::deserialize(d)?;
                if value == $value {
                    Ok($ty)
                } else {
                    Err(serde::de::Error::custom(concat!(
                        "expected ",
                        stringify!($value)
                    )))
                }
            }
        }
    };
}
literal_bool!(True, true);
literal_bool!(False, false);

impl DesktopActivitySupport {
    pub fn supported() -> Self {
        DesktopActivitySupport::Supported { supported: True }
    }
    pub fn unsupported(reason: DesktopActivityUnavailableReason, hint: Option<String>) -> Self {
        DesktopActivitySupport::Unsupported {
            supported: False,
            reason,
            hint,
        }
    }
    pub fn is_supported(&self) -> bool {
        matches!(self, DesktopActivitySupport::Supported { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityProtection {
    pub encrypted: bool,
    pub locked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trusted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_trust: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesktopActivityPaused {
    Idle,
    Locked,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivitySnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protection: Option<DesktopActivityProtection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub titles_permission_required: Option<bool>,
    pub settings: DesktopActivitySettings,
    pub support: DesktopActivitySupport,
    pub titles_available: bool,
    pub scoped: bool,
    pub recording: bool,
    pub paused: Option<DesktopActivityPaused>,
    pub stored_segments: u64,
    pub recent_apps: Vec<DesktopActivityApp>,
    pub rules: Vec<DesktopActivityRule>,
    pub autopilot: DesktopAutopilotState,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityProposal {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    pub project_id: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    pub task_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub billable: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityTopApp {
    pub key: String,
    pub name: String,
    pub seconds: f64,
    pub share: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivitySuggestion {
    pub start: f64,
    pub end: f64,
    pub top_apps: Vec<DesktopActivityTopApp>,
    pub titles: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<String>,
    pub proposed: DesktopActivityProposal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopActivityAcceptRefusal {
    AlreadyTracked,
    NoScope,
    BadRange,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DesktopActivityAcceptCheck {
    Ok {
        ok: True,
        start: f64,
        end: f64,
    },
    Refused {
        ok: False,
        reason: DesktopActivityAcceptRefusal,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesktopFilingVia {
    Rule,
    Learned,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAutopilotFiling {
    pub key: String,
    pub fields: DesktopActivityProposal,
    pub via: DesktopFilingVia,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAutopilotWatch {
    pub app: DesktopActivityApp,
    pub since: f64,
    pub credited_ms: f64,
    pub filing: Option<DesktopAutopilotFiling>,
    pub held: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesktopAutopilotAction {
    Start,
    Switch,
    Stop,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAutopilotLogEntry {
    pub id: String,
    pub kind: DesktopAutopilotAction,
    pub at: f64,
    pub decided_at: f64,
    pub app: Option<DesktopActivityApp>,
    pub filing: Option<DesktopAutopilotFiling>,
    pub undone: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAutopilotOwned {
    pub start: f64,
    pub filing_key: String,
    pub app: Option<DesktopActivityApp>,
    pub via: DesktopFilingVia,
    pub log_id: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAutopilotState {
    pub active: bool,
    pub owned: Option<DesktopAutopilotOwned>,
    pub watch: Option<DesktopAutopilotWatch>,
    pub log: Vec<DesktopAutopilotLogEntry>,
    pub learned_apps: u64,
    pub paused_until: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAutopilotRunning {
    pub start: f64,
    pub description: String,
    pub project_id: Option<String>,
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAutopilotHistoryEntry {
    pub start: f64,
    pub end: f64,
    pub description: String,
    pub project_id: Option<String>,
    pub task_id: Option<String>,
    pub tag_ids: Vec<String>,
    pub billable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum DesktopAutopilotPlan {
    None,
    Start {
        token: String,
        at: f64,
        filing: DesktopAutopilotFiling,
        app: DesktopActivityApp,
        #[serde(rename = "creditedMs")]
        credited_ms: f64,
    },
    Switch {
        token: String,
        at: f64,
        filing: DesktopAutopilotFiling,
        app: DesktopActivityApp,
        #[serde(rename = "creditedMs")]
        credited_ms: f64,
    },
    Stop {
        token: String,
        at: f64,
        app: Option<DesktopActivityApp>,
    },
}

/// `T | null` inside an optional key: absent → `None`, `null` →
/// `Some(None)`, a value → `Some(Some(v))`.
pub mod double_option {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<T: Serialize, S: Serializer>(
        value: &Option<Option<T>>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        match value {
            None => s.serialize_none(),
            Some(inner) => inner.serialize(s),
        }
    }

    pub fn deserialize<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
        d: D,
    ) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(d).map(Some)
    }
}

// ---------------------------------------------------------------------------
// Channels and the app origin
// ---------------------------------------------------------------------------

/// `DESKTOP_IPC`: every channel name. The bridge invokes these, the shell
/// dispatches on them, and pushes are emitted as Tauri events of the same name.
pub mod channels {
    pub const QUIT: &str = "app:quit";
    pub const OPEN_EXTERNAL: &str = "app:openExternal";
    pub const GET_IDLE: &str = "idle:get";
    pub const TOKEN_GET: &str = "secure-store:get";
    pub const TOKEN_SET: &str = "secure-store:set";
    pub const TOKEN_DELETE: &str = "secure-store:delete";
    pub const TOKEN_STATUS: &str = "secure-store:status";
    pub const DESKTOP_PUBLISH_STATE: &str = "desktop:timer-state";
    pub const DESKTOP_SETTINGS_GET: &str = "desktop:settings-get";
    pub const DESKTOP_SETTINGS_UPDATE: &str = "desktop:settings-update";
    pub const DESKTOP_SUSPEND_SHORTCUTS: &str = "desktop:shortcuts-suspend";
    pub const DESKTOP_SHOW_WINDOW: &str = "desktop:window-show";
    pub const WINDOW_GET: &str = "desktop:window-get";
    pub const WINDOW_MODE: &str = "desktop:window-mode";
    pub const WINDOW_PIN: &str = "desktop:window-pin";
    pub const WINDOW_CHANGED: &str = "desktop:window-changed";
    pub const DESKTOP_NOTIFY: &str = "desktop:notify";
    pub const UPDATE_GET_STATUS: &str = "update:status";
    pub const UPDATE_CHECK: &str = "update:check";
    pub const UPDATE_RESTART: &str = "update:restart";
    pub const ACTIVITY_PROTECT: &str = "activity:protect";
    pub const ACTIVITY_LOCK: &str = "activity:lock";
    pub const ACTIVITY_SNAPSHOT: &str = "activity:snapshot";
    pub const ACTIVITY_SETTINGS: &str = "activity:settings";
    pub const ACTIVITY_SCOPE: &str = "activity:scope";
    pub const ACTIVITY_FORGET: &str = "activity:forget";
    pub const ACTIVITY_WIPE: &str = "activity:wipe";
    pub const ACTIVITY_SUGGESTIONS: &str = "activity:suggestions";
    pub const ACTIVITY_CHECK_ACCEPT: &str = "activity:check-accept";
    pub const ACTIVITY_ACCEPTED: &str = "activity:accepted";
    pub const ACTIVITY_DISMISS: &str = "activity:dismiss";
    pub const ACTIVITY_RULE_ADD: &str = "activity:rule-add";
    pub const ACTIVITY_RULE_REMOVE: &str = "activity:rule-remove";
    pub const ACTIVITY_AUTOPILOT_LEARN: &str = "activity:autopilot-learn";
    pub const ACTIVITY_AUTOPILOT_PLAN: &str = "activity:autopilot-plan";
    pub const ACTIVITY_AUTOPILOT_APPLIED: &str = "activity:autopilot-applied";
    pub const ACTIVITY_AUTOPILOT_HOLD: &str = "activity:autopilot-hold";
    pub const ACTIVITY_AUTOPILOT_PAUSE: &str = "activity:autopilot-pause";
    /// Pushes (shell → renderer).
    pub const IDLE_STATE: &str = "idle:state";
    pub const DESKTOP_COMMAND: &str = "desktop:command";
    pub const DESKTOP_SETTINGS_CHANGED: &str = "desktop:settings-changed";
    pub const UPDATE_STATUS_CHANGED: &str = "update:status-changed";
    pub const ACTIVITY_CHANGED: &str = "activity:changed";

    /// Every channel, for the contract test and the dispatcher's allowlist.
    pub const ALL: &[&str] = &[
        QUIT,
        OPEN_EXTERNAL,
        GET_IDLE,
        TOKEN_GET,
        TOKEN_SET,
        TOKEN_DELETE,
        TOKEN_STATUS,
        DESKTOP_PUBLISH_STATE,
        DESKTOP_SETTINGS_GET,
        DESKTOP_SETTINGS_UPDATE,
        DESKTOP_SUSPEND_SHORTCUTS,
        DESKTOP_SHOW_WINDOW,
        WINDOW_GET,
        WINDOW_MODE,
        WINDOW_PIN,
        WINDOW_CHANGED,
        DESKTOP_NOTIFY,
        UPDATE_GET_STATUS,
        UPDATE_CHECK,
        UPDATE_RESTART,
        ACTIVITY_PROTECT,
        ACTIVITY_LOCK,
        ACTIVITY_SNAPSHOT,
        ACTIVITY_SETTINGS,
        ACTIVITY_SCOPE,
        ACTIVITY_FORGET,
        ACTIVITY_WIPE,
        ACTIVITY_SUGGESTIONS,
        ACTIVITY_CHECK_ACCEPT,
        ACTIVITY_ACCEPTED,
        ACTIVITY_DISMISS,
        ACTIVITY_RULE_ADD,
        ACTIVITY_RULE_REMOVE,
        ACTIVITY_AUTOPILOT_LEARN,
        ACTIVITY_AUTOPILOT_PLAN,
        ACTIVITY_AUTOPILOT_APPLIED,
        ACTIVITY_AUTOPILOT_HOLD,
        ACTIVITY_AUTOPILOT_PAUSE,
        IDLE_STATE,
        DESKTOP_COMMAND,
        DESKTOP_SETTINGS_CHANGED,
        UPDATE_STATUS_CHANGED,
        ACTIVITY_CHANGED,
    ];
}

/// The origin the app serves its export from on macOS and Linux. A constant:
/// localStorage, the offline queue and every server's trust list are keyed by
/// it, so changing it after a release orphans all of them.
pub const DESKTOP_APP_SCHEME: &str = "app";
pub const DESKTOP_APP_HOST: &str = "-";
pub const DESKTOP_APP_ORIGIN: &str = "app://-";
/// WebView2 cannot register a custom scheme with its own host, so Windows
/// serves the same protocol as `http://app.localhost` (wry's mapping).
pub const DESKTOP_APP_ORIGIN_WINDOWS: &str = "http://app.localhost";

/// The origin this build's documents carry.
pub fn desktop_app_origin() -> &'static str {
    if cfg!(windows) {
        DESKTOP_APP_ORIGIN_WINDOWS
    } else {
        DESKTOP_APP_ORIGIN
    }
}

/// What the secure store and the activity vault encrypt with. The shell
/// implements it with a key held by the OS (Keychain, Credential Manager,
/// Secret Service), the way Electron's `safeStorage` did; headless runs use a
/// fixed in-process key, like Chromium's mock keychain.
pub trait Encryption: Send + Sync {
    fn is_available(&self) -> bool;
    /// As `DesktopSecureStoreStatus.backend` reports it.
    fn backend(&self) -> String;
    fn encrypt(&self, plain: &str) -> Result<Vec<u8>, String>;
    fn decrypt(&self, cipher: &[u8]) -> Result<String, String>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn commands_serialize_like_the_typescript_union() {
        assert_eq!(
            serde_json::to_value(DesktopCommand::Stop).unwrap(),
            json!({"kind": "stop"})
        );
        assert_eq!(
            serde_json::to_value(DesktopCommand::Continue { key: "k".into() }).unwrap(),
            json!({"kind": "continue", "key": "k"})
        );
        assert_eq!(
            serde_json::to_value(DesktopCommand::OpenPrompt {
                prompt: DesktopNoticeKind::Runaway
            })
            .unwrap(),
            json!({"kind": "open-prompt", "prompt": "runaway"})
        );
        assert_eq!(
            serde_json::to_value(DesktopCommand::OpenPalette).unwrap(),
            json!({"kind": "open-palette"})
        );
    }

    #[test]
    fn update_status_uses_camel_case_inside_the_tag() {
        let status = DesktopUpdateStatus::Idle {
            last_checked_at: None,
        };
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            json!({"kind": "idle", "lastCheckedAt": null})
        );
        let reason = DesktopUpdateStatus::Disabled {
            reason: DesktopUpdateDisabledReason::PackageManager,
        };
        assert_eq!(
            serde_json::to_value(reason).unwrap(),
            json!({"kind": "disabled", "reason": "package-manager"})
        );
    }

    #[test]
    fn support_and_accept_unions_round_trip() {
        let support = DesktopActivitySupport::unsupported(
            DesktopActivityUnavailableReason::ToolMissing,
            Some("x11-utils".into()),
        );
        let value = serde_json::to_value(&support).unwrap();
        assert_eq!(
            value,
            json!({"supported": false, "reason": "tool-missing", "hint": "x11-utils"})
        );
        assert_eq!(
            serde_json::from_value::<DesktopActivitySupport>(value).unwrap(),
            support
        );
        assert_eq!(
            serde_json::to_value(DesktopActivitySupport::supported()).unwrap(),
            json!({"supported": true})
        );
        let check: DesktopActivityAcceptCheck =
            serde_json::from_value(json!({"ok": false, "reason": "already-tracked"})).unwrap();
        assert_eq!(
            check,
            DesktopActivityAcceptCheck::Refused {
                ok: False,
                reason: DesktopActivityAcceptRefusal::AlreadyTracked
            }
        );
    }

    #[test]
    fn optional_nullable_fields_keep_absent_null_and_value_apart() {
        let absent: DesktopActivityProposal = serde_json::from_value(json!({})).unwrap();
        assert_eq!(absent.project_id, None);
        let null: DesktopActivityProposal =
            serde_json::from_value(json!({"projectId": null})).unwrap();
        assert_eq!(null.project_id, Some(None));
        assert_eq!(
            serde_json::to_value(&null).unwrap(),
            json!({"projectId": null})
        );
        assert_eq!(serde_json::to_value(&absent).unwrap(), json!({}));
    }

    #[test]
    fn plans_and_shortcut_bindings_match_the_wire() {
        let plan = DesktopAutopilotPlan::Stop {
            token: "t".into(),
            at: 1.0,
            app: None,
        };
        assert_eq!(
            serde_json::to_value(plan).unwrap(),
            json!({"kind": "stop", "token": "t", "at": 1.0, "app": null})
        );
        assert_eq!(
            serde_json::to_value(DesktopShortcutBindings::defaults()).unwrap(),
            json!({"toggle-timer": "CommandOrControl+Alt+Shift+Space", "new-timer": null, "toggle-window": null, "open-palette": null})
        );
    }
}
