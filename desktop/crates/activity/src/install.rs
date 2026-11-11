//! Desktop activity capture, wired for the shell (`install.ts`): the bridge
//! channels, idle samples, the one-minute heartbeat, the daily prune and the
//! throttled change push.
//!
//! **Headless** (tests, agents) builds the fake source and nothing else: no
//! platform source, no `std::process`, no heartbeat or prune timer, and idle
//! comes from the test hook rather than the shell's idle monitor, so neither
//! the real frontmost app nor the machine owner's typing can reach a spec.
//! The `create_platform_source(` call below sits in the non-headless branch
//! only, and `tests/no_spawn.rs` greps for exactly that.
//!
//! Capture is off until the person turns it on in Settings, and nothing here
//! turns it on.
//!
//! Runtime model: no async runtime. One background thread owns an mpsc
//! event loop for the timers (heartbeat, prune, the push throttle) and for
//! source answers; bridge calls run on the caller's thread. Both take the one
//! lock around the vault and its service, which is what makes every
//! operation serial.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tyt_wire::{
    channels, DesktopActivityAcceptRefusal, DesktopActivitySnapshot, DesktopAutopilotPlan,
    DesktopIdlePayload, Encryption,
};

use crate::distribution::{activity_capture_support, ActivityCaptureSupport};
use crate::ipc_parse::{
    parse_autopilot_applied, parse_autopilot_history, parse_autopilot_hold, parse_autopilot_pause,
    parse_autopilot_plan_input, parse_check_accept_input, parse_interval, parse_rule_id,
    parse_rule_input, parse_settings_patch, parse_suggestions_input, SettingsPatch,
};
use crate::js;
use crate::model::{PresenceState, HEARTBEAT_MS};
use crate::platform_source::{create_platform_source, Spawns};
use crate::process_runner::current_pid;
use crate::service::{ActivityService, ActivityServiceOptions, Deliver, SourceEvent};
use crate::source::FrontmostSource;
use crate::source_fake::FakeFrontmostSource;
use crate::store::Clock;
use crate::suggest::refused;
use crate::test_hook::{ActivityTestHook, HookClock, HookHost};
use crate::vault::ActivityVault;

/// At most one `activity:changed` push per this long.
pub const CHANGED_THROTTLE_MS: u64 = 2_000;
const PRUNE_EVERY_MS: u64 = 24 * 60 * 60_000;
/// How long a test hook call waits for the event loop before giving up.
const SETTLE_TIMEOUT: Duration = Duration::from_secs(10);

pub struct ActivityOptions {
    pub headless: bool,
    /// "darwin" | "win32" | "linux"
    pub platform: String,
    /// The distribution channel, as `distribution.ts` names it.
    pub channel: String,
    pub env: HashMap<String, String>,
    pub user_data: PathBuf,
    /// None when headless (the TypeScript passes undefined); ignored headless anyway.
    pub encryption: Option<Arc<dyn Encryption>>,
    /// The macOS Screen Recording grant. The shell provides it.
    pub titles_permitted: Arc<dyn Fn() -> bool + Send + Sync>,
    pub parent_pid: u32,
}

pub trait ActivityHost: Send + Sync + 'static {
    /// Push `activity:changed` to the renderer. The controller throttles
    /// ([`CHANGED_THROTTLE_MS`]) before calling.
    fn changed(&self, snapshot: &DesktopActivitySnapshot);
}

enum Event {
    Source(SourceEvent),
    Changed,
    Barrier(Sender<()>),
    Stop,
}

struct Inner {
    vault: Mutex<ActivityVault>,
    events: Mutex<Sender<Event>>,
    headless: bool,
    platform: String,
    titles_permitted: Arc<dyn Fn() -> bool + Send + Sync>,
    fake: Option<Arc<FakeFrontmostSource>>,
    spawns: Spawns,
    clock: Arc<HookClock>,
    disposed: AtomicBool,
}

impl Inner {
    fn vault(&self) -> MutexGuard<'_, ActivityVault> {
        self.vault
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn send(&self, event: Event) -> bool {
        self.events
            .lock()
            .map(|tx| tx.send(event).is_ok())
            .unwrap_or(false)
    }
}

