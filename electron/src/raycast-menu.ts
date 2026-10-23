import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DESKTOP_MENU_LEASE_PARTS, RAYCAST_MENU_LEASE_PARTS, RAYCAST_MENU_POLL_MS, raycastMenuVisible } from "../../packages/shared/src/timer-menu.ts";

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Missing or inaccessible state leaves the desktop available. A host PID
 * survives command unloads, unlike the short-lived extension process. */
export function hasRaycastMenu(platform: string, home = homedir()): boolean {
  if (platform !== "darwin") return false;
  try {
    const lease: unknown = JSON.parse(readFileSync(path.join(home, ...RAYCAST_MENU_LEASE_PARTS), "utf8"));
    return raycastMenuVisible(lease) && processAlive(lease.ownerPid);
  } catch {
    return false;
  }
}

export function publishDesktopMenu(visible: boolean, home = homedir()): void {
  const file = path.join(home, ...DESKTOP_MENU_LEASE_PARTS);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.${process.pid}`, JSON.stringify({ version: 1, ownerPid: process.pid, visible }), { mode: 0o600 });
  renameSync(`${file}.${process.pid}`, file);
}

export function watchRaycastMenu(platform: string, onChange: (visible: boolean) => void, home = homedir()): () => void {
  if (platform !== "darwin") return () => {};
  const acknowledge = (visible: boolean): void => {
    try { publishDesktopMenu(visible, home); }
    catch { /* Tracking still works if ownership storage is unavailable. */ }
  };
  // Register before checking the claim, so a concurrently launching Raycast
  // command waits instead of racing creation of the desktop item.
  acknowledge(true);
  let visible: boolean | undefined;
  const update = (): void => {
    const next = hasRaycastMenu(platform, home);
    if (next === visible) return;
    visible = next;
    onChange(next);
    // Acknowledge only after onChange has destroyed the actual desktop tray.
    acknowledge(!next);
  };
  update();
  const timer = setInterval(update, RAYCAST_MENU_POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
