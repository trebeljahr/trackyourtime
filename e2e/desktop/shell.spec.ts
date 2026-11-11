import { spawn, spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "@playwright/test";

import {
  API_ORIGIN,
  APP_ORIGIN,
  APP_ORIGIN_RE,
  createAccount,
  desktopExecutable,
  expect,
  freshUserDataDir,
  launchApp,
  launchEnv,
  navDestinations,
  openedExternally,
  pageProblems,
  signInThroughForm,
  type DesktopApp,
  type Locator,
  type Page,
} from "./support";

/*
 * Stage 1 of docs/desktop-app-plan.md: a desktop app that navigates.
 *
 * The Stage 0 spike measured the opposite on a file:// build — the landing
 * page, then a blank error page on the first redirect. Every test here is one
 * of the things that was broken, run against the e2e debug build of the
 * shell (desktop/src-tauri) serving `packages/client/out-desktop` over
 * app://-, driven through its control channel (driver.ts).
 */

let app: DesktopApp;
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
  // app:// is the client-side navigation that ended on an error page before.
  await expectAt(page, new RegExp(`^${APP_ORIGIN_RE}/login/(\\?.*)?$`));
  await expect(page.getByTestId("login-email")).toBeVisible();
  expect(await page.evaluate(() => [location.origin, isSecureContext])).toEqual([APP_ORIGIN, true]);

  // The window marker the chrome styles key off, set before paint. The class
  // keeps its Electron-era name (desktop.css).
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

  await page.goto(`${APP_ORIGIN}/app/track/`);
  await expect(page.getByTestId("app-header")).toBeVisible();

  // The page collects its own errors and CSP violations, per document, so
  // they are read before each document goes away.
  const problems: string[] = [];
  const destinations = navDestinations();
  // Client-side: the sidebar link, which fetches the route's RSC payload
  // (`index.txt`) over app://. Next falls back to a full document load when
  // that fetch fails, which would pass every URL check below, so a marker on
  // `window` has to survive the whole loop.
  await page.evaluate(() => void Object.assign(window, { __sameDocument: true }));
  for (const { id, href } of destinations) {
    await page.getByTestId(`nav-${id}`).click();
    await expect(page).toHaveURL(new RegExp(`^${APP_ORIGIN_RE}${href}/?$`));
    await expect(page.getByTestId(`nav-${id}`)).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("app-header")).toBeVisible();
  }
  expect(await page.evaluate(() => (window as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
  problems.push(...(await pageProblems(page)));

  // Hard loads: each document and its chunks straight off the scheme.
  for (const { id, href } of destinations) {
    await page.goto(`${APP_ORIGIN}${href}/`);
    await expect(page.getByTestId(`nav-${id}`)).toHaveAttribute("aria-current", "page");
    problems.push(...(await pageProblems(page)).map((problem) => `${href}: ${problem}`));
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

/**
 * Whether a primary-button press on `target` (at `offsetY` px from its top)
 * makes the bridge ask to move the window. The shell's bridge script decides
 * on mousedown (desktop/src-tauri/src/bridge.js); an e2e build records the
 * request instead of dragging (e2e_dom.js).
 */
async function pressDrags(target: Page, element: Locator, offsetY?: number): Promise<boolean> {
  const before = (await target.windowRequests()).length;
  await element.evaluate((el, dy) => {
    const rect = el.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      buttons: 1,
      detail: 1,
      clientX: rect.left + rect.width / 2,
      clientY: dy === null ? rect.top + rect.height / 2 : rect.top + dy,
    };
    el.dispatchEvent(new MouseEvent("mousedown", init));
    el.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
  }, offsetY ?? null);
  const after = await target.windowRequests();
  return after.slice(before).includes("plugin:window|start_dragging");
}

test("an open dialog is never under a window drag region", async () => {
  ({ app, page } = await launchApp());
  await expectAt(page, /\/login\//);

  // The macOS window has no title bar. A screen without the app header
  // (sign-in, 404) drags by a strip across the top; its controls do not.
  if (process.platform === "darwin") {
    expect(await pressDrags(page, page.locator("body"), 10)).toBe(true);
    expect(await pressDrags(page, page.getByTestId("login-email"))).toBe(false);
  }

  await signInThroughForm(page, await createAccount());
  await page.goto(`${APP_ORIGIN}/app/track/`);
  const header = page.getByTestId("app-header");
  await expect(header).toBeVisible();

  // The header (`[data-window-drag]`) drags the window; a press on a control
  // inside it does not. A portal-rendered dialog that overlaps the header (a
  // tall one reaches 1rem from the top) must never have its clicks taken as
  // a window drag, and while a modal holds the page the header stands down,
  // so a click on the backdrop closes the dialog rather than moving the window.
  expect(await pressDrags(page, header)).toBe(true);
  expect(await pressDrags(page, header.locator("button").first())).toBe(false);

  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  const dialog = page.getByRole("dialog");
  await expect(page.getByTestId("command-palette-input")).toBeVisible();
  expect(await pressDrags(page, dialog)).toBe(false);
  expect(await pressDrags(page, header)).toBe(false);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => pressDrags(page, header)).toBe(true);
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

test("the shell refuses a bridge call from any window but the app's own", async () => {
  ({ app, page } = await launchApp());
  await expectAt(page, /\/login\//);

  // The app's own document may call the bridge.
  const own = await page.evaluate(() => window.electronAPI?.getIdleState?.().then((s) => typeof s.idleSeconds));
  expect(own).toBe("number");

  // Another window, which gets Tauri's IPC like any webview the app opens,
  // may not: neither showing a page from elsewhere (here the harness API's
  // health JSON), nor showing the app's origin under another label. Tauri's
  // capability for desktop_call (the main window, local URLs only) refuses
  // both before the call arrives; desktop/src-tauri/src/ipc.rs checks the
  // label and URL again behind it. Either refusal is the shell's.
  const refusal = /^refused: .*(desktop_call not allowed|Refused idle:get)/;
  expect(await app.foreignCall(`${API_ORIGIN}/api/health`, "idle:get")).toMatch(refusal);
  expect(await app.foreignCall(`${APP_ORIGIN}/robots.txt`, "idle:get")).toMatch(refusal);
  expect((await app.windowState())?.windows).toBe(1);
});

test("navigation off the app origin and permission requests are denied", async () => {
  ({ app, page } = await launchApp());
  await expectAt(page, /\/login\//);
  const before = await page.url();

  // file:// rather than https://, which a non-headless run would hand to the
  // test machine's browser.
  await page.evaluate(() => {
    location.href = "file:///etc/hosts";
  });
  await page.waitForTimeout(500);
  expect(await page.url()).toBe(before);

  const popup = await page.evaluate(() => window.open("file:///etc/hosts") === null);
  expect(popup).toBe(true);
  expect((await app.windowState())?.windows).toBe(1);

  // The page never gets a location. In the system WebViews a refused request
  // fails with PERMISSION_DENIED (1); a WebView without the API at all is as
  // good. An answer that never comes would mean a permission prompt is up.
  const geolocation = await page.evaluate(
    () =>
      new Promise<string>((done) => {
        if (!navigator.geolocation) return done("absent");
        const timer = setTimeout(() => done("no answer within 5s"), 5_000);
        navigator.geolocation.getCurrentPosition(
          () => {
            clearTimeout(timer);
            done("granted");
          },
          (err) => {
            clearTimeout(timer);
            done(`denied:${err.code}`);
          },
        );
      }),
    undefined,
    { timeout: 15_000 },
  );
  expect(["denied:1", "absent"]).toContain(geolocation);
});

test("the binary does not link CoreLocation", async () => {
  // Why the shell left Electron: Chromium links CoreLocation, so macOS lists
  // the app under Location Services. The system WebView is loaded from the
  // OS; only the app's own direct dependencies count here.
  test.skip(process.platform !== "darwin", "CoreLocation is a macOS framework");
  const listed = spawnSync("otool", ["-L", desktopExecutable()], { encoding: "utf8" });
  expect(listed.status, listed.stderr).toBe(0);
  const libraries = listed.stdout.split("\n").slice(1).map((line) => line.trim()).filter(Boolean);
  expect(libraries.length).toBeGreaterThan(3);
  expect(libraries.filter((line) => /CoreLocation/i.test(line))).toEqual([]);
});

/** The machine's clipboard as text, through the OS's own tool; null when there is none. */
function systemClipboard(): { read: () => string; write: (text: string) => void } | null {
  const tools: Record<string, { read: [string, string[]]; write: [string, string[]] }> = {
    darwin: { read: ["pbpaste", []], write: ["pbcopy", []] },
    win32: { read: ["powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"]], write: ["powershell", ["-NoProfile", "-Command", "$input | Set-Clipboard"]] },
    linux: { read: ["xclip", ["-selection", "clipboard", "-o"]], write: ["xclip", ["-selection", "clipboard", "-i"]] },
  };
  const tool = tools[process.platform];
  if (!tool || spawnSync(tool.read[0], tool.read[1]).error) return null;
  return {
    read: () => spawnSync(tool.read[0], tool.read[1], { encoding: "utf8" }).stdout.replace(/\r?\n$/, ""),
    write: (text) => void spawnSync(tool.write[0], tool.write[1], { input: text }),
  };
}

test("the permission lockdown leaves clipboard copy working", async () => {
  // This writes the machine's real clipboard. Only its text can be put back,
  // so a copied image, file or rich text on a developer's machine would be
  // lost — run it on CI, or locally on request.
  test.skip(
    !process.env.CI && process.env.DESKTOP_E2E_CLIPBOARD !== "1",
    "writes the system clipboard; set DESKTOP_E2E_CLIPBOARD=1 to run it locally",
  );
  const clipboard = systemClipboard();
  test.skip(clipboard === null, "no clipboard tool on this machine (pbcopy, PowerShell or xclip)");
  ({ app, page } = await launchApp());
  await expectAt(page, /\/login\//);
  // Invite links, API tokens and 2FA backup codes are copied with
  // navigator.clipboard.writeText, which the WebViews allow only in a user
  // gesture. A script the control channel evaluates runs as one in WebKit
  // (evaluateJavaScript forces it), standing in for the click that copies.
  const previous = clipboard!.read();
  try {
    await page.getByTestId("login-email").click();
    const copied = await page.evaluate(() =>
      navigator.clipboard.writeText("desktop-e2e-copy").then(
        () => "ok",
        (err: unknown) => `failed: ${String(err)}`,
      ),
    );
    expect(copied).toBe("ok");
    expect(clipboard!.read()).toBe("desktop-e2e-copy");

    // Reading stays denied: nothing in the app needs another app's clipboard.
    // Read after the gesture has expired, as an app script would; inside one
    // WebKit would put up its own Paste menu instead of answering.
    const read = await page.evaluate(
      () =>
        new Promise<string>((done) => {
          setTimeout(() => {
            const timer = setTimeout(() => done("no answer"), 3_000);
            navigator.clipboard.readText().then(
              () => (clearTimeout(timer), done("allowed")),
              () => (clearTimeout(timer), done("denied")),
            );
          }, 6_000);
        }),
      undefined,
      { timeout: 20_000 },
    );
    expect(read).toBe("denied");
  } finally {
    clipboard!.write(previous);
  }
});

test("a generated file reaches the download manager", async () => {
  ({ app, page } = await launchApp());
  await expectAt(page, /\/login\//);
  const before = await page.url();
  // lib/download.ts: a blob: URL on an <a download>, which is how CSV, PDF and
  // invoice exports leave the app. It must become a download, not a
  // navigation the security handlers refuse — and without a download handler
  // the WebView drops it silently. Headless, the shell saves into the profile
  // with no dialog and records it for the control channel.
  await page.evaluate(() => {
    const url = URL.createObjectURL(new Blob(["a,b\n1,2\n"], { type: "text/csv" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "report.csv";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  });
  await expect.poll(async () => (await app.downloads()).map((d) => `${d.file}:${d.state}`)).toEqual(["report.csv:completed"]);
  const [saved] = await app.downloads();
  expect(realpathSync(saved.path).startsWith(realpathSync(app.userDataDir))).toBe(true);
  expect(readFileSync(saved.path, "utf8")).toBe("a,b\n1,2\n");
  expect(await page.url()).toBe(before);
});

test("a test launch never shows a window, a Dock icon or takes focus", async () => {
  ({ app, page } = await launchApp());
  await expectAt(page, /\/login\//);
  const state = await app.windowState();
  expect({
    windows: state?.windows,
    visible: state?.visible,
    focused: state?.focused,
    // A regular activation policy is what puts an app in the Dock and lets
    // it become active; headless is an accessory app (shell.rs).
    dock: state?.activationPolicy === "regular",
    active: state?.appActive ?? false,
  }).toEqual({ windows: 1, visible: false, focused: false, dock: false, active: false });
  if (process.platform === "darwin") expect(state?.activationPolicy).toBe("accessory");
  // Everything above is the headless contract itself and is asserted on every
  // platform. Whether a frame can be read back OUT of a never-shown window is
  // not part of it. On macOS a hidden window keeps a compositor surface, and
  // this is where a headless run was screenshotted for the store and for
  // debugging; the control channel cannot capture the WebView yet (e2e.rs →
  // screenshot). The Linux smoke
  // test (scripts/desktop-linux-smoke.mjs) remains the proof that the app
  // renders there.
  test.info().annotations.push({
    type: "not ported",
    description: "page.screenshot() of the hidden window: the e2e control channel has no WebView capture yet",
  });
});

test("Web Inspector cannot reach the page and the menu has no reload or inspector", async () => {
  ({ app, page } = await launchApp());
  await expectAt(page, /\/login\//);
  // Outside a dev run the WebView is not inspectable: no "Inspect Element"
  // in its context menu, no Web Inspector shortcut, no Safari remote
  // inspection (window.rs → devtools). Read from WebKit itself, never by
  // opening an inspector, which would put a window on the screen if broken.
  const inspection = await app.inspection();
  if (process.platform === "darwin") {
    expect(inspection).toEqual({ inspectable: false, developerExtras: false });
  } else {
    test.info().annotations.push({ type: "not ported", description: "inspection state is read on macOS only" });
  }

  const labels = await app.menuLabels();
  expect(labels.filter((label) => /reload|developer tools|inspect/i.test(label))).toEqual([]);
});

test("the window background matches the OS theme before the page paints", async () => {
  ({ app, page } = await launchApp());
  const background = await app.background();
  test.skip(background === null, "the window background is read on macOS only");
  // Until the page paints, what shows is the window's own background, and
  // only if the WebView does not paint its default white over it.
  expect({ window: background!.window, webviewDrawsBackground: background!.webviewDrawsBackground }).toEqual({
    window: background!.dark ? "#0a0a0a" : "#ffffff",
    webviewDrawsBackground: false,
  });
});

test("a second launch on the same profile exits and leaves the first running", async () => {
  let userDataDir: string;
  ({ app, page, userDataDir } = await launchApp());
  await expectAt(page, /\/login\//);

  const second = spawn(desktopExecutable(), [], { env: launchEnv(userDataDir), stdio: "ignore" });
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
  expect((await app.windowState())?.windows).toBe(1);
});

test("a mailto: link is handed to the OS, not dropped", async () => {
  ({ app, page } = await launchApp());
  await expectAt(page, /\/login\//);
  const before = await page.url();
  // The 404 page links to /support/, whose contact address is a mailto: link.
  // Headless, the OS hand-off is recorded instead of opening a mail client:
  // external.rs returns before it reaches the opener.
  await page.evaluate(() => {
    const anchor = document.createElement("a");
    anchor.href = "mailto:support@example.com";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  });
  await expect.poll(() => openedExternally(app)).toEqual(["mailto:support@example.com"]);
  expect(await page.url()).toBe(before);
});

test("a profile last closed maximised or fullscreen still launches hidden in headless mode", async () => {
  // Maximising or entering fullscreen shows a hidden window, so restoring the
  // saved state before the first paint would put a window on screen.
  const userDataDir = freshUserDataDir();
  writeFileSync(
    join(userDataDir, "window-state.json"),
    JSON.stringify({ bounds: { x: 40, y: 40, width: 1000, height: 700 }, maximized: true, fullscreen: true }),
  );
  ({ app, page } = await launchApp(userDataDir));
  await expectAt(page, /\/login\//);
  // Give a stray show or fullscreen transition time to happen.
  await page.waitForTimeout(1000);
  const state = await app.windowState();
  expect({ visible: state?.visible, fullscreen: state?.fullscreen, focused: state?.focused }).toEqual({
    visible: false,
    fullscreen: false,
    focused: false,
  });
});
