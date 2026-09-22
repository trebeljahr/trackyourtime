/*
 * Windows: one long-lived `powershell.exe` running an embedded script.
 *
 * The script P/Invokes `GetForegroundWindow`, `GetWindowThreadProcessId` and
 * `QueryFullProcessImageNameW` (with `PROCESS_QUERY_LIMITED_INFORMATION`, the
 * right a standard user has over other processes), and `GetWindowTextW` only
 * when titles are on — the flag is baked into the script, so toggling titles
 * restarts the helper. It checks once a second and prints a JSON line only on
 * a change, plus `{"alive":true}` every 30 s so a hung helper can be told from
 * a person who stayed in one app.
 *
 * The script is a string constant in the esbuild bundle and goes to
 * PowerShell as `-EncodedCommand`: the asar holds only the bundle, and no
 * `.ps1` file is ever written or executed. Constrained Language Mode (AppLocker
 * or WDAC) refuses `Add-Type`; the script checks first and reports
 * `constrained-language`, which is `blocked-by-policy` here.
 *
 * Watchdog: no line for 90 s → kill and respawn; three failures in ten
 * minutes → `source-failed`, retried every five minutes. The helper also exits
 * on its own when this app's process is gone, so a crash leaves nothing behind.
 */

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

/** A helper silent for this long is presumed hung. */
export const WINDOWS_WATCHDOG_MS = 90_000;

export function powershellPath(env: Record<string, string | undefined>): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

