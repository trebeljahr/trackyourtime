//! Global shortcuts: register the bindings from Settings → Desktop, report
//! what did not register, and step aside while Settings records a new key.
//! Ported from `electron/src/shortcuts.ts`.
//!
//! The manager takes the registrar as an argument on every call, so every
//! rule is unit-tested without the OS: the shell's registrar is
//! `tauri-plugin-global-shortcut` (fed [`crate::accelerator::tauri_accelerator`]),
//! headless runs pass [`MemoryRegistrar`] (nothing is registered with the OS
//! while tests run on somebody's machine) whose "taken" chords a spec can set.
//!
//! A registration the OS refuses because another application holds the chord
//! comes back as `Ok(false)`; one the registrar cannot parse as `Err`. Both
//! end up in the status list Settings shows; neither is swallowed.

use tyt_wire::{
    DesktopShortcutAction, DesktopShortcutBindings, DesktopShortcutProblem, DesktopShortcutStatus,
};

/// Where accelerators are registered. Accelerators are canonical
/// (`CommandOrControl+Alt+Shift+Space`); the action travels with them so the
/// shell can run it when the OS reports the chord (TypeScript passed a
/// callback instead).
pub trait ShortcutRegistrar {
    /// `Ok(true)` registered, `Ok(false)` held by someone else, `Err` when the
    /// accelerator cannot be registered at all (reported as `invalid`).
    fn register(
        &mut self,
        accelerator: &str,
        action: DesktopShortcutAction,
    ) -> Result<bool, String>;
    fn unregister(&mut self, accelerator: &str);
}

#[derive(Debug, Default)]
pub struct ShortcutManager {
    bindings: Option<DesktopShortcutBindings>,
    suspended: bool,
    /// Accelerators this manager registered, so it never unregisters somebody else's.
    held: Vec<String>,
    current: Vec<DesktopShortcutStatus>,
}

impl ShortcutManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn release(&mut self, registrar: &mut dyn ShortcutRegistrar) {
        for accelerator in self.held.drain(..) {
            registrar.unregister(&accelerator);
        }
    }

    fn register_all(
        &mut self,
        registrar: &mut dyn ShortcutRegistrar,
    ) -> Vec<DesktopShortcutStatus> {
        self.release(registrar);
        let Some(bindings) = self.bindings.clone() else {
            return Vec::new();
        };
        let mut statuses = Vec::new();
        for action in DesktopShortcutAction::ALL {
            let Some(accelerator) = bindings.get(action) else {
                statuses.push(status(action, None, false, None));
                continue;
            };
            if self.suspended {
                statuses.push(status(action, Some(accelerator), false, None));
                continue;
            }
            let (registered, problem) = match registrar.register(accelerator, action) {
                Ok(true) => (true, None),
                Ok(false) => (false, Some(DesktopShortcutProblem::Taken)),
                Err(_) => (false, Some(DesktopShortcutProblem::Invalid)),
            };
            if registered && !self.held.iter().any(|held| held == accelerator) {
                self.held.push(accelerator.to_string());
            }
            statuses.push(status(action, Some(accelerator), registered, problem));
        }
        statuses
    }

    /// Replace every registration with `bindings`; returns the new statuses.
    pub fn apply(
        &mut self,
        registrar: &mut dyn ShortcutRegistrar,
        bindings: &DesktopShortcutBindings,
    ) -> Vec<DesktopShortcutStatus> {
        self.bindings = Some(bindings.clone());
        self.current = self.register_all(registrar);
        self.current.clone()
    }

    /// Unregister everything until `resume`, keeping the bindings.
    pub fn suspend(&mut self, registrar: &mut dyn ShortcutRegistrar) {
        self.suspended = true;
        self.current = self.register_all(registrar);
    }

    pub fn resume(&mut self, registrar: &mut dyn ShortcutRegistrar) -> Vec<DesktopShortcutStatus> {
        self.suspended = false;
        self.current = self.register_all(registrar);
        self.current.clone()
    }

    pub fn is_suspended(&self) -> bool {
        self.suspended
    }

    pub fn statuses(&self) -> &[DesktopShortcutStatus] {
        &self.current
    }

    /// Unregister everything (quit).
    pub fn dispose(&mut self, registrar: &mut dyn ShortcutRegistrar) {
        self.release(registrar);
        self.bindings = None;
        self.current = Vec::new();
    }
}

fn status(
    action: DesktopShortcutAction,
    accelerator: Option<&str>,
    registered: bool,
    problem: Option<DesktopShortcutProblem>,
) -> DesktopShortcutStatus {
    DesktopShortcutStatus {
        action,
        accelerator: accelerator.map(str::to_string),
        registered,
        problem,
        conflicts_with: None,
    }
}

/// The registrar headless runs use: nothing reaches the OS. `taken` stands in
/// for chords another application holds, so a spec can see a failure surface.
#[derive(Debug, Default, Clone)]
pub struct MemoryRegistrar {
    pub taken: Vec<String>,
    /// In registration order, as the hook's `registered()` lists them.
    pub registered: Vec<(String, DesktopShortcutAction)>,
}

impl MemoryRegistrar {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn take(&mut self, accelerator: &str) {
        if !self.taken.iter().any(|taken| taken == accelerator) {
            self.taken.push(accelerator.to_string());
        }
    }

