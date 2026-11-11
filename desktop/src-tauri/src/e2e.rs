//! The e2e control channel (cargo feature `e2e`, never in a release build).
//!
//! Playwright drove the Electron build over CDP. The system WebViews offer no
//! such protocol on macOS, so the harness (e2e/desktop/driver.ts) talks to
//! this instead: a loopback TCP port, JSON lines in both directions,
//!
//! ```text
//! → {"id":1,"method":"eval","params":{"script":"document.title"}}
//! ← {"id":1,"result":"Track Your Time"}
//! ```
//!
//! The port and a random token are written to `<profile>/e2e.json`; every
//! request line carries the token. Methods: `eval` (an expression, awaited,
//! JSON result), `navigate`, `loads` (page loads finished so far), `url`, `window`
//! (visibility, focus, size, position, and on macOS the app's activation
//! policy), `setSize`, `push` (a bridge push, as the shell sends one),
//! `foreignCall` (a bridge call from a window that is not the app's),
//! `menu`, `inspection`, `background`, `hook` (the shell's test hooks),
//! `openedExternally`, `offline`, `profile`, `quit`.
//!
//! Everything here only reads the shell's state or drives it the way the OS
//! or the page would; nothing in it shows, focuses or activates a window.

use base64::Engine;
use rand::RngCore;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow};

/// The page half of the driver (e2e/desktop/driver.ts).
pub const DOM_SCRIPT: &str = include_str!("e2e_dom.js");

/// The label prefix of the throwaway windows `foreignCall` opens.
const FOREIGN: &str = "e2e-foreign";
/// Where that window navigates to hand its answer back (never loaded).
const FOREIGN_ANSWER_HOST: &str = "e2e-answer.invalid";

/// Evals waiting for the page's answer, by id.
type Pending = Mutex<HashMap<u64, Sender<Result<Value, String>>>>;

static PENDING: OnceLock<Pending> = OnceLock::new();
static NEXT: AtomicU64 = AtomicU64::new(1);
pub static LOADS: AtomicU64 = AtomicU64::new(0);

fn pending() -> &'static Pending {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The page's answer to an `eval` (invoked by the wrapper script). Only the
/// app's own document may answer.
#[tauri::command]
pub fn e2e_result(webview: tauri::Webview, id: u64, ok: bool, value: Value) {
    let url = webview.url().map(|u| u.to_string()).ok();
    let dev_url = webview
        .app_handle()
        .state::<crate::shell::Shell>()
        .dev_url
        .clone();
    if webview.label() != crate::window::MAIN
        || !tyt_model::trust::is_trusted_sender_url(url.as_deref(), dev_url.as_deref())
    {
        return;
    }
    if let Some(tx) = pending().lock().unwrap().remove(&id) {
        let _ = tx.send(if ok {
            Ok(value)
        } else {
            Err(value
                .as_str()
                .map(String::from)
                .unwrap_or_else(|| value.to_string()))
        });
    }
}

fn eval_in(window: &WebviewWindow, script: &str, timeout: Duration) -> Result<Value, String> {
    let id = NEXT.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = channel();
    pending().lock().unwrap().insert(id, tx);
    let wrapped = format!(
        "(async () => {{ const report = (ok, value) => window.__TAURI_INTERNALS__.invoke('e2e_result', {{ id: {id}, ok, value }}); \
         const json = (value) => {{ try {{ return value === undefined ? null : JSON.parse(JSON.stringify(value)); }} catch (_) {{ return null; }} }}; \
         try {{ const value = await ({script}\n); report(true, json(value)); }} \
         catch (error) {{ report(false, error && error.message !== undefined ? String(error.message) + '\\n' + String(error.stack || '') : String(error)); }} }})()"
    );
    window.eval(wrapped).map_err(|e| e.to_string())?;
    let result = rx
        .recv_timeout(timeout)
        .map_err(|_| "eval timed out (page not loaded, or no bridge on this document)".to_string());
    pending().lock().unwrap().remove(&id);
    result?
}

fn eval(app: &AppHandle, script: &str, timeout: Duration) -> Result<Value, String> {
    let window = app
        .get_webview_window(crate::window::MAIN)
        .ok_or("no main window")?;
    eval_in(&window, script, timeout)
}

/// Run `f` on the main thread (AppKit wants it) and wait for its answer.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn on_main<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|_| "the main thread did not answer".to_string())
}

