//! Page errors and CSP violations, collected by an initialization script the
//! way Playwright's `pageerror` and console events did, for the e2e channel
//! and the smoke report.

/// Extra initialization script: collect page errors and CSP violations the
/// way Playwright's `pageerror` and console events did.
pub const SCRIPT: &str = r#"(function () {
  if (window !== window.top || window.__TYT_E2E_PROBLEMS__) return;
  var problems = [];
  Object.defineProperty(window, "__TYT_E2E_PROBLEMS__", { value: problems });
  window.addEventListener("error", function (e) { problems.push("pageerror: " + (e.message || String(e.error))); });
  window.addEventListener("unhandledrejection", function (e) { problems.push("pageerror: " + String(e.reason && e.reason.message || e.reason)); });
  // A blocked eval either throws (and is a pageerror) or was a deliberate,
  // caught probe (zod 4 tests `Function("")` once), so it is not reported.
  document.addEventListener("securitypolicyviolation", function (e) { if (e.blockedURI === "eval") return; problems.push("csp: Refused to load " + e.blockedURI + " (" + e.violatedDirective + ") at " + e.sourceFile + ":" + e.lineNumber + ":" + e.columnNumber); });
  var error = console.error;
  console.error = function () {
    var text = Array.prototype.map.call(arguments, String).join(" ");
    if (/Content Security Policy|Refused to (load|execute|connect|apply)/i.test(text)) problems.push("csp: " + text);
    return error.apply(console, arguments);
  };
})();"#;

/// Smoke mode (`TRACKYOURTIME_SMOKE_REPORT=<path>`, release builds too): once
/// the page has rendered, report what loaded and exit. The Linux package
/// smoke tests run an installed deb/rpm/AppImage this way; there is no CDP to
/// probe a system WebView with.
pub const SMOKE_ENV: &str = "TRACKYOURTIME_SMOKE_REPORT";

pub const SMOKE_SCRIPT: &str = r#"(function () {
  var started = Date.now();
  function report() {
    var text = (document.body && document.body.innerText) || "";
    if (text.trim().length === 0 && Date.now() - started < 15000) return setTimeout(report, 250);
    var problems = (window.__TYT_E2E_PROBLEMS__ || []).slice();
    var bridge = !!(window.electronAPI && window.electronAPI.isDesktop === true);
    window.__TAURI_INTERNALS__.invoke("desktop_call", { channel: "smoke:report", args: [{
      ok: bridge && text.trim().length > 0 && problems.length === 0,
      href: location.href, title: document.title, bridge: bridge,
      platform: bridge ? window.electronAPI.platform : null,
      bodyText: text.length, problems: problems,
      storageMarker: (function () { try { return localStorage.getItem("installed-release-qa"); } catch (e) { return null; } })()
    }] });
  }
  setTimeout(report, 1500);
})();"#;
