#!/usr/bin/env node
/*
 * The desktop app's Rust checks, for `pnpm typecheck` and `pnpm test:unit`:
 *
 *   node scripts/desktop-cargo.mjs check   # pnpm typecheck:desktop
 *   node scripts/desktop-cargo.mjs test    # pnpm test:desktop
 *
 * desktop/Cargo.toml is one workspace — the Tauri app (desktop/src-tauri) and
 * the pure crates tyt-wire, tyt-model and tyt-activity — with one lockfile and
 * one target directory (desktop/target, or CARGO_TARGET_DIR). `check`
 * type-checks all of it with its tests, then the app again with the `e2e` and
 * `mas` features, so neither feature's code can rot unseen. `test` runs every
 * crate's tests (`cargo test --workspace`) and checks the activity
 * conformance fixtures against the TypeScript core.
 *
 * The app embeds packages/client/out-desktop at compile time, and its build
 * script refuses to compile without it, so this says how to build one before
 * cargo does. CI builds a throwaway export against a dead loopback API first.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
if (mode !== "check" && mode !== "test") {
  console.error("Usage: node scripts/desktop-cargo.mjs <check|test>");
  process.exit(1);
}
const env = { ...process.env, CARGO_TARGET_DIR: resolve(repoRoot, process.env.CARGO_TARGET_DIR || "desktop/target") };
const workspace = join(repoRoot, "desktop/Cargo.toml");

function cargo(args) {
  console.log(`\n  $ cargo ${args.join(" ")}`);
  const result = spawnSync("cargo", args, { cwd: repoRoot, stdio: "inherit", env });
  if (result.error) {
    console.error(`\n  desktop-cargo — cargo could not start (${result.error.message}). Install Rust: https://rustup.rs\n`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// desktop/Cargo.lock is committed; CI never resolves dependencies anew.
const locked = process.env.CI ? ["--locked"] : [];

if (!existsSync(join(repoRoot, "packages/client/out-desktop/index.html"))) {
  console.error(
    "\n  desktop-cargo — the Tauri app embeds packages/client/out-desktop, and there is none.\n" +
      "  Build one (any API; a dead loopback port is fine for checks and tests):\n\n" +
      "    NEXT_PUBLIC_API_URL=http://127.0.0.1:59999 node scripts/build-desktop.mjs --export-only\n",
  );
  process.exit(1);
}

if (mode === "check") {
  cargo(["check", "--manifest-path", workspace, "--workspace", "--all-targets", ...locked]);
  cargo(["check", "--manifest-path", workspace, "-p", "trackyourtime-desktop", "--all-targets", "--features", "e2e,mas", ...locked]);
} else {
  cargo(["test", "--manifest-path", workspace, "--workspace", ...locked]);
  // The Rust activity core must keep giving what packages/core/src/activity
  // gives (the browser extension uses the TypeScript): regenerate the
  // conformance cases from the TypeScript and fail when they changed.
  console.log("\n  $ node desktop/crates/activity/fixtures/check.mjs");
  const fixtures = spawnSync(process.execPath, ["desktop/crates/activity/fixtures/check.mjs"], { cwd: repoRoot, stdio: "inherit" });
  if (fixtures.status !== 0) process.exit(fixtures.status ?? 1);
}
