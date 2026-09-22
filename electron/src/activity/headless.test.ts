/*
 * Headless runs must never read the real frontmost app, spawn a process or
 * raise a permission prompt. The service tests cover behaviour; these pin the
 * source text, so a refactor cannot quietly move a real source, a timer or
 * the idle monitor into the headless path.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const here = import.meta.dirname;
const electronSrc = path.resolve(here, "..");

const sources = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => path.join(dir, file));

const read = (file: string): string => readFileSync(file, "utf8");

/** Source text without comments, so an explanation cannot satisfy or break a check. */
const code = (file: string): string =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** The body of the first `if (!headless) {` block in a file, and the text outside it. */
function headlessGuard(text: string, opener: string): { inside: string; outside: string } {
  const start = text.indexOf(opener);
  assert.notEqual(start, -1, `no "${opener}" block`);
  let depth = 0;
  let end = start;
  for (let i = text.indexOf("{", start); i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    if (text[i] === "}") depth -= 1;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
  return { inside: text.slice(start, end), outside: text.slice(0, start) + text.slice(end) };
}

describe("headless activity capture", () => {
  it("constructs a platform source only outside headless", () => {
    const calls = sources(electronSrc).flatMap((file) =>
      [...code(file).matchAll(/(?<!function )createPlatformSource\(/g)].map(() => path.relative(electronSrc, file)),
    );
    assert.deepEqual(calls, ["activity/install.ts"]);
    const { inside, outside } = headlessGuard(code(path.join(here, "install.ts")), "if (!headless && ");
    assert.match(inside, /createPlatformSource\(/);
    assert.doesNotMatch(outside, /createPlatformSource\(/);
  });

  it("starts no timer and reads no idle monitor headless", () => {
    const { inside, outside } = headlessGuard(code(path.join(here, "install.ts")), "if (!headless) {");
    assert.match(inside, /setInterval\(/);
    assert.match(inside, /options\.subscribeIdle\(/);
    assert.doesNotMatch(outside, /setInterval\(|subscribeIdle\(|powerMonitor/);
  });

  it("imports child_process only in the process runner", () => {
    // Any mention in code, so a require() or a dynamic import() counts too.
    const importers = sources(electronSrc)
      .filter((file) => /["'](node:)?child_process["']/.test(code(file)))
      .map((file) => path.relative(electronSrc, file));
    assert.deepEqual(importers, ["activity/process-runner.ts"]);
  });

  it("never asks for a permission that could prompt", () => {
    for (const file of sources(here)) {
      assert.doesNotMatch(
        code(file),
        /systemPreferences|desktopCapturer|CGRequestScreenCaptureAccess|askForMediaAccess|powerMonitor/,
        path.basename(file),
      );
    }
  });
});
