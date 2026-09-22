/**
 * The rewrites `pnpm release` makes (scripts/lib/release.mjs), against
 * made-up files, plus one plan over this checkout so a moved version copy
 * fails here rather than in the middle of a release.
 *
 * Run by the server package's `test` script (`pnpm test:unit`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ANDROID_GRADLE,
  CHANGELOG,
  IOS_PROJECT,
  VERSION_CONSTANTS,
  compareVersions,
  localDate,
  parseStableVersion,
  planRelease,
  releaseNotesPath,
  rollChangelog,
  scaffoldReleaseNotes,
  setAndroidVersions,
  setIosVersions,
  setPackageVersion,
  setVersionConstant,
  versionRefusal,
} from "./release.mjs";
import { checkRelease, EMPTY_CONTRACT } from "./release-policy.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const CHANGELOG_TEXT = `# Changelog

Intro.

## [Unreleased]

The next release.

### Added

- A thing.

## [0.1.0] - 2026-01-02

- First.

[Unreleased]: https://github.com/owner/repo/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/owner/repo/releases/tag/v0.1.0
`;

describe("versions", () => {
  it("parses stable versions with or without the v", () => {
    assert.equal(parseStableVersion("0.2.0")?.version, "0.2.0");
    assert.equal(parseStableVersion("v1.10.3")?.version, "1.10.3");
    assert.equal(parseStableVersion("1.2"), null);
    assert.equal(parseStableVersion("1.2.3-rc.1"), null);
    assert.equal(parseStableVersion("01.2.x"), null);
  });

  it("orders by semver precedence", () => {
    assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
    assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
    assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
    assert.equal(compareVersions("1.0.0-rc.10", "1.0.0-rc.2"), 1);
    assert.equal(compareVersions("1.0.0-alpha", "1.0.0-1"), 1);
    assert.ok(Number.isNaN(compareVersions("x", "1.0.0")));
  });

  it("refuses an older, equal-and-tagged, prerelease or existing-tag version", () => {
    assert.match(versionRefusal({ current: "0.2.0", next: "0.1.9", tags: [] }) ?? "", /lower/);
    assert.match(versionRefusal({ current: "0.2.0", next: "0.2.0", tags: ["v0.2.0"] }) ?? "", /already exists/);
    assert.match(versionRefusal({ current: "0.2.0", next: "0.3.0", tags: ["v0.3.0"] }) ?? "", /already exists/);
    assert.match(versionRefusal({ current: "0.2.0", next: "0.3.0-rc.1", tags: [] }) ?? "", /Prereleases/);
  });

  it("allows a newer version, and the untagged current one (the first release)", () => {
    assert.equal(versionRefusal({ current: "0.1.0", next: "0.1.1", tags: ["v0.1.0"] }), null);
    assert.equal(versionRefusal({ current: "0.1.0", next: "0.1.0", tags: [] }), null);
    assert.equal(versionRefusal({ current: "0.2.0-rc.1", next: "0.2.0", tags: ["v0.2.0-rc.1"] }), null);
  });
});

describe("version copies", () => {
  it("sets the top-level package.json version and keeps the formatting", () => {
    const text = '{\n    "name": "x",\n    "version": "0.1.0",\n    "dependencies": { "y": "1.0.0" }\n}\n';
    assert.equal(setPackageVersion(text, "0.2.0"), text.replace('"0.1.0"', '"0.2.0"'));
    assert.throws(() => setPackageVersion('{ "name": "x" }', "0.2.0"), /no "version"/);
  });

  it("refuses a package.json whose first version key is nested", () => {
    const text = '{\n  "engines": {\n    "version": "1"\n  },\n  "version": "0.1.0"\n}\n';
    assert.throws(() => setPackageVersion(text, "0.2.0"), /not the top-level one/);
  });

  it("sets a version constant", () => {
    const text = '// note\nexport const APP_VERSION = "0.1.0";\n';
    assert.equal(setVersionConstant(text, "APP_VERSION", "0.2.0"), '// note\nexport const APP_VERSION = "0.2.0";\n');
    assert.throws(() => setVersionConstant("const X = 1;", "APP_VERSION", "0.2.0"), /declares no/);
  });

  it("sets every iOS marketing version and raises the build number past the highest", () => {
    const text =
      "CURRENT_PROJECT_VERSION = 3;\nMARKETING_VERSION = 0.1.0;\nCURRENT_PROJECT_VERSION = 5;\nMARKETING_VERSION = 0.1.0;\n";
    const bumped = setIosVersions(text, "0.2.0", true);
    assert.equal(bumped.build, 6);
    assert.equal(
      bumped.text,
      "CURRENT_PROJECT_VERSION = 6;\nMARKETING_VERSION = 0.2.0;\nCURRENT_PROJECT_VERSION = 6;\nMARKETING_VERSION = 0.2.0;\n",
    );
    assert.equal(setIosVersions(text, "0.1.0", false).build, 5);
  });

  it("sets the Android versionName and raises versionCode by one", () => {
    const text = '    defaultConfig {\n        versionCode 7\n        // note\n        versionName "0.1.0"\n    }\n';
    const bumped = setAndroidVersions(text, "0.2.0", true);
    assert.equal(bumped.code, 8);
    assert.equal(bumped.text, text.replace("versionCode 7", "versionCode 8").replace('"0.1.0"', '"0.2.0"'));
    assert.equal(setAndroidVersions(text, "0.1.0", false).code, 7);
    assert.throws(() => setAndroidVersions('versionName "1"\n', "0.2.0", true), /exactly one numeric versionCode/);
  });
});

describe("changelog", () => {
  it("dates the Unreleased section, opens a new one and rewrites the links", () => {
    const { text, section } = rollChangelog(CHANGELOG_TEXT, "0.2.0", "2026-09-22");
    assert.equal(section, "The next release.\n\n### Added\n\n- A thing.");
    assert.equal(
      text,
      `# Changelog

Intro.

## [Unreleased]

## [0.2.0] - 2026-09-22

The next release.

### Added

- A thing.

## [0.1.0] - 2026-01-02

- First.

[Unreleased]: https://github.com/owner/repo/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/owner/repo/releases/tag/v0.2.0
[0.1.0]: https://github.com/owner/repo/releases/tag/v0.1.0
`,
    );
  });

  it("handles a first release whose Unreleased link points at the branch", () => {
    const first = "# Changelog\n\n## [Unreleased]\n\nEverything.\n\n[Unreleased]: https://github.com/o/r/commits/main\n";
    assert.equal(
      rollChangelog(first, "0.1.0", "2026-09-22").text,
      "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-09-22\n\nEverything.\n\n" +
        "[Unreleased]: https://github.com/o/r/compare/v0.1.0...HEAD\n[0.1.0]: https://github.com/o/r/releases/tag/v0.1.0\n",
    );
  });

  it("refuses an empty section, a missing heading or link, and a version already listed", () => {
    assert.throws(
      () => rollChangelog("## [Unreleased]\n\n## [0.1.0] - 2026-01-02\n\n[Unreleased]: https://github.com/o/r\n", "0.2.0", "2026-09-22"),
      /empty/,
    );
    assert.throws(() => rollChangelog("# Changelog\n", "0.2.0", "2026-09-22"), /no "## \[Unreleased\]"/);
    assert.throws(() => rollChangelog("## [Unreleased]\n\nx\n", "0.2.0", "2026-09-22"), /no "\[Unreleased\]: <url>"/);
    assert.throws(() => rollChangelog(CHANGELOG_TEXT, "0.1.0", "2026-09-22"), /already has/);
    assert.throws(() => rollChangelog(CHANGELOG_TEXT, "0.2.0", "22.09.2026"), /YYYY-MM-DD/);
  });

  it("drafts release notes from the section, marked as a draft", () => {
    const notes = scaffoldReleaseNotes("0.2.0", "- A thing.\n");
    assert.match(notes, /^<!--\n/);
    assert.match(notes, /Then delete this comment/);
    assert.ok(notes.endsWith("-->\n\n- A thing.\n"));
  });

  it("formats the local date", () => {
    assert.equal(localDate(new Date(2026, 0, 5)), "2026-01-05");
  });
});

describe("planRelease", () => {
  const files = {
    "package.json": '{\n  "name": "root",\n  "version": "0.1.0"\n}\n',
    "packages/a/package.json": '{\n  "name": "a",\n  "version": "0.1.0"\n}\n',
    "packages/raycast/package.json": '{\n  "name": "raycast"\n}\n',
    "packages/raycast/src/lib/version.ts": 'export const APP_VERSION = "0.1.0";\n',
    "packages/mcp/src/server.ts": 'export const SERVER_VERSION = "0.1.0";\n',
    [IOS_PROJECT]: "CURRENT_PROJECT_VERSION = 1;\nMARKETING_VERSION = 0.1.0;\n",
    [ANDROID_GRADLE]: 'versionCode 1\nversionName "0.1.0"\n',
    [CHANGELOG]: "## [Unreleased]\n\n- New.\n\n[Unreleased]: https://github.com/o/r/commits/main\n",
  };
  const readFile = (path) => files[path] ?? null;
  const workspacePackages = ["packages/a/package.json", "packages/raycast/package.json", "packages/gone/package.json"];

  it("rewrites every copy, bumps both build numbers and drafts the notes", () => {
    const plan = planRelease({ version: "0.2.0", date: "2026-09-22", readFile, workspacePackages });
    assert.deepEqual(
      plan.changes.map((change) => change.path),
      [
        "package.json",
        "packages/a/package.json",
        "packages/raycast/src/lib/version.ts",
        "packages/mcp/src/server.ts",
        IOS_PROJECT,
        ANDROID_GRADLE,
        CHANGELOG,
        releaseNotesPath("0.2.0"),
      ],
    );
    assert.equal(plan.current, "0.1.0");
    assert.equal(plan.iosBuild, 2);
    assert.equal(plan.androidCode, 2);
    assert.equal(plan.notesCreated, true);
    assert.equal(plan.changes.at(-1)?.before, null);
  });

  it("releases the untagged current version without spending build numbers", () => {
    const withNotes = { ...files, [releaseNotesPath("0.1.0")]: "Notes.\n" };
    const plan = planRelease({
      version: "0.1.0",
      date: "2026-09-22",
      readFile: (path) => withNotes[path] ?? null,
      workspacePackages,
    });
    assert.deepEqual(
      plan.changes.map((change) => change.path),
      [CHANGELOG],
    );
    assert.equal(plan.iosBuild, 1);
    assert.equal(plan.androidCode, 1);
    assert.equal(plan.notesCreated, false);
  });

  it("produces a tree the release policy accepts for a first release", () => {
    const plan = planRelease({ version: "0.2.0", date: "2026-09-22", readFile, workspacePackages });
    const after = { ...files };
    for (const change of plan.changes) after[change.path] = change.after;
    const result = checkRelease({
      version: "v0.2.0",
      previousVersion: null,
      previous: EMPTY_CONTRACT,
      next: EMPTY_CONTRACT,
      readFile: (path) => after[path] ?? null,
    });
    assert.deepEqual(result.problems, []);
  });
});

describe("this checkout", () => {
  const read = (path) => (existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path), "utf8") : null);
  const workspacePackages = readdirSync(join(ROOT, "packages")).map((name) => `packages/${name}/package.json`);

  it("can be planned for the next patch release, touching every copy version-sync checks", () => {
    const current = JSON.parse(read("package.json") ?? "{}").version;
    const [major, minor, patch] = current.split(/[.-]/).map(Number);
    const next = `${major}.${minor}.${patch + 1}`;
    // The real CHANGELOG's Unreleased section is empty right after a release,
    // which the roll refuses; the roll has its own tests above.
    const readFile = (path) => (path === CHANGELOG ? CHANGELOG_TEXT : read(path));
    const plan = planRelease({ version: next, date: "2026-09-22", readFile, workspacePackages });
    const paths = plan.changes.map((change) => change.path);
    for (const path of ["package.json", IOS_PROJECT, ANDROID_GRADLE, CHANGELOG]) assert.ok(paths.includes(path), path);
    for (const { path } of VERSION_CONSTANTS) assert.ok(paths.includes(path), path);
    for (const path of workspacePackages) {
      const text = read(path);
      if (text !== null && JSON.parse(text).version !== undefined) assert.ok(paths.includes(path), path);
    }
    for (const change of plan.changes) {
      if (change.path.endsWith(".json")) assert.equal(JSON.parse(change.after).version, next, change.path);
    }
  });
});
