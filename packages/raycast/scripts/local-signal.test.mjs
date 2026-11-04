import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import ts from "typescript";

// Real files and a real watcher in a temp directory. Raycast is replaced only
// for the one path it supplies.
const support = mkdtempSync(path.join(tmpdir(), "local-signal-test-"));
after(() => rmSync(support, { recursive: true, force: true }));
globalThis.__supportPath = support;

const hook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@raycast/api") return { url: "raycast:api", shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "raycast:api") {
      return {
        format: "module",
        shortCircuit: true,
        source: "export const environment={get supportPath(){return globalThis.__supportPath;}};",
      };
    }
    if (url.endsWith(".ts")) {
      return {
        format: "module",
        shortCircuit: true,
        source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        }).outputText,
      };
    }
    return next(url, context);
  },
});
after(() => hook.deregister());

const { signalLocalChange, watchLocalChange } = await import("../src/lib/local-signal.ts");

test("a signal wakes a watcher, which stops hearing once closed", async () => {
  let heard = 0;
  let wake = () => {};
  const stop = watchLocalChange(() => {
    heard += 1;
    wake();
  });
  const woken = new Promise((resolve) => (wake = resolve));
  // macOS can miss a write made while a new watcher is still starting, so keep
  // signalling. A loaded menu bar has had its watcher running for much longer.
  const resend = setInterval(signalLocalChange, 100);
  signalLocalChange();
  try {
    await Promise.race([
      woken,
      new Promise((_, reject) => setTimeout(() => reject(new Error("the watcher never woke")), 10_000)),
    ]);
  } finally {
    clearInterval(resend);
  }
  assert.ok(heard > 0);

  stop();
  // Let events already queued for the first write drain before counting.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const before = heard;
  signalLocalChange();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(heard, before);
});

test("without a usable support path, neither end throws", () => {
  globalThis.__supportPath = undefined;
  try {
    assert.doesNotThrow(() => signalLocalChange());
    const stop = watchLocalChange(() => {});
    assert.doesNotThrow(() => stop());
  } finally {
    globalThis.__supportPath = support;
  }
});
