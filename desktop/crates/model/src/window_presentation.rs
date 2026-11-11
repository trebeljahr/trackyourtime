//! One renderer, two remembered sizes: the full app and the compact timer.
//! Ported from `electron/src/window-presentation.ts` (and the launch half of
//! `window.ts`) as a model over a small [`WindowOps`] trait the shell
//! implements with the Tauri window. Auth screens always get the full app.
//!
//! What the Electron version awaited, this one splits in two, because the
//! shell drives it from the thread that also delivers the window's events:
//! leaving fullscreen is asked for ([`WindowOps::leave_fullscreen`]) and, when
//! the window cannot do it at once, the switch finishes when the shell reports
//! it ([`WindowPresentation::fullscreen_left`]). Changes that arrive meanwhile
//! only update the preferences, and the switch uses the latest of them — the
//! TypeScript re-read them after the wait for the same reason ("authentication
//! may have changed while the OS left fullscreen") and queued the rest behind
//! it, which ends in the same state.
//!
//! Nothing here writes a file or talks to the renderer: each call returns
//! [`PresentationEffects`] (the state to save, the snapshot to announce),
//! which the desktop controller applies.

use tyt_wire::{DesktopWindowMode, DesktopWindowSnapshot};

use crate::window_state::{
    initial_bounds, InitialBounds, Rect, Size, WindowState, COMPACT_MIN_SIZE, MIN_SIZE,
};

pub trait WindowOps {
    fn is_destroyed(&self) -> bool;
    fn is_visible(&self) -> bool;
    fn is_maximized(&self) -> bool;
    fn is_full_screen(&self) -> bool;
    /// The un-maximized, un-fullscreen rectangle, in logical pixels.
    fn normal_bounds(&self) -> Rect;
    /// Every display's work area, in logical pixels.
    fn work_areas(&self) -> Vec<Rect>;
    fn set_minimum_size(&mut self, width: f64, height: f64);
    /// Resize; move only when `x`/`y` are given (a position on a display that
    /// is gone is dropped, the window keeps where it is).
    fn set_bounds(&mut self, bounds: &InitialBounds);
    fn set_always_on_top(&mut self, enabled: bool);
    fn unmaximize(&mut self);
    /// Also shows a hidden window on some platforms; only called while visible.
    fn maximize(&mut self);
    /// Leave simple and native fullscreen. `true` when the window is out of
    /// fullscreen already (nothing to wait for); `false` when the shell will
    /// call [`WindowPresentation::fullscreen_left`] once it is (or the window
    /// closed).
    fn leave_fullscreen(&mut self) -> bool;
}

/// What a presentation change asks the shell to do.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PresentationEffects {
    /// Merge into `window-state.json` (the whole remembered state, so the
    /// last one of several saves carries all of them).
    pub save: Option<WindowState>,
    /// Send as `desktop:window-changed`.
    pub changed: Option<DesktopWindowSnapshot>,
}

impl PresentationEffects {
    fn merge(&mut self, other: PresentationEffects) {
        if other.save.is_some() {
            self.save = other.save;
        }
        if other.changed.is_some() {
            self.changed = other.changed;
        }
    }
}

#[derive(Debug, Clone)]
pub struct WindowPresentation {
    saved: WindowState,
    headless: bool,
    mode: DesktopWindowMode,
    preferred: DesktopWindowMode,
    pinned: bool,
    signed_in: bool,
    switching: bool,
    /// Waiting for the window to leave fullscreen before switching.
    awaiting_fullscreen: bool,
}

impl WindowPresentation {
    /// `saved` is the file's state with `mode` already defaulted
    /// (`window_policy::default_window_mode`), as main.ts passed it.
    pub fn new(saved: WindowState, headless: bool) -> Self {
        let preferred = saved.mode.unwrap_or(DesktopWindowMode::Full);
        let pinned = saved.always_on_top.unwrap_or(false);
        WindowPresentation {
            saved,
            headless,
            mode: DesktopWindowMode::Full,
            preferred,
            pinned,
            signed_in: false,
            switching: false,
            awaiting_fullscreen: false,
        }
    }

    pub fn snapshot(&self) -> DesktopWindowSnapshot {
        DesktopWindowSnapshot {
            mode: self.mode,
            always_on_top: self.pinned,
        }
    }

    pub fn saved(&self) -> &WindowState {
        &self.saved
    }

    pub fn is_switching(&self) -> bool {
        self.switching
    }

    fn persist(&mut self, patch: WindowState) -> PresentationEffects {
        let mut next = self.saved.merged(&patch);
        next.mode = Some(self.preferred);
        next.always_on_top = Some(self.pinned);
        self.saved = next;
        PresentationEffects {
            save: Some(self.saved.clone()),
            changed: None,
        }
    }

