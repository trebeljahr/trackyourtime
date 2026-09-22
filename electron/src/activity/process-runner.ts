/*
 * The real `ProcessRunner`: `child_process` with no shell, a hidden window on
 * Windows, no stdin and stderr thrown away. Constructed only by
 * `createPlatformSource` in the non-headless branch of `install.ts`
 * (`headless.test.ts` pins that), so a test run never spawns anything.
 */

import { execFile, spawn } from "node:child_process";

import { createLineSplitter, MAX_LINE_BYTES, type ChildHandle, type ProcessRunner } from "./source.ts";

/** A one-shot helper that has not answered in this long is killed. */
const RUN_TIMEOUT_MS = 10_000;

export function createNodeProcessRunner(): ProcessRunner {
  return {
    run: (file, args, options) =>
      new Promise((resolve) => {
        execFile(
          file,
          [...args],
          {
            shell: false,
            windowsHide: true,
            timeout: RUN_TIMEOUT_MS,
            maxBuffer: MAX_LINE_BYTES,
            encoding: "utf8",
            ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
          },
          (error, stdout) => {
            const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
            resolve({ code, stdout: typeof stdout === "string" ? stdout : "" });
          },
        ).stdin?.end();
      }),

    spawn: (file, args, options): ChildHandle => {
      const child = spawn(file, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
      });
      const lineListeners: ((line: string) => void)[] = [];
      const exitListeners: ((code: number | null) => void)[] = [];
      let exited = false;
      const split = createLineSplitter((line) => {
        for (const listener of lineListeners) listener(line);
      });
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => split(chunk));
      const exit = (code: number | null): void => {
        if (exited) return;
        exited = true;
        for (const listener of exitListeners) listener(code);
      };
      child.on("exit", (code) => exit(code));
      // A missing binary is an `error` with no `exit`.
      child.on("error", () => exit(null));
      return {
        onLine: (listener) => {
          lineListeners.push(listener);
        },
        onExit: (listener) => {
          exitListeners.push(listener);
        },
        kill: () => {
          if (!exited) child.kill();
        },
      };
    },
  };
}
