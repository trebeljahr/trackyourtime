//! Idle detection: how long the OS has seen no input in ANY application, and
//! whether the screen is locked. The renderer cannot see this — a tab only
//! knows about input that reaches it — so the shell does the detecting and
//! the renderer does the deciding (policy in @starter/core/idle).
//!
//! Electron's powerMonitor gave the idle counter plus lock/suspend events.
//! Here the counter is sampled every IDLE_POLL_MS and broadcast, and the lock
//! state is sampled every LOCK_POLL_MS so a lock reaches the renderer within
//! seconds rather than at the next idle poll. A gap between two samples far
//! longer than the poll interval means the machine slept: a `locked` sample
//! is sent first (what Electron sent on `suspend`), then a fresh one.
//!
//! "Active" means input landed inside the last polling window, not that the
//! counter reads zero: it reads 0 only in the second after a keystroke, so a
//! zero test would report "idle" at someone typing continuously.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use tyt_wire::DesktopIdlePayload;

pub const IDLE_POLL_MS: u64 = 15_000;
const LOCK_POLL_MS: u64 = 2_000;
/// A sample this much later than expected means the machine was asleep.
const SLEEP_GAP_MS: u64 = 30_000;

pub fn read(locked: bool) -> DesktopIdlePayload {
    let idle_seconds = platform::idle_seconds();
    let state = if locked {
        "locked"
    } else if idle_seconds * 1000 >= IDLE_POLL_MS {
        "idle"
    } else {
        "active"
    };
    DesktopIdlePayload {
        state: state.into(),
        idle_seconds,
    }
}

pub struct IdleMonitor {
    locked: Arc<Mutex<bool>>,
}

impl IdleMonitor {
    pub fn current(&self) -> DesktopIdlePayload {
        read(*self.locked.lock().unwrap())
    }
}

/// Start sampling; `broadcast` receives every sample (renderer + activity).
/// Headless runs never start it: the fake activity source drives idle there.
pub fn start(broadcast: impl Fn(DesktopIdlePayload) + Send + 'static) -> IdleMonitor {
    let locked = Arc::new(Mutex::new(false));
    let shared = locked.clone();
    std::thread::Builder::new()
        .name("idle-monitor".into())
        .spawn(move || {
            let mut last_wall = SystemTime::now();
            let mut last_idle_broadcast = Instant::now();
            loop {
                std::thread::sleep(Duration::from_millis(LOCK_POLL_MS));
                let now_wall = SystemTime::now();
                // Monotonic clocks stop while asleep on macOS; the wall clock
                // does not, so the gap shows there.
                let gap = now_wall
                    .duration_since(last_wall)
                    .unwrap_or_default()
                    .as_millis() as u64;
                last_wall = now_wall;
                if gap > LOCK_POLL_MS + SLEEP_GAP_MS {
                    broadcast(DesktopIdlePayload {
                        state: "locked".into(),
                        idle_seconds: gap / 1000,
                    });
                }
                let is_locked = platform::screen_locked();
                let changed = {
                    let mut current = shared.lock().unwrap();
                    let changed = *current != is_locked;
                    *current = is_locked;
                    changed
                };
                if changed
                    || gap > LOCK_POLL_MS + SLEEP_GAP_MS
                    || last_idle_broadcast.elapsed() >= Duration::from_millis(IDLE_POLL_MS)
                {
                    broadcast(read(is_locked));
                    last_idle_broadcast = Instant::now();
                }
            }
        })
        .expect("idle monitor thread");
    IdleMonitor { locked }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::{c_char, c_void};

    type CFTypeRef = *const c_void;
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(source: i32, event_type: u32) -> f64;
        fn CGSessionCopyCurrentDictionary() -> CFTypeRef;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            alloc: CFTypeRef,
            s: *const c_char,
            encoding: u32,
        ) -> CFTypeRef;
        fn CFDictionaryGetValue(dict: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
        fn CFBooleanGetValue(b: CFTypeRef) -> u8;
        fn CFGetTypeID(cf: CFTypeRef) -> usize;
        fn CFBooleanGetTypeID() -> usize;
        fn CFRelease(cf: CFTypeRef);
    }
    const COMBINED_SESSION_STATE: i32 = 0;
    const ANY_INPUT_EVENT: u32 = !0;
    const UTF8: u32 = 0x0800_0100;

    pub fn idle_seconds() -> u64 {
        let seconds = unsafe {
            CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT_EVENT)
        };
        if seconds.is_finite() && seconds > 0.0 {
            seconds as u64
        } else {
            0
        }
    }

    pub fn screen_locked() -> bool {
        unsafe {
            let dict = CGSessionCopyCurrentDictionary();
            if dict.is_null() {
                return false;
            }
            let key = CFStringCreateWithCString(
                std::ptr::null(),
                c"CGSSessionScreenIsLocked".as_ptr(),
                UTF8,
            );
            let value = CFDictionaryGetValue(dict, key);
            let locked = !value.is_null()
                && CFGetTypeID(value) == CFBooleanGetTypeID()
                && CFBooleanGetValue(value) != 0;
            CFRelease(key);
            CFRelease(dict);
            locked
        }
    }
}

