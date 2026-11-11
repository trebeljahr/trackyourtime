//! Where an app-protocol request is answered from, as a pure function over a
//! file-existence probe. Ported from `electron/src/resolve-app-path.ts`.
//!
//! The rules are `packages/client/serve.mjs`'s, because the export is the
//! same bytes and `trailingSlash: true` is where the asset-path bugs live:
//!
//! ```text
//!   /                 → index.html
//!   /app/track/       → app/track/index.html
//!   /app/track        → app/track/index.html (a directory without the slash)
//!   /privacy          → privacy.html, when only that exists
//!   /_next/static/x   → the file itself
//!   anything else     → 404.html with a 404 status
//! ```
//!
//! A request may never leave the export: `..`, encoded `%2e%2e`, encoded
//! separators and NUL bytes are refused before anything is looked up. A
//! malformed percent-escape is a bad request, not a path.
//!
//! Paths here are logical export paths without a leading slash
//! (`app/track/index.html`): the shell serves the export embedded in the
//! binary, so there is no filesystem root to escape from — but the same
//! refusals keep a future on-disk variant safe.

use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppPathResolution {
    Ok { file: String },
    NotFound { file: Option<String> },
    BadRequest,
}

impl AppPathResolution {
    pub fn status(&self) -> u16 {
        match self {
            AppPathResolution::Ok { .. } => 200,
            AppPathResolution::NotFound { .. } => 404,
            AppPathResolution::BadRequest => 400,
        }
    }

    pub fn file(&self) -> Option<&str> {
        match self {
            AppPathResolution::Ok { file } => Some(file),
            AppPathResolution::NotFound { file } => file.as_deref(),
            AppPathResolution::BadRequest => None,
        }
    }
}

/// `expected_host` is the scheme's host (`-` for `app://-`, `app.localhost`
/// for Windows' `http://app.localhost`); any other host is not this app.
pub fn resolve_app_path(
    request_url: &str,
    expected_host: &str,
    is_file: impl Fn(&str) -> bool,
) -> AppPathResolution {
    let Ok(url) = Url::parse(request_url) else {
        return AppPathResolution::BadRequest;
    };
    if url.host_str().unwrap_or("") != expected_host {
        return not_found(&is_file);
    }
    let Some(decoded) = percent_decode_strict(url.path()) else {
        return AppPathResolution::BadRequest;
    };
    if decoded.contains('\0') {
        return AppPathResolution::BadRequest;
    }
    // Split on BOTH separators: a decoded "%5C" is a separator on Windows,
    // so "..\\" must be caught on every OS.
    let segments: Vec<&str> = decoded
        .split(['/', '\\'])
        .filter(|s| !s.is_empty() && *s != ".")
        .collect();
    if segments.contains(&"..") {
        return AppPathResolution::BadRequest;
    }
    let candidate = segments.join("/");
    if !candidate.is_empty() && is_file(&candidate) {
        return AppPathResolution::Ok { file: candidate };
    }
    let as_index = if candidate.is_empty() {
        "index.html".to_string()
    } else {
        format!("{candidate}/index.html")
    };
    if is_file(&as_index) {
        return AppPathResolution::Ok { file: as_index };
    }
    if !candidate.is_empty() {
        let as_html = format!("{candidate}.html");
        if is_file(&as_html) {
            return AppPathResolution::Ok { file: as_html };
        }
    }
    not_found(&is_file)
}

fn not_found(is_file: &impl Fn(&str) -> bool) -> AppPathResolution {
    AppPathResolution::NotFound {
        file: is_file("404.html").then(|| "404.html".to_string()),
    }
}

