#!/usr/bin/env node
/*
 * Fails when the committed conformance fixtures no longer match what the
 * TypeScript core produces, so a change to packages/core/src/activity that
 * the Rust port does not follow is caught (run from the repo root):
 *
 *   node desktop/crates/activity/fixtures/check.mjs          # check
 *   node desktop/crates/activity/fixtures/check.mjs --write  # regenerate in place
 *
 * After `--write`, run `cargo test` in desktop/crates/activity: the replay in
 * tests/conformance.rs says whether the Rust still agrees.
 *
 * The helper scripts the Rust embeds (src/windows-foreground.ps1,
 * src/macos-title.js) were copied from the Electron build's TypeScript and are
 * their own source of truth since that build was removed (2026-11-12).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const here = import.meta.dirname;
const generator = path.join(here, "generate.mts");
const write = process.argv.includes("--write");

const repo = path.resolve(here, "../../../..");

const run = (outDir) =>
  execFileSync(process.execPath, ["--import", "tsx", generator, ...(outDir ? [outDir] : [])], { stdio: "inherit", cwd: repo });

if (write) {
  run(null);
  console.log("fixtures regenerated");
  process.exit(0);
}

const scratch = mkdtempSync(path.join(tmpdir(), "tyt-activity-fixtures-"));
try {
  run(scratch);
  const fresh = readdirSync(scratch).filter((file) => file.endsWith(".json")).sort();
  const committed = readdirSync(here).filter((file) => file.startsWith("core-") && file.endsWith(".json")).sort();
  const problems = [];
  if (JSON.stringify(fresh) !== JSON.stringify(committed)) {
    problems.push(`fixture files differ: committed ${committed.join(", ")}; generated ${fresh.join(", ")}`);
  }
  for (const file of fresh) {
    let before = "";
    try {
      before = readFileSync(path.join(here, file), "utf8");
    } catch {
      continue;
    }
    if (before !== readFileSync(path.join(scratch, file), "utf8")) problems.push(`${file} is stale`);
  }
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    console.error("The TypeScript core changed. Run with --write, then `cargo test` in desktop/crates/activity.");
    process.exit(1);
  }
  console.log(`fixtures up to date (${fresh.length} files)`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
