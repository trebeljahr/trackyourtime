import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickHmrPort } from "./hmr-port.mjs";

const tempFile = () => join(mkdtempSync(join(tmpdir(), "hmr-port-")), "nested", "port");

test("a free remembered port is reused, so the loaded extension keeps working", async () => {
  const file = tempFile();
  const first = await pickHmrPort(file, { isFree: async () => true, random: () => 50645 });
  assert.equal(first, 50645);
  const second = await pickHmrPort(file, { isFree: async () => true, random: () => 60000 });
  assert.equal(second, 50645);
});

test("a busy remembered port is replaced and the new one remembered", async () => {
  const file = tempFile();
  await pickHmrPort(file, { isFree: async () => true, random: () => 50645 });
  const port = await pickHmrPort(file, { isFree: async (p) => p !== 50645, random: () => 51367 });
  assert.equal(port, 51367);
  assert.equal(readFileSync(file, "utf8").trim(), "51367");
});

test("a malformed or out-of-range stored value is ignored", async () => {
  for (const value of ["nope", "80", "70000"]) {
    const file = tempFile();
    await pickHmrPort(file, { isFree: async () => true, random: () => 50000 });
    writeFileSync(file, value);
    assert.equal(await pickHmrPort(file, { isFree: async () => true, random: () => 55555 }), 55555);
  }
});

test("gives up after three busy random ports", async () => {
  await assert.rejects(pickHmrPort(tempFile(), { isFree: async () => false, random: () => 50000 }));
});
