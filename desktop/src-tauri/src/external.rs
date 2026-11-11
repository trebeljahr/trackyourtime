//! Handing a URL to the OS: the browser for http(s), the mail client for
//! mailto:. Every caller goes through `open_in_os`: the navigation guard, the
//! new-window handler and the bridge's `openExternal`.
//!
//! Headless (tests, agents): nothing is handed over. Opening the machine's
//! browser — the "Sign in with your browser" approval page, a link on the
//! support page — would take focus from whoever is using the machine. The URL
//! is recorded instead, for the e2e control channel (`openedExternally`) and
//! on stdout.

use std::sync::Mutex;

static OPENED: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn open_in_os(url: &str, headless: bool) -> Result<(), String> {
    if !tyt_model::trust::is_os_handled_url(url) {
        return Err("refused: not a web or mail URL".into());
    }
    if headless {
        OPENED.lock().unwrap().push(url.to_string());
        println!("[headless] not opening {url}");
        return Ok(());
    }
    open::that_detached(url).map_err(|e| e.to_string())
}

pub fn opened_externally() -> Vec<String> {
    OPENED.lock().unwrap().clone()
}