    /// Remember the current mode's normal bounds (a resize, a move, a close).
    pub fn remember(&mut self, win: &dyn WindowOps) -> PresentationEffects {
        if win.is_destroyed() || self.switching {
            return PresentationEffects::default();
        }
        let patch = if self.mode == DesktopWindowMode::Compact {
            WindowState {
                compact_bounds: Some(win.normal_bounds()),
                ..Default::default()
            }
        } else {
            WindowState {
                bounds: Some(win.normal_bounds()),
                maximized: Some(win.is_maximized()),
                fullscreen: Some(win.is_full_screen()),
                ..Default::default()
            }
        };
        self.persist(patch)
    }

    fn target(&self) -> DesktopWindowMode {
        if self.signed_in {
            self.preferred
        } else {
            DesktopWindowMode::Full
        }
    }

    fn apply(&mut self, win: &mut dyn WindowOps) -> PresentationEffects {
        let mut effects = PresentationEffects::default();
        if win.is_destroyed() {
            return effects;
        }
        if self.awaiting_fullscreen {
            // The switch in flight picks the latest preferences up when it ends.
            return effects;
        }
        if self.mode != self.target() {
            effects.merge(self.remember(win));
            self.switching = true;
            if !win.leave_fullscreen() {
                self.awaiting_fullscreen = true;
                return effects;
            }
            effects.merge(self.switch(win));
        }
        effects.merge(self.finish(win));
        effects
    }

    /// The window left fullscreen (or closed): finish the switch it held up.
    pub fn fullscreen_left(&mut self, win: &mut dyn WindowOps) -> PresentationEffects {
        if !self.awaiting_fullscreen {
            return PresentationEffects::default();
        }
        self.awaiting_fullscreen = false;
        if win.is_destroyed() {
            self.switching = false;
            return PresentationEffects::default();
        }
        let mut effects = self.switch(win);
        effects.merge(self.finish(win));
        effects
    }

    fn switch(&mut self, win: &mut dyn WindowOps) -> PresentationEffects {
        // Authentication may have changed while the OS left fullscreen.
        let next = self.target();
        if next != self.mode {
            if win.is_maximized() {
                win.unmaximize();
            }
            let minimum: Size = if next == DesktopWindowMode::Compact {
                COMPACT_MIN_SIZE
            } else {
                MIN_SIZE
            };
            // Shrink the minimum before shrinking the window, and restore bounds
            // before raising it again. Each mode keeps its own normal rectangle.
            win.set_minimum_size(1.0, 1.0);
            let saved = if next == DesktopWindowMode::Compact {
                self.saved.compact_bounds
            } else {
                self.saved.bounds
            };
            win.set_bounds(&initial_bounds(saved.as_ref(), &win.work_areas(), next));
            win.set_minimum_size(f64::from(minimum.width), f64::from(minimum.height));
            self.mode = next;
            if next == DesktopWindowMode::Full
                && self.saved.maximized == Some(true)
                && !self.headless
                && win.is_visible()
            {
                win.maximize();
            }
        }
        self.switching = false;
        PresentationEffects::default()
    }

    fn finish(&mut self, win: &mut dyn WindowOps) -> PresentationEffects {
        // No pinning or activation of any real window during agent/test runs.
        if !self.headless {
            win.set_always_on_top(
                self.signed_in && self.mode == DesktopWindowMode::Compact && self.pinned,
            );
        }
        let mut effects = self.persist(WindowState::default());
        effects.changed = Some(self.snapshot());
        effects
    }

    pub fn set_mode(
        &mut self,
        win: &mut dyn WindowOps,
        next: DesktopWindowMode,
    ) -> PresentationEffects {
        self.preferred = next;
        self.apply(win)
    }

    pub fn set_always_on_top(
        &mut self,
        win: &mut dyn WindowOps,
        enabled: bool,
    ) -> PresentationEffects {
        self.pinned = enabled;
        self.apply(win)
    }

    pub fn set_signed_in(&mut self, win: &mut dyn WindowOps, enabled: bool) -> PresentationEffects {
        if self.signed_in == enabled {
            return PresentationEffects::default();
        }
        self.signed_in = enabled;
        self.apply(win)
    }
}

/// How to create the window, as `createMainWindow` and its `ready-to-show`
/// handler decided.
#[derive(Debug, Clone, PartialEq)]
pub struct WindowLaunch {
    pub bounds: InitialBounds,
    pub min_size: Size,
    /// Never in headless: a fullscreen window cannot stay hidden.
    pub fullscreen: bool,
    /// Show once the page is ready to paint (never in headless, nor for a
    /// login-item launch that stays in the tray).
    pub show_when_ready: bool,
    /// Maximize right before that first show, never at construction:
    /// maximizing also shows a hidden window, before the page painted.
    pub maximize_when_ready: bool,
}

