import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BUILT_IN_NEVER_RECORD, toActivityKey, type FrontmostTarget } from "./keys.ts";
import {
  decodeXpropString,
  findOnPath,
  parseActiveWindowLine,
  parseXpropWindow,
  xpropPackageHint,
  createLinuxSource,
} from "./source-linux.ts";
import { createMacosSource, LSAPPINFO, parseLsappinfoFront, parseLsappinfoInfo } from "./source-macos.ts";
import {
  createWindowsSource,
  encodedForegroundScript,
  parseWindowsHelperLine,
  powershellPath,
  WINDOWS_WATCHDOG_MS,
} from "./source-windows.ts";
import {
  createLineSplitter,
  RETRY_AFTER_MS,
  type ChildHandle,
  type ProcessRunner,
  type RunResult,
  type SourceFailure,
  type SourceListener,
  type Timers,
} from "./source.ts";

// ── fakes ─────────────────────────────────────────────────────────────

interface FakeTimers extends Timers {
  advance: (ms: number) => void;
}

function fakeTimers(): FakeTimers {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void; every: number | null }>();
  const timers: FakeTimers = {
    now: () => now,
    setInterval: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn, every: ms });
      return id;
    },
    clearInterval: (id) => {
      pending.delete(id as number);
    },
    setTimeout: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn, every: null });
      return id;
    },
    clearTimeout: (id) => {
      pending.delete(id as number);
    },
    advance: (ms) => {
      const until = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        const [id, timer] = due;
        now = timer.at;
        if (timer.every === null) pending.delete(id);
        else timer.at += timer.every;
        timer.fn();
      }
      now = until;
    },
  };
  return timers;
}

interface FakeChild extends ChildHandle {
  file: string;
  args: readonly string[];
  emitLine: (line: string) => void;
  exit: (code: number | null) => void;
  killed: boolean;
}

function fakeRunner(answer: (file: string, args: readonly string[]) => RunResult): ProcessRunner & {
  runs: string[][];
  children: FakeChild[];
} {
  const runs: string[][] = [];
  const children: FakeChild[] = [];
  return {
    runs,
    children,
    run: (file, args) => {
      runs.push([file, ...args]);
      return Promise.resolve(answer(file, args));
    },
    spawn: (file, args) => {
      const lines: ((line: string) => void)[] = [];
      const exits: ((code: number | null) => void)[] = [];
      const child: FakeChild = {
        file,
        args,
        killed: false,
        onLine: (listener) => {
          lines.push(listener);
        },
        onExit: (listener) => {
          exits.push(listener);
        },
        kill: () => {
          child.killed = true;
          for (const exit of exits) exit(null);
        },
        emitLine: (line) => {
          for (const listener of lines) listener(line);
        },
        exit: (code) => {
          for (const exit of exits) exit(code);
        },
      };
      children.push(child);
      return child;
    },
  };
}

