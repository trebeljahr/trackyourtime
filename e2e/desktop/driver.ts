/**
 * Drives the desktop build (Tauri, desktop/src-tauri) over the app's own e2e
 * control channel (desktop/src-tauri/src/e2e.rs), because the system WebViews
 * offer no CDP or WebDriver to Playwright on macOS. The binary is a debug build with the `e2e` cargo feature; release
 * builds have no such channel.
 *
 * What it offers is the subset of Playwright's Page and Locator the desktop
 * specs use, with the same names, plus an `expect` whose locator matchers
 * (toBeVisible, toHaveText, toHaveAttribute, …) poll these locators. Every
 * query goes to the page as a list of steps resolved against the live DOM
 * (e2e_dom.js), so there are no stale element handles. Functions passed to
 * `evaluate` are sent as source and must be self-contained, as with
 * Playwright.
 *
 * The app runs headless (TRACKYOURTIME_HEADLESS=1): never shown, never
 * focused, no Dock icon. Clicks are DOM events, not OS input.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { expect as baseExpect } from "@playwright/test";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type TextPattern = string | RegExp;
type Step =
  | { kind: "css"; selector: string }
  | { kind: "testid"; id: string }
  | { kind: "role"; role: string; name?: SerializedPattern; exact?: boolean }
  | { kind: "text"; text: SerializedPattern; exact?: boolean }
  | { kind: "label"; text: SerializedPattern; exact?: boolean }
  | { kind: "nth"; index: number }
  | { kind: "filter"; hasText?: SerializedPattern; hasNotText?: SerializedPattern; has?: Step[]; hasNot?: Step[]; visible?: boolean };
type SerializedPattern = string | { regex: string; flags: string };

const DEFAULT_TIMEOUT = 10_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function pattern(value: TextPattern): SerializedPattern {
  return value instanceof RegExp ? { regex: value.source, flags: value.flags } : value;
}

class Channel {
  private buffer = "";
  private next = 0;
  private waiting = new Map<number, (reply: { result?: unknown; error?: string }) => void>();
  private constructor(
    private socket: net.Socket,
    private token: string,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let index: number;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        const reply = JSON.parse(line) as { id: number; result?: unknown; error?: string };
        this.waiting.get(reply.id)?.(reply);
        this.waiting.delete(reply.id);
      }
    });
    socket.on("close", () => {
      for (const resolve of this.waiting.values()) resolve({ error: "the app closed the control channel" });
      this.waiting.clear();
    });
  }

  static async open(port: number, token: string): Promise<Channel> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(port, "127.0.0.1", () => resolve(s));
      s.once("error", reject);
    });
    return new Channel(socket, token);
  }

  call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.next;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, (reply) => (reply.error !== undefined ? reject(new Error(reply.error)) : resolve(reply.result as T)));
      this.socket.write(`${JSON.stringify({ id, token: this.token, method, params })}\n`);
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

export class Locator {
  constructor(
    readonly page: DesktopPage,
    readonly steps: Step[],
  ) {}

  private with(step: Step): Locator {
    return new Locator(this.page, [...this.steps, step]);
  }
  getByTestId(id: string): Locator {
    return this.with({ kind: "testid", id });
  }
  locator(selector: string, options?: { hasText?: TextPattern; hasNotText?: TextPattern; has?: Locator; hasNot?: Locator }): Locator {
    const found = this.with({ kind: "css", selector });
    return options ? found.filter(options) : found;
  }
  getByRole(role: string, options: { name?: TextPattern; exact?: boolean } = {}): Locator {
    return this.with({ kind: "role", role, name: options.name === undefined ? undefined : pattern(options.name), exact: options.exact });
  }
  getByText(text: TextPattern, options: { exact?: boolean } = {}): Locator {
    return this.with({ kind: "text", text: pattern(text), exact: options.exact });
  }
  getByLabel(text: TextPattern, options: { exact?: boolean } = {}): Locator {
    return this.with({ kind: "label", text: pattern(text), exact: options.exact });
  }
  filter(options: { hasText?: TextPattern; hasNotText?: TextPattern; has?: Locator; hasNot?: Locator; visible?: boolean }): Locator {
    return this.with({
      kind: "filter",
      hasText: options.hasText === undefined ? undefined : pattern(options.hasText),
      hasNotText: options.hasNotText === undefined ? undefined : pattern(options.hasNotText),
      has: options.has?.steps,
      hasNot: options.hasNot?.steps,
      visible: options.visible,
    });
  }
  first(): Locator {
    return this.with({ kind: "nth", index: 0 });
  }
  last(): Locator {
    return this.with({ kind: "nth", index: -1 });
  }
  nth(index: number): Locator {
    return this.with({ kind: "nth", index });
  }

  /** One query, answered at once. */
  query<T>(action: string, arg?: unknown): Promise<T> {
    return this.page.evaluate(`window.__TYT_E2E__.query(${JSON.stringify(this.steps)}, ${JSON.stringify(action)}, ${JSON.stringify(arg ?? null)})`) as Promise<T>;
  }

  /** An action, retried until it succeeds or the timeout passes (Playwright's actionability). */
  private async act(action: string, arg?: unknown, timeout = DEFAULT_TIMEOUT): Promise<void> {
    const deadline = Date.now() + timeout;
    let last: unknown;
    for (;;) {
      try {
        await this.query(action, arg);
        return;
      } catch (error) {
        last = error;
        if (!/no element matches|not visible|disabled|strict mode/.test(String(error)) || Date.now() > deadline) break;
        await sleep(100);
      }
    }
    throw new Error(`${action} on ${JSON.stringify(this.steps)}: ${String(last)}`);
  }

  click(options: { timeout?: number; modifiers?: string[] } = {}): Promise<void> {
    return this.act("click", { modifiers: options.modifiers ?? [] }, options.timeout);
  }
  fill(value: string, options: { timeout?: number } = {}): Promise<void> {
    return this.act("fill", { value }, options.timeout);
  }
  press(key: string, options: { timeout?: number } = {}): Promise<void> {
    return this.act("press", { key }, options.timeout);
  }
  check(options: { timeout?: number } = {}): Promise<void> {
    return this.act("check", {}, options.timeout);
  }
  uncheck(options: { timeout?: number } = {}): Promise<void> {
    return this.act("uncheck", {}, options.timeout);
  }
  focus(): Promise<void> {
    return this.act("focus");
  }
  hover(): Promise<void> {
    return this.act("hover");
  }
  scrollIntoViewIfNeeded(): Promise<void> {
    return this.act("scroll");
  }
  selectOption(value: string): Promise<void> {
    return this.act("selectOption", { value });
  }
  count(): Promise<number> {
    return this.query("count");
  }
  isVisible(): Promise<boolean> {
    return this.query("visible");
  }
  async isHidden(): Promise<boolean> {
    return !(await this.isVisible());
  }
  isEnabled(): Promise<boolean> {
    return this.query("enabled");
  }
  isChecked(): Promise<boolean> {
    return this.query("checked");
  }
  /** Wait until the locator matches an element, as Playwright's readers do. */
  private async attached(timeout = DEFAULT_TIMEOUT): Promise<void> {
    const deadline = Date.now() + timeout;
    while ((await this.count()) === 0) {
      if (Date.now() > deadline) throw new Error(`no element matches ${JSON.stringify(this.steps)}`);
      await sleep(100);
    }
  }
  async textContent(options: { timeout?: number } = {}): Promise<string | null> {
    await this.attached(options.timeout);
    return this.query("textContent");
  }
  async innerText(options: { timeout?: number } = {}): Promise<string> {
    await this.attached(options.timeout);
    return this.query<string | null>("text").then((t) => t ?? "");
  }
  allInnerTexts(): Promise<string[]> {
    return this.query("texts");
  }
  allTextContents(): Promise<string[]> {
    return this.query("texts");
  }
  /** The attribute, null when the element has none; matchers poll this. */
  getAttribute(name: string): Promise<string | null> {
    return this.query("attribute", name);
  }
  inputValue(): Promise<string> {
    return this.query<string | null>("value").then((v) => v ?? "");
  }
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    return this.query<{ x: number; y: number; width: number; height: number }>("rect").catch(() => null);
  }
  async waitFor(options: { state?: "attached" | "detached" | "visible" | "hidden"; timeout?: number } = {}): Promise<void> {
    const state = options.state ?? "visible";
    const deadline = Date.now() + (options.timeout ?? DEFAULT_TIMEOUT);
    for (;;) {
      const [count, visible] = await Promise.all([this.count(), this.isVisible()]);
      const ok =
        state === "attached" ? count > 0 : state === "detached" ? count === 0 : state === "visible" ? visible : !visible;
      if (ok) return;
      if (Date.now() > deadline) throw new Error(`waitFor(${state}) timed out for ${JSON.stringify(this.steps)}`);
      await sleep(100);
    }
  }
  /** `fn(element, arg)` in the page; `fn` must be self-contained. */
  evaluate<R, A = unknown>(fn: (element: HTMLElement, arg: A) => R | Promise<R>, arg?: A): Promise<R> {
    return this.page.evaluate(`window.__TYT_E2E__.withElement(${JSON.stringify(this.steps)}, (${fn.toString()}), ${JSON.stringify(arg ?? null)})`) as Promise<R>;
  }
  evaluateAll<R, A = unknown>(fn: (elements: HTMLElement[], arg: A) => R | Promise<R>, arg?: A): Promise<R> {
    return this.page.evaluate(`window.__TYT_E2E__.withElements(${JSON.stringify(this.steps)}, (${fn.toString()}), ${JSON.stringify(arg ?? null)})`) as Promise<R>;
  }
  toString(): string {
    return `Locator(${JSON.stringify(this.steps)})`;
  }
}

