/*
 * macOS: `/usr/bin/lsappinfo`, polled.
 *
 * `lsappinfo front` prints the frontmost application's ASN
 * (`ASN:0x0-0xaadaad:`), and `lsappinfo info -only bundleid -only name -only
 * pid <ASN>` its bundle id, display name and pid. Both read LaunchServices'
 * own table: no TCC surface, no AppleEvents, no Accessibility, no Screen
 * Recording — nothing that can raise a permission prompt. Each call is a
 * spawn that exits at once.
 *
 * Window titles are not read on macOS: they need Screen Recording, whose
 * prompt and relaunch cannot be exercised here. `titlesAvailable` is false.
 *
 * The output format is undocumented. A macOS release that changes it makes
 * the parser answer null — no capture, never wrong capture — and after three
 * failures the source reports `source-failed` and retries every five minutes.
 */

import type { FrontmostTarget } from "./keys.ts";
import {
  createRestartPolicy,
  RETRY_AFTER_MS,
  type FrontmostSource,
  type ProcessRunner,
  type SourceListener,
  type Timers,
} from "./source.ts";

export const LSAPPINFO = "/usr/bin/lsappinfo";
export const MACOS_POLL_MS = 5_000;

/** The ASN `lsappinfo front` printed, or null for anything else. */
export function parseLsappinfoFront(stdout: string): string | null {
  const match = /ASN:0x[0-9a-f]+-0x[0-9a-f]+:/i.exec(stdout.trim());
  return match === null ? null : match[0];
}

/** Decode a quoted lsappinfo value: `\"`, `\\` and `\uXXXX`. */
function unquote(value: string): string {
  return value.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_all, escaped: string) =>
    escaped.length === 5 ? String.fromCharCode(Number.parseInt(escaped.slice(1), 16)) : escaped,
  );
}

/**
 * The target `lsappinfo info` describes, or null when it has no usable
 * identity. A missing bundle id (a bare executable) falls back to
 * `exe-<name>`, so the app is still recorded and can still be excluded.
 */
export function parseLsappinfoInfo(stdout: string): FrontmostTarget | null {
  const fields = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*"([^"]+)"\s*=\s*(?:"((?:[^"\\]|\\.)*)"|(-?\d+))\s*$/.exec(line);
    if (match === null) continue;
    const [, name, quoted, number] = match;
    if (name !== undefined) fields.set(name, quoted !== undefined ? unquote(quoted) : (number ?? ""));
  }
  const bundleId = fields.get("CFBundleIdentifier")?.trim() ?? "";
  const displayName = fields.get("LSDisplayName")?.trim() ?? "";
  const pidText = fields.get("pid");
  const pid = pidText !== undefined && /^\d+$/.test(pidText) ? Number(pidText) : undefined;
  if (bundleId === "" && displayName === "") return null;
  const key = bundleId !== "" ? bundleId : `exe-${displayName}`;
  return { key, name: displayName !== "" ? displayName : bundleId, ...(pid !== undefined ? { pid } : {}) };
}

export function createMacosSource(runner: ProcessRunner, timers: Timers): FrontmostSource {
  let listener: SourceListener | null = null;
  let poll: unknown = null;
  let retry: unknown = null;
  let busy = false;
  let lastAsn: string | null = null;
  let lastTarget: FrontmostTarget | null = null;
  const policy = createRestartPolicy(timers.now);

  const clear = (): void => {
    if (poll !== null) timers.clearInterval(poll);
    if (retry !== null) timers.clearTimeout(retry);
    poll = null;
    retry = null;
  };

  const fail = (): void => {
    lastAsn = null;
    if (policy.fail() === "restart") return;
    clear();
    listener?.failure({ reason: "source-failed", hint: null });
    retry = timers.setTimeout(() => {
      retry = null;
      if (listener !== null) begin();
    }, RETRY_AFTER_MS);
  };

  const read = async (): Promise<void> => {
    if (busy || listener === null) return;
    busy = true;
    try {
      const front = await runner.run(LSAPPINFO, ["front"]);
      if (listener === null) return;
      if (front.code !== 0) {
        fail();
        return;
      }
      const asn = parseLsappinfoFront(front.stdout);
      if (asn === null) {
        // Nothing in front (every window closed, a transition): not a failure.
        if (front.stdout.trim() === "") {
          lastAsn = null;
          lastTarget = null;
          listener.target(null);
          return;
        }
        fail();
        return;
      }
      if (asn !== lastAsn) {
        const info = await runner.run(LSAPPINFO, ["info", "-only", "bundleid", "-only", "name", "-only", "pid", asn]);
        if (listener === null) return;
        const target = info.code === 0 ? parseLsappinfoInfo(info.stdout) : null;
        if (target === null) {
          fail();
          return;
        }
        lastAsn = asn;
        lastTarget = target;
      }
      policy.succeed();
      listener.failure(null);
      listener.target(lastTarget);
    } finally {
      busy = false;
    }
  };

  const begin = (): void => {
    clear();
    poll = timers.setInterval(() => void read(), MACOS_POLL_MS);
    void read();
  };

  return {
    kind: "macos-lsappinfo",
    start: (next) => {
      listener = next;
      begin();
    },
    stop: () => {
      listener = null;
      clear();
      lastAsn = null;
      lastTarget = null;
    },
    // No titles on macOS in Stage 8.
    setTitles: () => undefined,
  };
}
