//! `packages/core/src/activity`, in Rust.
//!
//! The TypeScript stays in use by the browser extension, so this copy must
//! give identical results: `fixtures/generate.mts` runs the TypeScript over a
//! fixed set of cases and `tests/conformance.rs` replays every one here.

pub mod autopilot;
pub mod rules;
pub mod segments;
pub mod suggest;
pub mod types;

pub use autopilot::*;
pub use rules::*;
pub use segments::*;
pub use suggest::*;
pub use types::*;
