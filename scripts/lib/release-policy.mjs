/**
 * The semver rule a release tag must follow, read from the code.
 *
 * docs/versioning.md → "Release numbers" is the policy in words; this is the
 * same policy as arithmetic, so a release cannot ship an API or schema change
 * under a patch number:
 *
 *  - patch: `API_LEVEL` and `SCHEMA_VERSION` unchanged.
 *  - minor: `API_LEVEL` raised, and/or migrations that every earlier release
 *    can still read (`minReaderSchema` at or below the previous release's
 *    `SCHEMA_VERSION`).
 *  - major: `MIN_CLIENT_API_LEVEL` or `MIN_SERVER_API_LEVEL` raised, or a
 *    migration the previous release can no longer read.
 *
 * While the major number is 0, a minor bump is the breaking bump (semver §4),
 * so "major" is satisfied by 0.y → 0.(y+1).
 *
 * Everything here is pure over two injected readers — a file at a ref, and the
 * names in a directory at a ref — so the test drives it with made-up trees and
 * `release-policy-check.mjs` binds it to git. It reads source text rather than
 * importing TypeScript, because a tag from before a constant existed must read
 * as 0, not fail to build.
 */

export const API_LEVEL_FILE = "packages/shared/src/api-level.ts";
export const SERVER_ORIGIN_FILE = "packages/core/src/server-origin.ts";
export const MIGRATIONS_DIR = "packages/server/src/services/migrations";

/** A migration file: `001-baseline.ts`. The runner's own modules are not. */
const MIGRATION_FILE = /^\d+-[^/]+\.ts$/;

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

/**
 * The integer a file declares as `export const NAME = <n>;`.
 *
 * 0 when the file does not exist at that ref (a release from before the
 * constant). A file that exists but no longer matches throws: a refactor that
 * moved the constant must fail this check loudly, not read as level 0 and
 * wave every release through.
 */
const readConstant = (readFile, path, name) => {
  const text = readFile(path);
  if (text === null) return 0;
  const match = new RegExp(`export const ${name}(?::\\s*number)?\\s*=\\s*(\\d+)\\s*;`).exec(text);
  if (!match) {
    throw new Error(`${path} exists but declares no \`export const ${name} = <integer>;\``);
  }
  return Number(match[1]);
};

/** `{ level, release }` rows of `API_LEVEL_CHANGES`, in file order. */
const readApiLevelChanges = (readFile) => {
  const text = readFile(API_LEVEL_FILE);
  if (text === null) return [];
  return [...text.matchAll(/level:\s*(\d+),\s*release:\s*"([^"]*)"/g)].map((match) => ({
    level: Number(match[1]),
    release: match[2],
  }));
};

const readMigrations = (readFile, listDir) => {
  const names = listDir(MIGRATIONS_DIR).filter((name) => MIGRATION_FILE.test(name));
  return names
    .map((name) => {
      const path = `${MIGRATIONS_DIR}/${name}`;
      const text = readFile(path) ?? "";
      const id = /\bid:\s*(\d+)\s*,/.exec(text);
      const reader = /\bminReaderSchema:\s*(\d+)\s*,/.exec(text);
      if (!id || !reader) {
        throw new Error(`${path} has no literal \`id: <n>,\` and \`minReaderSchema: <n>,\``);
      }
      return { file: name, id: Number(id[1]), minReaderSchema: Number(reader[1]) };
    })
    .sort((a, b) => a.id - b.id);
};

/**
 * The migrations a tree carries, and nothing else: what a server rollback
 * compares (`scripts/lib/coolify-deploy.mjs` → `serverDowngradeBlock`).
 *
 * Deliberately not `readContract`. That reader throws when `API_LEVEL`,
 * `MIN_CLIENT_API_LEVEL` or `MIN_SERVER_API_LEVEL` moved — right for the
 * release check, which must not wave such a refactor through — but a rollback
 * treats a throw as "cannot compare" and keeps the server on the failed
 * build. A constant that moved says nothing about whether an older server can
 * read the database, so the rollback reads only what decides that.
 *
 * @param {(path: string) => string | null} readFile
 * @param {(dir: string) => string[]} listDir
 * @returns {{ migrations: { file: string, id: number, minReaderSchema: number }[], schemaVersion: number }}
 */
export const readMigrationContract = (readFile, listDir) => {
  const migrations = readMigrations(readFile, listDir);
  return { migrations, schemaVersion: migrations.at(-1)?.id ?? 0 };
};