export class DesktopPage {
  readonly keyboard = {
    press: (key: string) => this.evaluate(`window.__TYT_E2E__.press(${JSON.stringify(key)})`).then(() => undefined),
  };

  constructor(readonly app: DesktopApp) {}

  private root(): Locator {
    return new Locator(this, []);
  }
  getByTestId(id: string): Locator {
    return this.root().getByTestId(id);
  }
  locator(selector: string, options?: { hasText?: TextPattern; hasNotText?: TextPattern; has?: Locator; hasNot?: Locator }): Locator {
    return this.root().locator(selector, options);
  }
  getByRole(role: string, options?: { name?: TextPattern; exact?: boolean }): Locator {
    return this.root().getByRole(role, options);
  }
  getByText(text: TextPattern, options?: { exact?: boolean }): Locator {
    return this.root().getByText(text, options);
  }
  getByLabel(text: TextPattern, options?: { exact?: boolean }): Locator {
    return this.root().getByLabel(text, options);
  }

  /**
   * An expression string, or a self-contained function (and a JSON argument)
   * run in the page; the result comes back as JSON.
   */
  evaluate<R = unknown, A = unknown>(fn: string | ((arg: A) => R | Promise<R>), arg?: A, options: { timeout?: number } = {}): Promise<R> {
    const script = typeof fn === "string" ? fn : `(${fn.toString()})(${JSON.stringify(arg ?? null)})`;
    return this.app.channel.call<R>("eval", { script, timeoutMs: options.timeout ?? DEFAULT_TIMEOUT });
  }

