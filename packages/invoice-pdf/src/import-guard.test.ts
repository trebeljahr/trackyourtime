/**
 * The package must run in the browser as well as on the server, so nothing
 * under `src/` (the tests aside) may reach for Node: no `node:` import, no bare
 * `fs`/`path`/`crypto`/… builtin, no `Buffer` in the source. This test walks
 * every source file and fails on any of them, so a stray `import { readFileSync }
 * from "node:fs"` can never ship in the package a public page bundles.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL(".", import.meta.url));

/** Every `.ts` under src, minus the test files (which are Node by definition). */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...sources(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

const NODE_BUILTINS = [
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs",
  "http", "http2", "https", "inspector", "module", "net", "os", "path",
  "perf_hooks", "process", "punycode", "querystring", "readline", "repl",
  "stream", "string_decoder", "sys", "timers", "tls", "trace_events", "tty",
  "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
];

const importFrom = /(?:import|export)[^"']*(?:from\s*)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;

test("no source file imports a Node-only module", () => {
  for (const file of sources(SRC)) {
    const code = readFileSync(file, "utf8");
    for (const match of code.matchAll(importFrom)) {
      const specifier = match[1] ?? match[2];
      if (specifier === undefined) continue;
      assert.ok(
        !specifier.startsWith("node:"),
        `${file} imports Node builtin ${specifier}`,
      );
      assert.ok(
        !NODE_BUILTINS.includes(specifier),
        `${file} imports bare Node builtin ${specifier}`,
      );
    }
  }
});

test("no source file uses Buffer", () => {
  for (const file of sources(SRC)) {
    const code = readFileSync(file, "utf8");
    // Word-boundary Buffer, ignoring the comments that explain its absence.
    const withoutComments = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.ok(
      !/\bBuffer\b/.test(withoutComments),
      `${file} references Buffer; return a Uint8Array instead`,
    );
  }
});
