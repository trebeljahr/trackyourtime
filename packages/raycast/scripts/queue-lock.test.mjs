import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";

const moduleUrl = new URL("../src/lib/queue-lock.ts", import.meta.url).href;
const worker = (root, id, hold = false) =>
  spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
  import { withQueueFileLock } from ${JSON.stringify(moduleUrl)};
  import { readFile, writeFile } from 'node:fs/promises';
  await withQueueFileLock(${JSON.stringify(join(root, "queue.lock"))}, async () => {
    process.stdout.write('owned\\n');
    if (${hold}) await new Promise(() => {});
    const rows = JSON.parse(await readFile(${JSON.stringify(join(root, "rows.json"))}, 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 50));
    rows.push(${JSON.stringify(id)});
    await writeFile(${JSON.stringify(join(root, "rows.json"))}, JSON.stringify(rows));
  });
`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
const finished = (child) =>
  new Promise((resolve, reject) => {
    let err = "";
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker ${code}: ${err}`))));
  });

test(
  "separate command processes serialize shared read-modify-write without lost rows",
  { skip: process.platform !== "darwin", timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "raycast-queue-proof-"));
    const children = [];
    try {
      await writeFile(join(root, "rows.json"), "[]");
      for (let id = 0; id < 8; id++) children.push(worker(root, id));
      await Promise.all(children.map(finished));
      assert.deepEqual(JSON.parse(await readFile(join(root, "rows.json"), "utf8")).sort(), [0, 1, 2, 3, 4, 5, 6, 7]);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a live owner cannot be stolen; process death releases ownership without a stale lease",
  { skip: process.platform !== "darwin", timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "raycast-queue-death-"));
    let first, second;
    try {
      await writeFile(join(root, "rows.json"), "[]");
      first = worker(root, "crashed", true);
      await once(first.stdout, "data");
      second = worker(root, "recovered");
      const done = finished(second);
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.deepEqual(JSON.parse(await readFile(join(root, "rows.json"), "utf8")), []);
      first.kill("SIGKILL");
      await done;
      assert.deepEqual(JSON.parse(await readFile(join(root, "rows.json"), "utf8")), ["recovered"]);
    } finally {
      if (first?.exitCode === null) first.kill("SIGKILL");
      if (second?.exitCode === null) second.kill("SIGTERM");
      await rm(root, { recursive: true, force: true });
    }
  },
);
