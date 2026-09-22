/*
 * Linux on X11: `xprop`.
 *
 * `xprop -root -spy _NET_ACTIVE_WINDOW` prints a line whenever the window
 * manager changes the active window, so detection is event-driven; each new
 * window id is then described with one `xprop -id <wid> WM_CLASS _NET_WM_PID
 * _NET_WM_NAME`. The key is WM_CLASS's class (the second string), which is
 * what a desktop file's StartupWMClass names. The title (`_NET_WM_NAME`) is
 * read only while titles are on, and then also every five seconds, since a
 * title changes without the active window changing.
 *
 * Wayland is refused before this file is reached (distribution.ts): XWayland
 * answers only for X clients and would record wrong data, silently.
 *
 * `xprop` is looked up on PATH here, in Node, and run by absolute path with
 * no shell. Missing → `tool-missing` with the package to install as the hint.
 */

import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";

import type { FrontmostTarget } from "./keys.ts";
import {
  createRestartPolicy,
  RETRY_AFTER_MS,
  type ChildHandle,
  type FrontmostSource,
  type ProcessRunner,
  type SourceListener,
  type Timers,
} from "./source.ts";

export const LINUX_TITLE_REFRESH_MS = 5_000;
/** The spy prints nothing while nothing changes, so a quiet one is not a hung one; it only must not exit. */
const XPROP_ENV = { LC_ALL: "C.UTF-8" };

/** The window id in a `_NET_ACTIVE_WINDOW` line; null for `0x0` (nothing focused) and for junk. */
export function parseActiveWindowLine(line: string): string | null | undefined {
  const match = /_NET_ACTIVE_WINDOW\(WINDOW\): window id # (0x[0-9a-f]+)/i.exec(line);
  if (match === null) return undefined;
  const id = match[1] ?? "";
  return /^0x0+$/i.test(id) ? null : id.toLowerCase();
}

/** Decode xprop's C-style escapes: `\"`, `\\`, `\n` and octal byte runs (`\303\244`) as UTF-8. */
export function decodeXpropString(value: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i] ?? "";
    if (char === "\\" && i + 1 < value.length) {
      const octal = /^[0-7]{1,3}/.exec(value.slice(i + 1));
      if (octal !== null) {
        bytes.push(Number.parseInt(octal[0], 8) & 0xff);
        i += octal[0].length;
        continue;
      }
      const next = value[i + 1] ?? "";
      bytes.push(...Buffer.from(next === "n" ? "\n" : next === "t" ? "\t" : next, "utf8"));
      i += 1;
      continue;
    }
    bytes.push(...Buffer.from(char, "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

const quotedStrings = (text: string): string[] =>
  [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => decodeXpropString(match[1] ?? ""));

/** The target `xprop -id` describes, or null without a WM_CLASS. */
export function parseXpropWindow(stdout: string): FrontmostTarget | null {
  let key: string | null = null;
  let pid: number | undefined;
  let title: string | undefined;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("WM_CLASS(")) {
      const [instance, klass] = quotedStrings(line);
      key = (klass ?? instance ?? "").trim() || null;
    } else if (line.startsWith("_NET_WM_PID(")) {
      const match = /=\s*(\d+)/.exec(line);
      if (match !== null) pid = Number(match[1]);
    } else if (line.startsWith("_NET_WM_NAME(")) {
      const [name] = quotedStrings(line);
      if (name !== undefined) title = name;
    }
  }
  if (key === null) return null;
  return { key, name: key, ...(pid !== undefined ? { pid } : {}), ...(title !== undefined ? { title } : {}) };
}

/** `xprop` on PATH, as an absolute path, or null. */
export function findOnPath(
  tool: string,
  envPath: string | undefined,
  isExecutable: (file: string) => boolean = (file) => {
    try {
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
): string | null {
  for (const dir of (envPath ?? "").split(path.delimiter)) {
    if (dir === "" || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, tool);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** The package that ships `xprop` on this distribution. A name, never a sentence. */
export function xpropPackageHint(exists: (file: string) => boolean = existsSync): string {
  if (exists("/etc/debian_version")) return "x11-utils";
  if (exists("/etc/arch-release")) return "xorg-xprop";
  return "xprop";
}

export function createLinuxSource(
  runner: ProcessRunner,
  timers: Timers,
  options: { env: Record<string, string | undefined> },
): FrontmostSource {
  let listener: SourceListener | null = null;
  let spy: ChildHandle | null = null;
  let retry: unknown = null;
  let refresh: unknown = null;
  let titles = false;
  let activeId: string | null = null;
  let generation = 0;
  const policy = createRestartPolicy(timers.now);

  const describe = async (id: string | null): Promise<void> => {
    const mine = ++generation;
    if (id === null) {
      listener?.target(null);
      return;
    }
    const xprop = findOnPath("xprop", options.env.PATH);
    if (xprop === null) return;
    const props = titles ? ["WM_CLASS", "_NET_WM_PID", "_NET_WM_NAME"] : ["WM_CLASS", "_NET_WM_PID"];
    const result = await runner.run(xprop, ["-id", id, ...props], { env: XPROP_ENV });
    // A newer change overtook this one: its answer wins.
    if (mine !== generation || listener === null) return;
    const target = result.code === 0 ? parseXpropWindow(result.stdout) : null;
    if (target !== null && !titles) delete target.title;
    listener.target(target);
  };

  const clearTimers = (): void => {
    if (retry !== null) timers.clearTimeout(retry);
    if (refresh !== null) timers.clearInterval(refresh);
    retry = null;
    refresh = null;
  };

  const kill = (): void => {
    const current = spy;
    spy = null;
    current?.kill();
  };

  const syncRefresh = (): void => {
    if (refresh !== null) timers.clearInterval(refresh);
    refresh = null;
    if (titles && listener !== null) {
      refresh = timers.setInterval(() => void describe(activeId), LINUX_TITLE_REFRESH_MS);
    }
  };

  const launch = (): void => {
    kill();
    const xprop = findOnPath("xprop", options.env.PATH);
    if (xprop === null) {
      listener?.failure({ reason: "tool-missing", hint: xpropPackageHint() });
      return;
    }
    const handle = runner.spawn(xprop, ["-root", "-spy", "_NET_ACTIVE_WINDOW"], { env: XPROP_ENV });
    spy = handle;
    handle.onLine((line) => {
      if (spy !== handle || listener === null) return;
      const id = parseActiveWindowLine(line);
      if (id === undefined) return;
      policy.succeed();
      listener.failure(null);
      activeId = id;
      void describe(id);
    });
    handle.onExit(() => {
      if (spy !== handle || listener === null) return;
      spy = null;
      if (policy.fail() === "restart") {
        launch();
        return;
      }
      clearTimers();
      listener.failure({ reason: "source-failed", hint: null });
      retry = timers.setTimeout(() => {
        retry = null;
        if (listener !== null) {
          launch();
          syncRefresh();
        }
      }, RETRY_AFTER_MS);
    });
  };

  return {
    kind: "linux-xprop",
    start: (next) => {
      listener = next;
      launch();
      syncRefresh();
    },
    stop: () => {
      listener = null;
      generation += 1;
      clearTimers();
      kill();
      activeId = null;
    },
    setTitles: (on) => {
      titles = on;
      syncRefresh();
    },
  };
}