    pub fn accelerators(&self) -> Vec<String> {
        self.registered
            .iter()
            .map(|(accelerator, _)| accelerator.clone())
            .collect()
    }

    /// What pressing a registered chord would run.
    pub fn fire(&self, accelerator: &str) -> Option<DesktopShortcutAction> {
        self.registered
            .iter()
            .find(|(held, _)| held == accelerator)
            .map(|(_, action)| *action)
    }
}

impl ShortcutRegistrar for MemoryRegistrar {
    fn register(
        &mut self,
        accelerator: &str,
        action: DesktopShortcutAction,
    ) -> Result<bool, String> {
        if self.taken.iter().any(|taken| taken == accelerator) || self.fire(accelerator).is_some() {
            return Ok(false);
        }
        self.registered.push((accelerator.to_string(), action));
        Ok(true)
    }

    fn unregister(&mut self, accelerator: &str) {
        self.registered.retain(|(held, _)| held != accelerator);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bindings_with(
        action: DesktopShortcutAction,
        accelerator: Option<&str>,
    ) -> DesktopShortcutBindings {
        let mut bindings = DesktopShortcutBindings::defaults();
        bindings.set(action, accelerator.map(str::to_string));
        bindings
    }

    #[test]
    fn registers_bound_actions_and_runs_the_right_one() {
        let mut registrar = MemoryRegistrar::new();
        let mut manager = ShortcutManager::new();
        let statuses = manager.apply(
            &mut registrar,
            &bindings_with(DesktopShortcutAction::OpenPalette, Some("Control+Alt+K")),
        );
        assert_eq!(
            statuses
                .iter()
                .map(|s| (s.action.as_str(), s.registered, s.problem))
                .collect::<Vec<_>>(),
            [
                ("toggle-timer", true, None),
                ("new-timer", false, None),
                ("toggle-window", false, None),
                ("open-palette", true, None)
            ]
        );
        let fired: Vec<_> = ["Control+Alt+K", "CommandOrControl+Alt+Shift+Space"]
            .into_iter()
            .filter_map(|accelerator| registrar.fire(accelerator))
            .collect();
        assert_eq!(
            fired,
            [
                DesktopShortcutAction::OpenPalette,
                DesktopShortcutAction::ToggleTimer
            ]
        );
    }

    #[test]
    fn reports_a_chord_somebody_else_holds_as_taken_not_registered() {
        let mut registrar = MemoryRegistrar::new();
        registrar.take("CommandOrControl+Alt+Shift+Space");
        let mut manager = ShortcutManager::new();
        let toggle = manager.apply(&mut registrar, &DesktopShortcutBindings::defaults())[0].clone();
        assert!(!toggle.registered);
        assert_eq!(toggle.problem, Some(DesktopShortcutProblem::Taken));
    }

    #[test]
    fn reports_a_failing_registration_as_invalid() {
        struct Throwing;
        impl ShortcutRegistrar for Throwing {
            fn register(&mut self, _: &str, _: DesktopShortcutAction) -> Result<bool, String> {
                Err("conversion failure".into())
            }
            fn unregister(&mut self, _: &str) {}
        }
        let mut manager = ShortcutManager::new();
        assert_eq!(
            manager.apply(&mut Throwing, &DesktopShortcutBindings::defaults())[0].problem,
            Some(DesktopShortcutProblem::Invalid)
        );
    }

    #[test]
    fn re_registers_on_change_and_releases_what_it_no_longer_binds() {
        let mut registrar = MemoryRegistrar::new();
        let mut manager = ShortcutManager::new();
        manager.apply(&mut registrar, &DesktopShortcutBindings::defaults());
        manager.apply(
            &mut registrar,
            &bindings_with(DesktopShortcutAction::ToggleTimer, Some("Control+Alt+T")),
        );
        assert_eq!(registrar.accelerators(), ["Control+Alt+T"]);
    }

    #[test]
    fn suspends_everything_while_recording_and_restores_it() {
        let mut registrar = MemoryRegistrar::new();
        let mut manager = ShortcutManager::new();
        manager.apply(&mut registrar, &DesktopShortcutBindings::defaults());
        manager.suspend(&mut registrar);
        assert!(registrar.registered.is_empty());
        assert!(manager.is_suspended());
        // A change while suspended is kept and registered on resume.
        manager.apply(
            &mut registrar,
            &bindings_with(DesktopShortcutAction::NewTimer, Some("Control+Alt+N")),
        );
        assert!(registrar.registered.is_empty());
        manager.resume(&mut registrar);
        let mut held = registrar.accelerators();
        held.sort();
        assert_eq!(held, ["CommandOrControl+Alt+Shift+Space", "Control+Alt+N"]);
    }

    #[test]
    fn never_unregisters_a_chord_it_did_not_register() {
        let mut registrar = MemoryRegistrar::new();
        registrar
            .registered
            .push(("Control+Alt+X".into(), DesktopShortcutAction::ToggleWindow));
        registrar.take("Control+Alt+X");
        let mut manager = ShortcutManager::new();
        manager.apply(
            &mut registrar,
            &bindings_with(DesktopShortcutAction::NewTimer, Some("Control+Alt+X")),
        );
        manager.dispose(&mut registrar);
        assert_eq!(
            registrar.fire("Control+Alt+X"),
            Some(DesktopShortcutAction::ToggleWindow)
        );
    }
}
