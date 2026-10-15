/**
 * Carrying earlier releases' hashed assets into the next Worker upload
 * (scripts/lib/static-carry.mjs), on exports built in a temp directory. No
 * network: the live site is a map of paths to bytes.
 *
 * Run by the server package's `test` script (`pnpm test:unit`).
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildIdOf, carry, MANIFEST_FILE, manifestFromDir, parseManifest, releaseFiles } from "./static-carry.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

/** An export: `files` maps URL paths to contents. */
const exportDir = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "carry-"));
  dirs.push(dir);
  writeFileSync(join(dir, "index.html"), "<html></html>");
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, ...path.slice(1).split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
};

const build = (id, chunks, extra = {}) =>
  exportDir({
    [`/_next/static/${id}/_buildManifest.js`]: `manifest ${id}`,
    ...Object.fromEntries(chunks.map((name) => [`/_next/static/chunks/${name}.js`, `chunk ${name}`])),
    ...extra,
  });

/** A live site that serves one earlier upload: its own files plus what it carried. */
const liveSite = (dir) => {
  const manifest = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"));
  const requested = [];
  const read = async (path) => {
    requested.push(path);
    return readFileSync(join(dir, ...path.slice(1).split("/")));
  };
  return { manifest, read, requested };
};

describe("releaseFiles", () => {
  it("lists only the hashed trees, with a sha256 and size each", () => {
    const dir = build("id1", ["x"], { "/docs/assets/js/main.abc.js": "docs", "/docs/index.html": "page", "/version.json": "{}" });
    assert.deepEqual(
      releaseFiles(dir).map((file) => file.path),
      ["/_next/static/chunks/x.js", "/_next/static/id1/_buildManifest.js", "/docs/assets/js/main.abc.js"],
    );
    const [first] = releaseFiles(dir);
    assert.equal(first.size, "chunk x".length);
    assert.match(first.sha256, /^[0-9a-f]{64}$/);
    assert.equal(buildIdOf(dir), "id1");
  });
});

describe("carry", () => {
  it("carries nothing on a first upload and describes this release", async () => {
    const dir = build("id1", ["x"]);
    const result = await carry({ outDir: dir, sha: A, previous: null, read: async () => assert.fail("nothing to read") });
    assert.deepEqual(result.carried, []);
    const written = parseManifest(readFileSync(join(dir, MANIFEST_FILE), "utf8"));
    assert.equal(written.releases.length, 1);
    assert.equal(written.releases[0].sha, A);
    assert.equal(written.releases[0].buildId, "id1");
  });

  it("downloads only what this build lacks, and keeps two earlier releases", async () => {
    const first = build("id1", ["shared", "old1"]);
    await carry({ outDir: first, sha: A, previous: null, read: async () => Buffer.alloc(0) });

    const second = build("id2", ["shared", "old2"]);
    const live1 = liveSite(first);
    await carry({ outDir: second, sha: B, previous: live1.manifest, read: live1.read });
    // "shared" has the same name and bytes in both builds: not downloaded.
    assert.deepEqual(live1.requested.sort(), ["/_next/static/chunks/old1.js", "/_next/static/id1/_buildManifest.js"]);

    const third = build("id3", ["shared", "new3"]);
    const live2 = liveSite(second);
    const result = await carry({ outDir: third, sha: C, previous: live2.manifest, read: live2.read });
    assert.deepEqual(result.carried.map((release) => release.sha), [B, A]);
    for (const name of ["old1", "old2", "new3", "shared"]) {
      assert.ok(existsSync(join(third, "_next", "static", "chunks", `${name}.js`)), name);
    }

    // The fourth upload drops the oldest: only two earlier releases ride along.
    const fourth = build("id4", ["new4"]);
    const live3 = liveSite(third);
    const after = await carry({ outDir: fourth, sha: D, previous: live3.manifest, read: live3.read });
    assert.deepEqual(after.carried.map((release) => release.sha), [C, B]);
    assert.ok(!existsSync(join(fourth, "_next", "static", "chunks", "old1.js")));
    assert.ok(existsSync(join(fourth, "_next", "static", "chunks", "old2.js")));
  });

  it("skips an earlier upload of the very same build", async () => {
    const first = build("same", ["x"]);
    await carry({ outDir: first, sha: A, previous: null, read: async () => Buffer.alloc(0) });
    const again = build("same", ["x"]);
    const live = liveSite(first);
    const result = await carry({ outDir: again, sha: A, previous: live.manifest, read: live.read });
    assert.deepEqual(result.carried, []);
  });

  it("refuses one path with two contents", async () => {
    const first = build("id1", ["x"]);
    await carry({ outDir: first, sha: A, previous: null, read: async () => Buffer.alloc(0) });
    const second = build("id2", [], { "/_next/static/chunks/x.js": "different bytes" });
    const live = liveSite(first);
    await assert.rejects(carry({ outDir: second, sha: B, previous: live.manifest, read: live.read }), /asset collision at \/_next\/static\/chunks\/x\.js/);
  });

  it("refuses a download that does not match its manifest", async () => {
    const first = build("id1", ["x"]);
    await carry({ outDir: first, sha: A, previous: null, read: async () => Buffer.alloc(0) });
    const second = build("id2", ["y"]);
    const live = liveSite(first);
    await assert.rejects(
      carry({ outDir: second, sha: B, previous: live.manifest, read: async () => Buffer.from("a 404 page") }),
      /came back as \d+ bytes with sha256/,
    );
  });

  it("refuses a carry above its size limit", async () => {
    const first = build("id1", ["x"]);
    await carry({ outDir: first, sha: A, previous: null, read: async () => Buffer.alloc(0) });
    const second = build("id2", ["y"]);
    const live = liveSite(first);
    await assert.rejects(carry({ outDir: second, sha: B, previous: live.manifest, read: live.read, maxBytes: 5 }), /above the 5-byte limit/);
  });

  it("seeds the first upload from an export on disk", async () => {
    const coolify = build("old", ["legacy"], { "/docs/assets/js/runtime.1.js": "docs runtime" });
    const seed = manifestFromDir(coolify, A);
    assert.equal(seed.releases[0].buildId, "old");
    const next = build("new", ["fresh"]);
    const result = await carry({
      outDir: next,
      sha: B,
      previous: seed,
      read: async (path) => readFileSync(join(coolify, ...path.slice(1).split("/"))),
    });
    assert.deepEqual(result.carried.map((release) => release.sha), [A]);
    assert.ok(existsSync(join(next, "_next", "static", "chunks", "legacy.js")));
    assert.ok(existsSync(join(next, "docs", "assets", "js", "runtime.1.js")));
  });
});

describe("parseManifest", () => {
  it("refuses paths outside the hashed trees", () => {
    const bad = { schema: 1, releases: [{ sha: A, files: [{ path: "/index.html", sha256: "0".repeat(64), size: 1 }] }] };
    assert.throws(() => parseManifest(JSON.stringify(bad)), /outside _next\/static and docs\/assets/);
    const climbing = { schema: 1, releases: [{ sha: A, files: [{ path: "/_next/static/../../x", sha256: "0".repeat(64), size: 1 }] }] };
    assert.throws(() => parseManifest(JSON.stringify(climbing)), /outside/);
  });

  it("refuses another schema", () => {
    assert.throws(() => parseManifest(JSON.stringify({ schema: 2, releases: [] })), /not schema 1/);
  });
});
