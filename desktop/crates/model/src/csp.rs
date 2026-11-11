//! The Content-Security-Policy every HTML document from the app protocol is
//! served with. A response header set by the protocol handler rather than a
//! `<meta>` in the export, so the web build's HTML stays byte-identical.
//! Ported from `electron/src/csp.ts`.
//!
//! - script-src needs 'unsafe-inline': the static export inlines the pre-paint
//!   scripts (app/pre-paint.ts) and Next's RSC payload (`self.__next_f.push`).
//!   No remote script host is allowed, so the optional analytics snippets
//!   that load from a third-party host do not run in the desktop app.
//! - connect-src is any https/wss origin because the server picker lets a
//!   person point the app at any Track Your Time server, plus plain http/ws on
//!   loopback for a local API. img-src allows the same hosts, because the
//!   profile picture is served by the API (`/api/avatars/...`).
//! - `ipc:` and `http://ipc.localhost` are Tauri's own IPC transport (a custom
//!   protocol on macOS/Linux, a localhost host on Windows). Without them every
//!   bridge call fails while the page looks fine.
//! - Nothing may frame the app or be framed by it, and forms post nowhere.

pub const APP_CSP_DIRECTIVES: [&str; 13] = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http://localhost:* http://127.0.0.1:*",
    "font-src 'self' data:",
    "connect-src 'self' ipc: http://ipc.localhost https: wss: http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*",
    "worker-src 'self' blob:",
    "media-src 'self' blob: data:",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'none'",
];

pub fn app_csp() -> String {
    APP_CSP_DIRECTIVES.join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_the_ipc_transport_and_no_remote_scripts() {
        let csp = app_csp();
        assert!(csp.contains("connect-src 'self' ipc: http://ipc.localhost"));
        let script = APP_CSP_DIRECTIVES
            .iter()
            .find(|d| d.starts_with("script-src"))
            .unwrap();
        assert_eq!(*script, "script-src 'self' 'unsafe-inline'");
        assert!(csp.contains("frame-ancestors 'none'"));
        assert!(!csp.contains("unsafe-eval"));
    }
}
