import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** Kernel ownership survives slow requests and ends when the command process
 * exits. Keep the inode: unlinking a lock file lets a second process bypass it. */
export async function withQueueFileLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const holder = spawn(
    "/usr/bin/lockf",
    ["-k", "-t", "30", path, "/bin/sh", "-c", "printf 'locked\\n'; cat >/dev/null"],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  // A closed pipe means the kernel lock was lost. Never acknowledge the write.
  holder.stdin.on("error", () => undefined);
  let acquired = false;
  let released = false;
  let lost = false;
  const exited = new Promise<void>((resolve) => {
    holder.once("error", () => {
      lost = true;
      resolve();
    });
    holder.once("exit", () => {
      lost = !released;
      resolve();
    });
  });
  await new Promise<void>((resolve, reject) => {
    let received = "";
    holder.stdout.on("data", (chunk: Buffer) => {
      received += chunk.toString();
      if (!acquired && received.includes("locked\n")) {
        acquired = true;
        resolve();
      }
    });
    void exited.then(() => {
      if (!acquired) reject(new Error("Pending writes are busy. Try again when the other command finishes."));
    });
  });
  try {
    const result = await task();
    if (lost) throw new Error("Pending write storage ownership was interrupted. Check pending writes before retrying.");
    return result;
  } finally {
    released = true;
    holder.stdin.end();
    await exited;
  }
}