#[cfg(windows)]
mod platform {
    use windows::Win32::System::StationsAndDesktops::{
        CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_ACCESS_FLAGS,
        DESKTOP_CONTROL_FLAGS, UOI_NAME,
    };
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    pub fn idle_seconds() -> u64 {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        unsafe {
            if !GetLastInputInfo(&mut info).as_bool() {
                return 0;
            }
            (GetTickCount().wrapping_sub(info.dwTime) / 1000) as u64
        }
    }

    /// The secure desktop ("Winlogon") is the input desktop while the
    /// session is locked; "Default" otherwise.
    pub fn screen_locked() -> bool {
        unsafe {
            let Ok(desktop) = OpenInputDesktop(
                DESKTOP_CONTROL_FLAGS(0),
                false,
                DESKTOP_ACCESS_FLAGS(0x0001),
            ) else {
                // Access to the input desktop is denied while it is the secure one.
                return true;
            };
            let mut name = [0u16; 64];
            let mut needed = 0u32;
            let ok = GetUserObjectInformationW(
                windows::Win32::Foundation::HANDLE(desktop.0),
                UOI_NAME,
                Some(name.as_mut_ptr() as *mut _),
                (name.len() * 2) as u32,
                Some(&mut needed),
            )
            .is_ok();
            let _ = CloseDesktop(desktop);
            if !ok {
                return false;
            }
            let len = name.iter().position(|c| *c == 0).unwrap_or(name.len());
            !String::from_utf16_lossy(&name[..len]).eq_ignore_ascii_case("Default")
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::sync::OnceLock;
    use std::time::Duration;

    struct X {
        xlib: x11_dl::xlib::Xlib,
        xss: x11_dl::xss::Xss,
        display: usize,
    }
    // Only ever used from the idle thread.
    unsafe impl Send for X {}
    unsafe impl Sync for X {}

    fn x() -> Option<&'static X> {
        static X11: OnceLock<Option<X>> = OnceLock::new();
        X11.get_or_init(|| {
            let xlib = x11_dl::xlib::Xlib::open().ok()?;
            let xss = x11_dl::xss::Xss::open().ok()?;
            let display = unsafe { (xlib.XOpenDisplay)(std::ptr::null()) };
            if display.is_null() {
                return None;
            }
            Some(X {
                xlib,
                xss,
                display: display as usize,
            })
        })
        .as_ref()
    }

    fn x11_idle_ms() -> Option<u64> {
        let x = x()?;
        unsafe {
            let display = x.display as *mut x11_dl::xlib::Display;
            let info = (x.xss.XScreenSaverAllocInfo)();
            if info.is_null() {
                return None;
            }
            let root = (x.xlib.XDefaultRootWindow)(display);
            let ok = (x.xss.XScreenSaverQueryInfo)(display, root, info) != 0;
            let idle = (*info).idle;
            (x.xlib.XFree)(info as *mut _);
            ok.then_some(idle as u64)
        }
    }

    /// GNOME's own counter, which also answers under Wayland.
    fn mutter_idle_ms() -> Option<u64> {
        let conn = dbus::blocking::Connection::new_session().ok()?;
        let proxy = conn.with_proxy(
            "org.gnome.Mutter.IdleMonitor",
            "/org/gnome/Mutter/IdleMonitor/Core",
            Duration::from_millis(500),
        );
        let (ms,): (u64,) = proxy
            .method_call("org.gnome.Mutter.IdleMonitor", "GetIdletime", ())
            .ok()?;
        Some(ms)
    }

    pub fn idle_seconds() -> u64 {
        x11_idle_ms().or_else(mutter_idle_ms).unwrap_or(0) / 1000
    }

    /// logind's LockedHint, which every screen locker on a systemd desktop sets.
    pub fn screen_locked() -> bool {
        use dbus::blocking::stdintf::org_freedesktop_dbus::Properties;
        let Ok(conn) = dbus::blocking::Connection::new_system() else {
            return false;
        };
        let proxy = conn.with_proxy(
            "org.freedesktop.login1",
            "/org/freedesktop/login1/session/auto",
            Duration::from_millis(500),
        );
        proxy
            .get::<bool>("org.freedesktop.login1.Session", "LockedHint")
            .unwrap_or(false)
    }
}
