//! The headless source (`source-fake.ts`): answers only what a test told it,
//! only when a test asks (`tick`). No child process, no timer, and never the
//! real frontmost application of whoever is using the machine.

use std::sync::Mutex;

use crate::keys::FrontmostTarget;
use crate::source::{FrontmostSource, SourceKind, SourceListener};

#[derive(Default)]
struct FakeState {
    listener: Option<SourceListener>,
    current: Option<FrontmostTarget>,
    titles: bool,
}

#[derive(Default)]
pub struct FakeFrontmostSource {
    state: Mutex<FakeState>,
}

impl FakeFrontmostSource {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_frontmost(&self, target: Option<FrontmostTarget>) {
        self.state.lock().expect("fake source").current = target;
    }

    /// Deliver the current answer, as one poll would. False when the source is not running.
    pub fn emit(&self) -> bool {
        let (listener, target) = {
            let state = self.state.lock().expect("fake source");
            let Some(listener) = state.listener.clone() else {
                return false;
            };
            let mut target = state.current.clone();
            // A real source reads a title only while titles are on.
            if let Some(target) = &mut target {
                if !state.titles {
                    target.title = None;
                }
            }
            (listener, target)
        };
        (listener.target)(target);
        true
    }

    pub fn running(&self) -> bool {
        self.state.lock().expect("fake source").listener.is_some()
    }

    pub fn titles(&self) -> bool {
        self.state.lock().expect("fake source").titles
    }
}

impl FrontmostSource for FakeFrontmostSource {
    fn kind(&self) -> SourceKind {
        SourceKind::Fake
    }
    fn start(&self, listener: SourceListener) {
        self.state.lock().expect("fake source").listener = Some(listener);
    }
    fn stop(&self) {
        self.state.lock().expect("fake source").listener = None;
    }
    fn set_titles(&self, on: bool) {
        self.state.lock().expect("fake source").titles = on;
    }
}
