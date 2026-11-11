//! Every bridge call arrives here as `desktop_call(channel, args)` and is
//! refused unless it comes from the main window's own document — the export
//! over the app origin, or the dev server in a dev run. The initialization
//! script runs per navigation, not per origin, so a window that ever showed
//! something else must not hold a working bridge (Electron's ipc.ts rule).

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Webview};
use tyt_wire::channels as c;

use crate::shell::Shell;

#[tauri::command(async)]
pub fn desktop_call(
    app: AppHandle,
    webview: Webview,
    channel: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    let shell = app.state::<Shell>();
    let url = webview.url().map(|u| u.to_string()).ok();
    if webview.label() != crate::window::MAIN
        || !tyt_model::trust::is_trusted_sender_url(url.as_deref(), shell.dev_url.as_deref())
    {
        eprintln!(
            "[ipc] {channel} refused: sender {}",
            url.as_deref().unwrap_or("(no frame)")
        );
        return Err(format!(
            "Refused {channel} from {}",
            url.as_deref().unwrap_or("a detached frame")
        ));
    }
    dispatch(&app, &shell, &channel, args)
}

fn arg(args: &[Value], index: usize) -> &Value {
    args.get(index).unwrap_or(&Value::Null)
}

fn dispatch(
    app: &AppHandle,
    shell: &Shell,
    channel: &str,
    args: Vec<Value>,
) -> Result<Value, String> {
    match channel {
        c::QUIT => {
            crate::shell::request_quit(app);
            Ok(Value::Null)
        }
        c::OPEN_EXTERNAL => {
            let Some(url) = arg(&args, 0).as_str() else {
                return Ok(json!(false));
            };
            if !tyt_model::trust::is_external_web_url(url) {
                return Ok(json!(false));
            }
            Ok(json!(
                crate::external::open_in_os(url, shell.headless).is_ok()
            ))
        }
        c::GET_IDLE => Ok(match shell.idle.get() {
            Some(monitor) => serde_json::to_value(monitor.current()).unwrap(),
            None => json!({ "state": "active", "idleSeconds": 0 }),
        }),
        c::TOKEN_GET => Ok(json!(shell.secure.get_token())),
        c::TOKEN_SET => match arg(&args, 0).as_str() {
            Some(token) => Ok(serde_json::to_value(shell.secure.set_token(token)).unwrap()),
            None => Ok(serde_json::to_value(shell.secure.status()).unwrap()),
        },
        c::TOKEN_DELETE => {
            shell.secure.delete_token();
            Ok(Value::Null)
        }
        c::TOKEN_STATUS => Ok(serde_json::to_value(shell.secure.status()).unwrap()),
        "smoke:report" => {
            let Some(path) = shell.smoke_report.as_ref() else {
                return Err("smoke mode is off".into());
            };
            let mut report = arg(&args, 0).clone();
            if let Some(object) = report.as_object_mut() {
                object.insert(
                    "version".into(),
                    json!(app.package_info().version.to_string()),
                );
            }
            let ok = report["ok"].as_bool() == Some(true);
            std::fs::write(path, serde_json::to_vec_pretty(&report).unwrap())
                .map_err(|e| e.to_string())?;
            println!("[smoke] report written to {} (ok: {ok})", path.display());
            crate::shell::exit_now(app, if ok { 0 } else { 1 });
            Ok(Value::Null)
        }
        "migration:done" => {
            let keys = shell
                .migration
                .lock()
                .unwrap()
                .take()
                .map(|m| m.len())
                .unwrap_or(0);
            crate::migrate::mark_done(&shell.profile, keys);
            Ok(Value::Null)
        }
        other if crate::activity::Activity::handles(other) => {
            crate::activity::before_call(shell, other, &args);
            shell
                .activity
                .get()
                .ok_or("activity is not installed")?
                .call(other, args)
        }
        other if other.starts_with("desktop:") || other.starts_with("update:") => shell
            .controller()
            .ok_or("the desktop controller is not ready")?
            .call(other, args),
        other => Err(format!("Unknown desktop channel {other}")),
    }
}