/**
 * What a tree promises its peers.
 *
 * @param {(path: string) => string | null} readFile
 * @param {(dir: string) => string[]} listDir
 */
export const readContract = (readFile, listDir) => ({
  apiLevel: readConstant(readFile, API_LEVEL_FILE, "API_LEVEL"),
  minClientApiLevel: readConstant(readFile, API_LEVEL_FILE, "MIN_CLIENT_API_LEVEL"),
  minServerApiLevel: readConstant(readFile, SERVER_ORIGIN_FILE, "MIN_SERVER_API_LEVEL"),
  apiLevelChanges: readApiLevelChanges(readFile),
  ...readMigrationContract(readFile, listDir),
});

/** The contract of a release from before any of it existed. */
export const EMPTY_CONTRACT = Object.freeze({
  apiLevel: 0,
  minClientApiLevel: 0,
  minServerApiLevel: 0,
  apiLevelChanges: [],
  migrations: [],
  schemaVersion: 0,
});

export const parseSemver = (version) => {
  const match = SEMVER.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] !== undefined,
    core: `${match[1]}.${match[2]}.${match[3]}`,
  };
};

const RANK = { none: -1, patch: 0, minor: 1, major: 2 };

/**
 * "major", "minor", "patch", or "none" when `next` is not newer than `previous`
 * (a prerelease of the same core counts as newer only from another core).
 */
export const bumpKind = (previous, next) => {
  const a = parseSemver(previous);
  const b = parseSemver(next);
  if (!a || !b) return "none";
  if (b.major !== a.major) return b.major > a.major ? "major" : "none";
  if (b.minor !== a.minor) return b.minor > a.minor ? "minor" : "none";
  if (b.patch !== a.patch) return b.patch > a.patch ? "patch" : "none";
  // Same core: v1.2.0-rc.1 → v1.2.0 carries the bump the rc already declared.
  return a.prerelease && !b.prerelease ? "patch" : "none";
};

/**
 * The smallest bump the change from `previous` to `next` needs, and why.
 *
 * `errors` are changes no bump excuses: a lowered API level or schema version
 * means a released peer relies on something this tree no longer has.
 */
export const requiredBump = (previous, next) => {
  const reasons = [];
  const errors = [];
  let required = "patch";
  const need = (kind, reason) => {
    reasons.push(`${kind}: ${reason}`);
    if (RANK[kind] > RANK[required]) required = kind;
  };

  if (next.apiLevel < previous.apiLevel) {
    errors.push(`API_LEVEL went down from ${previous.apiLevel} to ${next.apiLevel}; it is never lowered`);
  }
  if (next.schemaVersion < previous.schemaVersion) {
    errors.push(
      `SCHEMA_VERSION went down from ${previous.schemaVersion} to ${next.schemaVersion}; released migrations are never removed`,
    );
  }

  if (next.minClientApiLevel > previous.minClientApiLevel) {
    need(
      "major",
      `MIN_CLIENT_API_LEVEL raised from ${previous.minClientApiLevel} to ${next.minClientApiLevel}, so clients the previous release served are refused`,
    );
  }
  if (next.minServerApiLevel > previous.minServerApiLevel) {
    need(
      "major",
      `MIN_SERVER_API_LEVEL raised from ${previous.minServerApiLevel} to ${next.minServerApiLevel}, so servers the previous clients used are refused`,
    );
  }
  for (const migration of breakingMigrations(previous, next)) {
    need(
      "major",
      `migration ${migration.id} (${migration.file}) needs schema ${migration.minReaderSchema}; the previous release reads up to ${previous.schemaVersion}, so rolling back requires restoring a dump`,
    );
  }
  if (next.apiLevel > previous.apiLevel) {
    need("minor", `API_LEVEL raised from ${previous.apiLevel} to ${next.apiLevel}`);
  }
  if (next.schemaVersion > previous.schemaVersion) {
    need("minor", `SCHEMA_VERSION raised from ${previous.schemaVersion} to ${next.schemaVersion}`);
  }
  return { required, reasons, errors };
};

/** New migrations the previous release cannot read the database after. */
export const breakingMigrations = (previous, next) =>
  next.migrations.filter(
    (migration) =>
      migration.id > previous.schemaVersion && migration.minReaderSchema > previous.schemaVersion,
  );

