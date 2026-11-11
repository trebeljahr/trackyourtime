//! `globalThis.__trackYourTimeDesktop.activity`, headless runs only
//! (`test-hook.ts`).
//!
//! Playwright drives capture through this: what is in front (the fake
//! source), what time it is, when a detection or a heartbeat happens, and
//! whether the person is idle — so a spec is deterministic and nothing about
//! the machine it runs on (its frontmost app, its owner's typing) can reach it.
//!
//! [`ActivityTestHook::call`] is the JSON surface the shell exposes:
//! `method` is the hook's method name and `args` its arguments, either the
//! one argument as is or a positional array (`idle` takes
//! `["idle", 120]` or `{"state": "idle", "idleSeconds": 120}`).

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tyt_wire::DesktopActivitySupport;

use crate::keys::FrontmostTarget;
use crate::model::PresenceState;
use crate::platform_source::Spawns;
use crate::service::ActivityService;
use crate::source_fake::FakeFrontmostSource;
use crate::store::StoreFiles;
use crate::timers::epoch_ms;

/// Where the hook reaches the current service, and how it waits for the
/// source answers it caused to be handled.
pub trait HookHost {
    fn with_service<R>(&self, f: impl FnOnce(&mut ActivityService) -> R) -> R;
    /// Every source event delivered so far has been handled.
    fn settle(&self);
}

/// The clock capture reads: pinned by `setNow`, else the real one.
#[derive(Default)]
pub struct HookClock {
    pinned: Mutex<Option<f64>>,
}

impl HookClock {
    pub fn now(&self) -> f64 {
        self.pinned.lock().expect("clock").unwrap_or_else(epoch_ms)
    }
    pub fn set(&self, epoch_ms: Option<f64>) {
        *self.pinned.lock().expect("clock") = epoch_ms;
    }
}

pub struct ActivityTestHook<H: HookHost> {
    pub host: H,
    pub fake: Arc<FakeFrontmostSource>,
    pub spawns: Spawns,
    pub clock: Arc<HookClock>,
}

fn target_from(value: &Value) -> Result<Option<FrontmostTarget>, String> {
    if value.is_null() {
        return Ok(None);
    }
    let record = value
        .as_object()
        .ok_or("setFrontmost takes a target or null")?;
    let text = |name: &str| record.get(name).and_then(Value::as_str).map(str::to_string);
    Ok(Some(FrontmostTarget {
        key: text("key").ok_or("setFrontmost: key must be a string")?,
        name: text("name").ok_or("setFrontmost: name must be a string")?,
        title: text("title"),
        pid: None,
    }))
}

impl<H: HookHost> ActivityTestHook<H> {
    pub fn set_frontmost(&self, target: Option<FrontmostTarget>) {
        self.fake.set_frontmost(target);
    }

    /// Pin the clock capture reads; None goes back to the real one.
    pub fn set_now(&self, epoch_ms: Option<f64>) {
        self.clock.set(epoch_ms);
    }

    /// One detection at the current (fake) time, settled.
    pub fn tick(&self) {
        self.host.settle();
        self.fake.emit();
        self.host.settle();
    }

    pub fn heartbeat(&self) -> Result<(), String> {
        self.host.with_service(|s| s.heartbeat())
    }

    pub fn idle(&self, state: PresenceState, idle_seconds: Option<f64>) -> Result<(), String> {
        let seconds = idle_seconds.unwrap_or(if state == PresenceState::Idle {
            120.0
        } else {
            0.0
        });
        self.host.with_service(|s| s.presence(state, seconds))
    }

    /// Simulate a channel or session without capture (store, Wayland…); None restores it.
    pub fn set_support(&self, support: Option<DesktopActivitySupport>) -> Result<(), String> {
        self.host.with_service(|s| s.set_support_override(support))
    }

    pub fn set_titles_available(&self, on: bool) {
        self.host.with_service(|s| s.set_titles_available(on));
    }

    pub fn source_kind(&self) -> Option<&'static str> {
        self.host
            .with_service(|s| s.source_kind().map(|k| k.as_str()))
    }

    /// Whether the fake source is running, i.e. capture is actually on.
    pub fn capturing(&self) -> bool {
        self.fake.running()
    }

    /// Every child process capture attempted. Headless, this stays empty.
    pub fn spawns(&self) -> Vec<String> {
        self.spawns.lock().expect("spawns").clone()
    }

    pub fn files(&self) -> StoreFiles {
        self.host.with_service(|s| s.files())
    }

    /// The hook by name, arguments and result as JSON.
    pub fn call(&self, method: &str, args: Value) -> Result<Value, String> {
        let positional: Vec<Value> = match args {
            Value::Array(items) => items,
            Value::Null => Vec::new(),
            other => vec![other],
        };
        let arg = |index: usize| positional.get(index).cloned().unwrap_or(Value::Null);
        match method {
            "setFrontmost" => {
                self.set_frontmost(target_from(&arg(0))?);
                Ok(Value::Null)
            }
            "setNow" => {
                let value = arg(0);
                if !value.is_null() && value.as_f64().is_none() {
                    return Err("setNow takes epoch ms or null".into());
                }
                self.set_now(value.as_f64());
                Ok(Value::Null)
            }
            "tick" => {
                self.tick();
                Ok(Value::Null)
            }
            "heartbeat" => self.heartbeat().map(|_| Value::Null),
            "idle" => {
                let (state, seconds) = match arg(0) {
                    Value::Object(record) => (
                        record
                            .get("state")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        record.get("idleSeconds").and_then(Value::as_f64),
                    ),
                    Value::String(state) => (Some(state), arg(1).as_f64()),
                    _ => (None, None),
                };
                let state = state.ok_or("idle takes a state")?;
                self.idle(PresenceState::parse(&state), seconds)
                    .map(|_| Value::Null)
            }
            "setSupport" => {
                let value = arg(0);
                let support = if value.is_null() {
                    None
                } else {
                    Some(serde_json::from_value(value).map_err(|e| format!("setSupport: {e}"))?)
                };
                self.set_support(support).map(|_| Value::Null)
            }
            "setTitlesAvailable" => {
                let on = arg(0)
                    .as_bool()
                    .ok_or("setTitlesAvailable takes a boolean")?;
                self.set_titles_available(on);
                Ok(Value::Null)
            }
            "sourceKind" => Ok(self.source_kind().map_or(Value::Null, Value::from)),
            "capturing" => Ok(Value::Bool(self.capturing())),
            "spawns" => Ok(json!(self.spawns())),
            "files" => {
                let files = self.files();
                Ok(json!({ "state": files.state, "open": files.open, "segments": files.segments }))
            }
            other => Err(format!("Unknown activity test hook method: {other}")),
        }
    }
}
