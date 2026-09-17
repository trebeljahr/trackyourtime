import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron, type ElectronApplication, type Page } from "@playwright/test";

export const REPO_ROOT = resolve(__dirname, "..", "..");
export const MAIN_JS = join(REPO_ROOT, "electron", "dist", "main.js");
export const PRELOAD_JS = join(REPO_ROOT, "electron", "dist", "preload.js");
export const EXPORT_DIR = join(REPO_ROOT, "packages", "client", "out-desktop");

/**
 * The API the export is built against. Fixed rather than random, because the
 * URL is baked into the export and a random port would rebuild it every run.
 * Override with DESKTOP_E2E_API_PORT when it is taken.
 */
export const API_PORT = Number(process.env.DESKTOP_E2E_API_PORT ?? "49764");
export const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
export const APP_ORIGIN = "app://-";

/** The electron executable, as scripts/ensure-electron.mjs installed it. */
export function electronExecutable(): string {
  const dir = resolve(REPO_ROOT, "node_modules", "electron");
  const executable = join(dir, "dist", readFileSync(join(dir, "path.txt"), "utf8").trim());
  if (!existsSync(executable)) throw new Error(`No Electron binary at ${executable}; run pnpm electron:ensure`);
  return executable;
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
  delete env.ELECTRON_DEV_URL;
  // An inherited ELECTRON_RUN_AS_NODE (set by some tool runners) turns the
  // binary into plain Node and the launch hangs.
  delete env.ELECTRON_RUN_AS_NODE;
  env.TRACKYOURTIME_USER_DATA_DIR = userDataDir;
  // Never show, focus or activate a window while tests run on somebody's
  // machine (electron/src/headless.ts).
  env.TRACKYOURTIME_HEADLESS = "1";
  return env;
}

/**
 * Uncaught page errors and CSP violations, collected from the moment of the
 * call. A route can "render" its shell while its own chunk was blocked, so the
 * navigation specs assert this stays empty.
 */
export function collectPageProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error" && /Content Security Policy|Refused to (load|execute|connect|apply)/i.test(text)) {
      problems.push(`csp: ${text}`);
    }
  });
  return problems;
}

export async function launchApp(userDataDir = freshUserDataDir()): Promise<{
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
}> {
  const app = await _electron.launch({
    executablePath: electronExecutable(),
    args: [MAIN_JS],
    env: launchEnv(userDataDir),
  });
  const page = await app.firstWindow();
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
  const items = [...block.matchAll(/href:\s*"([^"]+)",\s*id:\s*"([^"]+)"/g)].map((m) => ({
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
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  const token = response.headers.get("set-auth-token");
  if (!response.ok || !token) throw new Error(`sign-in failed: ${response.status} ${await response.text()}`);
  return token;
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
  await page.waitForURL(/^app:\/\/-\/app\/track\/?(\?.*)?$/);
}

async function expectLoginForm(page: Page): Promise<void> {
  await page.waitForURL(/^app:\/\/-\/login\//);
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

/** Replace shell.openExternal so a spec never opens the machine's browser; returns the read-back. */
export async function stubOpenExternal(app: ElectronApplication): Promise<() => Promise<string[]>> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as { __opened?: string[] };
    g.__opened = [];
    shell.openExternal = async (url: string) => {
      g.__opened?.push(url);
    };
  });
  return () => app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? []);
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
  const enabled = await authCall(token, "/two-factor/enable", { body: { password: account.password } });
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