  async url(): Promise<string> {
    return (await this.app.channel.call<string | null>("url")) ?? "";
  }

  async goto(url: string, options: { timeout?: number } = {}): Promise<void> {
    const loads = await this.app.channel.call<number>("loads");
    const target = /^[a-z]+:/i.test(url) ? url : new URL(url, APP_BASE).toString();
    await this.app.channel.call("navigate", { url: target });
    await this.waitForLoads(loads + 1, options.timeout);
  }

  async reload(options: { timeout?: number } = {}): Promise<void> {
    const loads = await this.app.channel.call<number>("loads");
    await this.evaluate("void location.reload()");
    await this.waitForLoads(loads + 1, options.timeout);
  }

  private async waitForLoads(count: number, timeout = DEFAULT_TIMEOUT): Promise<void> {
    const deadline = Date.now() + timeout;
    while ((await this.app.channel.call<number>("loads")) < count) {
      if (Date.now() > deadline) throw new Error("page load timed out");
      await sleep(50);
    }
    await this.waitForLoadState();
  }

  /** The bridge's document finished loading and answers evals. */
  async waitForLoadState(_state?: string, options: { timeout?: number } = {}): Promise<void> {
    const deadline = Date.now() + (options.timeout ?? DEFAULT_TIMEOUT);
    for (;;) {
      try {
        if (await this.evaluate<boolean>("document.readyState !== 'loading' && !!window.__TYT_E2E__", undefined, { timeout: 2_000 })) return;
      } catch {
        /* between documents */
      }
      if (Date.now() > deadline) throw new Error("waitForLoadState timed out");
      await sleep(50);
    }
  }

