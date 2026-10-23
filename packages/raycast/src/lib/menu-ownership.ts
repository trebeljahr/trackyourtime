import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DESKTOP_MENU_LEASE_PARTS, RAYCAST_MENU_LEASE_PARTS } from "../vendor/index.js";

let ownerPid: number | undefined;
function raycastPid(): number {
  if (ownerPid) return ownerPid;
  // Raycast's app owns the native item even after its extension worker exits.
  const pid = Number(
    execFileSync("/usr/bin/pgrep", ["-u", String(process.getuid!()), "-x", "Raycast"], {
      encoding: "utf8",
      timeout: 1_000,
    })
      .trim()
      .split("\n")[0],
  );
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Raycast host unavailable");
  return (ownerPid = pid);
}

/** No timer, account or server data leaves Raycast; this is local ownership. */
export function publishMenuPresence(visible: boolean, home = homedir(), pid = raycastPid()): boolean {
  const file = path.join(home, ...RAYCAST_MENU_LEASE_PARTS);
  const temporary = `${file}.${process.pid}`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(temporary, JSON.stringify({ version: 1, visible, ownerPid: pid }), { mode: 0o600 });
    renameSync(temporary, file);
    return true;
  } catch {
    return false;
  }
}

export function desktopHasYielded(home = homedir()): boolean {
  try {
    const status = JSON.parse(readFileSync(path.join(home, ...DESKTOP_MENU_LEASE_PARTS), "utf8"));
    if (!status || status.version !== 1 || !Number.isSafeInteger(status.ownerPid) || status.ownerPid <= 0) return false;
    try {
      process.kill(status.ownerPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") return true;
    }
    return status.visible === false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}
