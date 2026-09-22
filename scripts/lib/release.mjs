/**
 * The file rewrites behind `pnpm release X.Y.Z` (scripts/release.mjs), kept
 * free of git, the filesystem and the clock so every one of them is
 * unit-tested (`release.test.mjs`) against made-up files.
 *
 * What a release changes is docs/releasing.md → Steps, step 2: the root
 * version and every hand-kept copy `version-sync.test.mjs` checks (the
 * self-host `TRACKYOURTIME_VERSION` defaults among them), the iOS and Android
 * build numbers, the dated CHANGELOG section with its links, and the release
 * notes the policy check requires.
 */

/** Every hand-kept copy of the version that is not a package.json. */
export const VERSION_CONSTANTS = Object.freeze([
  { path: "packages/raycast/src/lib/version.ts", name: "APP_VERSION" },
  { path: "packages/mcp/src/server.ts", name: "SERVER_VERSION" },
]);

export const IOS_PROJECT = "ios/App/App.xcodeproj/project.pbxproj";
export const ANDROID_GRADLE = "android/app/build.gradle";
export const CHANGELOG = "CHANGELOG.md";

/**
 * The self-host files that default `TRACKYOURTIME_VERSION` to a tag: the
 * example env file (`TRACKYOURTIME_VERSION=vX.Y.Z`) and the compose file
 * (`${TRACKYOURTIME_VERSION:-vX.Y.Z}`, once per image). release.yml's smoke
 * job starts the compose file from the tagged commit, and a self-hoster's
 * first `docker compose up` pulls whatever these say, so they name the tag
 * being cut.
 */
export const SELFHOST_ENV_EXAMPLE = ".env.selfhost.example";
export const SELFHOST_COMPOSE = "docker-compose.selfhost.yml";
export const SELFHOST_VERSION_FILES = Object.freeze([SELFHOST_ENV_EXAMPLE, SELFHOST_COMPOSE]);

/** The path `release-policy.mjs` looks for, and the release page body. */
export const releaseNotesPath = (version) => `docs/release-notes/v${version}.md`;

const STABLE = /^v?(\d+)\.(\d+)\.(\d+)$/;
const ANY = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * `X.Y.Z` from what was typed (`0.2.0` or `v0.2.0`), or null.
 *
 * Stable versions only. A prerelease is tagged by hand: the policy check
 * skips its written record, and neither App Store Connect nor Play takes a
 * `-rc.1` as a marketing version, so there is nothing here to automate.
 */
export const parseStableVersion = (input) => {
  const match = STABLE.exec(String(input).trim());
  if (!match) return null;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  return { major, minor, patch, version: `${major}.${minor}.${patch}` };
};

/** Semver precedence of two versions (prerelease below its release); NaN when either is unreadable. */
export const compareVersions = (a, b) => {
  const pa = ANY.exec(String(a).trim());
  const pb = ANY.exec(String(b).trim());
  if (!pa || !pb) return Number.NaN;
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return Math.sign(diff);
  }
  if (pa[4] === pb[4]) return 0;
  if (pa[4] === undefined) return 1;
  if (pb[4] === undefined) return -1;
  const ia = pa[4].split(".");
  const ib = pb[4].split(".");
  for (let i = 0; i < Math.max(ia.length, ib.length); i += 1) {
    if (ia[i] === undefined) return -1;
    if (ib[i] === undefined) return 1;
    const na = /^\d+$/.test(ia[i]);
    const nb = /^\d+$/.test(ib[i]);
    if (na && nb && Number(ia[i]) !== Number(ib[i])) return Math.sign(Number(ia[i]) - Number(ib[i]));
    if (na !== nb) return na ? -1 : 1;
    if (!na && ia[i] !== ib[i]) return ia[i] < ib[i] ? -1 : 1;
  }
  return 0;
};

/**
 * Why `next` cannot be released from a tree at `current`, or null.
 *
 * `next` must be newer than `current` — with one exception: the version the
 * tree already carries may be released when no tag has it yet. The first
 * release is exactly that (the repository has said 0.1.0 since before any
 * tag), and so is a bump committed by hand before running the script.
 *
 * @param {object} input
 * @param {string} input.current    the root package.json version
 * @param {string} input.next       the typed version
 * @param {string[]} input.tags     every known tag, local and remote
 */
