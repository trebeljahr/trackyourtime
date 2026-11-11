//! The window's remembered size and place, as pure functions, plus the
//! `<userData>/window-state.json` file Electron wrote. Ported from
//! `electron/src/window-state.ts` and the file half of `window.ts`.
//!
//! Coordinates are logical (DIP) pixels, as Electron's `getNormalBounds`
//! reported them: the shell converts Tauri's physical positions and sizes by
//! the window's scale factor before handing them over, or an existing
//! install's window opens at the wrong place on a Retina or 150 % display.

use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Map, Value};
use tyt_wire::DesktopWindowMode;

use crate::timer_menu::js::{finite_number, js_round};

pub const WINDOW_STATE_FILE: &str = "window-state.json";

/// Integral values print as integers (`10`, not `10.0`), as `JSON.stringify` did.
fn js_number<S: Serializer>(value: &f64, s: S) -> Result<S::Ok, S::Error> {
    if value.fract() == 0.0 && value.abs() < 9.007_199_254_740_992e15 {
        s.serialize_i64(*value as i64)
    } else {
        s.serialize_f64(*value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    #[serde(serialize_with = "js_number")]
    pub x: f64,
    #[serde(serialize_with = "js_number")]
    pub y: f64,
    #[serde(serialize_with = "js_number")]
    pub width: f64,
    #[serde(serialize_with = "js_number")]
    pub height: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<DesktopWindowMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact_bounds: Option<Rect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub always_on_top: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Rect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximized: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fullscreen: Option<bool>,
}

impl WindowState {
    /// `{ ...self, ...patch }`: every field the patch carries wins.
    pub fn merged(&self, patch: &WindowState) -> WindowState {
        WindowState {
            mode: patch.mode.or(self.mode),
            compact_bounds: patch.compact_bounds.or(self.compact_bounds),
            always_on_top: patch.always_on_top.or(self.always_on_top),
            bounds: patch.bounds.or(self.bounds),
            maximized: patch.maximized.or(self.maximized),
            fullscreen: patch.fullscreen.or(self.fullscreen),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Size {
    pub width: u32,
    pub height: u32,
}

pub const DEFAULT_SIZE: Size = Size {
    width: 1280,
    height: 800,
};
pub const MIN_SIZE: Size = Size {
    width: 800,
    height: 500,
};
pub const COMPACT_SIZE: Size = Size {
    width: 380,
    height: 540,
};
pub const COMPACT_MIN_SIZE: Size = Size {
    width: 320,
    height: 420,
};

fn finite_rect(value: Option<&Value>) -> Option<Rect> {
    let Some(Value::Object(r)) = value else {
        return None;
    };
    let field = |k: &str| r.get(k).and_then(finite_number);
    Some(Rect {
        x: field("x")?,
        y: field("y")?,
        width: field("width")?,
        height: field("height")?,
    })
}

fn boolean(map: &Map<String, Value>, key: &str) -> Option<bool> {
    map.get(key).and_then(Value::as_bool)
}

/// Whatever was on disk, reduced to fields that are the right shape.
pub fn parse_window_state(raw: Option<&str>) -> WindowState {
    let Some(raw) = raw else {
        return WindowState::default();
    };
    let Ok(Value::Object(d)) = serde_json::from_str::<Value>(raw) else {
        return WindowState::default();
    };
    WindowState {
        mode: match d.get("mode").and_then(Value::as_str) {
            Some("full") => Some(DesktopWindowMode::Full),
            Some("compact") => Some(DesktopWindowMode::Compact),
            _ => None,
        },
        compact_bounds: finite_rect(d.get("compactBounds")),
        always_on_top: boolean(&d, "alwaysOnTop"),
        bounds: finite_rect(d.get("bounds")),
        maximized: boolean(&d, "maximized"),
        fullscreen: boolean(&d, "fullscreen"),
    }
}

/// Bounds to open with: a size always, a position only when it lands on a
/// display that exists now.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct InitialBounds {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: f64,
    pub height: f64,
}

fn overlap(a: &Rect, b: &Rect) -> f64 {
    let w = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
    let h = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
    if w > 0.0 && h > 0.0 {
        w * h
    } else {
        0.0
    }
}

/// The bounds to open with. Saved bounds are used only when at least a
/// 100×50 corner of the title area lands on a display that exists now — a
/// window last closed on an unplugged monitor otherwise opens off-screen, with
/// no way to drag it back. Too-small sizes are raised to the minimum.
pub fn initial_bounds(
    saved: Option<&Rect>,
    work_areas: &[Rect],
    mode: DesktopWindowMode,
) -> InitialBounds {
    let compact = mode == DesktopWindowMode::Compact;
    let minimum = if compact { COMPACT_MIN_SIZE } else { MIN_SIZE };
    let Some(saved) = saved else {
        let size = if compact { COMPACT_SIZE } else { DEFAULT_SIZE };
        return InitialBounds {
            x: None,
            y: None,
            width: f64::from(size.width),
            height: f64::from(size.height),
        };
    };
    let width = f64::from(minimum.width).max(js_round(saved.width));
    let height = f64::from(minimum.height).max(js_round(saved.height));
    let title_area = Rect {
        x: saved.x,
        y: saved.y,
        width: width.min(100.0),
        height: 50.0,
    };
    let visible = work_areas
        .iter()
        .any(|area| overlap(&title_area, area) >= 100.0 * 50.0 * 0.99);
    if !visible {
        return InitialBounds {
            x: None,
            y: None,
            width,
            height,
        };
    }
    InitialBounds {
        x: Some(js_round(saved.x)),
        y: Some(js_round(saved.y)),
        width,
        height,
    }
}

/// The window background, painted before the first frame of the page.
/// `globals.css` `--background`: `0 0% 100%` light, `0 0% 3.9%` dark. The
/// renderer's own theme preference is not readable from here, so this
/// follows the OS, which is also what the theme script falls back to.
pub fn background_color_for(dark: bool) -> &'static str {
    if dark {
        "#0a0a0a"
    } else {
        "#ffffff"
    }
}

pub fn read_window_state(user_data: &Path) -> WindowState {
    parse_window_state(
        fs::read_to_string(user_data.join(WINDOW_STATE_FILE))
            .ok()
            .as_deref(),
    )
}

/// Merge `patch` into what is on disk and write it back (compact JSON, as
/// `JSON.stringify` wrote it).
pub fn write_window_state(user_data: &Path, patch: &WindowState) -> io::Result<()> {
    let next = read_window_state(user_data).merged(patch);
    fs::create_dir_all(user_data)?;
    let text = serde_json::to_string(&next).map_err(io::Error::other)?;
    fs::write(user_data.join(WINDOW_STATE_FILE), text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PRIMARY: Rect = Rect {
        x: 0.0,
        y: 25.0,
        width: 1512.0,
        height: 920.0,
    };

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn keeps_well_formed_fields_and_drops_the_rest() {
        let parsed = parse_window_state(Some(
            &json!({"bounds": {"x": 10, "y": 20, "width": 900, "height": 600}, "maximized": true, "extra": 1}).to_string(),
        ));
        assert_eq!(
            parsed,
            WindowState {
                bounds: Some(rect(10.0, 20.0, 900.0, 600.0)),
                maximized: Some(true),
                ..Default::default()
            }
        );
        assert_eq!(
            parse_window_state(Some(
                &json!({"bounds": {"x": "1"}, "fullscreen": "yes"}).to_string()
            )),
            WindowState::default()
        );
    }

    #[test]
    fn treats_a_missing_or_corrupt_file_as_no_state() {
        assert_eq!(parse_window_state(None), WindowState::default());
        assert_eq!(
            parse_window_state(Some("{not json")),
            WindowState::default()
        );
        assert_eq!(parse_window_state(Some("null")), WindowState::default());
    }

    #[test]
    fn uses_the_default_size_with_nothing_saved() {
        assert_eq!(
            initial_bounds(None, &[PRIMARY], DesktopWindowMode::Full),
            InitialBounds {
                x: None,
                y: None,
                width: 1280.0,
                height: 800.0
            }
        );
        assert_eq!(
            initial_bounds(None, &[PRIMARY], DesktopWindowMode::Compact).width,
            380.0
        );
    }

    #[test]
    fn restores_bounds_that_are_on_a_display() {
        assert_eq!(
            initial_bounds(
                Some(&rect(100.0, 80.0, 1000.0, 700.0)),
                &[PRIMARY],
                DesktopWindowMode::Full
            ),
            InitialBounds {
                x: Some(100.0),
                y: Some(80.0),
                width: 1000.0,
                height: 700.0
            }
        );
    }

    #[test]
    fn keeps_the_size_but_drops_the_position_of_a_window_on_a_missing_display() {
        assert_eq!(
            initial_bounds(
                Some(&rect(3000.0, 80.0, 1000.0, 700.0)),
                &[PRIMARY],
                DesktopWindowMode::Full
            ),
            InitialBounds {
                x: None,
                y: None,
                width: 1000.0,
                height: 700.0
            }
        );
    }

    #[test]
    fn raises_a_too_small_size_to_the_minimum() {
        assert_eq!(
            initial_bounds(
                Some(&rect(100.0, 80.0, 200.0, 100.0)),
                &[PRIMARY],
                DesktopWindowMode::Full
            ),
            InitialBounds {
                x: Some(100.0),
                y: Some(80.0),
                width: 800.0,
                height: 500.0
            }
        );
    }

    #[test]
    fn matches_globals_css_background() {
        assert_eq!(background_color_for(false), "#ffffff");
        assert_eq!(background_color_for(true), "#0a0a0a");
    }

    #[test]
    fn merges_into_the_file_and_writes_integers_as_integers() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(WINDOW_STATE_FILE),
            r#"{"maximized":true,"bounds":{"x":1,"y":2,"width":900,"height":600}}"#,
        )
        .unwrap();
        write_window_state(
            dir.path(),
            &WindowState {
                mode: Some(DesktopWindowMode::Compact),
                compact_bounds: Some(rect(5.0, 6.0, 380.5, 540.0)),
                ..Default::default()
            },
        )
        .unwrap();
        let text = fs::read_to_string(dir.path().join(WINDOW_STATE_FILE)).unwrap();
        assert_eq!(
            text,
            r#"{"mode":"compact","compactBounds":{"x":5,"y":6,"width":380.5,"height":540},"bounds":{"x":1,"y":2,"width":900,"height":600},"maximized":true}"#
        );
        assert_eq!(read_window_state(dir.path()).maximized, Some(true));
    }
}