/// What the main window's WebView answers through `with_webview`, on the main thread.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn with_platform_webview<T: Send + 'static>(
    window: &WebviewWindow,
    f: impl FnOnce(tauri::webview::PlatformWebview) -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = channel();
    window
        .with_webview(move |webview| {
            let _ = tx.send(f(webview));
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|_| "the webview did not answer".to_string())
}

#[cfg(target_os = "macos")]
mod mac {
    //! Read-only AppKit and WebKit state, for checks the Electron harness
    //! made through Electron's own getters.
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send, sel};

    unsafe fn responds(object: *mut AnyObject, selector: objc2::runtime::Sel) -> bool {
        if object.is_null() {
            return false;
        }
        let answer: bool = msg_send![object, respondsToSelector: selector];
        answer
    }

    /// A BOOL getter, or None where this WebKit has no such selector.
    macro_rules! flag {
        ($object:expr, $selector:ident) => {{
            let object: *mut AnyObject = $object;
            if responds(object, sel!($selector)) {
                let answer: bool = msg_send![object, $selector];
                Some(answer)
            } else {
                None
            }
        }};
    }

    /// `NSApp.activationPolicy` and `NSApp.isActive`.
    pub unsafe fn app_state() -> (&'static str, bool) {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let policy: isize = msg_send![app, activationPolicy];
        let active: bool = msg_send![app, isActive];
        let name = match policy {
            0 => "regular",
            1 => "accessory",
            2 => "prohibited",
            _ => "unknown",
        };
        (name, active)
    }

    /// An NSColor as #rrggbb in sRGB, or None when it has no RGB form.
    unsafe fn hex(color: *mut AnyObject) -> Option<String> {
        if color.is_null() {
            return None;
        }
        let space: *mut AnyObject = msg_send![class!(NSColorSpace), sRGBColorSpace];
        let rgb: *mut AnyObject = msg_send![color, colorUsingColorSpace: space];
        if rgb.is_null() {
            return None;
        }
        let channel = |value: f64| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
        let r: f64 = msg_send![rgb, redComponent];
        let g: f64 = msg_send![rgb, greenComponent];
        let b: f64 = msg_send![rgb, blueComponent];
        Some(format!(
            "#{:02x}{:02x}{:02x}",
            channel(r),
            channel(g),
            channel(b)
        ))
    }

    /// The NSWindow's background and whether the WKWebView paints its own
    /// (white) background over it before the page does.
    pub unsafe fn background(
        webview: *mut AnyObject,
        window: *mut AnyObject,
    ) -> (Option<String>, Option<bool>) {
        let color: *mut AnyObject = if window.is_null() {
            std::ptr::null_mut()
        } else {
            msg_send![window, backgroundColor]
        };
        (hex(color), flag!(webview, _drawsBackground))
    }

    /// Whether Web Inspector can reach this WebView: `isInspectable` (macOS
    /// 13.3+, also Safari's remote inspection) and the developer-extras
    /// preference behind the context menu's "Inspect Element".
    pub unsafe fn inspection(webview: *mut AnyObject) -> (Option<bool>, Option<bool>) {
        let inspectable = flag!(webview, isInspectable);
        let configuration: *mut AnyObject = if webview.is_null() {
            std::ptr::null_mut()
        } else {
            msg_send![webview, configuration]
        };
        let preferences: *mut AnyObject = if configuration.is_null() {
            std::ptr::null_mut()
        } else {
            msg_send![configuration, preferences]
        };
        (inspectable, flag!(preferences, _developerExtrasEnabled))
    }
}

fn menu_labels(items: Vec<tauri::menu::MenuItemKind<tauri::Wry>>, out: &mut Vec<String>) {
    use tauri::menu::MenuItemKind;
    for item in items {
        match item {
            MenuItemKind::Submenu(submenu) => {
                out.push(submenu.text().unwrap_or_default());
                menu_labels(submenu.items().unwrap_or_default(), out);
            }
            MenuItemKind::MenuItem(item) => out.push(item.text().unwrap_or_default()),
            MenuItemKind::Predefined(item) => out.push(item.text().unwrap_or_default()),
            MenuItemKind::Check(item) => out.push(item.text().unwrap_or_default()),
            MenuItemKind::Icon(item) => out.push(item.text().unwrap_or_default()),
        }
    }
}