export const versionRefusal = ({ current, next, tags }) => {
  const parsed = parseStableVersion(next);
  if (!parsed) {
    return `"${next}" is not an X.Y.Z version. Prereleases are tagged by hand (docs/releasing.md).`;
  }
  const tag = `v${parsed.version}`;
  if (tags.includes(tag)) return `the tag ${tag} already exists`;
  const order = compareVersions(parsed.version, current);
  if (Number.isNaN(order)) return `the root package.json version "${current}" is not a semver version`;
  if (order < 0) return `${parsed.version} is lower than the current version ${current}`;
  if (order === 0 && tags.includes(`v${current}`)) {
    return `${parsed.version} is the current version and is already tagged; release a higher one`;
  }
  return null;
};

// ── Version copies ──────────────────────────────────────────────────────

/**
 * `text` with its top-level `"version"` set, formatting untouched.
 *
 * A regex rather than JSON.stringify so the file keeps its own indentation and
 * key order. The first `"version"` key is the top-level one in every
 * package.json here (it sits under `name`); the parse check below is what
 * would notice if that stopped being true.
 */
export const setPackageVersion = (text, version, path = "package.json") => {
  const pattern = /^(\s*"version"\s*:\s*")[^"]*(")/m;
  if (!pattern.test(text)) throw new Error(`${path} has no "version" field`);
  const next = text.replace(pattern, `$1${version}$2`);
  if (JSON.parse(next).version !== version) {
    throw new Error(`${path}: the first "version" key is not the top-level one`);
  }
  return next;
};

/** `text` with `export const NAME = "…";` set to `version`. */
export const setVersionConstant = (text, name, version, path = name) => {
  const pattern = new RegExp(`(export const ${name}(?::\\s*string)?\\s*=\\s*")[^"]*(")`, "g");
  const count = [...text.matchAll(pattern)].length;
  if (count === 0) throw new Error(`${path} declares no \`export const ${name} = "…"\``);
  return text.replace(pattern, `$1${version}$2`);
};

/** Two groups each: what precedes the tag and what follows it. */
const SELFHOST_PATTERNS = {
  [SELFHOST_ENV_EXAMPLE]: /^(TRACKYOURTIME_VERSION=)v\S+($)/m,
  [SELFHOST_COMPOSE]: /(\$\{TRACKYOURTIME_VERSION:-)v[^}\s]+(\})/g,
};

/**
 * A self-host file (`SELFHOST_VERSION_FILES`) with its `TRACKYOURTIME_VERSION`
 * default set to `vX.Y.Z`. Throws when the file has no such default, since a
 * file that stopped carrying one would otherwise pass through untouched and
 * keep pulling the previous release.
 */
export const setSelfhostVersion = (text, version, path) => {
  const pattern = SELFHOST_PATTERNS[path];
  if (!pattern) throw new Error(`${path} is not one of ${SELFHOST_VERSION_FILES.join(", ")}`);
  if (!pattern.test(text)) throw new Error(`${path} has no TRACKYOURTIME_VERSION default matching ${pattern}`);
  pattern.lastIndex = 0;
  return text.replace(pattern, `$1v${version}$2`);
};

/**
 * The Xcode project with every `MARKETING_VERSION` set and, when `bumpBuild`,
 * every `CURRENT_PROJECT_VERSION` set to one above the highest it had.
 *
 * App Store Connect refuses a build number it has seen for the same marketing
 * version, and TestFlight sorts by it; one number for Debug and Release keeps
 * the two configurations from disagreeing about which build this is.
 */