  async waitForURL(expected: TextPattern | ((url: URL) => boolean), options: { timeout?: number } = {}): Promise<void> {
    const deadline = Date.now() + (options.timeout ?? DEFAULT_TIMEOUT);
    let url = "";
    for (;;) {
      url = await this.url();
      if (urlMatches(url, expected)) {
        await this.waitForLoadState().catch(() => undefined);
        return;
      }
      if (Date.now() > deadline) throw new Error(`waitForURL timed out at ${url}`);
      await sleep(100);
    }
  }

  waitForTimeout(ms: number): Promise<void> {
    return sleep(ms);
  }

  async bringToFront(): Promise<void> {
    /* Headless: there is no front. */
  }

  /**
   * Fail requests whose URL matches one of `patterns` (`*` wildcards) as a
   * network error before they leave (e2e_dom.js), so a spec can make one
   * request fail the way a dropped connection does. An empty list lifts the
   * block. Kept for the tab.
   */
  blockRequests(patterns: string[]): Promise<void> {
    return this.evaluate(`window.__TYT_E2E__.block(${JSON.stringify(patterns)})`).then(() => undefined);
  }

  /**
   * The window moves the bridge asked for in this document (bridge.js drags
   * the window on a mousedown in a drag region), recorded instead of
   * performed by e2e_dom.js.
   */
  windowRequests(): Promise<string[]> {
    return this.evaluate<string[]>("window.__TYT_E2E__.windowRequests()");
  }

  /** Page errors and CSP violations collected since the document loaded. */
  problems(): Promise<string[]> {
    return this.evaluate<string[]>("window.__TYT_E2E_PROBLEMS__ ? window.__TYT_E2E_PROBLEMS__.slice() : []");
  }

  /** A PNG of the page, taken by the WebView itself (it works while hidden on macOS). */
  async screenshot(options: { path?: string } = {}): Promise<Buffer> {
    const base64 = await this.app.channel.call<string>("screenshot");
    const bytes = Buffer.from(base64, "base64");
    if (options.path) writeFileSync(options.path, bytes);
    return bytes;
  }
}

export const APP_BASE = process.platform === "win32" ? "http://app.localhost/" : "app://-/";

function urlMatches(url: string, expected: TextPattern | ((url: URL) => boolean)): boolean {
  if (typeof expected === "function") {
    try {
      return expected(new URL(url));
    } catch {
      return false;
    }
  }
  return expected instanceof RegExp ? expected.test(url) : url === expected;
}

export type WindowState = {
  visible: boolean;
  focused: boolean;
  minimized: boolean;
  maximized: boolean;
  fullscreen: boolean;
  alwaysOnTop: boolean;
  /** Outer position and inner size, in logical pixels. */
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  url: string;
  /** Every webview window the app has, the harness's foreign one included. */
  windows: number;
  /** macOS: NSApp's activation policy ("regular" has a Dock icon); null elsewhere. */
  activationPolicy: "regular" | "accessory" | "prohibited" | "unknown" | null;
  /** macOS: whether the app is the active one (has keyboard focus); null elsewhere. */
  appActive: boolean | null;
} | null;