/// A bridge call made from a hidden window that is not the app's main one,
/// showing `url`, the way a page that is not the app would make it. The
/// window gets Tauri's IPC like any webview the app opens, so only the
/// shell's own checks stand between it and the shell (ipc.rs; Tauri's ACL
/// refuses a remote origin even earlier). The answer comes back as a
/// navigation the window refuses, because the IPC it is testing cannot be
/// trusted to carry it.
fn foreign_call(app: &AppHandle, url: &str, channel_name: &str) -> Result<Value, String> {
    // A label of its own each time: destroying a window is not immediate.
    let label = format!("{FOREIGN}-{}", NEXT.fetch_add(1, Ordering::SeqCst));
    let parsed: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    let (loaded_tx, loaded_rx) = channel::<()>();
    let loaded_tx = Mutex::new(Some(loaded_tx));
    let (answer_tx, answer_rx) = channel::<String>();
    let answer_tx = Mutex::new(answer_tx);
    let window = tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::External(parsed))
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .on_navigation(move |target| {
            if target.host_str() != Some(FOREIGN_ANSWER_HOST) {
                return true;
            }
            let encoded = target.fragment().unwrap_or_default();
            let answer = url::form_urlencoded::parse(format!("v={encoded}").as_bytes())
                .next()
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default();
            let _ = answer_tx.lock().unwrap().send(answer);
            false
        })
        .on_page_load(move |_window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                if let Some(tx) = loaded_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            }
        })
        .build()
        .map_err(|e| e.to_string())?;
    let outcome = loaded_rx
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| "the foreign window never loaded".to_string())
        .and_then(|_| {
            let script = format!(
                "(function () {{ var answer = function (text) {{ location.href = 'https://{FOREIGN_ANSWER_HOST}/#' + encodeURIComponent(text); }}; \
                 var ipc = window.__TAURI_INTERNALS__; \
                 if (!ipc || typeof ipc.invoke !== 'function') return answer('no ipc'); \
                 ipc.invoke('desktop_call', {{ channel: {channel}, args: [] }}).then(function () {{ answer('allowed'); }}, function (e) {{ answer('refused: ' + String(e && e.message || e)); }}); }})()",
                channel = serde_json::to_string(channel_name).unwrap()
            );
            window.eval(script).map_err(|e| e.to_string())?;
            answer_rx.recv_timeout(Duration::from_secs(10)).map_err(|_| "the foreign window never answered".to_string())
        });
    let _ = window.destroy();
    outcome.map(Value::from)
}