export const setIosVersions = (text, version, bumpBuild) => {
  const marketing = /(MARKETING_VERSION = )[^;]+(;)/g;
  if (![...text.matchAll(marketing)].length) throw new Error(`${IOS_PROJECT} has no MARKETING_VERSION`);
  let next = text.replace(marketing, `$1${version}$2`);
  const builds = [...next.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map((m) => Number(m[1]));
  if (builds.length === 0) throw new Error(`${IOS_PROJECT} has no numeric CURRENT_PROJECT_VERSION`);
  const build = bumpBuild ? Math.max(...builds) + 1 : Math.max(...builds);
  next = next.replace(/(CURRENT_PROJECT_VERSION = )\d+(;)/g, `$1${build}$2`);
  return { text: next, build };
};

/**
 * The Gradle file with `versionName` set and, when `bumpBuild`, `versionCode`
 * raised by one. Play refuses an upload whose versionCode is not higher than
 * every one it has seen, whatever the versionName says.
 */
export const setAndroidVersions = (text, version, bumpBuild) => {
  const name = /^(\s*versionName\s*=?\s*["'])[^"']+(["'])/gm;
  if (![...text.matchAll(name)].length) throw new Error(`${ANDROID_GRADLE} has no versionName`);
  const codes = [...text.matchAll(/^[ \t]*versionCode[ \t]*=?[ \t]*(\d+)[ \t]*$/gm)].map((m) => Number(m[1]));
  if (codes.length !== 1) throw new Error(`${ANDROID_GRADLE} must declare exactly one numeric versionCode`);
  const code = bumpBuild ? codes[0] + 1 : codes[0];
  const next = text
    .replace(name, `$1${version}$2`)
    .replace(/^([ \t]*versionCode[ \t]*=?[ \t]*)\d+([ \t]*)$/m, `$1${code}$2`);
  return { text: next, code };
};

// ── CHANGELOG ───────────────────────────────────────────────────────────

const UNRELEASED_HEADING = /^## \[Unreleased\][^\n]*\n/m;
/** The next `## [` heading or the link reference block, whichever is first. */
const SECTION_END = /^(## \[|\[[^\]]+\]:\s*\S)/m;

/**
 * CHANGELOG.md with `## [Unreleased]` renamed to `## [X.Y.Z] - <date>`, an
 * empty `## [Unreleased]` above it, and the links docs/releasing.md step 2
 * names: `[Unreleased]` → `compare/vX.Y.Z...HEAD`, `[X.Y.Z]` →
 * `releases/tag/vX.Y.Z`. Returns the section's body too, for the notes.
 *
 * The body moves unchanged. Rewriting its opening paragraph in the past tense
 * is a person's edit, made on `main` before the release command runs.
 */
export const rollChangelog = (text, version, date) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`"${date}" is not a YYYY-MM-DD date`);
  if (text.includes(`## [${version}]`)) throw new Error(`${CHANGELOG} already has a "## [${version}]" section`);
  const heading = UNRELEASED_HEADING.exec(text);
  if (!heading) throw new Error(`${CHANGELOG} has no "## [Unreleased]" heading`);
  const bodyStart = heading.index + heading[0].length;
  const rest = text.slice(bodyStart);
  const end = SECTION_END.exec(rest);
  const body = (end ? rest.slice(0, end.index) : rest).trim();
  if (body === "") throw new Error(`${CHANGELOG}'s "## [Unreleased]" section is empty: nothing to release`);
  const after = end ? rest.slice(end.index) : "";

  const link = /^\[Unreleased\]:[ \t]*(\S+)[ \t]*$/m.exec(after);
  if (!link) throw new Error(`${CHANGELOG} has no "[Unreleased]: <url>" link`);
  const repo = /^(https:\/\/github\.com\/[^/\s]+\/[^/\s]+)/.exec(link[1]);
  if (!repo) throw new Error(`${CHANGELOG}'s [Unreleased] link is not a github.com URL: ${link[1]}`);
  const links = after.replace(
    link[0],
    `[Unreleased]: ${repo[1]}/compare/v${version}...HEAD\n[${version}]: ${repo[1]}/releases/tag/v${version}`,
  );

  const rolled =
    `${text.slice(0, heading.index)}## [Unreleased]\n\n## [${version}] - ${date}\n\n${body}\n\n` + links;
  return { text: rolled, section: body };
};

/**
 * A first draft of `docs/release-notes/vX.Y.Z.md`: the changelog section,
 * under a comment saying what the file is for. It is the GitHub release page
 * (docs/releasing.md step 6), read by someone deciding whether to upgrade, so
 * the script stops after writing it and a person rewrites it.
 */
