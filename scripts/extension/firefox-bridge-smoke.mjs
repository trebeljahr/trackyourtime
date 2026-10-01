/**
 * Real Firefox transport check with the unmodified production add-on and fake accounts.
 * Build shared/core and build:extension:firefox first. Requires openssl, FIREFOX_BINARY
 * and GECKODRIVER. All hosted URLs are intercepted by a loopback HTTPS fixture proxy;
 * no hosted account, user browser profile, or remote service is used.
 */
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { API_LEVEL, MIN_CLIENT_API_LEVEL } from "../../packages/shared/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const addon = resolve(root, "packages/extension/dist-firefox");
const id = "trackyourtime@ricoslabs.com";
const temp = await mkdtemp(resolve(tmpdir(), "firefox-bridge-smoke-"));
const WEB = "https://trackyourtime.dev";
const API = "https://api.trackyourtime.dev";
let driver, driverPort, sessionId;
const sockets = new Set();
const servers = [];
let issued = 0, approvedUser = null;
const sessions = new Map();
const calls = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listen(server) {
  servers.push(server);
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  // Ask the OS for an unused high port, without disturbing other servers.
  await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  return server.address().port;
}
async function wd(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${driverPort}${path}`, {
    method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result.value;
}
const command = (path, body) => wd("POST", `/session/${sessionId}${path}`, body);
const js = (script, args = []) => command("/execute/sync", { script, args });
const asyncJs = (script, args = []) => command("/execute/async", { script, args });

try {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${temp}/key.pem`, "-out", `${temp}/cert.pem`, "-days", "1", "-subj", "/CN=trackyourtime.dev", "-addext", "subjectAltName=DNS:trackyourtime.dev,DNS:api.trackyourtime.dev"], { stdio: "ignore" });
  const bundle = await build({
    stdin: { contents: 'export { sendThroughPageRelay, pageRelayAvailable } from "./packages/client/src/lib/extension-bridge-transport.ts"; export { syncWithExtensions } from "./packages/client/src/lib/extension-bridge.ts";', resolveDir: root },
    bundle: true, format: "iife", globalName: "Bridge", platform: "browser", write: false,
    define: { "process.env.NEXT_PUBLIC_EXTENSION_IDS": "undefined" },
  });
  const page = `<!doctype html><title>Firefox bridge fixture</title><script>${bundle.outputFiles[0].text}</script>`;
  const api = https.createServer({ key: await readFile(`${temp}/key.pem`), cert: await readFile(`${temp}/cert.pem`) }, async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const path = new URL(req.url, API).pathname;
    const origin = req.headers.origin;
    if (origin) res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-headers", req.headers["access-control-request-headers"] ?? "content-type,authorization");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    if (req.headers.host === "trackyourtime.dev") {
      res.setHeader("content-type", "text/html"); res.end(page); return;
    }
    calls.push({ path, cookie: Boolean(req.headers.cookie), bearer: Boolean(req.headers.authorization) });
    const json = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    if (path === "/api/health") return json({ status: "ok", service: "trackyourtime", webUrl: WEB, originTrusted: true, apiLevel: API_LEVEL, minClientApiLevel: MIN_CLIENT_API_LEVEL });
    if (path === "/api/auth/device/code") {
      issued++;
      return json({ device_code: `device-${issued}`, user_code: "ABCDEFGH", verification_uri: WEB, verification_uri_complete: `${WEB}/app/device?user_code=ABCDEFGH`, expires_in: 1800, interval: 1 });
    }
    if (path === "/api/auth/device/token") {
      if (!approvedUser) return json({ error: "authorization_pending" }, 400);
      const access_token = `fixture-token-${issued}`;
      sessions.set(access_token, { id: approvedUser, email: `${approvedUser}@example.test` });
      approvedUser = null;
      return json({ access_token, token_type: "Bearer", expires_in: 3600 });
    }
    if (path === "/api/auth/get-session") return json(sessions.has(token) ? { user: sessions.get(token), session: {} } : null);
    if (path === "/api/auth/sign-out") { sessions.delete(token); return json({ success: true }); }
    if (path.startsWith("/api/trpc/")) {
      const proc = path.slice("/api/trpc/".length);
      let data = [];
      if (proc === "workspaces.list") data = [{ id: "ws-1", name: "Fixture", role: "member", memberCount: 1, isDefault: true, permissions: {} }];
      if (proc === "settings.get") data = { userId: sessions.get(token)?.id, workspaceId: "ws-1" };
      if (proc === "entries.current" || req.method === "POST") data = null;
      if (proc === "entries.list") data = { entries: [], nextCursor: null };
      return json({ result: { data } });
    }
    return json({}, 404);
  });
  api.on("tlsClientError", () => {});
  const apiPort = await listen(api);
  const proxy = http.createServer((_req, res) => { res.writeHead(502); res.end(); });
  proxy.on("connect", (req, client, head) => {
    if (!["trackyourtime.dev:443", "api.trackyourtime.dev:443"].includes(req.url)) { client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); return; }
    const upstream = net.connect(apiPort, "127.0.0.1", () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); client.pipe(upstream).pipe(client); });
    sockets.add(upstream); upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => client.destroy()); client.on("error", () => upstream.destroy());
  });
  const proxyPort = await listen(proxy);
  const reserve = net.createServer();
  await new Promise((done) => reserve.listen(0, "127.0.0.1", done));
  driverPort = reserve.address().port;
  await new Promise((done) => reserve.close(done));
  driver = spawn(process.env.GECKODRIVER ?? "geckodriver", ["--port", String(driverPort), "--host", "127.0.0.1", "--allow-system-access"], { env: { ...process.env, MOZ_HEADLESS: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let driverLog = "";
  driver.stdout.on("data", (chunk) => { driverLog += chunk; });
  driver.stderr.on("data", (chunk) => { driverLog += chunk; });
  driver.on("error", (error) => { driverLog += error.message; });
  for (let i = 0; i < 100; i++) { try { await wd("GET", "/status"); break; } catch { if (i === 99) throw new Error(driverLog); await sleep(100); } }
  const session = await wd("POST", "/session", { capabilities: { alwaysMatch: {
    browserName: "firefox", acceptInsecureCerts: true,
    proxy: { proxyType: "manual", httpProxy: `127.0.0.1:${proxyPort}`, sslProxy: `127.0.0.1:${proxyPort}`, noProxy: [] },
    "moz:firefoxOptions": { binary: process.env.FIREFOX_BINARY, args: ["-headless"], prefs: { "network.trr.mode": 5, "network.dns.disablePrefetch": true, "network.prefetch-next": false, "browser.startup.page": 0 } },
  } } });
  sessionId = session.sessionId;
  console.log(`Firefox ${session.capabilities.browserVersion}; isolated temporary profile`);
  await command("/moz/addon/install", { path: addon, temporary: true });
  await command("/moz/context", { context: "chrome" });
  const popupUrl = await js(`return WebExtensionPolicy.getByID(arguments[0]).getURL("src/popup/index.html")`, [id]);
  await command("/moz/context", { context: "content" });
  await command("/url", { url: `${WEB}/app` });
  const webHandle = await wd("GET", `/session/${sessionId}/window`);
  assert.equal(await js("return Bridge.pageRelayAvailable()"), true);
  await js('window.bridgeMessages = []; window.addEventListener("message", event => { if (event.data?.channel === "trackyourtime.extension-relay") window.bridgeMessages.push(event.data); });');
  await command("/window/new", { type: "tab" });
  const handles = await wd("GET", `/session/${sessionId}/window/handles`);
  const popupHandle = handles.find((handle) => handle !== webHandle);
  async function popupMessage(message) {
    await command("/window", { handle: popupHandle });
    if (await wd("GET", `/session/${sessionId}/url`) !== popupUrl) await command("/url", { url: popupUrl });
    return asyncJs("const done = arguments[arguments.length - 1]; chrome.runtime.sendMessage(arguments[0], done);", [message]);
  }
  async function sync(userId, apiOrigin = API, createdAt = Date.now()) {
    await command("/window", { handle: webHandle });
    approvedUser = userId;
    return asyncJs(`const done = arguments[arguments.length - 1];
      const session = arguments[0] ? { userId: arguments[0], createdAt: arguments[2] } : null;
      Bridge.syncWithExtensions({ ids: ["${id}"], apiOrigin: arguments[1], session, currentSession: () => session,
        send: async (_id, message) => { const reply = await Bridge.sendThroughPageRelay(message); window.lastBridgeReply = reply; return reply; }, approve: async () => true,
        signOutWeb: async () => { window.webSignOutRequested = true; }, now: Date.now }).then(done, error => done({ error: String(error) }));`, [userId, apiOrigin, createdAt]);
  }
  const initial = await popupMessage({ type: "state:get" });
  assert.equal(initial.ok, true);
  assert.equal(initial.state.signedIn, false);
  assert.equal(await js('return Boolean(document.querySelector("[data-testid=open-web-app]"))'), true);
  const first = await sync("user-u");
  assert.deepEqual(first, ["approved"], JSON.stringify({ reply: await js("return window.lastBridgeReply"), calls }));
  let state = await popupMessage({ type: "state:get" });
  assert.equal(state.state.email, "user-u@example.test");
  assert.deepEqual(await sync("user-v"), ["approved"]);
  state = await popupMessage({ type: "state:get" });
  assert.equal(state.state.email, "user-v@example.test");
  assert.deepEqual(await sync(null), ["nothing-to-do"]);
  state = await popupMessage({ type: "state:get" });
  assert.equal(state.state.signedIn, false);
  const before = issued;
  assert.deepEqual(await sync("user-u", "https://other.example.test"), ["nothing-to-do"]);
  assert.equal(issued, before);
  await command("/window", { handle: webHandle });
  // A real same-origin iframe must not get a relay, even on the allowlisted host.
  await asyncJs('const done = arguments[arguments.length - 1]; const frame = document.createElement("iframe"); frame.src = "/framed"; frame.onload = () => done(); document.body.append(frame);');
  const frameReply = await asyncJs(`const done = arguments[arguments.length - 1]; const frame = document.querySelector("iframe").contentWindow;
    frame.postMessage({ channel: "trackyourtime.extension-relay", direction: "request", id: "frame-request-1234", payload: { channel: "trackyourtime.extension-bridge", v: 1, kind: "sync", apiOrigin: "${API}", web: { userId: "evil", sessionCreatedAt: Date.now() } } }, "${WEB}");
    let answered = false; frame.addEventListener("message", event => { if (event.data.direction === "reply") answered = true; }); setTimeout(() => done(answered), 300);`);
  assert.equal(frameReply, false);
  assert.equal(issued, before);
  const oldSession = Date.now() - 60_000;
  assert.deepEqual(await sync("user-u", API, oldSession), ["approved"]);
  await popupMessage({ type: "auth:sign-out" });
  assert.deepEqual(await sync("user-u", API, oldSession), ["signed-out-web"]);
  assert.equal(await js("return window.webSignOutRequested"), true);
  const pageMessages = await js("return JSON.stringify(window.bridgeMessages)");
  assert.equal(pageMessages.includes("fixture-token-"), false);
  assert.equal(pageMessages.includes("device_code"), false);
  state = await popupMessage({ type: "state:get" });
  assert.equal(state.state.signedIn, false);
  assert.equal(calls.some((call) => call.cookie), false);
  console.log("PASS: automatic connection, account switch, web sign-out, server binding, iframe isolation, hosted popup, explicit extension sign-out, no API cookies");
} finally {
  if (sessionId) await wd("DELETE", `/session/${sessionId}`).catch(() => {});
  if (driver && driver.exitCode === null) { driver.kill("SIGTERM"); await Promise.race([new Promise((r) => driver.once("exit", r)), sleep(3000)]); if (driver.exitCode === null) driver.kill("SIGKILL"); }
  if (driver?.pid) { try { process.kill(-driver.pid, "SIGTERM"); } catch { /* Already stopped. */ } }
  for (const socket of sockets) socket.destroy();
  for (const server of servers) await new Promise((r) => server.close(r));
  await rm(temp, { recursive: true, force: true });
}
