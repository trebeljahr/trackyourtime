//! Desktop activity capture and Autopilot for Track Your Time, without Tauri.
//!
//! A port of `electron/src/activity/**` and `packages/core/src/activity/**`.
//! The shell talks to one type, [`ActivityController`]: it answers every
//! `activity:*` bridge channel, takes idle samples, and pushes
//! `activity:changed` through an [`ActivityHost`]. `PORTING.md` maps every
//! TypeScript file to its module here.

// `!(a > b)` is the TypeScript's own spelling, and it is NaN-aware on
// purpose: a NaN that reaches a comparison must take the same branch it
// takes in JavaScript, which `a <= b` would not.
#![allow(clippy::neg_cmp_op_on_partial_ord)]

pub mod core;
pub mod js;

pub mod autopilot;
pub mod distribution;
pub mod install;
pub mod ipc_parse;
pub mod keys;
pub mod macos_titles;
pub mod model;
pub mod platform_source;
pub mod process_runner;
pub mod protection;
pub mod secure_store;
pub mod service;
pub mod settings;
pub mod source;
pub mod source_fake;
pub mod source_linux;
pub mod source_macos;
pub mod source_windows;
pub mod store;
pub mod suggest;
pub mod test_hook;
pub mod timers;
pub mod vault;

#[cfg(test)]
mod install_tests;
#[cfg(test)]
mod service_tests;
#[cfg(test)]
mod sources_tests;
#[cfg(test)]
mod vault_tests;

pub use install::{ActivityController, ActivityHost, ActivityOptions, CHANGED_THROTTLE_MS};
