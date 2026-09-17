import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";

import {
  APP_ORIGIN,
  MAIN_JS,
  PRELOAD_JS,
  collectPageProblems,
  createAccount,
  electronExecutable,
  freshUserDataDir,
  launchApp,
  launchEnv,
  navDestinations,
  openedExternally,
  signInThroughForm,
} from "./support";

/*
 * Stage 1 of docs/desktop-app-plan.md: a desktop app that navigates.
 *
 * The Stage 0 spike measured the opposite on a file:// build — the landing
 * page, then a blank chrome-error page on the first redirect. Every test here
 * is one of the things that was broken, run against `electron/dist/main.js`
 * serving `packages/client/out-desktop` over app://-.
 */

let app: ElectronApplication;
let page: Page;

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
});

/** Wait for a route to settle: the URL, then a rendered document. */
async function expectAt(target: Page, path: RegExp): Promise<void> {
  await expect(target).toHaveURL(path);
  await expect(target.locator("body")).not.toBeEmpty();
}

test("opens on app://- and moves from / into the app", async () => {
  ({ app, page } = await launchApp());
  // ShellEntryRedirect sends the shell on to /app/track, and the protected
  // layout, with no session, on to /login. Reaching the login form over
  // app:// is the client-side navigation that ended on chrome-error before.
  await expectAt(page, /^app:\/\/-\/login\/(\?.*)?$/);
  await expect(page.getByTestId("login-email")).toBeVisible();
  expect(await page.evaluate(() => [location.origin, isSecureContext])).toEqual([APP_ORIGIN, true]);

  // The window marker the chrome styles key off, set before paint.
  const marker = await page.evaluate(() => ({
    electron: document.documentElement.classList.contains("electron"),
    cap: document.documentElement.classList.contains("cap"),
    platform: document.documentElement.getAttribute("data-platform"),
  }));
  expect(marker).toEqual({ electron: true, cap: false, platform: process.platform });
});

test("every NAV_SECTIONS destination renders, by click and by hard load", async () => {
  ({ app, page } = await launchApp());
  await expectAt(page, /\/login\//);
  await signInThroughForm(page, await createAccount());
  const problems = collectPageProblems(page);

  await page.goto(`${APP_ORIGIN}/app/track/`);
  await expect(page.getByTestId("app-header")).toBeVisible();

  const destinations = navDestinations();
  // Client-side: the sidebar link, which fetches the route's RSC payload
  // (`index.txt`) over app://. Next falls back to a full document load when
  // that fetch fails, which would pass every URL check below, so a marker on
  // `window` has to survive the whole loop.
  await page.evaluate(() => Object.assign(window, { __sameDocument: true }));
  for (const { id, href } of destinations) {
    await page.getByTestId(`nav-${id}`).click();
    await expect(page).toHaveURL(new RegExp(`^app://-${href}/?$`));
    await expect(page.getByTestId(`nav-${id}`)).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("app-header")).toBeVisible();
  }
  expect(await page.evaluate(() => (window as { __sameDocument?: boolean }).__sameDocument)).toBe(true);

  // Hard loads: each document and its chunks straight off the scheme.
  for (const { id, href } of destinations) {
    await page.goto(`${APP_ORIGIN}${href}/`);
    await expect(page.getByTestId(`nav-${id}`)).toHaveAttribute("aria-current", "page");
  }

  expect(problems).toEqual([]);
});

