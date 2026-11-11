#!/usr/bin/env node
/*
 * `pnpm dev:desktop`: the Next dev server on 7130 and the debug desktop app
 * pointed at it, for UI iteration with hot reload.
 *
 * The app loads TRACKYOURTIME_DEV_URL instead of its embedded export — and
 * only a debug build honours it (desktop/src-tauri/src/lib.rs), so nothing
 * that can set an environment variable can make an installed app load a page
 * of its choosing with the desktop bridge. The debug profile is its own
 * (`trackyourtime-dev`), never the installed app's.
 *
 * It opens a real window: a person's command, never an agent's or a test's.
 * Ctrl-C stops both; either one exiting stops the other. Only the processes
 * started here are ever signalled.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { terminateGroup } from "./lib/process-group.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 7130;
const DEV_URL = `http://localhost:${PORT}`;

if (!existsSync(join(repoRoot, "packages/client/out-desktop/index.html"))) {
  // The debug binary still embeds an export at compile time (build.rs).
  console.error(
    "\n  dev:desktop — the app embeds packages/client/out-desktop at compile time, and there is none.\n" +
      "  Build one once (it is not what dev:desktop shows):\n\n" +
      "    NEXT_PUBLIC_API_URL=http://localhost:5159 node scripts/build-desktop.mjs --export-only\n",
  );
  process.exit(1);
}

const posix = process.platform !== "win32";
const children = [];
function start(name, command, args, env) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...env },
    // Leader of its own group, so stopping it reaches pnpm's and cargo's children.
    detached: posix,
    shell: !posix,
  });
  child.name = name;
  children.push(child);
  child.on("exit", (code) => {
    console.log(`\n  dev:desktop — ${name} exited (${code ?? "signal"}); stopping the rest.`);
    void stopAll(code ?? 1);
  });
  return child;
}

let stopping = false;
async function stopAll(code) {
  if (stopping) return;
  stopping = true;
  await Promise.all(
    children
      .filter((child) => child.exitCode === null && child.pid !== undefined)
      .map((child) => (posix ? terminateGroup(child.pid) : Promise.resolve(child.kill()))),
  );
  process.exit(code);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => void stopAll(0));

start("next", "pnpm", ["--filter", "@starter/client", "dev"], { PORT: String(PORT) });

const deadline = Date.now() + 180_000;
for (;;) {
  try {
    if ((await fetch(DEV_URL)).status < 500) break;
  } catch {
    // not listening yet
  }
  if (Date.now() > deadline) {
    console.error(`\n  dev:desktop — ${DEV_URL} did not answer within three minutes.\n`);
    await stopAll(1);
  }
  await new Promise((r) => setTimeout(r, 500));
}

start(
  "desktop",
  "cargo",
  ["run", "--manifest-path", join(repoRoot, "desktop/src-tauri/Cargo.toml")],
  { TRACKYOURTIME_DEV_URL: DEV_URL, CARGO_TARGET_DIR: resolve(repoRoot, process.env.CARGO_TARGET_DIR || "desktop/target") },
);
