//! System notifications for the prompts a hidden window would otherwise
//! swallow (Stage 5): posted natively so a click comes back to the app,
//! which Tauri's notification plugin does not report on desktop.
//!
//! `on_click` runs on a background thread when the person clicks the
//! notification; it is dropped unrun when they dismiss it.

pub fn post(
    title: &str,
    body: &str,
    tag: &str,
    on_click: Box<dyn FnOnce() + Send>,
) -> Result<(), String> {
    platform::post(
        title.to_string(),
        body.to_string(),
        tag.to_string(),
        on_click,
    )
}

#[cfg(target_os = "macos")]
mod platform {
    use std::sync::Once;

    pub fn post(
        title: String,
        body: String,
        _tag: String,
        on_click: Box<dyn FnOnce() + Send>,
    ) -> Result<(), String> {
        static APP: Once = Once::new();
        APP.call_once(|| {
            let _ = mac_notification_sys::set_application("com.ricoslabs.trackyourtime");
        });
        std::thread::Builder::new()
            .name("notification".into())
            .spawn(move || {
                let response = mac_notification_sys::Notification::new()
                    .title(&title)
                    .message(&body)
                    .wait_for_click(true)
                    .send();
                if let Ok(mac_notification_sys::NotificationResponse::Click) = response {
                    on_click();
                }
            })
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    pub fn post(
        title: String,
        body: String,
        tag: String,
        on_click: Box<dyn FnOnce() + Send>,
    ) -> Result<(), String> {
        let handle = notify_rust::Notification::new()
            .appname("Track Your Time")
            .summary(&title)
            .body(&body)
            .hint(notify_rust::Hint::Custom("x-trackyourtime-tag".into(), tag))
            .action("default", "Open")
            .show()
            .map_err(|e| e.to_string())?;
        std::thread::spawn(move || {
            let mut on_click = Some(on_click);
            handle.wait_for_action(|action| {
                if action == "default" {
                    if let Some(f) = on_click.take() {
                        f();
                    }
                }
            });
        });
        Ok(())
    }
}

#[cfg(windows)]
mod platform {
    use std::sync::Mutex;

    pub fn post(
        title: String,
        body: String,
        tag: String,
        on_click: Box<dyn FnOnce() + Send>,
    ) -> Result<(), String> {
        let once = Mutex::new(Some(on_click));
        tauri_winrt_notification::Toast::new("com.ricoslabs.trackyourtime")
            .title(&title)
            .text1(&body)
            .tag(&tag)
            .on_activated(move |_| {
                if let Some(f) = once.lock().unwrap().take() {
                    f();
                }
                Ok(())
            })
            .show()
            .map_err(|e| e.to_string())
    }
}