fn window_state(app: &AppHandle) -> Result<Value, String> {
    let Some(window) = app.get_webview_window(crate::window::MAIN) else {
        return Ok(Value::Null);
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let position = window
        .outer_position()
        .map(|p| p.to_logical::<f64>(scale))
        .ok();
    #[cfg(target_os = "macos")]
    let (policy, app_active) = {
        let (policy, active) = on_main(app, || unsafe { mac::app_state() })?;
        (Value::from(policy), Value::from(active))
    };
    #[cfg(not(target_os = "macos"))]
    let (policy, app_active) = (Value::Null, Value::Null);
    Ok(json!({
        "visible": window.is_visible().unwrap_or(false),
        "focused": window.is_focused().unwrap_or(false),
        "minimized": window.is_minimized().unwrap_or(false),
        "maximized": window.is_maximized().unwrap_or(false),
        "fullscreen": window.is_fullscreen().unwrap_or(false),
        "alwaysOnTop": window.is_always_on_top().unwrap_or(false),
        "x": position.map(|p| p.x.round()),
        "y": position.map(|p| p.y.round()),
        "width": size.width.round(),
        "height": size.height.round(),
        "url": window.url().map(|u| u.to_string()).unwrap_or_default(),
        "windows": app.webview_windows().len(),
        "activationPolicy": policy,
        "appActive": app_active,
    }))
}

fn handle(app: &AppHandle, method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "eval" => {
            let script = params["script"].as_str().ok_or("eval needs a script")?;
            let timeout = Duration::from_millis(params["timeoutMs"].as_u64().unwrap_or(15_000));
            eval(app, script, timeout)
        }
        "navigate" => {
            let url = params["url"].as_str().ok_or("navigate needs a url")?;
            let window = app
                .get_webview_window(crate::window::MAIN)
                .ok_or("no main window")?;
            window
                .navigate(url.parse().map_err(|e: url::ParseError| e.to_string())?)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "loads" => Ok(json!(LOADS.load(Ordering::SeqCst))),
        "window" => window_state(app),
        "url" => Ok(app
            .get_webview_window(crate::window::MAIN)
            .and_then(|w| w.url().ok())
            .map_or(Value::Null, |u| Value::from(u.to_string()))),
        "setSize" => {
            // What a person dragging the window's edge does; the Resized event
            // reaches the controller as it would then (window.rs).
            let width = params["width"].as_f64().ok_or("setSize needs a width")?;
            let height = params["height"].as_f64().ok_or("setSize needs a height")?;
            let window = app
                .get_webview_window(crate::window::MAIN)
                .ok_or("no main window")?;
            window
                .set_size(tauri::LogicalSize::new(width, height))
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "push" => {
            // The shell's own push path (shell.rs → bridge.rs push_script).
            let channel_name = params["channel"].as_str().ok_or("push needs a channel")?;
            crate::shell::push(app, channel_name, &params["payload"]);
            Ok(Value::Null)
        }
        "foreignCall" => {
            let url = params["url"].as_str().ok_or("foreignCall needs a url")?;
            let channel_name = params["channel"]
                .as_str()
                .ok_or("foreignCall needs a channel")?;
            foreign_call(app, url, channel_name)
        }
        "menu" => {
            // Menu getters hop to the main thread themselves.
            let mut labels = Vec::new();
            if let Some(menu) = app.menu() {
                menu_labels(menu.items().unwrap_or_default(), &mut labels);
            }
            Ok(json!(labels))
        }
        "inspection" => {
            let window = app
                .get_webview_window(crate::window::MAIN)
                .ok_or("no main window")?;
            #[cfg(target_os = "macos")]
            {
                let (inspectable, extras) = with_platform_webview(&window, |webview| unsafe {
                    mac::inspection(webview.inner().cast())
                })?;
                Ok(json!({ "inspectable": inspectable, "developerExtras": extras }))
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = window;
                Ok(Value::Null)
            }
        }
        "background" => {
            let window = app
                .get_webview_window(crate::window::MAIN)
                .ok_or("no main window")?;
            let dark = window
                .theme()
                .map(|t| t == tauri::Theme::Dark)
                .unwrap_or(false);
            #[cfg(target_os = "macos")]
            {
                let (color, draws) = with_platform_webview(&window, |webview| unsafe {
                    mac::background(webview.inner().cast(), webview.ns_window().cast())
                })?;
                Ok(json!({ "window": color, "webviewDrawsBackground": draws, "dark": dark }))
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = dark;
                Ok(Value::Null)
            }
        }
        "offline" => {
            let offline = params["offline"].as_bool().unwrap_or(false);
            eval(
                app,
                &format!("window.__TYT_E2E__.setOffline({offline})"),
                Duration::from_secs(5),
            )
        }
        "screenshot" => {
            Err("screenshots of the hidden WebView are not supported by this harness yet".into())
        }
        "downloads" => Ok(json!(crate::downloads::recorded())),
        "openedExternally" => Ok(json!(crate::external::opened_externally())),
        "profile" => Ok(json!(app
            .state::<crate::shell::Shell>()
            .profile
            .to_string_lossy())),
        "hook" => {
            let name = params["name"].as_str().ok_or("hook needs a name")?;
            crate::shell::test_hook(
                app,
                name,
                params.get("args").cloned().unwrap_or(Value::Null),
            )
        }
        "quit" => {
            crate::shell::request_quit(app);
            Ok(Value::Null)
        }
        other => Err(format!("unknown e2e method {other}")),
    }
}

fn serve(app: AppHandle, stream: TcpStream, token: String) {
    let mut writer = match stream.try_clone() {
        Ok(w) => w,
        Err(_) => return,
    };
    for line in BufReader::new(stream).lines() {
        let Ok(line) = line else { break };
        let Ok(request) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if request["token"].as_str() != Some(token.as_str()) {
            break;
        }
        let id = request["id"].clone();
        let app = app.clone();
        let method = request["method"].as_str().unwrap_or("").to_string();
        let params = request["params"].clone();
        let reply = match handle(&app, &method, &params) {
            Ok(result) => json!({ "id": id, "result": result }),
            Err(error) => json!({ "id": id, "error": error }),
        };
        if writer.write_all(format!("{reply}\n").as_bytes()).is_err() {
            break;
        }
    }
}

pub fn start(app: &AppHandle) {
    let shell = app.state::<crate::shell::Shell>();
    let Ok(listener) = TcpListener::bind(("127.0.0.1", 0)) else {
        eprintln!("[e2e] could not bind the control port");
        return;
    };
    let mut raw = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut raw);
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let info = json!({ "port": port, "token": token, "pid": std::process::id() }).to_string();
    let _ = tyt_model::secure_store::write_private_atomic(
        &shell.profile,
        &shell.profile.join("e2e.json"),
        info.as_bytes(),
    );
    println!("[e2e] control channel on 127.0.0.1:{port}");
    let app = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            let token = token.clone();
            std::thread::spawn(move || serve(app, stream, token));
        }
    });
}