export class DesktopApp {
  readonly page: DesktopPage;
  readonly output: string[] = [];
  private exited: Promise<number | null>;

  private constructor(
    readonly process: ChildProcess,
    readonly channel: Channel,
    readonly userDataDir: string,
  ) {
    this.page = new DesktopPage(this);
    this.exited = new Promise((resolve) => process.once("exit", (code) => resolve(code)));
  }

  static async launch(options: { executable: string; args?: string[]; env: Record<string, string>; userDataDir: string; timeout?: number }): Promise<DesktopApp> {
    const info = join(options.userDataDir, "e2e.json");
    const child = spawn(options.executable, options.args ?? [], { env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    const output: string[] = [];
    child.stdout?.on("data", (d) => output.push(String(d)));
    child.stderr?.on("data", (d) => output.push(String(d)));
    // Generous: macOS scans a freshly built, unsigned binary on its first
    // launch, which can take tens of seconds before main() runs.
    const deadline = Date.now() + (options.timeout ?? 90_000);
    let port = 0;
    let token = "";
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`the app exited (${child.exitCode}) before it was ready:\n${output.join("")}`);
      if (existsSync(info)) {
        try {
          const parsed = JSON.parse(readFileSync(info, "utf8")) as { port: number; token: string; pid: number };
          if (parsed.pid === child.pid) {
            port = parsed.port;
            token = parsed.token;
            break;
          }
        } catch {
          /* being written */
        }
      }
      await sleep(50);
    }
    if (!port) {
      child.kill();
      throw new Error(`the app never opened its control channel:\n${output.join("")}`);
    }
    const app = new DesktopApp(child, await Channel.open(port, token), options.userDataDir);
    app.output.push(...output);
    child.stdout?.on("data", (d) => app.output.push(String(d)));
    child.stderr?.on("data", (d) => app.output.push(String(d)));
    return app;
  }

  /** The one window, as Playwright's `app.windows()` listed it. */
  windows(): DesktopPage[] {
    return [this.page];
  }

  windowState(): Promise<WindowState> {
    return this.channel.call<WindowState>("window");
  }

  /** A shell test hook (the DesktopTestHook / ActivityTestHook surfaces). */
  hook<T = Json>(name: string, args?: unknown): Promise<T> {
    return this.channel.call<T>("hook", { name, args: args ?? null });
  }

  openedExternally(): Promise<string[]> {
    return this.channel.call<string[]>("openedExternally");
  }

  /** What the shell downloaded; headless, it saves into the profile without a dialog. */
  downloads(): Promise<{ file: string; state: "completed" | "interrupted"; path: string }[]> {
    return this.channel.call("downloads");
  }

  /** Resize the window the way a person dragging its edge does. */
  setWindowSize(width: number, height: number): Promise<void> {
    return this.channel.call("setSize", { width, height });
  }

  /** A push to the page's bridge listeners, through the shell's own push path. */
  push(channel: string, payload: unknown): Promise<void> {
    return this.channel.call("push", { channel, payload });
  }

  /**
   * A bridge call from a hidden window that is not the app's main one,
   * showing `url`: "allowed" or "refused: <message>".
   */
  foreignCall(url: string, channel: string): Promise<string> {
    return this.channel.call<string>("foreignCall", { url, channel });
  }

  /** Every label in the application menu, submenus included. */
  menuLabels(): Promise<string[]> {
    return this.channel.call<string[]>("menu");
  }

  /** macOS: whether Web Inspector can reach the WebView; null elsewhere. */
  inspection(): Promise<{ inspectable: boolean | null; developerExtras: boolean | null } | null> {
    return this.channel.call("inspection");
  }

  /** macOS: the window's background colour, whether the WebView paints over it, and the theme; null elsewhere. */
  background(): Promise<{ window: string | null; webviewDrawsBackground: boolean | null; dark: boolean } | null> {
    return this.channel.call("background");
  }

