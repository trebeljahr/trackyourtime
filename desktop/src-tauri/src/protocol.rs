//! The app protocol: the static export, embedded in the binary, served as
//! `app://-` (macOS, Linux) or `http://app.localhost` (Windows).
//!
//! Why a scheme of our own rather than Tauri's `tauri://localhost`: the
//! Electron build served the same export from `app://-`, and the origin is the
//! key of localStorage and of every server's TRUSTED_ORIGINS. Keeping it means
//! an update leaves the server side untouched on macOS and Linux. Never change
//! the scheme or host once released.
//!
//! Paths follow `serve.mjs` (tyt_model::resolve_app_path). HTML gets the CSP
//! as a response header, so the web export's bytes stay identical.

use std::borrow::Cow;
use std::sync::Arc;
use tauri::http::{header, Response, StatusCode};
use tauri::utils::assets::AssetKey;
use tyt_model::resolve_app_path::{content_type_for, resolve_app_path, AppPathResolution};

pub type SharedAssets = Arc<Box<dyn tauri::Assets<tauri::Wry>>>;

/// Tauri's own protocol keeps working off the same assets (nothing loads it;
/// the navigation guard refuses it), while ours answers from them exactly.
pub struct ForwardAssets(pub SharedAssets);

impl tauri::Assets<tauri::Wry> for ForwardAssets {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        self.0.get(key)
    }
    fn iter(&self) -> Box<tauri::utils::assets::AssetsIter<'_>> {
        self.0.iter()
    }
    fn csp_hashes(
        &self,
        html_path: &AssetKey,
    ) -> Box<dyn Iterator<Item = tauri::utils::assets::CspHash<'_>> + '_> {
        self.0.csp_hashes(html_path)
    }
}

pub fn app_host() -> &'static str {
    if cfg!(windows) {
        "app.localhost"
    } else {
        tyt_wire::DESKTOP_APP_HOST
    }
}

pub fn handle(
    assets: &SharedAssets,
    request: &tauri::http::Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    let method = request.method().as_str();
    if method != "GET" && method != "HEAD" {
        return Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .header(header::ALLOW, "GET, HEAD")
            .body(Cow::Borrowed(&[][..]))
            .unwrap();
    }
    let url = request.uri().to_string();
    let exists = |path: &str| assets.get(&AssetKey::from(path)).is_some();
    let resolved = resolve_app_path(&url, app_host(), exists);
    let status = resolved.status();
    let Some(file) = resolved.file().map(String::from) else {
        let text: &'static [u8] = if matches!(resolved, AppPathResolution::BadRequest) {
            b"Bad request"
        } else {
            b"Not found"
        };
        return Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(Cow::Borrowed(text))
            .unwrap();
    };
    let body = assets
        .get(&AssetKey::from(file.as_str()))
        .map(|b| b.into_owned())
        .unwrap_or_default();
    let kind = content_type_for(&file);
    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, kind)
        .header("x-content-type-options", "nosniff")
        .header(header::CACHE_CONTROL, "no-cache");
    if kind.starts_with("text/html") {
        response = response.header("content-security-policy", tyt_model::csp::app_csp());
    }
    let body = if method == "HEAD" { Vec::new() } else { body };
    response.body(Cow::Owned(body)).unwrap()
}