/** True when `actual` is at least `required`, with the 0.x rule applied. */
export const bumpSatisfies = (actual, required, nextVersion) => {
  const next = parseSemver(nextVersion);
  let needed = required;
  if (needed === "major" && next && next.major === 0) needed = "minor";
  return RANK[actual] >= RANK[needed];
};

/**
 * Every problem with releasing `version` from `next` after `previousVersion`
 * (null for the first release). Empty means the tag may publish.
 *
 * @param {object} input
 * @param {string} input.version          the tag being released, `vX.Y.Z`
 * @param {string | null} input.previousVersion  newest stable tag below it
 * @param {object} input.previous         `readContract` at the previous tag
 * @param {object} input.next             `readContract` at the tag
 * @param {(path: string) => string | null} input.readFile  files at the tag
 */
export const checkRelease = ({ version, previousVersion, previous, next, readFile }) => {
  const problems = [];
  const notes = [];
  const parsed = parseSemver(version);
  if (!parsed) return { problems: [`${version} is not a vX.Y.Z tag`], notes };

  const { required, reasons, errors } = requiredBump(previous, next);
  problems.push(...errors);
  notes.push(...reasons);

  if (previousVersion === null) {
    notes.push("no earlier stable release: nothing to compare the bump against");
  } else {
    const actual = bumpKind(previousVersion, version);
    if (actual === "none") {
      problems.push(`${version} is not newer than the previous release ${previousVersion}`);
    } else if (!bumpSatisfies(actual, required, version)) {
      const zero = required === "major" && parsed.major === 0 ? " (a minor bump while the major is 0)" : "";
      problems.push(
        `${previousVersion} → ${version} is a ${actual} bump, but the changes need a ${required} bump${zero}:\n  - ${reasons.join("\n  - ")}`,
      );
    }
  }

  // Every level this release introduces names this release.
  for (const row of next.apiLevelChanges) {
    if (row.level > previous.apiLevel && row.release !== parsed.core) {
      problems.push(
        `API_LEVEL_CHANGES row for level ${row.level} says release "${row.release}", but it first ships in ${parsed.core}; set its release to "${parsed.core}" in ${API_LEVEL_FILE}`,
      );
    }
  }
  if (next.apiLevel > 0 && next.apiLevelChanges.at(-1)?.level !== next.apiLevel) {
    problems.push(`API_LEVEL_CHANGES in ${API_LEVEL_FILE} does not end with a row for API_LEVEL ${next.apiLevel}`);
  }

  // Prereleases get their exact tag only; the written release record is the
  // stable tag's job.
  if (parsed.prerelease) return { problems, notes };

  const changelog = readFile("CHANGELOG.md") ?? "";
  if (!changelog.includes(`## [${parsed.core}]`)) {
    problems.push(`CHANGELOG.md has no "## [${parsed.core}]" heading (docs/releasing.md → Steps, step 2)`);
  }

  const notesPath = `docs/release-notes/v${parsed.core}.md`;
  const releaseNotes = readFile(notesPath);
  if (releaseNotes === null) {
    problems.push(`${notesPath} does not exist; write the release notes before tagging`);
  } else if (previousVersion !== null) {
    if (next.schemaVersion > previous.schemaVersion && !/migrat/i.test(releaseNotes)) {
      problems.push(
        `${notesPath} does not mention the migrations this release runs (schema ${previous.schemaVersion} → ${next.schemaVersion})`,
      );
    }
    if (
      breakingMigrations(previous, next).length > 0 &&
      !/rollback requires restoring your dump/i.test(releaseNotes)
    ) {
      problems.push(
        `${notesPath} must say "Rollback requires restoring your dump": a migration in this release cannot be read by ${previousVersion}`,
      );
    }
  }

  return { problems, notes };
};

const compareCore = (a, b) =>
  a.major - b.major || a.minor - b.minor || a.patch - b.patch;

/** The newest stable `vX.Y.Z` in `tags` below `version`'s core, or null. */
export const previousStableTag = (tags, version) => {
  const target = parseSemver(version);
  if (!target) return null;
  const below = tags
    .filter((tag) => tag.startsWith("v"))
    .map((tag) => ({ tag, parsed: parseSemver(tag) }))
    .filter(({ parsed }) => parsed !== null && !parsed.prerelease && compareCore(parsed, target) < 0)
    .sort((a, b) => compareCore(a.parsed, b.parsed));
  return below.at(-1)?.tag ?? null;
};
