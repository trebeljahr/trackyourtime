//! Which documents the shell talks to, and which URLs the window may show.
//! Pure functions; `src-tauri` applies them to navigation, new windows,
//! permissions and every bridge call. Ported from `electron/src/trust.ts`.

use url::Url;

/// A URL on this build's own origin: `app://-` on macOS and Linux,
/// `http://app.localhost` on Windows (WebView2 serves custom schemes there).
pub fn is_app_url(url: Option<&str>) -> bool {
    is_app_url_for(url, tyt_wire::desktop_app_origin())
}

/// `is_app_url` against an explicit origin, so both platforms are testable
/// everywhere.
pub fn is_app_url_for(url: Option<&str>, origin: &str) -> bool {
    let Some(url) = url.filter(|u| !u.is_empty()) else {
        return false;
    };
    let Ok(parsed) = Url::parse(url) else {
        return false;
    };
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let own = match parsed.port() {
        Some(port) => format!("{}://{}:{}", parsed.scheme(), host, port),
        None => format!("{}://{}", parsed.scheme(), host),
    };
    own == origin
}

/// Same origin as the dev server `dev:desktop` loads, when there is one. Only
/// an http(s) dev URL counts: file:, data: and about: URLs all share the
/// opaque origin "null", so comparing origins alone would trust every one.
pub fn is_dev_url(url: Option<&str>, dev_url: Option<&str>) -> bool {
    let (Some(url), Some(dev_url)) = (url, dev_url) else {
        return false;
    };
    if !is_external_web_url(dev_url) {
        return false;
    }
    match (Url::parse(url), Url::parse(dev_url)) {
        (Ok(a), Ok(b)) => a.origin() == b.origin() && a.origin().is_tuple(),
        _ => false,
    }
}

/// May a document at `url` call the bridge? Only the app's own documents.
pub fn is_trusted_sender_url(url: Option<&str>, dev_url: Option<&str>) -> bool {
    is_app_url(url) || is_dev_url(url, dev_url)
}

/// An http(s) URL, the only kind handed to the OS browser.
pub fn is_external_web_url(url: &str) -> bool {
    Url::parse(url).is_ok_and(|u| matches!(u.scheme(), "https" | "http"))
}

/// A URL a link may hand to the OS when it would leave the app: http(s) for
/// the browser and `mailto:` for the mail client. Nothing else: `file:`,
/// custom schemes and the like can launch arbitrary handlers.
pub fn is_os_handled_url(url: &str) -> bool {
    is_external_web_url(url) || Url::parse(url).is_ok_and(|u| u.scheme() == "mailto")
}

/// The web permissions the app's own documents are granted. Everything else —
/// camera, microphone, geolocation, MIDI, clipboard reads — is denied.
pub const GRANTED_PERMISSIONS: [&str; 2] = ["notifications", "clipboard-sanitized-write"];

