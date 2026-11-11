//! The initialization script that installs `window.electronAPI`.

use serde_json::{json, Value};
use std::collections::BTreeMap;
use tyt_wire::channels as c;

const BRIDGE_JS: &str = include_str!("bridge.js");

fn channel_map() -> Value {
    json!({
        "quit": c::QUIT,
        "openExternal": c::OPEN_EXTERNAL,
        "getIdle": c::GET_IDLE,
        "tokenGet": c::TOKEN_GET,
        "tokenSet": c::TOKEN_SET,
        "tokenDelete": c::TOKEN_DELETE,
        "tokenStatus": c::TOKEN_STATUS,
        "desktopPublishState": c::DESKTOP_PUBLISH_STATE,
        "desktopSettingsGet": c::DESKTOP_SETTINGS_GET,
        "desktopSettingsUpdate": c::DESKTOP_SETTINGS_UPDATE,
        "desktopSuspendShortcuts": c::DESKTOP_SUSPEND_SHORTCUTS,
        "desktopShowWindow": c::DESKTOP_SHOW_WINDOW,
        "windowGet": c::WINDOW_GET,
        "windowMode": c::WINDOW_MODE,
        "windowPin": c::WINDOW_PIN,
        "windowChanged": c::WINDOW_CHANGED,
        "desktopNotify": c::DESKTOP_NOTIFY,
        "updateGetStatus": c::UPDATE_GET_STATUS,
        "updateCheck": c::UPDATE_CHECK,
        "updateRestart": c::UPDATE_RESTART,
        "activityProtect": c::ACTIVITY_PROTECT,
        "activityLock": c::ACTIVITY_LOCK,
        "activitySnapshot": c::ACTIVITY_SNAPSHOT,
        "activitySettings": c::ACTIVITY_SETTINGS,
        "activityScope": c::ACTIVITY_SCOPE,
        "activityForget": c::ACTIVITY_FORGET,
        "activityWipe": c::ACTIVITY_WIPE,
        "activitySuggestions": c::ACTIVITY_SUGGESTIONS,
        "activityCheckAccept": c::ACTIVITY_CHECK_ACCEPT,
        "activityAccepted": c::ACTIVITY_ACCEPTED,
        "activityDismiss": c::ACTIVITY_DISMISS,
        "activityRuleAdd": c::ACTIVITY_RULE_ADD,
        "activityRuleRemove": c::ACTIVITY_RULE_REMOVE,
        "activityAutopilotLearn": c::ACTIVITY_AUTOPILOT_LEARN,
        "activityAutopilotPlan": c::ACTIVITY_AUTOPILOT_PLAN,
        "activityAutopilotApplied": c::ACTIVITY_AUTOPILOT_APPLIED,
        "activityAutopilotHold": c::ACTIVITY_AUTOPILOT_HOLD,
        "activityAutopilotPause": c::ACTIVITY_AUTOPILOT_PAUSE,
        "idleState": c::IDLE_STATE,
        "desktopCommand": c::DESKTOP_COMMAND,
        "desktopSettingsChanged": c::DESKTOP_SETTINGS_CHANGED,
        "updateStatusChanged": c::UPDATE_STATUS_CHANGED,
        "activityChanged": c::ACTIVITY_CHANGED,
    })
}

pub fn script(dev_origin: Option<&str>, migration: Option<&BTreeMap<String, String>>) -> String {
    let config = json!({
        "platform": crate::platform(),
        "origin": tyt_wire::desktop_app_origin(),
        "devOrigin": dev_origin,
        "channels": channel_map(),
        "migration": migration.map(|data| json!({ "marker": crate::migrate::STORAGE_MARKER, "data": data })),
    });
    BRIDGE_JS.replace("__TYT_CONFIG__", &config.to_string())
}

/// `webview.eval` source for a push to the bridge's listeners.
pub fn push_script(channel: &str, payload: &Value) -> String {
    format!(
        "window.__TYT_DESKTOP__&&window.__TYT_DESKTOP__.push({},{})",
        serde_json::to_string(channel).unwrap(),
        serde_json::to_string(payload).unwrap()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_bridge_channel_is_a_known_channel() {
        let map = channel_map();
        for (_, value) in map.as_object().unwrap() {
            assert!(c::ALL.contains(&value.as_str().unwrap()), "{value}");
        }
        assert_eq!(map.as_object().unwrap().len(), c::ALL.len());
    }

    #[test]
    fn the_script_carries_its_config_and_nothing_left_to_fill() {
        let s = script(None, None);
        assert!(!s.contains("__TYT_CONFIG__"));
        assert!(s.contains("\"platform\""));
        // Every channel the bridge names must exist in its config.
        for line in BRIDGE_JS.lines() {
            if let Some(idx) = line.find("C.") {
                let name: String = line[idx + 2..]
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric())
                    .collect();
                if !name.is_empty() {
                    assert!(
                        channel_map().get(&name).is_some(),
                        "bridge.js uses C.{name}"
                    );
                }
            }
        }
    }

    #[test]
    fn push_scripts_quote_their_payload() {
        let s = push_script(
            "desktop:command",
            &json!({ "kind": "stop", "x": "</script>\u{2028}" }),
        );
        assert!(s.starts_with(
            "window.__TYT_DESKTOP__&&window.__TYT_DESKTOP__.push(\"desktop:command\",{"
        ));
    }
}