function recorder(): SourceListener & { targets: (FrontmostTarget | null)[]; failures: (SourceFailure | null)[] } {
  const targets: (FrontmostTarget | null)[] = [];
  const failures: (SourceFailure | null)[] = [];
  return {
    targets,
    failures,
    target: (target) => targets.push(target),
    failure: (failure) => failures.push(failure),
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// ── keys ──────────────────────────────────────────────────────────────

describe("toActivityKey", () => {
  it("lowercases and replaces the characters core's globs cut at", () => {
    assert.equal(toActivityKey("  com.JetBrains.IntelliJ "), "com.jetbrains.intellij");
    assert.equal(toActivityKey("C:\\Program Files\\App\\app.exe"), "c-program-files-app-app.exe");
    assert.equal(toActivityKey("Gnome-terminal"), "gnome-terminal");
    assert.equal(toActivityKey("host:8080/x"), "host-8080-x");
    assert.equal(toActivityKey("x".repeat(500)).length, 200);
  });

  it("lists this app and the lock screens as never recorded", () => {
    for (const key of ["com.trebeljahr.trackyourtime", "com.apple.loginwindow", "lockapp.exe", "logonui.exe"]) {
      assert.ok(BUILT_IN_NEVER_RECORD.includes(key), key);
      assert.equal(toActivityKey(key), key);
    }
  });
});

// ── macOS ─────────────────────────────────────────────────────────────

describe("lsappinfo parsers", () => {
  it("reads the ASN from front", () => {
    assert.equal(parseLsappinfoFront("ASN:0x0-0xaadaad:\n"), "ASN:0x0-0xaadaad:");
    assert.equal(parseLsappinfoFront("[ NULL ]"), null);
    assert.equal(parseLsappinfoFront(""), null);
  });

  it("reads bundle id, name and pid", () => {
    const stdout = '"CFBundleIdentifier"="com.google.Chrome"\n"LSDisplayName"="Google Chrome"\n"pid"=60880\n';
    assert.deepEqual(parseLsappinfoInfo(stdout), { key: "com.google.Chrome", name: "Google Chrome", pid: 60880 });
  });

  it("falls back to exe-<name> without a bundle id, and decodes escapes", () => {
    const stdout = '"CFBundleIdentifier"=[ NULL ]\n"LSDisplayName"="my \\"tool\\" \\u00e4"\n"pid"=12\n';
    assert.deepEqual(parseLsappinfoInfo(stdout), { key: 'exe-my "tool" ä', name: 'my "tool" ä', pid: 12 });
  });

  it("answers null for output it does not recognise", () => {
    assert.equal(parseLsappinfoInfo("something else entirely"), null);
  });
});

describe("macOS source", () => {
  it("polls front and asks info only when the ASN changes", async () => {
    let asn = "ASN:0x0-0x1:";
    const runner = fakeRunner((_file, args) =>
      args[0] === "front"
        ? { code: 0, stdout: `${asn}\n` }
        : { code: 0, stdout: `"CFBundleIdentifier"="app.${args.at(-1)}"\n"LSDisplayName"="App"\n"pid"=5\n` },
    );
    const timers = fakeTimers();
    const source = createMacosSource(runner, timers);
    const listener = recorder();
    source.start(listener);
    await settle();
    timers.advance(5_000);
    await settle();
    asn = "ASN:0x0-0x2:";
    timers.advance(5_000);
    await settle();
    assert.ok(runner.runs.every((run) => run[0] === LSAPPINFO));
    assert.equal(runner.runs.filter((run) => run[1] === "info").length, 2);
    assert.deepEqual(
      listener.targets.map((t) => t?.key),
      ["app.ASN:0x0-0x1:", "app.ASN:0x0-0x1:", "app.ASN:0x0-0x2:"],
    );
    source.stop();
    const before = runner.runs.length;
    timers.advance(60_000);
    await settle();
    assert.equal(runner.runs.length, before);
  });

  it("gives up after three failures and retries five minutes later", async () => {
    let broken = true;
    const runner = fakeRunner((_file, args) =>
      broken
        ? { code: 1, stdout: "" }
        : args[0] === "front"
          ? { code: 0, stdout: "ASN:0x0-0x1:" }
          : { code: 0, stdout: '"CFBundleIdentifier"="a.b"\n"LSDisplayName"="AB"\n' },
    );
    const timers = fakeTimers();
    const source = createMacosSource(runner, timers);
    const listener = recorder();
    source.start(listener);
    for (let i = 0; i < 3; i += 1) {
      await settle();
      timers.advance(5_000);
    }
    await settle();
    assert.deepEqual(listener.failures.at(-1), { reason: "source-failed", hint: null });
    const runsAtGiveUp = runner.runs.length;
    timers.advance(RETRY_AFTER_MS - 10_000);
    await settle();
    assert.equal(runner.runs.length, runsAtGiveUp);
    broken = false;
    timers.advance(10_000);
    await settle();
    await settle();
    assert.equal(listener.failures.at(-1), null);
    assert.equal(listener.targets.at(-1)?.key, "a.b");
  });
});

// ── Windows ───────────────────────────────────────────────────────────

describe("PowerShell helper lines", () => {
  it("parses targets, none, alive and errors", () => {
    assert.deepEqual(parseWindowsHelperLine('{"key":"Code.exe","name":"Visual Studio Code","pid":42,"title":"a.ts"}'), {
      kind: "target",
      target: { key: "Code.exe", name: "Visual Studio Code", pid: 42, title: "a.ts" },
    });
    assert.deepEqual(parseWindowsHelperLine('{"key":"x.exe","name":""}'), {
      kind: "target",
      target: { key: "x.exe", name: "x.exe" },
    });
    assert.deepEqual(parseWindowsHelperLine('{"none":true}'), { kind: "none" });
    assert.deepEqual(parseWindowsHelperLine('{"alive":true}'), { kind: "alive" });
    assert.deepEqual(parseWindowsHelperLine('{"error":"constrained-language"}'), {
      kind: "error",
      error: "constrained-language",
    });
    assert.deepEqual(parseWindowsHelperLine("Add-Type : something"), { kind: "junk" });
  });

  it("bakes the titles flag and the parent pid into the encoded script", () => {
    const decode = (b64: string): string => Buffer.from(b64, "base64").toString("utf16le");
    assert.match(decode(encodedForegroundScript(false, 77)), /\$titles = \$false\n\$parentId = 77\n/);
    assert.match(decode(encodedForegroundScript(true, 77)), /\$titles = \$true/);
    assert.equal(powershellPath({ SystemRoot: "D:\\Win" }), "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });
});

describe("Windows source", () => {
  const start = (): {
    runner: ReturnType<typeof fakeRunner>;
    timers: FakeTimers;
    listener: ReturnType<typeof recorder>;
    source: ReturnType<typeof createWindowsSource>;
  } => {
    const runner = fakeRunner(() => ({ code: 0, stdout: "" }));
    const timers = fakeTimers();
    const source = createWindowsSource(runner, timers, { env: { SystemRoot: "C:\\Windows" }, parentPid: 9 });
    const listener = recorder();
    source.start(listener);
    return { runner, timers, listener, source };
  };

  it("spawns one absolute powershell.exe with no profile and an encoded command", () => {
    const { runner, listener } = start();
    const [child] = runner.children;
    assert.equal(child?.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.deepEqual(child?.args.slice(0, 4), ["-NoProfile", "-NonInteractive", "-NoLogo", "-EncodedCommand"]);
    child?.emitLine('{"key":"code.exe","name":"Code","pid":1}');
    child?.emitLine('{"alive":true}');
    child?.emitLine('{"none":true}');
    assert.deepEqual(
      listener.targets.map((t) => t?.key ?? null),
      ["code.exe", "code.exe", null],
    );
  });

  it("reports Constrained Language Mode as blocked-by-policy and does not retry", () => {
    const { runner, timers, listener } = start();
    runner.children[0]?.emitLine('{"error":"constrained-language"}');
    assert.deepEqual(listener.failures.at(-1), { reason: "blocked-by-policy", hint: null });
    timers.advance(60 * 60_000);
    assert.equal(runner.children.length, 1);
  });

  it("respawns a silent helper and gives up after three failures", () => {
    const { runner, timers, listener } = start();
    timers.advance(WINDOWS_WATCHDOG_MS);
    assert.equal(runner.children[0]?.killed, true);
    assert.equal(runner.children.length, 2);
    runner.children[1]?.exit(1);
    assert.equal(runner.children.length, 3);
    runner.children[2]?.exit(1);
    assert.deepEqual(listener.failures.at(-1), { reason: "source-failed", hint: null });
    assert.equal(runner.children.length, 3);
    timers.advance(RETRY_AFTER_MS);
    assert.equal(runner.children.length, 4);
  });

  it("restarts the helper when titles are toggled, and kills it on stop", () => {
    const { runner, source } = start();
    source.setTitles(true);
    assert.equal(runner.children.length, 2);
    assert.equal(runner.children[0]?.killed, true);
    source.stop();
    assert.equal(runner.children[1]?.killed, true);
  });
});

// ── Linux ─────────────────────────────────────────────────────────────

describe("xprop parsers", () => {
  it("reads the active window id, and 0x0 as nothing", () => {
    assert.equal(parseActiveWindowLine("_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3A00007"), "0x3a00007");
    assert.equal(parseActiveWindowLine("_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0"), null);
    assert.equal(parseActiveWindowLine("garbage"), undefined);
  });

  it("reads WM_CLASS's class, the pid and the title, decoding octal escapes", () => {
    const stdout = [
      'WM_CLASS(STRING) = "gnome-terminal-server", "Gnome-terminal"',
      "_NET_WM_PID(CARDINAL) = 4321",
      '_NET_WM_NAME(UTF8_STRING) = "Gr\\303\\274\\303\\237e \\"x\\""',
    ].join("\n");
    assert.deepEqual(parseXpropWindow(stdout), {
      key: "Gnome-terminal",
      name: "Gnome-terminal",
      pid: 4321,
      title: 'Grüße "x"',
    });
  });

  it("answers null without WM_CLASS and tolerates a missing pid", () => {
    assert.equal(parseXpropWindow("WM_CLASS:  not found.\n_NET_WM_PID:  not found."), null);
    assert.deepEqual(parseXpropWindow('WM_CLASS(STRING) = "firefox", "firefox"\n_NET_WM_PID:  not found.'), {
      key: "firefox",
      name: "firefox",
    });
    assert.equal(decodeXpropString("a\\\\b"), "a\\b");
  });

  it("finds xprop on PATH by absolute directory only, and names the package", () => {
    assert.equal(findOnPath("xprop", "relative:/usr/bin", (file) => file === "/usr/bin/xprop"), "/usr/bin/xprop");
    assert.equal(findOnPath("xprop", "relative", () => true), null);
    assert.equal(xpropPackageHint((file) => file === "/etc/debian_version"), "x11-utils");
    assert.equal(xpropPackageHint((file) => file === "/etc/arch-release"), "xorg-xprop");
    assert.equal(xpropPackageHint(() => false), "xprop");
  });
});

describe("Linux source", () => {
  it("reports tool-missing without spawning when xprop is not on PATH", () => {
    const runner = fakeRunner(() => ({ code: 0, stdout: "" }));
    const source = createLinuxSource(runner, fakeTimers(), { env: { PATH: "/nonexistent-tyt-dir" } });
    const listener = recorder();
    source.start(listener);
    assert.equal(runner.children.length, 0);
    assert.equal(listener.failures.at(-1)?.reason, "tool-missing");
  });
});

describe("createLineSplitter", () => {
  it("splits chunks and drops an over-long line", () => {
    const lines: string[] = [];
    const split = createLineSplitter((line) => lines.push(line));
    split("a\r\nb");
    split("c\n");
    split("x".repeat(70_000));
    split("tail\nnext\n");
    assert.deepEqual(lines, ["a", "bc", "next"]);
  });
});

/*
 * Opt-in, never in CI: the parsers against a real `lsappinfo` on this Mac.
 * Read-only and prompt-free, and it launches no Electron — but it does read
 * the real frontmost app, which is why it is off unless asked for.
 */
describe("real lsappinfo", () => {
  const enabled = process.env.TRACKYOURTIME_ACTIVITY_REAL_SOURCE_TEST === "1" && process.platform === "darwin";
  it("parses what this Mac answers", { skip: !enabled }, async () => {
    const { createNodeProcessRunner } = await import("./process-runner.ts");
    const runner = createNodeProcessRunner();
    const front = await runner.run(LSAPPINFO, ["front"]);
    const asn = parseLsappinfoFront(front.stdout);
    assert.ok(asn !== null, front.stdout);
    const info = await runner.run(LSAPPINFO, ["info", "-only", "bundleid", "-only", "name", "-only", "pid", asn]);
    const target = parseLsappinfoInfo(info.stdout);
    assert.ok(target !== null && target.key !== "", info.stdout);
  });
});
