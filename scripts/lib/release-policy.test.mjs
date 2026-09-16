/**
 * The release-number policy (docs/versioning.md → Release numbers) against
 * made-up trees, plus one read of this checkout so a refactor that moves a
 * constant fails here rather than on a release tag.
 *
 * Run by the server package's `test` script (`pnpm test:unit`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  API_LEVEL_FILE,
  EMPTY_CONTRACT,
  MIGRATIONS_DIR,
  SERVER_ORIGIN_FILE,
  bumpKind,
  checkRelease,
  previousStableTag,
  readContract,
  requiredBump,
} from "./release-policy.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A tree as a map of path → text. */
const tree = (files) => ({
  readFile: (path) => files[path] ?? null,
  listDir: (dir) =>
    Object.keys(files)
      .filter((path) => path.startsWith(`${dir}/`))
      .map((path) => path.slice(dir.length + 1)),
});

const apiLevelFile = (level, minClient, rows) => `
export const API_LEVEL = ${level};
export const API_LEVEL_CHANGES: readonly ApiLevelChange[] = [
${rows.map(([l, release]) => `  {\n    level: ${l},\n    release: "${release}",\n    added: [],\n  },`).join("\n")}
];
export const MIN_CLIENT_API_LEVEL = ${minClient};
`;

const migration = (id, minReaderSchema) => `export const m: Migration = {
  id: ${id},
  description: "m${id}",
  minReaderSchema: ${minReaderSchema},
  up: async () => {},
};`;

const release = ({ level = 1, minClient = 1, minServer = 1, rows, migrations = [[1, 0]], extra = {} }) =>
  tree({
    [API_LEVEL_FILE]: apiLevelFile(level, minClient, rows ?? Array.from({ length: level }, (_, i) => [i + 1, "1.0.0"])),
    [SERVER_ORIGIN_FILE]: `export const MIN_SERVER_API_LEVEL = ${minServer};`,
    [`${MIGRATIONS_DIR}/index.ts`]: "export {};",
    [`${MIGRATIONS_DIR}/registry.ts`]: "export const MIGRATIONS = [];",
    ...Object.fromEntries(
      migrations.map(([id, reader]) => [`${MIGRATIONS_DIR}/${String(id).padStart(3, "0")}-m.ts`, migration(id, reader)]),
    ),
    ...extra,
  });

const contract = (t) => readContract(t.readFile, t.listDir);

const recorded = (version, notes = "Upgrade notes.") => ({
  "CHANGELOG.md": `## [${version}] - 2026-10-01\n`,
  [`docs/release-notes/v${version}.md`]: notes,
});

const check = (previousVersion, previousTree, version, nextTree) =>
  checkRelease({
    version,
    previousVersion,
    previous: previousTree ? contract(previousTree) : EMPTY_CONTRACT,
    next: contract(nextTree),
    readFile: nextTree.readFile,
  });