export const scaffoldReleaseNotes = (version, section) =>
  `<!--\n` +
  `  Drafted by \`pnpm release ${version}\` from the [${version}] section of CHANGELOG.md.\n` +
  `  This file is the body of the v${version} GitHub release page. Rewrite it for a\n` +
  `  reader deciding whether to upgrade (see docs/release-notes/ for earlier ones):\n` +
  `  what changed for them, what to do, and any migration or rollback note the\n` +
  `  release policy check asks for. Then delete this comment.\n` +
  `-->\n\n${section.trim()}\n`;

/**
 * The scaffold without its leading drafting comment: what `--yes` commits,
 * since a release page that still says "then delete this comment" was never
 * read by the person the comment addresses. Text with no such comment is
 * returned as it is.
 */
export const stripDraftingComment = (notes) => notes.replace(/^<!--[\s\S]*?-->\n*/, "");

// ── The whole plan ──────────────────────────────────────────────────────

/**
 * Every file a release of `version` writes, as `{ path, before, after }`
 * (`before` is null for a new file), plus the build numbers it chose.
 *
 * @param {object} input
 * @param {string} input.version           X.Y.Z
 * @param {string} input.date              YYYY-MM-DD
 * @param {(path: string) => string | null} input.readFile   the tree at HEAD
 * @param {string[]} input.workspacePackages  packages/<name>/package.json paths
 * @param {boolean} [input.acceptDraft]   `--yes`: the drafted notes are the
 *   release page as they are, so the scaffold's drafting comment is left out
 */
export const planRelease = ({ version, date, readFile, workspacePackages, acceptDraft = false }) => {
  const must = (path) => {
    const text = readFile(path);
    if (text === null) throw new Error(`${path} is missing`);
    return text;
  };
  const changes = [];
  const change = (path, after) => {
    const before = readFile(path);
    if (before !== after) changes.push({ path, before, after });
  };

  const current = JSON.parse(must("package.json")).version;
  // Build numbers move only with the version. Re-running the release of a
  // version the tree already carries (the first release) would otherwise
  // spend a build number on a version no store has seen.
  const bumpBuild = current !== version;

  change("package.json", setPackageVersion(must("package.json"), version));
  for (const path of workspacePackages) {
    const text = readFile(path);
    // Raycast's manifest has no version field; its constant is below.
    if (text === null || JSON.parse(text).version === undefined) continue;
    change(path, setPackageVersion(text, version, path));
  }
  for (const { path, name } of VERSION_CONSTANTS) {
    change(path, setVersionConstant(must(path), name, version, path));
  }
  for (const path of SELFHOST_VERSION_FILES) {
    change(path, setSelfhostVersion(must(path), version, path));
  }
  const ios = setIosVersions(must(IOS_PROJECT), version, bumpBuild);
  change(IOS_PROJECT, ios.text);
  const android = setAndroidVersions(must(ANDROID_GRADLE), version, bumpBuild);
  change(ANDROID_GRADLE, android.text);

  const changelog = rollChangelog(must(CHANGELOG), version, date);
  change(CHANGELOG, changelog.text);

  const notesPath = releaseNotesPath(version);
  const notesCreated = readFile(notesPath) === null;
  if (notesCreated) {
    const scaffold = scaffoldReleaseNotes(version, changelog.section);
    change(notesPath, acceptDraft ? stripDraftingComment(scaffold) : scaffold);
  }

  return { current, changes, notesPath, notesCreated, iosBuild: ios.build, androidCode: android.code };
};

/** The local calendar date, which is what a person means by "released today". */
export const localDate = (now) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

/** What the two pushes printed at the end start (docs/releasing.md → Steps). */
export const PUSH_EFFECTS = Object.freeze([
  {
    command: "git push origin main",
    effects: [
      "build-and-deploy.yml: builds both images and deploys the hosted app (trackyourtime.dev, api.trackyourtime.dev)",
    ],
  },
  {
    command: (tag) => `git push origin ${tag}`,
    effects: [
      "release.yml: self-host images to GHCR, smoke test on both arches, then X.Y/latest",
      "extension-release.yml: extension zip; Chrome Web Store submission when its secrets are set",
      "desktop-release.yml: every desktop channel into a DRAFT GitHub Release (publishing it is the release)",
      "release-summary.yml: one table of every channel's outcome as each of the above finishes",
    ],
  },
]);