/// `saved` with its mode already defaulted, as [`WindowPresentation::new`]
/// takes it. The window opens in full mode; the presentation moves it to the
/// compact timer once a signed-in renderer says so.
pub fn window_launch(
    saved: &WindowState,
    work_areas: &[Rect],
    headless: bool,
    show_on_ready: bool,
) -> WindowLaunch {
    let compact = saved.mode == Some(DesktopWindowMode::Compact);
    let show = !headless && show_on_ready;
    WindowLaunch {
        bounds: initial_bounds(saved.bounds.as_ref(), work_areas, DesktopWindowMode::Full),
        min_size: MIN_SIZE,
        fullscreen: !compact && saved.fullscreen == Some(true) && !headless,
        show_when_ready: show,
        // The presentation's mode at ready-to-show is "full": nothing has
        // signed in yet.
        maximize_when_ready: show && saved.maximized == Some(true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        rect: Rect,
        top: bool,
        fullscreen: bool,
        patches: Vec<WindowState>,
        presentation: WindowPresentation,
    }

    struct Win<'a> {
        rect: &'a mut Rect,
        top: &'a mut bool,
        fullscreen: &'a mut bool,
    }

    impl WindowOps for Win<'_> {
        fn is_destroyed(&self) -> bool {
            false
        }
        fn is_visible(&self) -> bool {
            false
        }
        fn is_maximized(&self) -> bool {
            false
        }
        fn is_full_screen(&self) -> bool {
            *self.fullscreen
        }
        fn normal_bounds(&self) -> Rect {
            *self.rect
        }
        fn work_areas(&self) -> Vec<Rect> {
            vec![Rect {
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            }]
        }
        fn set_minimum_size(&mut self, _: f64, _: f64) {}
        fn set_bounds(&mut self, bounds: &InitialBounds) {
            self.rect.x = bounds.x.unwrap_or(self.rect.x);
            self.rect.y = bounds.y.unwrap_or(self.rect.y);
            self.rect.width = bounds.width;
            self.rect.height = bounds.height;
        }
        fn set_always_on_top(&mut self, enabled: bool) {
            *self.top = enabled;
        }
        fn unmaximize(&mut self) {}
        fn maximize(&mut self) {
            panic!("Must not show/maximize a hidden window");
        }
        fn leave_fullscreen(&mut self) -> bool {
            !*self.fullscreen
        }
    }

    impl Fixture {
        fn new(saved: WindowState, headless: bool) -> Self {
            Fixture {
                rect: Rect {
                    x: 30.0,
                    y: 40.0,
                    width: 1100.0,
                    height: 720.0,
                },
                top: false,
                fullscreen: false,
                patches: Vec::new(),
                presentation: WindowPresentation::new(saved, headless),
            }
        }

        fn run(
            &mut self,
            f: impl FnOnce(&mut WindowPresentation, &mut dyn WindowOps) -> PresentationEffects,
        ) {
            let mut win = Win {
                rect: &mut self.rect,
                top: &mut self.top,
                fullscreen: &mut self.fullscreen,
            };
            let effects = f(&mut self.presentation, &mut win);
            if let Some(save) = effects.save {
                self.patches.push(save);
            }
        }

        fn signed_in(&mut self, on: bool) {
            self.run(|p, w| p.set_signed_in(w, on));
        }
        fn mode(&mut self, mode: DesktopWindowMode) {
            self.run(|p, w| p.set_mode(w, mode));
        }
        fn pin(&mut self, on: bool) {
            self.run(|p, w| p.set_always_on_top(w, on));
        }
        fn remember(&mut self) {
            self.run(|p, w| p.remember(w));
        }
    }

    use DesktopWindowMode::{Compact, Full};

    #[test]
    fn keeps_both_normal_bounds_while_switching_without_showing_a_window() {
        let mut f = Fixture::new(WindowState::default(), false);
        f.signed_in(true);
        let full = f.rect;
        f.mode(Compact);
        assert_eq!(f.rect.width, 380.0);
        let compact = Rect {
            x: 110.0,
            y: 120.0,
            width: 400.0,
            height: 580.0,
        };
        f.rect = compact;
        f.remember();
        f.mode(Full);
        assert_eq!(f.rect, full);
        f.mode(Compact);
        assert_eq!(f.rect, compact);
    }

    #[test]
    fn restores_compact_preference_only_after_sign_in_and_leaves_auth_screens_unpinned() {
        let mut f = Fixture::new(
            WindowState {
                mode: Some(Compact),
                always_on_top: Some(true),
                ..Default::default()
            },
            false,
        );
        assert_eq!(f.presentation.snapshot().mode, Full);
        f.signed_in(true);
        assert_eq!(f.presentation.snapshot().mode, Compact);
        assert!(f.top);
        f.signed_in(false);
        assert_eq!(f.presentation.snapshot().mode, Full);
        assert!(!f.top);
        assert_eq!(
            f.patches.last().unwrap().mode,
            Some(Compact),
            "sign-out must preserve the person's preferred mode"
        );
        f.signed_in(true);
        assert_eq!(f.presentation.snapshot().mode, Compact);
    }

    #[test]
    fn pinning_is_off_initially_applies_only_in_compact_mode_and_can_be_cleared() {
        let mut f = Fixture::new(WindowState::default(), false);
        f.signed_in(true);
        assert!(!f.top);
        f.pin(true);
        assert!(!f.top);
        f.mode(Compact);
        assert!(f.top);
        f.pin(false);
        assert!(!f.top);
    }

    #[test]
    fn headless_records_preferences_without_pinning_a_real_window() {
        let mut f = Fixture::new(
            WindowState {
                mode: Some(Compact),
                always_on_top: Some(true),
                ..Default::default()
            },
            true,
        );
        f.signed_in(true);
        assert!(f.presentation.snapshot().always_on_top);
        assert!(!f.top);
    }

    #[test]
    fn does_not_restore_compact_coordinates_on_a_disconnected_display() {
        let mut f = Fixture::new(
            WindowState {
                mode: Some(Compact),
                compact_bounds: Some(Rect {
                    x: 5000.0,
                    y: 200.0,
                    width: 390.0,
                    height: 550.0,
                }),
                ..Default::default()
            },
            false,
        );
        f.signed_in(true);
        assert_eq!(f.rect.x, 30.0);
        assert_eq!(f.rect.width, 390.0);
    }

    #[test]
    fn serializes_competing_changes_and_lets_sign_out_win() {
        let mut f = Fixture::new(WindowState::default(), false);
        f.signed_in(true);
        f.mode(Compact);
        f.pin(true);
        f.signed_in(false);
        assert_eq!(f.presentation.snapshot().mode, Full);
        assert!(!f.top);
    }

    #[test]
    fn waits_for_fullscreen_to_end_and_uses_the_latest_preferences() {
        let mut f = Fixture::new(WindowState::default(), false);
        f.signed_in(true);
        f.fullscreen = true;
        f.mode(Compact);
        assert_eq!(
            f.presentation.snapshot().mode,
            Full,
            "nothing switches inside fullscreen"
        );
        assert!(f.presentation.is_switching());
        // Signed out while the OS animates out of fullscreen: the switch is dropped.
        f.signed_in(false);
        f.fullscreen = false;
        let mut changed = None;
        f.run(|p, w| {
            let effects = p.fullscreen_left(w);
            changed = effects.changed;
            effects
        });
        assert_eq!(
            changed,
            Some(DesktopWindowSnapshot {
                mode: Full,
                always_on_top: false
            })
        );
        assert_eq!(f.rect.width, 1100.0, "the window kept its full bounds");
        assert!(!f.presentation.is_switching());
        assert_eq!(
            f.presentation.saved().mode,
            Some(Compact),
            "the preference stays"
        );
    }

    #[test]
    fn announces_every_settled_change() {
        let mut f = Fixture::new(WindowState::default(), false);
        let mut changed = None;
        f.run(|p, w| {
            let effects = p.set_signed_in(w, true);
            changed = effects.changed;
            effects
        });
        assert_eq!(
            changed,
            Some(DesktopWindowSnapshot {
                mode: Full,
                always_on_top: false
            })
        );
        let mut repeat = Some(DesktopWindowSnapshot {
            mode: Compact,
            always_on_top: true,
        });
        f.run(|p, w| {
            let effects = p.set_signed_in(w, true);
            repeat = effects.changed;
            effects
        });
        assert_eq!(repeat, None, "no change, no announcement");
    }

    #[test]
    fn launches_hidden_in_headless_and_maximizes_only_when_shown() {
        let saved = WindowState {
            mode: Some(Full),
            bounds: Some(Rect {
                x: 10.0,
                y: 10.0,
                width: 900.0,
                height: 600.0,
            }),
            maximized: Some(true),
            fullscreen: Some(true),
            ..Default::default()
        };
        let areas = [Rect {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        }];
        let headless = window_launch(&saved, &areas, true, true);
        assert!(!headless.show_when_ready && !headless.maximize_when_ready && !headless.fullscreen);
        let shown = window_launch(&saved, &areas, false, true);
        assert!(shown.show_when_ready && shown.maximize_when_ready && shown.fullscreen);
        assert_eq!(shown.bounds.x, Some(10.0));
        let tray = window_launch(&saved, &areas, false, false);
        assert!(!tray.show_when_ready && !tray.maximize_when_ready);
        let compact = window_launch(
            &WindowState {
                mode: Some(Compact),
                ..saved
            },
            &areas,
            false,
            true,
        );
        assert!(!compact.fullscreen);
    }
}
