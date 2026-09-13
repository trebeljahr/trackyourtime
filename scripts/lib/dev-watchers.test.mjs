/**
 * Stray dev watchers and watcher failures, as `scripts/dev.mjs` reports them.
 *
 * The failure behind this is silent: once leftover `tsx watch` processes have
 * used up the file watches, `next dev` cannot open its own, never scans `app/`,
 * and answers 404 on every route with nothing in the page to say why.
 *
 * Run by the server package's `test` script (`pnpm test:unit`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  checkoutOf,
  describeStrayWatchers,
  describeWatcherFailure,
  findRepoWatchers,
  isOrphaned,
  parsePs,
  watcherFailureIn,
} from "./dev-watchers.mjs";

const ROOT = "/Users/rico/projects/tracktime";
const WT = `${ROOT}/.claude/worktrees/raycast-extension-commands-85460e`;

// An orphaned server watcher (its pnpm was reparented to launchd), a live one
// under a shell in the main checkout, and an unrelated project's watcher.
const PS = `
    1     0 20-00:00:00 /sbin/launchd
  500     1 20-00:00:00 /Applications/Utilities/Terminal.app/Contents/MacOS/Terminal
  501   500 01:00:00 -zsh
10178     1 05-14:18:52 node /Users/rico/.nvm/versions/node/v24.14.1/bin/pnpm run dev
10221 10178 05-14:18:52 node ${WT}/packages/server/node_modules/.bin/../tsx/dist/cli.mjs watch --clear-screen=false src/index.ts
49031   501    00:23 node scripts/dev.mjs
49460 49031    00:18 node ${ROOT}/node_modules/.bin/../concurrently/dist/bin/concurrently.js --kill-others-on-fail
49529 49460    00:17 node /Users/rico/.nvm/versions/node/v24.14.1/bin/pnpm --filter @starter/server run dev
49697 49529    00:16 node ${ROOT}/packages/server/node_modules/.bin/../tsx/dist/cli.mjs watch --clear-screen=false src/index.ts
50027 49460    00:08 node ${ROOT}/packages/client/node_modules/.bin/../next/dist/bin/next dev
60000     1 03:00:00 node /Users/rico/projects/other/node_modules/.bin/../tsx/dist/cli.mjs watch src/index.ts
`;

describe("parsePs", () => {
  it("reads pid, ppid, elapsed time and the full command line", () => {
    const rows = parsePs(PS);
    const tsx = rows.find((row) => row.pid === 10221);
    assert.equal(tsx.ppid, 10178);
    assert.equal(tsx.etime, "05-14:18:52");
    assert.match(tsx.command, /cli\.mjs watch --clear-screen=false src\/index\.ts$/);
  });

  it("skips blank and malformed lines", () => {
    assert.deepEqual(parsePs("\n  \nnot a row\n"), []);
  });
});

describe("isOrphaned", () => {
  const rows = parsePs(PS);
  const byPid = new Map(rows.map((row) => [row.pid, row]));

  it("is true when only dev tooling stands between the watcher and launchd", () => {
    assert.equal(isOrphaned(byPid.get(10221), byPid), true);
  });

  it("is false when a shell is still above the watcher", () => {
    assert.equal(isOrphaned(byPid.get(49697), byPid), false);
    assert.equal(isOrphaned(byPid.get(50027), byPid), false);
  });

  it("is false when the parent is not in the listing", () => {
    assert.equal(isOrphaned({ pid: 7, ppid: 6, etime: "1", command: "node x" }, byPid), false);
  });
});

describe("checkoutOf", () => {
  it("names the worktree a command runs from", () => {
    assert.equal(
      checkoutOf(`node ${WT}/packages/server/node_modules/.bin/tsx`, ROOT),
      ".claude/worktrees/raycast-extension-commands-85460e",
    );
  });

  it("names the main checkout, and nothing for another project", () => {
    assert.equal(checkoutOf(`node ${ROOT}/packages/client/x`, ROOT), "(main checkout)");
    assert.equal(checkoutOf("node /Users/rico/projects/other/x", ROOT), null);
    // A sibling directory that merely shares the prefix is not this repo.
    assert.equal(checkoutOf(`node ${ROOT}-old/packages/x`, ROOT), null);
  });
});

describe("findRepoWatchers", () => {
  it("finds this repo's watchers only, and marks the orphaned ones", () => {
    const found = findRepoWatchers(parsePs(PS), ROOT);
    assert.deepEqual(
      found.map((row) => [row.pid, row.orphaned]),
      [
        [10221, true],
        [49697, false],
        [50027, false],
      ],
    );
  });
});

describe("describeStrayWatchers", () => {
  it("is null when every watcher belongs to a live run", () => {
    const live = findRepoWatchers(parsePs(PS), ROOT).filter((row) => !row.orphaned);
    assert.equal(describeStrayWatchers(live, ROOT), null);
  });

  it("lists the orphans and a scoped way to inspect them, never a blanket kill", () => {
    const text = describeStrayWatchers(findRepoWatchers(parsePs(PS), ROOT), ROOT);
    assert.match(text, /1 dev watcher process of this repo outlived/);
    assert.match(text, /10221 .*tsx watch .*raycast-extension-commands-85460e/);
    assert.match(text, /2 other watchers are attached to a live run/);
    assert.match(text, /kill 10221$/m);
    assert.doesNotMatch(text, /pkill|killall/);
    assert.ok(text.includes(`grep -F '${ROOT}/'`));
  });
});

describe("watcherFailureIn", () => {
  it("recognises Watchpack's EMFILE, through concurrently's prefix and colors", () => {
    assert.equal(
      watcherFailureIn(
        "\x1b[33m[client]\x1b[39m Watchpack Error (watcher): Error: EMFILE: too many open files, watch",
      ),
      "EMFILE",
    );
  });

  it("recognises the Linux inotify limit in both of its spellings", () => {
    assert.equal(watcherFailureIn("Error: ENOSPC: System limit for number of file watchers reached, watch '/x'"), "ENOSPC");
    assert.equal(watcherFailureIn("System limit for number of file watchers reached"), "ENOSPC");
  });

  it("ignores an EMFILE that has nothing to do with watching", () => {
    assert.equal(watcherFailureIn("Error: EMFILE: too many open files, open '/x'"), null);
    assert.equal(watcherFailureIn("[server] listening on 5159"), null);
  });
});

describe("describeWatcherFailure", () => {
  it("says what it means, how to look, and the polling escape hatch", () => {
    const text = describeWatcherFailure({
      code: "EMFILE",
      source: "client",
      watchers: [],
      repoRoot: ROOT,
    });
    assert.match(text, /\[client\] cannot watch files \(EMFILE\)/);
    assert.match(text, /EVERY route will/);
    assert.match(text, /WATCHPACK_POLLING=true pnpm run dev/);
    assert.ok(text.includes(`grep -F '${ROOT}/'`));
    assert.doesNotMatch(text, /kill/);
  });

  it("names the orphans it found, with their pids", () => {
    const text = describeWatcherFailure({
      code: "EMFILE",
      source: "client",
      watchers: findRepoWatchers(parsePs(PS), ROOT),
      repoRoot: ROOT,
    });
    assert.match(text, /Outlived the run that started them/);
    assert.match(text, /│\s+10221 .*tsx watch/);
    assert.match(text, /kill 10221$/m);
  });
});