pub struct ActivityController {
    inner: Arc<Inner>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

fn to_json<T: Serialize>(value: &T) -> Value {
    let mut value = serde_json::to_value(value).expect("bridge values serialize");
    js::normalize_numbers(&mut value);
    value
}

fn warn(context: &str, error: &str) {
    eprintln!("[activity] {context}: {error}");
}

impl ActivityController {
    pub fn install(options: ActivityOptions, host: Arc<dyn ActivityHost>) -> Self {
        let support = activity_capture_support(&options.channel, &options.platform, &options.env);
        let spawns: Spawns = Arc::default();
        let clock = Arc::new(HookClock::default());
        let (tx, rx) = mpsc::channel::<Event>();

        let fake = options
            .headless
            .then(|| Arc::new(FakeFrontmostSource::new()));
        let mut source: Option<Arc<dyn FrontmostSource>> =
            fake.clone().map(|fake| fake as Arc<dyn FrontmostSource>);
        if !options.headless {
            if let ActivityCaptureSupport::Supported(mechanism) = support {
                source = Some(create_platform_source(
                    mechanism,
                    &options.env,
                    options.parent_pid,
                    spawns.clone(),
                    options.titles_permitted.clone(),
                ));
            }
        }

        let now: Clock = {
            let clock = clock.clone();
            Arc::new(move || clock.now())
        };
        let deliver: Deliver = {
            let tx = Mutex::new(tx.clone());
            Arc::new(move |event| {
                if let Ok(tx) = tx.lock() {
                    let _ = tx.send(Event::Source(event));
                }
            })
        };
        let changed: Arc<dyn Fn() + Send + Sync> = {
            let tx = Mutex::new(tx.clone());
            Arc::new(move || {
                if let Ok(tx) = tx.lock() {
                    let _ = tx.send(Event::Changed);
                }
            })
        };
        let make_service = {
            let (user_data, now, changed) =
                (options.user_data.clone(), now.clone(), changed.clone());
            Box::new(move |codec, protection_status| {
                ActivityService::new(ActivityServiceOptions {
                    user_data: user_data.clone(),
                    codec,
                    protection_status: Some(protection_status),
                    support,
                    titles_available: true,
                    source: source.clone(),
                    self_pid: current_pid() as i64,
                    now: now.clone(),
                    on_changed: changed.clone(),
                    deliver: deliver.clone(),
                })
            })
        };
        // Never hand an OS credential store to a headless run.
        let encryption = if options.headless {
            None
        } else {
            options.encryption
        };
        let vault = ActivityVault::new(&options.user_data, now, encryption, make_service, changed);

        let inner = Arc::new(Inner {
            vault: Mutex::new(vault),
            events: Mutex::new(tx),
            headless: options.headless,
            platform: options.platform,
            titles_permitted: options.titles_permitted,
            fake,
            spawns,
            clock,
            disposed: AtomicBool::new(false),
        });
        let looped = inner.clone();
        let thread = thread::Builder::new()
            .name("tyt-activity".into())
            .spawn(move || run_loop(looped, rx, host))
            .expect("the activity thread starts");
        ActivityController {
            inner,
            thread: Mutex::new(Some(thread)),
        }
    }

    /// True for every `activity:*` channel this controller answers.
    pub fn handles(channel: &str) -> bool {
        channel != channels::ACTIVITY_CHANGED
            && channel.starts_with("activity:")
            && channels::ALL.contains(&channel)
    }

