import assert from "node:assert/strict";
import { it } from "node:test";
import { createMacosTitleReader } from "./macos-titles.ts";
import type { ProcessRunner } from "./source.ts";
it("never runs a title reader without permission and discards a revoked read", async () => {
  let permitted = false, runs = 0;
  const runner = { run: async () => { runs++; permitted = false; return { code: 0, stdout: '"synthetic title"' }; } } as unknown as ProcessRunner;
  const read = createMacosTitleReader(runner, () => permitted);
  assert.equal(await read(123), null); assert.equal(runs, 0);
  permitted = true; assert.equal(await read(123), null); assert.equal(runs, 1);
});
it("accepts only a bounded JSON title from the metadata reader", async () => {
  let stdout = JSON.stringify("synthetic title");
  const read = createMacosTitleReader({ run: async () => ({ code: 0, stdout }) } as unknown as ProcessRunner, () => true);
  assert.equal(await read(42), "synthetic title");
  stdout = "invalid output"; assert.equal(await read(42), null);
  assert.equal(await read(-1), null);
});
