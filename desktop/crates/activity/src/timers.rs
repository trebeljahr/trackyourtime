//! Timers for the platform sources (`Timers` and `realTimers` in `source.ts`).
//!
//! [`RealTimers`] runs callbacks on one background thread, created only for a
//! platform source (never headless). [`FakeTimers`] runs them when a test
//! advances its clock, so every source is tested without waiting.
//! Callbacks never run while a timer lock is held, so a callback may set and
//! clear timers freely.

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub type TimerId = u64;

pub enum TimerCallback {
    Once(Box<dyn FnOnce() + Send>),
    Every(Box<dyn FnMut() + Send>),
}

pub trait Timers: Send + Sync {
    /// Epoch ms, for the restart policy.
    fn now(&self) -> f64;
    fn set_interval(&self, ms: f64, callback: Box<dyn FnMut() + Send>) -> TimerId;
    fn set_timeout(&self, ms: f64, callback: Box<dyn FnOnce() + Send>) -> TimerId;
    /// Clears a timeout or an interval. Unknown ids are ignored.
    fn clear(&self, id: TimerId);
}

pub fn epoch_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

struct Entry<T> {
    at: T,
    every: Option<f64>,
    /// None while the callback is running on the timer thread.
    callback: Option<TimerCallback>,
}

// ── real ──────────────────────────────────────────────────────────────

struct RealState {
    next_id: TimerId,
    entries: HashMap<TimerId, Entry<Instant>>,
    shutdown: bool,
}

struct RealShared {
    state: Mutex<RealState>,
    wake: Condvar,
}

/// One thread for every timer of one source. Dropped with the source.
pub struct RealTimers {
    shared: Arc<RealShared>,
}

impl RealTimers {
    pub fn new() -> Arc<Self> {
        let shared = Arc::new(RealShared {
            state: Mutex::new(RealState {
                next_id: 1,
                entries: HashMap::new(),
                shutdown: false,
            }),
            wake: Condvar::new(),
        });
        let weak = Arc::downgrade(&shared);
        thread::Builder::new()
            .name("tyt-activity-timers".into())
            .spawn(move || run_timers(weak))
            .expect("the timer thread starts");
        Arc::new(RealTimers { shared })
    }

    fn add(&self, ms: f64, every: Option<f64>, callback: TimerCallback) -> TimerId {
        let mut state = self.shared.state.lock().expect("timer lock");
        let id = state.next_id;
        state.next_id += 1;
        let at = Instant::now() + Duration::from_millis(ms.max(0.0) as u64);
        state.entries.insert(
            id,
            Entry {
                at,
                every,
                callback: Some(callback),
            },
        );
        self.shared.wake.notify_all();
        id
    }
}

impl Drop for RealTimers {
    fn drop(&mut self) {
        if let Ok(mut state) = self.shared.state.lock() {
            state.shutdown = true;
            state.entries.clear();
        }
        self.shared.wake.notify_all();
    }
}

fn run_timers(weak: Weak<RealShared>) {
    loop {
        let Some(shared) = weak.upgrade() else { return };
        let mut state = shared.state.lock().expect("timer lock");
        if state.shutdown {
            return;
        }
        let now = Instant::now();
        let due = state
            .entries
            .iter()
            .filter(|(_, e)| e.callback.is_some())
            .min_by_key(|(id, e)| (e.at, **id))
            .map(|(id, e)| (*id, e.at));
        match due {
            Some((id, at)) if at <= now => {
                let entry = state.entries.get_mut(&id).expect("due entry");
                let callback = entry.callback.take();
                match entry.every {
                    Some(every) => entry.at = at + Duration::from_millis(every.max(1.0) as u64),
                    None => {
                        state.entries.remove(&id);
                    }
                }
                drop(state);
                match callback {
                    Some(TimerCallback::Once(f)) => f(),
                    Some(TimerCallback::Every(mut f)) => {
                        f();
                        let mut state = shared.state.lock().expect("timer lock");
                        // Cleared while it ran: dropped with it.
                        if let Some(entry) = state.entries.get_mut(&id) {
                            entry.callback = Some(TimerCallback::Every(f));
                        }
                    }
                    None => {}
                }
            }
            Some((_, at)) => {
                let wait = at - now;
                let _ = shared.wake.wait_timeout(state, wait).expect("timer lock");
            }
            None => {
                // Woken by a new timer or the drop; the timeout keeps a
                // dropped handle from parking this thread forever.
                let _ = shared
                    .wake
                    .wait_timeout(state, Duration::from_secs(60))
                    .expect("timer lock");
            }
        }
    }
}