    /// One bridge call, with the arguments exactly as the renderer passed them.
    pub fn call(&self, channel: &str, args: Vec<Value>) -> Result<Value, String> {
        let input = args.into_iter().next().unwrap_or(Value::Null);
        let mut vault = self.inner.vault();
        let result = match channel {
            channels::ACTIVITY_PROTECT => vault.protect(&input).map(|s| to_json(&s)),
            channels::ACTIVITY_LOCK => vault.lock().map(|s| to_json(&s)),
            channels::ACTIVITY_SNAPSHOT => Ok(to_json(&vault.service.snapshot())),
            channels::ACTIVITY_SETTINGS => {
                let parsed = parse_settings_patch(&input);
                match parsed {
                    Some(patch)
                        if !self.inner.headless
                            && self.inner.platform == "darwin"
                            && patch.store_titles == Some(true)
                            && !(self.inner.titles_permitted)() =>
                    {
                        // Only a deliberate toggle may lead to the OS
                        // permission request, which the shell makes; until it
                        // is granted, titles stay off and the page says why.
                        let patch = SettingsPatch {
                            store_titles: Some(false),
                            ..patch
                        };
                        vault.service.update_settings(&patch).map(|mut snapshot| {
                            snapshot.titles_permission_required = Some(true);
                            to_json(&snapshot)
                        })
                    }
                    Some(patch) => vault.service.update_settings(&patch).map(|s| to_json(&s)),
                    None => Ok(to_json(&vault.service.snapshot())),
                }
            }
            channels::ACTIVITY_SCOPE => vault.set_scope(&input).map(|_| Value::Null),
            channels::ACTIVITY_FORGET => vault.forget().map(|_| Value::Null),
            channels::ACTIVITY_WIPE => vault.wipe_locked().map(|s| to_json(&s)),
            channels::ACTIVITY_SUGGESTIONS => Ok(match parse_suggestions_input(&input) {
                None => Value::Null,
                Some(parsed) => to_json(&vault.service.suggestions(&parsed)),
            }),
            channels::ACTIVITY_CHECK_ACCEPT => Ok(match parse_check_accept_input(&input) {
                None => to_json(&refused(DesktopActivityAcceptRefusal::BadRange)),
                Some(parsed) => to_json(&vault.service.check_accept(&parsed)),
            }),
            channels::ACTIVITY_ACCEPTED => {
                if let Some(span) = parse_interval(&input) {
                    vault.service.mark_accepted(span);
                }
                Ok(Value::Null)
            }
            channels::ACTIVITY_DISMISS => match parse_interval(&input) {
                None => Ok(Value::Bool(false)),
                Some(span) => vault.service.dismiss(span).map(Value::Bool),
            },
            channels::ACTIVITY_RULE_ADD => match parse_rule_input(&input) {
                None => Ok(to_json(&vault.service.rules())),
                Some(rule) => vault.service.add_rule(&rule).map(|r| to_json(&r)),
            },
            channels::ACTIVITY_RULE_REMOVE => match parse_rule_id(&input) {
                None => Ok(to_json(&vault.service.rules())),
                Some(id) => vault.service.remove_rule(&id).map(|r| to_json(&r)),
            },
            channels::ACTIVITY_AUTOPILOT_LEARN => {
                if let Some(history) = parse_autopilot_history(&input) {
                    vault.service.autopilot_learn(&history);
                }
                Ok(Value::Null)
            }
            channels::ACTIVITY_AUTOPILOT_PLAN => match parse_autopilot_plan_input(&input) {
                None => Ok(to_json(&DesktopAutopilotPlan::None)),
                Some(parsed) => vault.service.autopilot_plan(&parsed).map(|p| to_json(&p)),
            },
            channels::ACTIVITY_AUTOPILOT_APPLIED => match parse_autopilot_applied(&input) {
                None => Ok(Value::Null),
                Some(result) => vault
                    .service
                    .autopilot_applied(&result)
                    .map(|_| Value::Null),
            },
            channels::ACTIVITY_AUTOPILOT_HOLD => match parse_autopilot_hold(&input) {
                None => Ok(Value::Null),
                Some(hold) => vault.service.autopilot_hold(&hold).map(|_| Value::Null),
            },
            channels::ACTIVITY_AUTOPILOT_PAUSE => match parse_autopilot_pause(&input) {
                None => Ok(Value::Null),
                Some(paused) => vault.service.autopilot_pause(paused).map(|_| Value::Null),
            },
            other => Err(format!("Unknown activity channel: {other}")),
        };
        if let Err(error) = &result {
            warn(channel, error);
        }
        result
    }

    /// Every idle sample from the shell's idle monitor. Ignored headless,
    /// where idle comes from the test hook.
    pub fn idle(&self, sample: &DesktopIdlePayload) {
        if self.inner.headless || self.inner.disposed.load(Ordering::SeqCst) {
            return;
        }
        let state = PresenceState::parse(&sample.state);
        if let Err(error) = self
            .inner
            .vault()
            .service
            .presence(state, sample.idle_seconds as f64)
        {
            warn("presence", &error);
        }
    }