describe("reading a tree", () => {
  it("reads 0 for everything a pre-handshake release lacks", () => {
    assert.deepEqual(contract(tree({})), { ...EMPTY_CONTRACT });
  });

  it("throws when a file exists but the constant moved", () => {
    const t = tree({ [API_LEVEL_FILE]: "export const API_LEVEL = computeLevel();" });
    assert.throws(() => contract(t), /declares no `export const API_LEVEL/);
  });

  it("reads this checkout", () => {
    const t = {
      readFile: (path) => (existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path), "utf8") : null),
      listDir: (dir) => readdirSync(join(ROOT, dir)),
    };
    const current = contract(t);
    assert.ok(current.apiLevel >= 1);
    assert.equal(current.apiLevelChanges.at(-1)?.level, current.apiLevel);
    assert.ok(current.minClientApiLevel >= 1);
    assert.ok(current.minServerApiLevel >= 1);
    assert.ok(current.schemaVersion >= 1);
    assert.deepEqual(
      current.migrations.map((m) => m.id),
      Array.from({ length: current.schemaVersion }, (_, i) => i + 1),
    );
  });
});

describe("the bump a change needs", () => {
  it("names the kind of a version step", () => {
    assert.equal(bumpKind("v1.2.3", "v1.2.4"), "patch");
    assert.equal(bumpKind("v1.2.3", "v1.3.0"), "minor");
    assert.equal(bumpKind("v1.2.3", "v2.0.0"), "major");
    assert.equal(bumpKind("v1.2.3", "v1.2.3"), "none");
    assert.equal(bumpKind("v1.2.3", "v1.2.2"), "none");
  });

  it("patch when nothing a peer sees changed", () => {
    assert.equal(requiredBump(contract(release({})), contract(release({}))).required, "patch");
  });

  it("minor for a new API level or a readable migration", () => {
    assert.equal(requiredBump(contract(release({})), contract(release({ level: 2 }))).required, "minor");
    assert.equal(
      requiredBump(contract(release({})), contract(release({ migrations: [[1, 0], [2, 1]] }))).required,
      "minor",
    );
  });

  it("major for a raised floor or a migration the previous release cannot read", () => {
    assert.equal(requiredBump(contract(release({})), contract(release({ minClient: 2, level: 2 }))).required, "major");
    assert.equal(requiredBump(contract(release({})), contract(release({ minServer: 2 }))).required, "major");
    assert.equal(
      requiredBump(contract(release({})), contract(release({ migrations: [[1, 0], [2, 2]] }))).required,
      "major",
    );
  });

  it("refuses a lowered API level or a removed migration outright", () => {
    const { errors } = requiredBump(contract(release({ level: 2 })), contract(release({ migrations: [] })));
    assert.equal(errors.length, 2);
  });
});

describe("checking a release", () => {
  it("fails an API level bump released as a patch", () => {
    const { problems } = check("v1.0.0", release({}), "v1.0.1", release({ level: 2, rows: [[1, "1.0.0"], [2, "1.0.1"]], extra: recorded("1.0.1") }));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /patch bump, but the changes need a minor bump/);
  });

  it("passes the same change released as a minor", () => {
    const { problems } = check("v1.0.0", release({}), "v1.1.0", release({ level: 2, rows: [[1, "1.0.0"], [2, "1.1.0"]], extra: recorded("1.1.0") }));
    assert.deepEqual(problems, []);
  });

  it("fails a migration-bearing patch", () => {
    const { problems } = check(
      "v1.0.0",
      release({}),
      "v1.0.1",
      release({ migrations: [[1, 0], [2, 0]], extra: recorded("1.0.1", "One migration runs at startup.") }),
    );
    assert.match(problems.join("\n"), /need a minor bump/);
  });

  it("takes a minor bump as breaking while the major is 0", () => {
    const next = release({ minServer: 2, extra: recorded("0.2.0") });
    assert.deepEqual(check("v0.1.0", release({}), "v0.2.0", next).problems, []);
    assert.match(check("v0.1.0", release({}), "v0.1.1", release({ minServer: 2, extra: recorded("0.1.1") })).problems.join(), /need a major bump \(a minor bump while the major is 0\)/);
  });

  it("requires the rollback sentence when a migration raises minReaderSchema", () => {
    const withoutSentence = release({ migrations: [[1, 0], [2, 2]], extra: recorded("2.0.0", "Migration 2 rewrites entries.") });
    assert.match(check("v1.0.0", release({}), "v2.0.0", withoutSentence).problems.join(), /Rollback requires restoring your dump/);
    const withSentence = release({
      migrations: [[1, 0], [2, 2]],
      extra: recorded("2.0.0", "Migration 2 rewrites entries. Rollback requires restoring your dump."),
    });
    assert.deepEqual(check("v1.0.0", release({}), "v2.0.0", withSentence).problems, []);
  });

  it("requires migration notes and a CHANGELOG heading for a stable release", () => {
    const next = release({ migrations: [[1, 0], [2, 0]], extra: { [`docs/release-notes/v1.1.0.md`]: "Faster reports." } });
    const problems = check("v1.0.0", release({}), "v1.1.0", next).problems.join("\n");
    assert.match(problems, /CHANGELOG\.md has no "## \[1\.1\.0\]"/);
    assert.match(problems, /does not mention the migrations/);
  });

  it("requires each new API level row to name this release", () => {
    const next = release({ level: 2, rows: [[1, "1.0.0"], [2, "1.0.0"]], extra: recorded("1.1.0") });
    assert.match(check("v1.0.0", release({}), "v1.1.0", next).problems.join(), /level 2 says release "1\.0\.0"/);
  });

  it("skips the written record for a prerelease", () => {
    const next = release({ level: 2, rows: [[1, "1.0.0"], [2, "1.1.0"]] });
    assert.deepEqual(check("v1.0.0", release({}), "v1.1.0-rc.1", next).problems, []);
  });

  it("checks the first release against nothing but its own record", () => {
    const first = release({ rows: [[1, "0.1.0"]], extra: recorded("0.1.0", "First release.") });
    assert.deepEqual(check(null, null, "v0.1.0", first).problems, []);
  });
});

describe("the previous release", () => {
  it("is the newest stable tag below the version", () => {
    const tags = ["v0.1.0", "v0.2.0-rc.1", "v0.2.0", "v0.10.0", "v0.3.0", "not-a-tag"];
    assert.equal(previousStableTag(tags, "v0.10.1"), "v0.10.0");
    assert.equal(previousStableTag(tags, "v0.3.0"), "v0.2.0");
    assert.equal(previousStableTag(tags, "v0.4.0-rc.1"), "v0.3.0");
    assert.equal(previousStableTag(tags, "v0.1.0"), null);
  });
});