  /** Network on or off for the page, as `context().setOffline` did (e2e.rs). */
  setOffline(offline: boolean): Promise<void> {
    return this.channel.call("offline", { offline });
  }

  context(): { setOffline: (offline: boolean) => Promise<void> } {
    return { setOffline: (offline) => this.setOffline(offline) };
  }

  /** Quit the app (as the bridge's quit does) and wait for the process to end. */
  async close(): Promise<void> {
    if (this.process.exitCode !== null) return;
    await this.channel.call("quit").catch(() => undefined);
    const timer = setTimeout(() => this.process.kill(), 10_000);
    await this.exited;
    clearTimeout(timer);
    this.channel.close();
  }

  waitForExit(): Promise<number | null> {
    return this.exited;
  }
}

// ── expect ───────────────────────────────────────────────────────────────

async function poll(isNot: boolean, timeout: number, probe: () => Promise<{ pass: boolean; actual: unknown }>) {
  const deadline = Date.now() + timeout;
  let last: { pass: boolean; actual: unknown } = { pass: false, actual: undefined };
  for (;;) {
    try {
      last = await probe();
    } catch (error) {
      last = { pass: false, actual: String(error) };
    }
    if (last.pass !== isNot || Date.now() > deadline) return last;
    await sleep(100);
  }
}

function textMatch(actual: string | null, expected: TextPattern, contains: boolean): boolean {
  if (actual === null) return false;
  const normalized = actual.replace(/\s+/g, " ").trim();
  if (expected instanceof RegExp) return expected.test(normalized);
  const want = expected.replace(/\s+/g, " ").trim();
  return contains ? normalized.includes(want) : normalized === want;
}

type MatcherThis = { isNot: boolean; timeout?: number };

function result(
  self: MatcherThis,
  name: string,
  outcome: { pass: boolean; actual: unknown },
  expected: unknown,
  receiver: Locator | DesktopPage,
) {
  return {
    pass: outcome.pass,
    name,
    expected,
    actual: outcome.actual,
    message: () =>
      `${name}${self.isNot ? " (not)" : ""} failed for ${receiver.toString()}\n  expected: ${String(expected)}\n  received: ${JSON.stringify(outcome.actual)}`,
  };
}

const timeoutOf = (self: MatcherThis, options?: { timeout?: number }) => options?.timeout ?? self.timeout ?? 5_000;

