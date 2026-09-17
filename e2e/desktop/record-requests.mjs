/*
 * Preloaded into the harness's API process (`node --import`), so the specs can
 * read what reached the SERVER — the only place the "no Cookie header" claim
 * can be proved. A browser-side check would miss a cookie added by the network
 * stack after the page's fetch, and Electron's webRequest does not report the
 * WebSocket upgrade at all (Stage 0).
 *
 * Every HTTP request and upgrade is appended to DESKTOP_E2E_REQUEST_LOG as one
 * JSON line. Header VALUES of credentials are never written: only whether a
 * cookie was present, and the authorization scheme.
 */
import { appendFileSync } from "node:fs";
import http from "node:http";

const logPath = process.env.DESKTOP_E2E_REQUEST_LOG;

if (logPath) {
  const originalEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function emit(event, ...args) {
    if (event === "request" || event === "upgrade") {
      const [req] = args;
      const headers = req.headers ?? {};
      const authorization = typeof headers.authorization === "string" ? headers.authorization : "";
      const line = {
        at: Date.now(),
        kind: event,
        method: req.method,
        url: req.url,
        origin: headers.origin ?? null,
        // The specs' own Node helpers mark themselves, so "from the app" can
        // exclude them even though they send the app's Origin.
        harness: headers["user-agent"] === "desktop-e2e-harness",
        client: headers["x-trackyourtime-client"] ?? null,
        cookie: typeof headers.cookie === "string" && headers.cookie.length > 0,
        authorization: authorization ? authorization.split(" ")[0] : null,
        protocol: event === "upgrade" ? String(headers["sec-websocket-protocol"] ?? "").split(".")[0] || null : null,
      };
      try {
        appendFileSync(logPath, `${JSON.stringify(line)}\n`);
      } catch {
        /* a lost log line fails the spec that needed it, never the server */
      }
    }
    return originalEmit.call(this, event, ...args);
  };
}
