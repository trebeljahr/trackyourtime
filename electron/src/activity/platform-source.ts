/*
 * The real frontmost-app source for this OS. Called only from the
 * non-headless branch of `install.ts`; `headless.test.ts` pins that, and that
 * this is the only way a `ProcessRunner` backed by `child_process` is made.
 */

import type { ActivityCaptureMechanism } from "../distribution.ts";
import { createNodeProcessRunner } from "./process-runner.ts";
import { createLinuxSource } from "./source-linux.ts";
import { createMacosSource } from "./source-macos.ts";
import { createWindowsSource } from "./source-windows.ts";
import { realTimers, type FrontmostSource, type ProcessRunner } from "./source.ts";

/** Wraps a runner so every attempted child is named in `spawns` (the test hook reads it). */
export function recordingRunner(inner: ProcessRunner, spawns: string[]): ProcessRunner {
  return {
    run: (file, args, options) => {
      spawns.push(file);
      return inner.run(file, args, options);
    },
    spawn: (file, args, options) => {
      spawns.push(file);
      return inner.spawn(file, args, options);
    },
  };
}

export function createPlatformSource(
  mechanism: ActivityCaptureMechanism,
  options: { env: Record<string, string | undefined>; parentPid: number; spawns: string[] },
): FrontmostSource {
  const runner = recordingRunner(createNodeProcessRunner(), options.spawns);
  switch (mechanism) {
    case "macos-lsappinfo":
      return createMacosSource(runner, realTimers);
    case "windows-powershell":
      return createWindowsSource(runner, realTimers, { env: options.env, parentPid: options.parentPid });
    case "linux-xprop":
      return createLinuxSource(runner, realTimers, { env: options.env });
  }
}