export const expect = baseExpect.extend({
  async toBeVisible(this: MatcherThis, locator: Locator, options?: { timeout?: number; visible?: boolean }) {
    const want = options?.visible ?? true;
    const outcome = await poll(this.isNot, timeoutOf(this, options), async () => {
      const visible = await locator.isVisible();
      return { pass: visible === want, actual: visible ? "visible" : "hidden" };
    });
    return result(this, "toBeVisible", outcome, want ? "visible" : "hidden", locator);
  },
  async toBeHidden(this: MatcherThis, locator: Locator, options?: { timeout?: number }) {
    const outcome = await poll(this.isNot, timeoutOf(this, options), async () => {
      const visible = await locator.isVisible();
      return { pass: !visible, actual: visible ? "visible" : "hidden" };
    });
    return result(this, "toBeHidden", outcome, "hidden", locator);
  },
  async toBeEmpty(this: MatcherThis, locator: Locator, options?: { timeout?: number }) {
    const outcome = await poll(this.isNot, timeoutOf(this, options), async () => {
      // Playwright's rule: an empty editable, or a node with no text.
      const actual = await locator.evaluate((el) =>
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el.textContent ?? "").trim(),
      );
      return { pass: actual === "", actual: actual.slice(0, 80) };
    });
    return result(this, "toBeEmpty", outcome, "empty", locator);
  },
  async toHaveClass(this: MatcherThis, locator: Locator, expected: TextPattern, options?: { timeout?: number }) {
    const outcome = await poll(this.isNot, timeoutOf(this, options), async () => {
      const actual = (await locator.getAttribute("class")) ?? "";
      return { pass: expected instanceof RegExp ? expected.test(actual) : actual === expected, actual };
    });
    return result(this, "toHaveClass", outcome, expected, locator);
  },
  async toHaveCount(this: MatcherThis, locator: Locator, count: number, options?: { timeout?: number }) {
    const outcome = await poll(this.isNot, timeoutOf(this, options), async () => {
      const actual = await locator.count();
      return { pass: actual === count, actual };
    });
    return result(this, "toHaveCount", outcome, count, locator);
  },
  async toHaveText(this: MatcherThis, locator: Locator, expected: TextPattern, options?: { timeout?: number }) {
    const outcome = await poll(this.isNot, timeoutOf(this, options), async () => {
      const actual = await locator.query<string | null>("text");
      return { pass: textMatch(actual, expected, false), actual };
    });
    return result(this, "toHaveText", outcome, expected, locator);
  },
  async toContainText(this: MatcherThis, locator: Locator, expected: TextPattern, options?: { timeout?: number }) {
    const outcome = await poll(this.isNot, timeoutOf(this, options), async () => {
      const actual = await locator.query<string | null>("text");
      return { pass: textMatch(actual, expected, true), actual };
    });
    return result(this, "toContainText", outcome, expected, locator);
  },
  async toHaveAttribute(this: MatcherThis, locator: Locator, name: string, expected?: TextPattern, options?: { timeout?: number }) {
    const outcome = await poll(this.isNot, timeoutOf(this, options), async () => {
      const actual = await locator.getAttribute(name);
      const pass = expected === undefined ? actual !== null : actual !== null && (expected instanceof RegExp ? expected.test(actual) : actual === expected);
      return { pass, actual };
    });
    return result(this, "toHaveAttribute", outcome, expected === undefined ? `[${name}]` : `${name}=${String(expected)}`, locator);
  },
  async toHaveValue(this: MatcherThis, locator: Locator, expected: TextPattern, options?: { timeout?: number }) {
    const outcome = await poll(this.isNot, timeoutOf(this, options), async () => {
      const actual = await locator.inputValue();
      return { pass: expected instanceof RegExp ? expected.test(actual) : actual === expected, actual };
    });
    return result(this, "toHaveValue", outcome, expected, locator);
  },
  async toBeEnabled(this: MatcherThis, locator: Locator, options?: { timeout?: number }) {
    const outcome = await poll(this.isNot, timeoutOf(this, options), async () => {
      const actual = await locator.isEnabled();
      return { pass: actual, actual: actual ? "enabled" : "disabled" };
    });
    return result(this, "toBeEnabled", outcome, "enabled", locator);
  },
  async toBeDisabled(this: MatcherThis, locator: Locator, options?: { timeout?: number }) {
    const outcome = await poll(this.isNot, timeoutOf(this, options), async () => {
      const actual = await locator.isEnabled();
      return { pass: !actual, actual: actual ? "enabled" : "disabled" };
    });
    return result(this, "toBeDisabled", outcome, "disabled", locator);
  },
  async toBeChecked(this: MatcherThis, locator: Locator, options?: { timeout?: number; checked?: boolean }) {
    const want = options?.checked ?? true;
    const outcome = await poll(this.isNot, timeoutOf(this, options), async () => {
      const actual = await locator.isChecked();
      return { pass: actual === want, actual };
    });
    return result(this, "toBeChecked", outcome, want, locator);
  },
  async toBeFocused(this: MatcherThis, locator: Locator, options?: { timeout?: number }) {
    const outcome = await poll(this.isNot, timeoutOf(this, options), async () => {
      const actual = await locator.query<boolean>("focused");
      return { pass: actual, actual };
    });
    return result(this, "toBeFocused", outcome, "focused", locator);
  },
  async toHaveURL(this: MatcherThis, page: DesktopPage, expected: TextPattern, options?: { timeout?: number }) {
    const outcome = await poll(this.isNot, timeoutOf(this, options), async () => {
      const actual = await page.url();
      return { pass: urlMatches(actual, expected), actual };
    });
    return result(this, "toHaveURL", outcome, expected, page);
  },
});
