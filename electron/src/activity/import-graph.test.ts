/*
 * Captured activity must not be able to leave the device.
 *
 * Everything under `activity/` records which applications somebody used, and
 * the only way any of it may reach a server is as an entry the person
 * accepted — which the renderer creates. So this walks the real import graph
 * from every module here and fails if it reaches anything that can open a
 * connection (node:net, http, electron's `net`, the updater, core's barrel
 * with its API client) or any reachable file calls a network primitive.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const here = import.meta.dirname;
const repo = path.resolve(here, "../../..");

/** Files that may be reached, relative to the repo root. */
const ALLOWED_FILES = [
  /^electron\/src\/activity\/(?!.*\.test\.ts$)[^/]+\.ts$/,
  /^electron\/src\/(distribution|ipc|trust)\.ts$/,
  /^packages\/core\/src\/activity\/[^/]+\.ts$/,
  /^packages\/shared\/src\/desktop-(bridge|shortcuts)\.ts$/,
];

/** Bare modules that may be imported, and by which files only. */
const ALLOWED_BARE: Record<string, RegExp> = {
  "node:fs": /./,
  "node:path": /./,
  "node:crypto": /./,
  "node:child_process": /^electron\/src\/activity\/process-runner\.ts$/,
  electron: /^electron\/src\/(activity\/install|ipc)\.ts$/,
};

const NETWORK_PRIMITIVES =
  /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(|new\s+(WebSocket|XMLHttpRequest|EventSource)\b|\bnet\.request\b/;

type ImportRef = { specifier: string; names: string };

const importsOf = (source: string): ImportRef[] => {
  const refs: ImportRef[] = [];
  const pattern = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    if (match[2] !== undefined) continue; // type-only: erased by the bundler
    refs.push({ specifier: match[4] ?? "", names: match[3] ?? "" });
  }
  for (const match of source.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) {
    refs.push({ specifier: match[1] ?? "", names: "" });
  }
  for (const match of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
    refs.push({ specifier: match[1] ?? "", names: "" });
  }
  return refs;
};

const resolveFile = (from: string, specifier: string): string | null => {
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [base, base.replace(/\.js$/, ".ts"), `${base}.ts`]) {
    if (existsSync(candidate) && candidate.endsWith(".ts")) return candidate;
  }
  return null;
};

describe("activity import graph", () => {
  it("reaches no network code", () => {
    const start = readdirSync(here)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => path.join(here, file));
    const seen = new Set<string>();
    const queue = [...start];
    const problems: string[] = [];

    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      const label = path.relative(repo, file);
      if (!ALLOWED_FILES.some((pattern) => pattern.test(label))) problems.push(`reaches ${label}`);
      const source = readFileSync(file, "utf8");
      if (NETWORK_PRIMITIVES.test(source.replace(/\/\*[\s\S]*?\*\//g, ""))) problems.push(`${label} calls the network`);

      for (const ref of importsOf(source)) {
        if (ref.specifier.startsWith(".")) {
          const target = resolveFile(file, ref.specifier);
          if (target === null) problems.push(`${label}: unresolved ${ref.specifier}`);
          else queue.push(target);
          continue;
        }
        const allowed = ALLOWED_BARE[ref.specifier];
        if (allowed === undefined || !allowed.test(label)) problems.push(`${label} imports ${ref.specifier}`);
        if (ref.specifier === "electron" && /\bnet\b/.test(ref.names)) problems.push(`${label} imports electron's net`);
      }
    }

    assert.deepEqual(problems, []);
    assert.ok([...seen].some((file) => file.endsWith("packages/core/src/activity/suggest.ts")));
  });
});