export const WINDOWS_FOREGROUND_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  [Console]::Out.WriteLine('{"error":"constrained-language"}'); [Console]::Out.Flush(); exit 3
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class TytForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
$titles = __TITLES__
$parentId = __PARENT__
$names = @{}
$last = ''
$lastLine = [DateTime]::UtcNow
$lastParentCheck = [DateTime]::UtcNow
while ($true) {
  $line = '{"none":true}'
  $window = [TytForeground]::GetForegroundWindow()
  if ($window -ne [IntPtr]::Zero) {
    $processId = [uint32]0
    [void][TytForeground]::GetWindowThreadProcessId($window, [ref]$processId)
    $path = ''
    $handle = [TytForeground]::OpenProcess(0x1000, $false, $processId)
    if ($handle -ne [IntPtr]::Zero) {
      $buffer = New-Object System.Text.StringBuilder 1024
      $size = [uint32]1024
      if ([TytForeground]::QueryFullProcessImageNameW($handle, 0, $buffer, [ref]$size)) { $path = $buffer.ToString() }
      [void][TytForeground]::CloseHandle($handle)
    }
    if ($path -ne '') {
      $exe = [System.IO.Path]::GetFileName($path)
      if (-not $names.ContainsKey($path)) {
        $description = ''
        try { $description = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($path).FileDescription } catch { }
        if ([string]::IsNullOrWhiteSpace($description)) { $description = $exe }
        $names[$path] = $description
      }
      $record = [ordered]@{ key = $exe; name = $names[$path]; pid = [int]$processId }
      if ($titles) {
        $text = New-Object System.Text.StringBuilder 512
        [void][TytForeground]::GetWindowTextW($window, $text, 512)
        $record.title = $text.ToString()
      }
      $line = ConvertTo-Json -InputObject $record -Compress
    }
  }
  $now = [DateTime]::UtcNow
  if ($line -ne $last) {
    [Console]::Out.WriteLine($line); [Console]::Out.Flush(); $last = $line; $lastLine = $now
  } elseif (($now - $lastLine).TotalSeconds -ge 30) {
    [Console]::Out.WriteLine('{"alive":true}'); [Console]::Out.Flush(); $lastLine = $now
  }
  if (($now - $lastParentCheck).TotalSeconds -ge 30) {
    $lastParentCheck = $now
    if (-not (Get-Process -Id $parentId -ErrorAction SilentlyContinue)) { exit 0 }
  }
  Start-Sleep -Seconds 1
}
`;

/** The script with its two parameters filled in, as `-EncodedCommand` wants it (UTF-16LE, base64). */
export function encodedForegroundScript(titles: boolean, parentPid: number): string {
  const script = WINDOWS_FOREGROUND_SCRIPT.replace("__TITLES__", titles ? "$true" : "$false").replace(
    "__PARENT__",
    String(Math.trunc(parentPid)),
  );
  return Buffer.from(script, "utf16le").toString("base64");
}

export type WindowsHelperLine =
  | { kind: "target"; target: FrontmostTarget }
  | { kind: "none" }
  | { kind: "alive" }
  | { kind: "error"; error: string }
  | { kind: "junk" };

export function parseWindowsHelperLine(line: string): WindowsHelperLine {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return { kind: "junk" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { kind: "junk" };
  const record = value as Record<string, unknown>;
  if (record.alive === true) return { kind: "alive" };
  if (record.none === true) return { kind: "none" };
  if (typeof record.error === "string") return { kind: "error", error: record.error };
  if (typeof record.key !== "string" || record.key.trim() === "") return { kind: "junk" };
  const name = typeof record.name === "string" && record.name.trim() !== "" ? record.name : record.key;
  return {
    kind: "target",
    target: {
      key: record.key,
      name,
      ...(typeof record.pid === "number" && Number.isInteger(record.pid) ? { pid: record.pid } : {}),
      ...(typeof record.title === "string" ? { title: record.title } : {}),
    },
  };
}

export function createWindowsSource(
  runner: ProcessRunner,
  timers: Timers,
  options: { env: Record<string, string | undefined>; parentPid: number },
): FrontmostSource {
  let listener: SourceListener | null = null;
  let child: ChildHandle | null = null;
  let watchdog: unknown = null;
  let retry: unknown = null;
  let titles = false;
  let lastTarget: FrontmostTarget | null = null;
  const policy = createRestartPolicy(timers.now);

  const clearTimers = (): void => {
    if (watchdog !== null) timers.clearTimeout(watchdog);
    if (retry !== null) timers.clearTimeout(retry);
    watchdog = null;
    retry = null;
  };

  const kill = (): void => {
    const current = child;
    child = null;
    current?.kill();
  };

  const armWatchdog = (): void => {
    if (watchdog !== null) timers.clearTimeout(watchdog);
    watchdog = timers.setTimeout(() => {
      watchdog = null;
      kill();
      failed();
    }, WINDOWS_WATCHDOG_MS);
  };

  const giveUp = (reason: "source-failed" | "blocked-by-policy"): void => {
    clearTimers();
    kill();
    listener?.failure({ reason, hint: null });
    if (reason === "source-failed") {
      retry = timers.setTimeout(() => {
        retry = null;
        if (listener !== null) launch();
      }, RETRY_AFTER_MS);
    }
  };

  const failed = (): void => {
    if (listener === null) return;
    if (policy.fail() === "give-up") giveUp("source-failed");
    else launch();
  };

  const launch = (): void => {
    kill();
    const handle = runner.spawn(powershellPath(options.env), [
      "-NoProfile",
      "-NonInteractive",
      "-NoLogo",
      "-EncodedCommand",
      encodedForegroundScript(titles, options.parentPid),
    ]);
    child = handle;
    armWatchdog();
    handle.onLine((line) => {
      if (child !== handle || listener === null) return;
      const parsed = parseWindowsHelperLine(line);
      if (parsed.kind === "junk") return;
      armWatchdog();
      if (parsed.kind === "error") {
        giveUp(parsed.error === "constrained-language" ? "blocked-by-policy" : "source-failed");
        return;
      }
      policy.succeed();
      listener.failure(null);
      if (parsed.kind === "target") lastTarget = parsed.target;
      if (parsed.kind === "none") lastTarget = null;
      // `alive` repeats the last answer, which keeps a long stretch in one app alive.
      listener.target(lastTarget);
    });
    handle.onExit(() => {
      if (child !== handle) return;
      child = null;
      if (watchdog !== null) timers.clearTimeout(watchdog);
      watchdog = null;
      failed();
    });
  };

  return {
    kind: "windows-powershell",
    start: (next) => {
      listener = next;
      launch();
    },
    stop: () => {
      listener = null;
      clearTimers();
      kill();
      lastTarget = null;
    },
    setTitles: (on) => {
      if (on === titles) return;
      titles = on;
      if (listener !== null && child !== null) launch();
    },
  };
}