test("a reload on a deep route renders it again", async () => {
  ({ app, page } = await launchApp());
  await expectAt(page, /\/login\//);
  await signInThroughForm(page, await createAccount());
  await page.goto(`${APP_ORIGIN}/app/reports/`);
  await expect(page.getByTestId("nav-reports")).toHaveAttribute("aria-current", "page");

  await page.reload();
  await expect(page).toHaveURL(`${APP_ORIGIN}/app/reports/`);
  await expect(page.getByTestId("nav-reports")).toHaveAttribute("aria-current", "page");
});

test("an unknown path shows the 404 page with a 404 status", async () => {
  ({ app, page } = await launchApp());
  await expectAt(page, /\/login\//);
  const status = await page.evaluate(async () => (await fetch("/no/such/page/")).status);
  expect(status).toBe(404);
  await page.goto(`${APP_ORIGIN}/no/such/page/`);
  await expect(page.getByTestId("not-found")).toBeVisible();
});

test("an open dialog is never under a window drag region", async () => {
  ({ app, page } = await launchApp());
  await expectAt(page, /\/login\//);
  await signInThroughForm(page, await createAccount());
  await page.goto(`${APP_ORIGIN}/app/track/`);
  const header = page.getByTestId("app-header");
  await expect(header).toBeVisible();

  // Electron builds the drag region from app-region styles alone, in document
  // order, ignoring stacking: a portal-rendered dialog that overlaps the
  // header (a tall one reaches 1rem from the top) would have its clicks
  // swallowed as window drags unless it opts out and the header stands down.
  const region = (locator: ReturnType<Page["locator"]>): Promise<string> =>
    locator.evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region"));
  expect(await region(header)).toBe("drag");

  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  const dialog = page.getByRole("dialog");
  await expect(page.getByTestId("command-palette-input")).toBeVisible();
  expect(await region(dialog)).toBe("no-drag");
  expect(await region(header)).toBe("no-drag");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => region(header)).toBe("drag");
});

test("HTML is served with the CSP and nosniff", async () => {
  ({ app, page } = await launchApp());
  await expectAt(page, /\/login\//);
  const headers = await page.evaluate(async () => {
    const html = await fetch("/app/track/");
    return {
      csp: html.headers.get("content-security-policy"),
      type: html.headers.get("content-type"),
      nosniff: html.headers.get("x-content-type-options"),
    };
  });
  expect(headers.type).toContain("text/html");
  expect(headers.csp).toContain("default-src 'self'");
  expect(headers.csp).toContain("frame-ancestors 'none'");
  expect(headers.nosniff).toBe("nosniff");
});

test("ipcMain refuses a frame outside app://-", async () => {
  ({ app, page } = await launchApp());
  await expectAt(page, /\/login\//);

  // The app's own document may call the bridge.
  const own = await page.evaluate(() => window.electronAPI?.getIdleState?.().then((s) => typeof s.idleSeconds));
  expect(own).toBe("number");

  // A window with the very same preload, showing anything else, may not.
  const refused = await app.evaluate(async ({ BrowserWindow }, preload) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    try {
      await win.loadURL("data:text/html,<p>not the app</p>");
      return await win.webContents.executeJavaScript(
        `window.electronAPI.getIdleState().then(() => "allowed", (e) => "refused: " + e.message)`,
      );
    } finally {
      win.destroy();
    }
  }, PRELOAD_JS);
  expect(refused).toMatch(/^refused: .*Refused idle:get/);
});

test("navigation off the app origin and permission requests are denied", async () => {
  ({ app, page } = await launchApp());
  await expectAt(page, /\/login\//);
  const before = page.url();

  // file:// rather than https://, which would open the test machine's browser.
  await page.evaluate(() => {
    location.href = "file:///etc/hosts";
  });
  await page.waitForTimeout(500);
  expect(page.url()).toBe(before);

  const popup = await page.evaluate(() => window.open("file:///etc/hosts") === null);
  expect(popup).toBe(true);
  expect(app.windows()).toHaveLength(1);

  const geolocation = await page.evaluate(
    () =>
      new Promise<string>((done) => {
        navigator.geolocation.getCurrentPosition(
          () => done("granted"),
          (err) => done(`denied:${err.code}`),
        );
      }),
  );
  expect(geolocation).toBe("denied:1");
});

test("the permission lockdown leaves clipboard copy working", async () => {
  // This writes the machine's real clipboard. Only its text can be put back,
  // so a copied image, file or rich text on a developer's machine would be
  // lost — run it on CI, or locally on request.
  test.skip(
    !process.env.CI && process.env.DESKTOP_E2E_CLIPBOARD !== "1",
    "writes the system clipboard; set DESKTOP_E2E_CLIPBOARD=1 to run it locally",
  );
  ({ app, page } = await launchApp());
  await expectAt(page, /\/login\//);
  // Invite links, API tokens and 2FA backup codes are copied with
  // navigator.clipboard.writeText, which Chromium gates on a permission.
  // This writes the machine's real clipboard, so whatever was on it is put back.
  const previous = await app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    await page.bringToFront();
    await page.getByTestId("login-email").click();
    const copied = await page.evaluate(() =>
      navigator.clipboard.writeText("desktop-e2e-copy").then(
        () => "ok",
        (err: unknown) => `failed: ${String(err)}`,
      ),
    );
    expect(copied).toBe("ok");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("desktop-e2e-copy");

    // Reading stays denied: nothing in the app needs another app's clipboard.
    const read = await page.evaluate(() =>
      navigator.clipboard.readText().then(
        () => "allowed",
        () => "denied",
      ),
    );
    expect(read).toBe("denied");
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), previous);
  }
});

test("a generated file reaches the download manager", async () => {
  ({ app, page } = await launchApp());
  await expectAt(page, /\/login\//);
  const before = page.url();
  // lib/download.ts: a blob: URL on an <a download>, which is how CSV, PDF and
  // invoice exports leave the app. It must become a download, not a navigation
  // the security handlers refuse. The save path is set here, so no dialog opens.
  const dir = freshUserDataDir();
  await app.evaluate(
    ({ session }, saveDir) => {
      const g = globalThis as { __downloads?: string[] };
      g.__downloads = [];
      session.defaultSession.once("will-download", (_event, item) => {
        item.setSavePath(`${saveDir}/${item.getFilename()}`);
        item.once("done", (_e, state) => g.__downloads?.push(`${item.getFilename()}:${state}`));
      });
    },
    dir,
  );
  await page.evaluate(() => {
    const url = URL.createObjectURL(new Blob(["a,b\n1,2\n"], { type: "text/csv" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "report.csv";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  });
  await expect
    .poll(() => app.evaluate(() => (globalThis as { __downloads?: string[] }).__downloads ?? []))
    .toEqual(["report.csv:completed"]);
  expect(readFileSync(join(dir, "report.csv"), "utf8")).toBe("a,b\n1,2\n");
  expect(page.url()).toBe(before);
});

test("a test launch never shows a window, a Dock icon or takes focus", async () => {
  ({ app, page } = await launchApp());
  await expectAt(page, /\/login\//);
  const state = await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows();
    return {
      windows: wins.length,
      visible: wins.some((w) => w.isVisible()),
      focused: BrowserWindow.getFocusedWindow() !== null,
      dock: process.platform === "darwin" ? electronApp.dock?.isVisible() ?? false : false,
    };
  });
  expect(state).toEqual({ windows: 1, visible: false, focused: false, dock: false });
  // A hidden window still paints, which is what every screenshot relies on.
  expect((await page.screenshot()).byteLength).toBeGreaterThan(1000);
});

test("DevTools cannot be opened and the menu has no reload or inspector", async () => {
  ({ app, page } = await launchApp());
  await expectAt(page, /\/login\//);
  const result = await app.evaluate(async ({ BrowserWindow, Menu }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.openDevTools();
    await new Promise((r) => setTimeout(r, 500));
    const roles: string[] = [];
    const walk = (items: Electron.MenuItem[]): void => {
      for (const item of items) {
        if (item.role) roles.push(String(item.role).toLowerCase());
        if (item.submenu) walk(item.submenu.items);
      }
    };
    walk(Menu.getApplicationMenu()?.items ?? []);
    return { opened: win.webContents.isDevToolsOpened(), roles };
  });
  expect(result.opened).toBe(false);
  expect(result.roles).not.toContain("toggledevtools");
  expect(result.roles).not.toContain("reload");
  expect(result.roles).not.toContain("forcereload");
});

test("the window background matches the OS theme before the page paints", async () => {
  ({ app, page } = await launchApp());
  const { background, dark } = await app.evaluate(({ BrowserWindow, nativeTheme }) => ({
    background: BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase(),
    dark: nativeTheme.shouldUseDarkColors,
  }));
  expect(background).toBe(dark ? "#0a0a0a" : "#ffffff");
});

test("a second launch on the same profile exits and leaves the first running", async () => {
  let userDataDir: string;
  ({ app, page, userDataDir } = await launchApp());
  await expectAt(page, /\/login\//);

  const second = spawn(electronExecutable(), [MAIN_JS], { env: launchEnv(userDataDir), stdio: "ignore" });
  const code = await new Promise<number | null>((done, reject) => {
    const timer = setTimeout(() => {
      second.kill("SIGKILL");
      reject(new Error("the second instance did not exit within 20s"));
    }, 20_000);
    second.once("exit", (exitCode) => {
      clearTimeout(timer);
      done(exitCode);
    });
  });
  expect(code).toBe(0);
  expect(await page.evaluate(() => location.origin)).toBe(APP_ORIGIN);
  expect(app.windows()).toHaveLength(1);
});

test("a mailto: link is handed to the OS, not dropped", async () => {
  ({ app, page } = await launchApp());
  await expectAt(page, /\/login\//);
  const before = page.url();
  // The 404 page links to /support/, whose contact address is a mailto: link.
  // Headless, the OS hand-off is recorded instead of opening a mail client
  // (electron/src/external.ts). A stub of shell.openExternal would never be
  // reached: nothing calls it while headless.
  // And it really is never called: a trap replaces it for the whole spec.
  await app.evaluate(({ shell }) => {
    shell.openExternal = async () => {
      throw new Error("shell.openExternal called in a headless launch");
    };
  });

  await page.evaluate(() => {
    const anchor = document.createElement("a");
    anchor.href = "mailto:support@example.com";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  });
  await expect
    .poll(() => openedExternally(app))
    .toEqual(["mailto:support@example.com"]);
  expect(page.url()).toBe(before);
});

test("a profile last closed maximised or fullscreen still launches hidden in headless mode", async () => {
  // BrowserWindow.maximize() shows a hidden window, so restoring the saved
  // state before ready-to-show put a window on screen before the page painted.
  const userDataDir = freshUserDataDir();
  writeFileSync(
    join(userDataDir, "window-state.json"),
    JSON.stringify({ bounds: { x: 40, y: 40, width: 1000, height: 700 }, maximized: true, fullscreen: true }),
  );
  ({ app, page } = await launchApp(userDataDir));
  await expectAt(page, /\/login\//);
  // Give a stray show or fullscreen transition time to happen.
  await page.waitForTimeout(1000);
  const state = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return { visible: win.isVisible(), fullscreen: win.isFullScreen(), focused: BrowserWindow.getFocusedWindow() !== null };
  });
  expect(state).toEqual({ visible: false, fullscreen: false, focused: false });
});