    /// The tray's "Pause Autopilot for an hour" and "Resume Autopilot".
    pub fn pause_autopilot(&self, paused: bool) {
        if let Err(error) = self.inner.vault().service.autopilot_pause(paused) {
            warn("autopilot pause", &error);
        }
    }

    /// Headless only: the test hook's methods by name, as JSON.
    pub fn test_call(&self, method: &str, args: Value) -> Result<Value, String> {
        let Some(fake) = self.inner.fake.clone().filter(|_| self.inner.headless) else {
            return Err("The activity test hook exists only in headless runs".into());
        };
        let hook = ActivityTestHook {
            host: ControllerHost {
                inner: self.inner.clone(),
            },
            fake,
            spawns: self.inner.spawns.clone(),
            clock: self.inner.clock.clone(),
        };
        hook.call(method, args)
    }

    /// On quit: persist the open segment, stop the source and the timers. Idempotent.
    pub fn dispose(&self) {
        if self.inner.disposed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.inner.vault().dispose();
        self.inner.send(Event::Stop);
        let thread = self.thread.lock().ok().and_then(|mut slot| slot.take());
        if let Some(thread) = thread {
            if thread.thread().id() != thread::current().id() {
                let _ = thread.join();
            }
        }
    }
}

impl Drop for ActivityController {
    fn drop(&mut self) {
        self.dispose();
    }
}

struct ControllerHost {
    inner: Arc<Inner>,
}

impl HookHost for ControllerHost {
    fn with_service<R>(&self, f: impl FnOnce(&mut ActivityService) -> R) -> R {
        f(&mut self.inner.vault().service)
    }

    fn settle(&self) {
        let (ack, done) = mpsc::channel();
        if self.inner.send(Event::Barrier(ack)) {
            let _ = done.recv_timeout(SETTLE_TIMEOUT);
        }
    }
}

fn push(inner: &Inner, host: &dyn ActivityHost) {
    let snapshot = inner.vault().service.snapshot();
    host.changed(&snapshot);
}

fn run_loop(inner: Arc<Inner>, rx: mpsc::Receiver<Event>, host: Arc<dyn ActivityHost>) {
    let heartbeat = Duration::from_millis(HEARTBEAT_MS);
    let prune = Duration::from_millis(PRUNE_EVERY_MS);
    let throttle = Duration::from_millis(CHANGED_THROTTLE_MS);
    // Timers and idle: never headless.
    let mut heartbeat_at = (!inner.headless).then(|| Instant::now() + heartbeat);
    let mut prune_at = (!inner.headless).then(|| Instant::now() + prune);
    let mut push_until: Option<Instant> = None;
    let mut dirty = false;
    loop {
        let next = [heartbeat_at, prune_at, push_until]
            .into_iter()
            .flatten()
            .min();
        let event = match next {
            Some(at) => match rx.recv_timeout(at.saturating_duration_since(Instant::now())) {
                Ok(event) => Some(event),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            },
            None => match rx.recv() {
                Ok(event) => Some(event),
                Err(_) => return,
            },
        };
        match event {
            Some(Event::Stop) => return,
            Some(Event::Source(event)) => {
                if let Err(error) = inner.vault().service.source_event(event) {
                    warn("source event", &error);
                }
            }
            Some(Event::Changed) => {
                if push_until.is_some() {
                    dirty = true;
                } else {
                    push(&inner, &*host);
                    push_until = Some(Instant::now() + throttle);
                }
            }
            Some(Event::Barrier(ack)) => {
                let _ = ack.send(());
            }
            None => {}
        }
        let now = Instant::now();
        if heartbeat_at.is_some_and(|at| at <= now) {
            heartbeat_at = Some(now + heartbeat);
            if let Err(error) = inner.vault().service.heartbeat() {
                warn("heartbeat", &error);
            }
        }
        if prune_at.is_some_and(|at| at <= now) {
            prune_at = Some(now + prune);
            if let Err(error) = inner.vault().service.prune() {
                warn("prune", &error);
            }
        }
        if push_until.is_some_and(|at| at <= now) {
            push_until = None;
            if dirty {
                dirty = false;
                push(&inner, &*host);
                push_until = Some(Instant::now() + throttle);
            }
        }
    }
}