impl Timers for RealTimers {
    fn now(&self) -> f64 {
        epoch_ms()
    }
    fn set_interval(&self, ms: f64, callback: Box<dyn FnMut() + Send>) -> TimerId {
        self.add(ms, Some(ms), TimerCallback::Every(callback))
    }
    fn set_timeout(&self, ms: f64, callback: Box<dyn FnOnce() + Send>) -> TimerId {
        self.add(ms, None, TimerCallback::Once(callback))
    }
    fn clear(&self, id: TimerId) {
        self.shared
            .state
            .lock()
            .expect("timer lock")
            .entries
            .remove(&id);
    }
}

// ── fake ──────────────────────────────────────────────────────────────

struct FakeState {
    now: f64,
    next_id: TimerId,
    entries: HashMap<TimerId, Entry<f64>>,
}

/// The tests' clock: nothing runs until [`FakeTimers::advance`].
pub struct FakeTimers {
    state: Mutex<FakeState>,
}

impl Default for FakeTimers {
    fn default() -> Self {
        FakeTimers {
            state: Mutex::new(FakeState {
                now: 0.0,
                next_id: 1,
                entries: HashMap::new(),
            }),
        }
    }
}

impl FakeTimers {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Run every timer due within `ms`, in order, moving the clock to each.
    pub fn advance(&self, ms: f64) {
        let until = self.state.lock().expect("fake timers").now + ms;
        loop {
            let mut state = self.state.lock().expect("fake timers");
            let due = state
                .entries
                .iter()
                .filter(|(_, e)| e.at <= until && e.callback.is_some())
                .min_by(|a, b| a.1.at.total_cmp(&b.1.at).then(a.0.cmp(b.0)))
                .map(|(id, e)| (*id, e.at));
            let Some((id, at)) = due else {
                state.now = until;
                return;
            };
            state.now = at;
            let entry = state.entries.get_mut(&id).expect("due entry");
            let callback = entry.callback.take();
            match entry.every {
                Some(every) => entry.at += every,
                None => {
                    state.entries.remove(&id);
                }
            }
            drop(state);
            match callback {
                Some(TimerCallback::Once(f)) => f(),
                Some(TimerCallback::Every(mut f)) => {
                    f();
                    let mut state = self.state.lock().expect("fake timers");
                    if let Some(entry) = state.entries.get_mut(&id) {
                        entry.callback = Some(TimerCallback::Every(f));
                    }
                }
                None => {}
            }
        }
    }

    pub fn pending(&self) -> usize {
        self.state.lock().expect("fake timers").entries.len()
    }

    fn add(&self, ms: f64, every: Option<f64>, callback: TimerCallback) -> TimerId {
        let mut state = self.state.lock().expect("fake timers");
        let id = state.next_id;
        state.next_id += 1;
        let at = state.now + ms;
        state.entries.insert(
            id,
            Entry {
                at,
                every,
                callback: Some(callback),
            },
        );
        id
    }
}

impl Timers for FakeTimers {
    fn now(&self) -> f64 {
        self.state.lock().expect("fake timers").now
    }
    fn set_interval(&self, ms: f64, callback: Box<dyn FnMut() + Send>) -> TimerId {
        self.add(ms, Some(ms), TimerCallback::Every(callback))
    }
    fn set_timeout(&self, ms: f64, callback: Box<dyn FnOnce() + Send>) -> TimerId {
        self.add(ms, None, TimerCallback::Once(callback))
    }
    fn clear(&self, id: TimerId) {
        self.state.lock().expect("fake timers").entries.remove(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;

    #[test]
    fn fake_timers_run_due_callbacks_in_order() {
        let timers = FakeTimers::new();
        let log = Arc::new(Mutex::new(Vec::new()));
        let l = log.clone();
        timers.set_timeout(10.0, Box::new(move || l.lock().unwrap().push("ten")));
        let l = log.clone();
        let every = timers.set_interval(4.0, Box::new(move || l.lock().unwrap().push("four")));
        timers.advance(9.0);
        assert_eq!(*log.lock().unwrap(), ["four", "four"]);
        timers.advance(3.0);
        assert_eq!(*log.lock().unwrap(), ["four", "four", "ten", "four"]);
        timers.clear(every);
        timers.advance(100.0);
        assert_eq!(log.lock().unwrap().len(), 4);
        assert_eq!(timers.now(), 112.0);
    }

    #[test]
    fn real_timers_fire_and_clear() {
        let timers = RealTimers::new();
        let (tx, rx) = mpsc::channel();
        timers.set_timeout(5.0, Box::new(move || tx.send(()).unwrap()));
        rx.recv_timeout(Duration::from_secs(5))
            .expect("the timeout fired");
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        let id = timers.set_interval(
            5.0,
            Box::new(move || {
                c.fetch_add(1, Ordering::SeqCst);
            }),
        );
        thread::sleep(Duration::from_millis(60));
        timers.clear(id);
        let seen = count.load(Ordering::SeqCst);
        assert!(seen >= 2, "{seen}");
        thread::sleep(Duration::from_millis(30));
        assert!(count.load(Ordering::SeqCst) <= seen + 1);
    }
}
