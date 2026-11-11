import { createHash, createHmac } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DesktopApp, DesktopPage, expect, Locator } from "./driver";

export { expect, Locator };
export type { DesktopApp, DesktopPage };
/** Playwright's name, which the specs and helpers use for the page. */
export type Page = DesktopPage;

export const REPO_ROOT = resolve(__dirname, "..", "..");
export const EXPORT_DIR = join(REPO_ROOT, "packages", "client", "out-desktop");
/** Written by `scripts/build-desktop.mjs --e2e` (global-setup.ts runs it). */
export const E2E_BINARY_INFO = join(REPO_ROOT, "desktop", "target", "e2e-binary.json");

/**
 * The API the export is built against. Fixed rather than random, because the
 * URL is baked into the export and a random port would rebuild it every run.
 * Override with DESKTOP_E2E_API_PORT when it is taken.
 */
export const API_PORT = Number(process.env.DESKTOP_E2E_API_PORT ?? "49764");
export const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
/** The document origin the app runs at (desktop/src-tauri/src/protocol.rs). */
export const APP_ORIGIN = process.platform === "win32" ? "http://app.localhost" : "app://-";
/** `APP_ORIGIN` as a RegExp source, for URL assertions. */
export const APP_ORIGIN_RE = APP_ORIGIN.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The debug build with the e2e control channel, as global setup built it. */
export function desktopExecutable(): string {
  if (!existsSync(E2E_BINARY_INFO)) throw new Error(`No ${E2E_BINARY_INFO}; run through the desktop Playwright config (its global setup builds the app)`);
  const { path } = JSON.parse(readFileSync(E2E_BINARY_INFO, "utf8")) as { path: string };
  if (!existsSync(path)) throw new Error(`No desktop binary at ${path}; run: node scripts/build-desktop.mjs --e2e`);
  return path;
}

export function freshUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), "tyt-desktop-e2e-"));
}

export function launchEnv(userDataDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // Never the dev URL: these specs are about the app:// build.
  delete env.TRACKYOURTIME_DEV_URL;
  delete env.TRACKYOURTIME_SMOKE_REPORT;
  env.TRACKYOURTIME_USER_DATA_DIR = userDataDir;
  // Never show, focus or activate a window while tests run on somebody's
  // machine (desktop/src-tauri/src/window.rs).
  env.TRACKYOURTIME_HEADLESS = "1";
  return env;
}

/**
 * Uncaught page errors and CSP violations since the document loaded, as
 * collected in the page (desktop/src-tauri/src/problems.rs). A route can
 * "render" its shell while its own chunk was blocked, so the navigation specs
 * assert this stays empty.
 */
export function pageProblems(page: Page): Promise<string[]> {
  return page.problems();
}

/**
 * macOS keeps a WebKit data store per profile (window.rs →
 * data_store_identifier); a test profile's store is removed when its run ends.
 */
function webkitStoreDir(executable: string, userDataDir: string): string | null {
  if (process.platform !== "darwin") return null;
  const digest = createHash("sha256").update(userDataDir).digest();
  const id = Buffer.from(digest.subarray(0, 16));
  id[6] = (id[6] & 0x0f) | 0x80;
  id[8] = (id[8] & 0x3f) | 0x80;
  const hex = id.toString("hex");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return join(homedir(), "Library", "WebKit", basename(executable), "WebsiteDataStore", uuid);
}

/**
 * Every store a run created, for global-setup's teardown to remove
 * (DESKTOP_E2E_STORE_LOG). The `exit` hook is only a fallback: Playwright
 * stops its workers without letting it run.
 */
const launched = new Set<string>();
process.once("exit", () => {
  for (const dir of launched) rmSync(dir, { recursive: true, force: true });
});

export function removeWebkitStores(log: string): void {
  if (!existsSync(log)) return;
  const root = join(homedir(), "Library", "WebKit");
  for (const dir of readFileSync(log, "utf8").split("\n")) {
    if (dir.startsWith(`${root}/`) && dir.includes("/WebsiteDataStore/")) rmSync(dir, { recursive: true, force: true });
  }
}

export async function launchApp(userDataDir = freshUserDataDir(), args: string[] = []): Promise<{
  app: DesktopApp;
  page: DesktopPage;
  userDataDir: string;
}> {
  const executable = desktopExecutable();
  const store = webkitStoreDir(executable, userDataDir);
  if (store) {
    launched.add(store);
    if (process.env.DESKTOP_E2E_STORE_LOG) appendFileSync(process.env.DESKTOP_E2E_STORE_LOG, `${store}\n`);
  }
  const app = await DesktopApp.launch({ executable, args, env: launchEnv(userDataDir), userDataDir });
  const page = app.page;
  await page.waitForLoadState("domcontentloaded");
  return { app, page, userDataDir };
}