pub fn is_permission_granted(permission: &str, url: Option<&str>, dev_url: Option<&str>) -> bool {
    GRANTED_PERMISSIONS.contains(&permission) && is_trusted_sender_url(url, dev_url)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAC: &str = "app://-";
    const WIN: &str = "http://app.localhost";

    #[test]
    fn trusts_the_apps_own_origin() {
        assert!(is_app_url_for(Some("app://-/"), MAC));
        assert!(is_app_url_for(Some("app://-/app/track/?x=1"), MAC));
        assert!(is_app_url_for(Some("http://app.localhost/app/track/"), WIN));
    }

    #[test]
    fn refuses_everything_else() {
        for url in [
            "app://evil/",
            "https://trackyourtime.dev/app/track/",
            "http://localhost:7130/",
            "file:///Applications/Track%20Your%20Time.app/index.html",
            "data:text/html,<p>hi</p>",
            "about:blank",
            "",
            "http://app.localhost:8080/",
            "https://app.localhost/",
            "tauri://localhost/",
        ] {
            assert!(!is_app_url_for(Some(url), MAC), "{url}");
            assert!(!is_trusted_sender_url_for(url, None, MAC), "{url}");
        }
        for url in [
            "app://-/",
            "http://evil.localhost/",
            "http://app.localhost.evil.com/",
        ] {
            assert!(!is_app_url_for(Some(url), WIN), "{url}");
        }
        assert!(!is_app_url_for(None, MAC));
    }

    fn is_trusted_sender_url_for(url: &str, dev: Option<&str>, origin: &str) -> bool {
        is_app_url_for(Some(url), origin) || is_dev_url(Some(url), dev)
    }

    #[test]
    fn trusts_the_dev_server_only_when_configured() {
        let dev = Some("http://localhost:7130");
        assert!(is_trusted_sender_url_for(
            "http://localhost:7130/app/track/",
            dev,
            MAC
        ));
        assert!(!is_trusted_sender_url_for(
            "http://localhost:7131/",
            dev,
            MAC
        ));
        assert!(!is_trusted_sender_url_for(
            "http://127.0.0.1:7130/",
            dev,
            MAC
        ));
    }

    #[test]
    fn never_lets_an_opaque_dev_url_trust_opaque_documents() {
        for dev in [
            "file:///tmp/index.html",
            "data:text/html,x",
            "about:blank",
            "not a url",
        ] {
            for url in [
                "data:text/html,<p>hi</p>",
                "about:blank",
                "file:///etc/hosts",
            ] {
                assert!(
                    !is_trusted_sender_url_for(url, Some(dev), MAC),
                    "{url} with dev {dev}"
                );
            }
        }
    }

    #[test]
    fn is_not_fooled_by_look_alike_urls() {
        assert!(!is_app_url_for(Some("app://-.evil.com/"), MAC));
        assert!(!is_app_url_for(Some("app://-@evil/"), MAC));
        assert!(!is_app_url_for(Some("app://x@-/"), MAC));
        assert!(!is_app_url_for(Some("https://app/-"), MAC));
        assert!(!is_app_url_for(Some("http://user@app.localhost/"), WIN));
    }

    #[test]
    fn external_web_urls_are_http_and_https_only() {
        assert!(is_external_web_url("https://trackyourtime.dev/docs/"));
        assert!(is_external_web_url("http://localhost:5159/"));
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "smb://server/share",
            "not a url",
        ] {
            assert!(!is_external_web_url(url), "{url}");
        }
    }

    #[test]
    fn permissions() {
        // Through the platform origin, so this holds on every OS the tests run on.
        let own = format!("{}/app/track/", tyt_wire::desktop_app_origin());
        assert!(is_permission_granted("notifications", Some(&own), None));
        assert!(is_permission_granted(
            "clipboard-sanitized-write",
            Some(&own),
            None
        ));
        for permission in [
            "clipboard-read",
            "media",
            "geolocation",
            "midi",
            "openExternal",
            "fullscreen",
        ] {
            assert!(
                !is_permission_granted(permission, Some(&own), None),
                "{permission}"
            );
        }
        for url in [
            "https://example.com/",
            "data:text/html,x",
            "about:blank",
            "",
        ] {
            assert!(
                !is_permission_granted("notifications", Some(url), None),
                "{url}"
            );
        }
        assert!(!is_permission_granted("notifications", None, None));
    }

    #[test]
    fn os_handled_urls() {
        assert!(is_os_handled_url("https://trackyourtime.dev/docs/"));
        assert!(is_os_handled_url("http://localhost:5159/"));
        assert!(is_os_handled_url("mailto:support@example.com"));
        for url in [
            "file:///etc/hosts",
            "app://-/",
            "javascript:alert(1)",
            "data:text/html,x",
            "smb://host/share",
            "x-apple.systempreferences:",
            "not a url",
        ] {
            assert!(!is_os_handled_url(url), "{url}");
        }
    }
}
