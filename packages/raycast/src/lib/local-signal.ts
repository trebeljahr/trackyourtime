/**
 * Tells other Raycast commands that this Mac's stored state changed.
 *
 * Commands are separate processes, and LocalStorage has no change event. A
 * touched file gives a loaded menu bar the news without a timer that re-reads
 * storage every second. It carries no data: readers go back to LocalStorage.
 */
import { mkdirSync, watch, writeFileSync } from "node:fs";
import path from "node:path";
import { environment } from "@raycast/api";

const directory = (): string => path.join(environment.supportPath, "local-changes");

/** Call after the storage write, so a woken reader sees the new value. */
export function signalLocalChange(): void {
  try {
    mkdirSync(directory(), { recursive: true });
    writeFileSync(path.join(directory(), "changed"), String(Date.now()));
  } catch {
    // The reader catches up on its next load.
  }
}

/** `persistent: false`: a watcher never keeps the process alive on its own. */
export function watchLocalChange(listener: () => void): () => void {
  try {
    mkdirSync(directory(), { recursive: true });
    const watcher = watch(directory(), { persistent: false }, () => listener());
    watcher.on("error", () => undefined);
    return () => watcher.close();
  } catch {
    return () => undefined;
  }
}
