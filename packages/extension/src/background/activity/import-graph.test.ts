/**
 * Captured activity must not be able to leave the device.
 *
 * Everything under `background/activity/` records which sites somebody looked
 * at, and the only way any of it may reach a server is as an entry the person
 * accepted — which goes through `background/entries.ts`, outside this
 * directory. So this walks the real import graph from every module here and
 * fails if it reaches the runtime, the API client, the sync socket or anything
 * else that can open a connection, or if any reachable file calls a network
 * primitive directly.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const extensionSrc = resolve(here, "../..");
const coreSrc = resolve(extensionSrc, "../../core/src");

/** Only these may be reached. Everything else is a failure. */
const ALLOWED_FILES = [
  /^extension\/background\/activity\/(?!.*\.test\.ts$)[^/]+\.ts$/,
  /^extension\/lib\/chrome-storage\.ts$/,
  /^core\/activity\/[^/]+\.ts$/,
];

const NETWORK_PRIMITIVES = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(|new\s+(WebSocket|XMLHttpRequest|EventSource)\b/;

type ImportRef = { specifier: string; typeOnly: boolean };

const importsOf = (source: string): ImportRef[] => {
  const refs: ImportRef[] = [];
  const fromPattern = /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of source.matchAll(fromPattern)) {
    refs.push({ specifier: match[3] ?? "", typeOnly: match[2] !== undefined });
  }
  for (const match of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
    refs.push({ specifier: match[1] ?? "", typeOnly: false });
  }
  return refs;
};

const resolveFile = (from: string, specifier: string): string | null => {
  if (specifier === "@starter/core/activity/index") return join(coreSrc, "activity/index.ts");
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, base.replace(/\.js$/, ".ts"), join(base, "index.ts")]) {
    if (existsSync(candidate) && candidate.match(/\.tsx?$/)) return candidate;
  }
  return null;
};

const label = (file: string): string =>
  file.startsWith(coreSrc)
    ? `core/${relative(coreSrc, file)}`
    : `extension/${relative(extensionSrc, file)}`;

const walk = (): { files: Set<string>; bare: Set<string> } => {
  const entries = readdirSync(here)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => join(here, name));
  const files = new Set<string>();
  const bare = new Set<string>();
  const pending = [...entries];

  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || files.has(file)) continue;
    files.add(file);
    for (const ref of importsOf(readFileSync(file, "utf8"))) {
      // Type-only imports are erased at build time and cannot run anything.
      if (ref.typeOnly) continue;
      const target = resolveFile(file, ref.specifier);
      if (target === null) {
        bare.add(ref.specifier);
        continue;
      }
      pending.push(target);
    }
  }
  return { files, bare };
};

test("background/activity reaches no runtime, API client or network module", () => {
  const { files, bare } = walk();
  const labels = [...files].map(label).sort();

  expect(labels).toContain("extension/background/activity/capture.ts");
  expect(labels).toContain("core/activity/suggest.ts");

  const forbidden = labels.filter((name) => !ALLOWED_FILES.some((pattern) => pattern.test(name)));
  expect(forbidden).toEqual([]);

  // A bare import is a package; the only one allowed is core's activity
  // subpath, which is resolved above. The `@starter/core` barrel would pull in
  // the API client and the sync socket.
  expect([...bare]).toEqual([]);

  for (const file of files) {
    expect({ file: label(file), network: NETWORK_PRIMITIVES.test(readFileSync(file, "utf8")) }).toEqual({
      file: label(file),
      network: false,
    });
  }
});

test("the walker would notice a forbidden import", () => {
  expect(importsOf('import { ensureReady } from "../runtime";')).toEqual([
    { specifier: "../runtime", typeOnly: false },
  ]);
  expect(importsOf('import type { Runtime } from "../runtime";')[0]?.typeOnly).toBe(true);
  expect(importsOf('const m = await import("@starter/core");')[0]?.specifier).toBe("@starter/core");
  expect(NETWORK_PRIMITIVES.test("await fetch(url)")).toBe(true);
  expect(resolveFile(join(here, "capture.ts"), "../runtime")).toBe(join(extensionSrc, "background/runtime.ts"));
});