/// `decodeURIComponent`: refuses a malformed escape or invalid UTF-8.
fn percent_decode_strict(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let valid = i + 2 < bytes.len()
                && bytes.get(i + 1).is_some_and(u8::is_ascii_hexdigit)
                && bytes.get(i + 2).is_some_and(u8::is_ascii_hexdigit);
            if !valid {
                return None;
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    percent_encoding::percent_decode_str(input)
        .decode_utf8()
        .ok()
        .map(|s| s.into_owned())
}

pub fn content_type_for(file: &str) -> &'static str {
    let ext = file
        .rsplit('/')
        .next()
        .and_then(|name| name.rsplit_once('.'))
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        // Next's RSC payloads for client-side navigation (`index.txt`).
        "txt" => "text/plain; charset=utf-8",
        "webmanifest" => "application/manifest+json",
        "xml" => "application/xml; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILES: [&str; 9] = [
        "index.html",
        "404.html",
        "app/track/index.html",
        "app/track/index.txt",
        "app/reports/index.html",
        "privacy.html",
        "_next/static/chunks/main.js",
        "marketing/popup.png",
        "with space/index.html",
    ];

    fn resolve(url: &str) -> AppPathResolution {
        resolve_app_path(url, "-", |p| FILES.contains(&p))
    }

    fn ok(file: &str) -> AppPathResolution {
        AppPathResolution::Ok { file: file.into() }
    }

    fn missing() -> AppPathResolution {
        AppPathResolution::NotFound {
            file: Some("404.html".into()),
        }
    }

    #[test]
    fn serves_index_html_at_the_root() {
        assert_eq!(resolve("app://-/"), ok("index.html"));
        assert_eq!(resolve("app://-"), ok("index.html"));
    }

    #[test]
    fn resolves_routes_with_and_without_the_trailing_slash() {
        assert_eq!(resolve("app://-/app/track/"), ok("app/track/index.html"));
        assert_eq!(resolve("app://-/app/reports"), ok("app/reports/index.html"));
    }

    #[test]
    fn falls_back_to_dot_html() {
        assert_eq!(resolve("app://-/privacy"), ok("privacy.html"));
    }

    #[test]
    fn serves_files_as_themselves_ignoring_query_and_fragment() {
        assert_eq!(
            resolve("app://-/_next/static/chunks/main.js"),
            ok("_next/static/chunks/main.js")
        );
        assert_eq!(
            resolve("app://-/app/track/index.txt"),
            ok("app/track/index.txt")
        );
        assert_eq!(
            resolve("app://-/app/track/index.txt?_rsc=abc123"),
            ok("app/track/index.txt")
        );
        assert_eq!(
            resolve("app://-/app/track/?next=%2Fapp#top"),
            ok("app/track/index.html")
        );
    }

    #[test]
    fn decodes_percent_encoding() {
        assert_eq!(
            resolve("app://-/with%20space/"),
            ok("with space/index.html")
        );
    }

    #[test]
    fn answers_unknown_paths_with_the_404_page() {
        assert_eq!(resolve("app://-/no/such/page/"), missing());
        assert_eq!(resolve("app://-/app/"), missing());
        assert_eq!(resolve("app://-/_next/static/").status(), 404);
        let bare = resolve_app_path("app://-/missing", "-", |p| p == "index.html");
        assert_eq!(bare, AppPathResolution::NotFound { file: None });
    }

    #[test]
    fn never_resolves_outside_the_export() {
        for url in [
            "app://-/%2e%2e/%2e%2e/etc/passwd",
            "app://-/app/%2E%2E/%2E%2E/secret",
            "app://-/..%2f..%2fsecret",
            "app://-/..%5c..%5csecret",
            "app://-/app/track/%2e%2e%2f%2e%2e%2f%2e%2e%2fsecret",
        ] {
            let result = resolve(url);
            assert_ne!(result.status(), 200, "{url}");
            assert!(
                result.file().is_none() || result.file() == Some("404.html"),
                "{url}"
            );
        }
        assert_eq!(
            resolve("app://-/..%2f..%2fsecret"),
            AppPathResolution::BadRequest
        );
        assert_eq!(
            resolve("app://-/..%5c..%5csecret"),
            AppPathResolution::BadRequest
        );
        assert_eq!(resolve("app://-/app/../index.html"), ok("index.html"));
    }

    #[test]
    fn refuses_malformed_escapes_and_nul() {
        assert_eq!(resolve("app://-/%E0%A4%A"), AppPathResolution::BadRequest);
        assert_eq!(
            resolve("app://-/index.html%00.png"),
            AppPathResolution::BadRequest
        );
    }

    #[test]
    fn does_not_answer_another_host_or_garbage() {
        assert_eq!(resolve("app://evil/index.html"), missing());
        assert_eq!(resolve("not a url"), AppPathResolution::BadRequest);
    }

    #[test]
    fn serves_the_windows_origin_from_its_host() {
        let win = |url: &str| resolve_app_path(url, "app.localhost", |p| FILES.contains(&p));
        assert_eq!(
            win("http://app.localhost/app/track/"),
            ok("app/track/index.html")
        );
        assert_eq!(win("http://evil.localhost/index.html"), missing());
    }

    #[test]
    fn content_types() {
        assert_eq!(content_type_for("a/index.html"), "text/html; charset=utf-8");
        assert_eq!(content_type_for("x.JS"), "text/javascript; charset=utf-8");
        assert_eq!(content_type_for("index.txt"), "text/plain; charset=utf-8");
        assert_eq!(content_type_for("font.woff2"), "font/woff2");
        assert_eq!(content_type_for("blob.bin"), "application/octet-stream");
        assert_eq!(content_type_for("dir.d/README"), "application/octet-stream");
    }
}
