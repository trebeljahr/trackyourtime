/*
 * The Content-Security-Policy every HTML document from `app://-` is served
 * with. A response header set by protocol.ts rather than a <meta> in the
 * export, so the web build's HTML stays byte-identical.
 *
 * - script-src needs 'unsafe-inline': the static export inlines the pre-paint
 *   scripts (app/pre-paint.ts) and Next's RSC payload (`self.__next_f.push`).
 *   No remote script host is allowed, so the optional analytics snippets that
 *   load from a third-party host do not run in the desktop app.
 * - connect-src is any https/wss origin because the server picker lets a
 *   person point the app at any Track Your Time server, plus plain http/ws on
 *   loopback for a local API.
 * - Nothing may frame the app or be framed by it, and forms post nowhere.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss: http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*",
  "worker-src 'self' blob:",
  "media-src 'self' blob: data:",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");
