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

/**
 * A signed-in session for the harness, as a Cookie header value.
 *
 * STAGE 1 STAND-IN. The desktop app cannot sign in yet: its origin is
 * cross-site to the API, so the session cookie is never sent, and the bearer
 * path is gated on `isNative()` until Stage 2 of docs/desktop-app-plan.md.
 * To test that every signed-in screen renders from `app://-` anyway, the
 * account is created from Node and the cookie is attached to the app's API
 * requests by the main process (`attachSessionCookie`). Stage 2 replaces this
 * with a real sign-in through the login form.
 */
export async function createAccountCookie(): Promise<string> {
  const email = `desktop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const response = await fetch(`${API_ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    // Node's fetch sends `Sec-Fetch-Mode: cors`, which makes better-auth
    // demand a trusted Origin; the harness API trusts the app's.
    headers: { "content-type": "application/json", origin: APP_ORIGIN },
    body: JSON.stringify({ email, password: "desktop-e2e-password-1", name: "Desktop E2E" }),
  });
  if (!response.ok) throw new Error(`sign-up failed: ${response.status} ${await response.text()}`);
  const cookies = response.headers.getSetCookie().map((c) => c.split(";")[0]);
  const session = cookies.find((c) => c.includes("session_token"));
  if (!session) throw new Error(`no session cookie in ${JSON.stringify(cookies)}`);
  return cookies.join("; ");
}

export async function attachSessionCookie(app: ElectronApplication, cookie: string): Promise<void> {
  await app.evaluate(
    ({ session }, { cookie: value, origin }) => {
      session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
        callback({ requestHeaders: { ...details.requestHeaders, Cookie: value } });
      });
    },
    { cookie, origin: API_ORIGIN },
  );
}
