/**
 * The process-group teardown behind `scripts/dev.mjs`, against real processes.
 *
 * What it guards: a dev tree whose parent died must still be stopped. Each
 * test builds a small group — a shell whose child ignores SIGTERM, standing in
 * for a `tsx watch` that outlives its pnpm — and checks the group is empty
 * afterwards. POSIX only; Windows has no process groups to signal.
 *
 * Run by the server package's `test` script (`pnpm test:unit`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { groupAlive, terminateGroup, waitForGroupExit } from "./process-group.mjs";

const posix = process.platform !== "win32";
const REAPER = fileURLToPath(new URL("./dev-reaper.mjs", import.meta.url));

/** A detached group: sh, a child that ignores SIGTERM, and a plain sleeper. */
const startGroup = () => {
  const leader = spawn(
    "sh",
    ["-c", `trap '' TERM; sleep 60 & (trap '' TERM; sleep 60) & wait`],
    { detached: true, stdio: "ignore" },
  );
  leader.unref();
  return leader.pid;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("terminateGroup", { skip: !posix }, () => {
  it("escalates to SIGKILL for members that ignore SIGTERM", async () => {
    const pgid = startGroup();
    await sleep(200);
    assert.equal(groupAlive(pgid), true);
    await terminateGroup(pgid, { graceMs: 300 });
    assert.equal(groupAlive(pgid), false);
  });

  it("is a no-op for a group that is already gone", async () => {
    await terminateGroup(999_999_9);
  });
});

describe("dev-reaper", { skip: !posix }, () => {
  it("stops the group when the process holding its stdin dies", async () => {
    const pgid = startGroup();
    // Stand-in for dev.mjs: the reaper's stdin is its pipe, and SIGKILL — which
    // no handler can see — is how it goes.
    const owner = spawn(
      process.execPath,
      [
        "-e",
        `const r = require("child_process").spawn(process.execPath, [${JSON.stringify(REAPER)}, "${pgid}"], { detached: true, stdio: ["pipe", "ignore", "ignore"] }); r.unref(); setInterval(() => {}, 1000);`,
      ],
      { stdio: "ignore" },
    );
    await sleep(500);
    assert.equal(groupAlive(pgid), true, "the group must survive while its owner lives");
    owner.kill("SIGKILL");
    // The reaper's grace is 8s for SIGTERM, but `sleep` honours SIGTERM, so
    // only the trap-protected member waits for SIGKILL.
    assert.equal(await waitForGroupExit(pgid, 15_000), true);
  });
});
