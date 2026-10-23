import type { ProcessRunner } from "./source.ts";

/** Metadata only. Core Graphics does not request permission or capture pixels. */
export const MACOS_TITLE_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
function run(args) {
  var pid = Number(args[0]);
  var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!front || Number(front.processIdentifier) !== pid) return JSON.stringify(null);
  var windows = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(17, 0)) || [];
  for (var i = 0; i < windows.length; i++) {
    var w = windows[i];
    if (w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0 && typeof w.kCGWindowName === 'string') {
      return JSON.stringify(w.kCGWindowName.slice(0, 2000));
    }
  }
  return JSON.stringify(null);
}`;

export function createMacosTitleReader(runner: ProcessRunner, permitted: () => boolean): (pid: number) => Promise<string | null> {
  return async (pid) => {
    if (!permitted() || !Number.isSafeInteger(pid) || pid <= 0) return null;
    const result = await runner.run("/usr/bin/osascript", ["-l", "JavaScript", "-e", MACOS_TITLE_SCRIPT, String(pid)]);
    if (result.code !== 0 || !permitted()) return null;
    try { const value: unknown = JSON.parse(result.stdout); return typeof value === "string" && value.trim() ? value.slice(0, 2000) : null; }
    catch { return null; }
  };
}