/**
 * The signed-in destinations, read out of `NAV_SECTIONS` in app-shell.tsx
 * rather than copied, so a new screen is covered the day it is added. Parsed
 * as text: importing the module would pull React and lucide into Node.
 */
export function navDestinations(): { id: string; href: string }[] {
  const source = readFileSync(join(REPO_ROOT, "packages/client/src/components/app-shell.tsx"), "utf8");
  const start = source.indexOf("export const NAV_SECTIONS");
  const end = source.indexOf("];", start);
  const block = source.slice(start, end);
  // Shell-only items (`shell: "electron"`) show only where their feature
  // works on this machine; activity.spec.ts covers /app/activity itself.
  const items = [...block.matchAll(/\{\s*href:\s*"([^"]+)",\s*id:\s*"([^"]+)"[^}]*\}/g)]
    .filter((m) => !/\bshell:/.test(m[0]))
    .map((m) => ({
      href: m[1],
      id: m[2],
    }));
  if (items.length < 5) throw new Error(`NAV_SECTIONS parse found only ${items.length} items`);
  return items;
}

export type Account = { email: string; password: string; name: string };

/** Marks the harness's own requests in the server log (record-requests.mjs). */
export const HARNESS_UA = "desktop-e2e-harness";

/** A fresh account on the harness API (or `origin`), created from Node. */
export async function createAccount(origin = API_ORIGIN): Promise<Account> {
  const account = {
    email: `desktop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    password: "desktop-e2e-password-1",
    name: "Desktop E2E",
  };
  const response = await fetch(`${origin}/api/auth/sign-up/email`, {
    method: "POST",
    // Node's fetch sends `Sec-Fetch-Mode: cors`, which makes better-auth
    // demand a trusted Origin; the harness API trusts the app's.
    headers: { "content-type": "application/json", origin: APP_ORIGIN, "user-agent": HARNESS_UA },
    body: JSON.stringify(account),
  });
  if (!response.ok) throw new Error(`sign-up failed: ${response.status} ${await response.text()}`);
  return account;
}

/**
 * A second session for the same account, standing in for "the web app on
 * another machine": a bearer token labelled `web`. Everything a spec does
 * "from the web" goes through it, so the desktop app's own session stays the
 * only thing under test.
 */
export async function webSession(account: Account, origin = API_ORIGIN): Promise<string> {
  const response = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      "x-trackyourtime-client": "web",
      "user-agent": HARNESS_UA,
    },
    body: JSON.stringify({ email: account.email, password: await passwordForApi(account, origin) }),
  });
  const token = response.headers.get("set-auth-token");
  if (!response.ok || !token) throw new Error(`sign-in failed: ${response.status} ${await response.text()}`);
  return token;
}

/**
 * What a raw HTTP call must send as the password. Signing in through the
 * app's form upgrades the account to password unlock, after which the server
 * accepts only the derived login secret, never the typed password. Mirrors
 * core's `signInWithPassword` and `e2e/helpers.ts` `passwordForApi`
 * (docs/private-workspace-protocol.md → "Password unlock").
 */
export async function passwordForApi(account: Account, origin = API_ORIGIN): Promise<string> {
  const { derivePasswordKeys } = await import("../../packages/core/src/privacy/crypto");
  const response = await fetch(
    `${origin}/api/trpc/accountPassword.kdf?input=${encodeURIComponent(JSON.stringify({ email: account.email }))}`,
    { headers: { "user-agent": HARNESS_UA } },
  );
  const answer = (await response.json()).result?.data as
    | { state: string; kdf: Parameters<typeof derivePasswordKeys>[1] }
    | undefined;
  if (!answer || answer.state !== "ready") return account.password;
  return (await derivePasswordKeys(account.password, answer.kdf)).loginSecret;
}

/** An auth API call as that web session. */
export async function authCall(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
  origin = API_ORIGIN,
): Promise<{ status: number; body: unknown; token: string | null }> {
  const response = await fetch(`${origin}/api/auth${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      authorization: `Bearer ${token}`,
      "x-trackyourtime-client": "web",
      "user-agent": HARNESS_UA,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: response.status, body, token: response.headers.get("set-auth-token") };
}

/** A tRPC query or mutation as that web session; returns `result.data.json ?? result.data`. */
export async function trpcCall<T = unknown>(
  token: string,
  path: string,
  input: unknown,
  kind: "query" | "mutation",
  origin = API_ORIGIN,
): Promise<T> {
  const headers = {
    "content-type": "application/json",
    origin: APP_ORIGIN,
    authorization: `Bearer ${token}`,
    "x-trackyourtime-client": "web",
    "user-agent": HARNESS_UA,
  };
  const url = `${origin}/api/trpc/${path}`;
  const response =
    kind === "query"
      ? await fetch(`${url}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`, { headers })
      : await fetch(url, { method: "POST", headers, body: JSON.stringify(input ?? {}) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${text}`);
  const parsed = JSON.parse(text) as { result?: { data?: { json?: T } | T } };
  const data = parsed.result?.data as { json?: T } | T | undefined;
  return (data && typeof data === "object" && "json" in (data as object) ? (data as { json: T }).json : data) as T;
}

/** Sign in through the app's own login form, as a person would. */
export async function signInThroughForm(page: Page, account: Account): Promise<void> {
  await expectLoginForm(page);
  await page.getByTestId("login-email").fill(account.email);
  await page.getByTestId("login-password").fill(account.password);
  await page.getByTestId("login-submit").click();
  try {
    await page.waitForURL(new RegExp(`^${APP_ORIGIN_RE}/app/track/?(\\?.*)?$`), { timeout: 20_000 });
  } catch (error) {
    // Say what the form says, not only where the page stayed.
    const shown = await page.getByTestId("login-error").allInnerTexts().catch(() => []);
    throw new Error(`${String(error)}; the login form shows: ${JSON.stringify(shown)}`);
  }
}

async function expectLoginForm(page: Page): Promise<void> {
  await page.waitForURL(new RegExp(`^${APP_ORIGIN_RE}/login/`));
  await page.getByTestId("login-email").waitFor();
}

export type LoggedRequest = {
  at: number;
  kind: "request" | "upgrade";
  method: string;
  url: string;
  origin: string | null;
  client: string | null;
  cookie: boolean;
  authorization: string | null;
  protocol: string | null;
  harness: boolean;
};

/** Requests the app itself sent: its origin, and not one of the harness's own. */
export function appRequests(since = 0, log = process.env.DESKTOP_E2E_REQUEST_LOG): LoggedRequest[] {
  return apiRequests(since, log).filter((r) => r.origin === APP_ORIGIN && !r.harness);
}

/** What the API received, from record-requests.mjs, optionally since a time. */
export function apiRequests(since = 0, log = process.env.DESKTOP_E2E_REQUEST_LOG): LoggedRequest[] {
  if (!log) throw new Error("DESKTOP_E2E_REQUEST_LOG is not set; run through the desktop Playwright config");
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoggedRequest)
    .filter((entry) => entry.at >= since);
}

/**
 * What the app handed to the OS browser or mail client. Headless launches
 * never open anything (desktop/src-tauri/src/external.rs); they record it
 * for the control channel instead.
 */
export function openedExternally(app: DesktopApp): Promise<string[]> {
  return app.openedExternally();
}

/** RFC 6238 from an otpauth:// URI, what an authenticator app computes. */
export function totpFromUri(uri: string, at = Date.now()): string {
  const url = new URL(uri);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of (url.searchParams.get("secret") ?? "").replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const period = Number(url.searchParams.get("period") ?? 30);
  const digits = Number(url.searchParams.get("digits") ?? 6);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / period)));
  const hmac = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, "0");
}

/**
 * Turn two-factor on for the account, as Settings → Account does. Confirming
 * replaces the session; the returned token is the one that stays valid.
 */
export async function enableTwoFactor(account: Account, token: string): Promise<string> {
  const enabled = await authCall(token, "/two-factor/enable", { body: { password: await passwordForApi(account) } });
  const uri = (enabled.body as { totpURI?: string }).totpURI;
  if (enabled.status !== 200 || !uri) throw new Error(`two-factor enable failed: ${enabled.status}`);
  const confirmed = await authCall(token, "/two-factor/verify-totp", { body: { code: totpFromUri(uri) } });
  if (confirmed.status !== 200) throw new Error(`two-factor verify failed: ${confirmed.status} ${JSON.stringify(confirmed.body)}`);
  return confirmed.token ?? token;
}

/** Approve or decline a device code from a signed-in "browser" session, as /app/device does. */
export async function answerDeviceCode(token: string, userCode: string, action: "approve" | "deny"): Promise<void> {
  const claim = await authCall(token, `/device?user_code=${encodeURIComponent(userCode)}`);
  if (claim.status !== 200) throw new Error(`device claim failed: ${claim.status} ${JSON.stringify(claim.body)}`);
  const answer = await authCall(token, `/device/${action}`, { body: { userCode } });
  if (answer.status !== 200) throw new Error(`device ${action} failed: ${answer.status} ${JSON.stringify(answer.body)}`);
}
