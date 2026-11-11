/*
 * Staged rollout of desktop updates, as rules with no network or GitHub in
 * them. `scripts/desktop-release-draft.mjs` (CI, on a tag) and
 * `scripts/desktop-rollout.mjs` (a person, on a published release) both write
 * the percentage through `rewriteFeed`, so the two cannot disagree about what
 * a feed says.
 *
 * Two readers, one rule. The Tauri app reads `stagingPercentage` from
 * `latest.json`, and every Electron install still reads it from `latest.yml`,
 * `latest-mac.yml` and `latest-linux*.yml`; both offer the update only when
 * `lastFourBytesOf(<userData>/.updaterId) / 0xffffffff < percentage / 100`
 * (electron-updater 6.8.9's `AppUpdater.isStagingMatch`, which
 * `tyt_model::updater_model::is_staging_match` ports byte for byte, reading
 * the same file — `offeredTo` below is the same rule once more, for the
 * tests). Three consequences the rules below are built on:
 *
 *   - The id is random per install and never changes, so raising 10 → 50
 *     keeps the first 10 % in and adds 40 % more. Lowering takes nobody back:
 *     an install that already updated is on the new version.
 *   - `0` offers the update to nobody.
 *   - An explicit `100` is NOT everybody: `x < 1` is false for the one id in
 *     2^32 whose last four bytes are all 0xff. A full rollout therefore removes
 *     the key, which is what "no staging" means to both readers.
 *
 * A feed is edited as text, one line, and never re-serialised: every other
 * byte — above all each file's sha512 and size in the YAML feeds and each
 * signature in latest.json, which the updaters verify — stays exactly as it
 * was written. `rewriteFeed` proves that by parsing both versions and
 * comparing everything but the key.
 */

/** The top-level key both updaters read. */
export const STAGING_KEY = "stagingPercentage";

/**
 * A staging percentage as a person or a workflow input gives it.
 *
 * Empty (or absent) means a full rollout and returns null. Otherwise a whole
 * number from 0 to 100, with an optional trailing `%`; anything else is a
 * typo and throws. `100` also returns null: see the header.
 *
 * @param {string | number | null | undefined} raw
 * @returns {number | null} the percentage to write, or null for "remove the key"
 */
export function parseStagingPercentage(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().replace(/%$/, "").trim();
  if (text === "") return null;
  if (!/^\d{1,3}$/.test(text)) {
    throw new Error(`Staging percentage "${raw}" is not a whole number from 0 to 100.`);
  }
  const value = Number(text);
  if (value > 100) throw new Error(`Staging percentage ${value} is above 100.`);
  return value === 100 ? null : value;
}

/** How a parsed percentage reads in a log line. */
export function describeStaging(percent) {
  if (percent === null) return "every install (no stagingPercentage)";
  if (percent === 0) return "nobody (stagingPercentage: 0, rollout halted)";
  return `${percent} % of installs (stagingPercentage: ${percent})`;
}

const KEY_LINE = new RegExp(`^${STAGING_KEY}\\s*:.*(?:\\r?\\n|$)`, "gm");

/**
 * The feed text with its top-level `stagingPercentage` set to `percent`, or
 * removed for null. Only column-0 lines are touched, so a nested key of the
 * same name (there is none today) could never be rewritten by accident.
 *
 * @param {string} text
 * @param {number | null} percent
 * @returns {string}
 */
export function setStagingPercentage(text, percent) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let next = text.replace(KEY_LINE, "");
  if (percent === null) return next;
  if (next !== "" && !next.endsWith("\n")) next += eol;
  return `${next}${STAGING_KEY}: ${percent}${eol}`;
}

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function withoutKey(feed) {
  const copy = { ...feed };
  delete copy[STAGING_KEY];
  return copy;
}

/**
 * Rewrite one feed and prove the rewrite: `latest.json` by its name, every
 * other feed as electron-updater YAML. Throws, naming the file, when the input
 * does not parse as an update feed (a `version` and a non-empty `files` list,
 * or `platforms` map), or when the output parses to anything but the input
 * with the new percentage.
 *
 * @param {{ name: string, text: string, percent: number | null, parse: (text: string) => unknown }} input
 *   `parse` is js-yaml's `load`, the parser electron-updater reads the
 *   feed with, so the feed is read the way installed Electron apps read it.
 * @returns {{ text: string, before: number | null, after: number | null }}
 */
export function rewriteFeed({ name, text, percent, parse }) {
  return name.endsWith(".json") ? rewriteJsonFeed({ name, text, percent }) : rewriteYamlFeed({ name, text, percent, parse });
}

function rewriteYamlFeed({ name, text, percent, parse }) {
  let feed;
  try {
    feed = parse(text);
  } catch (err) {
    throw new Error(`${name} does not parse as YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isPlainObject(feed) || typeof feed.version !== "string" || !Array.isArray(feed.files) || feed.files.length === 0) {
    throw new Error(`${name} is not an update feed (no version or no files).`);
  }
  const before = feed[STAGING_KEY] === undefined ? null : feed[STAGING_KEY];
  if (before !== null && typeof before !== "number") {
    throw new Error(`${name} has a ${STAGING_KEY} that is not a number: ${JSON.stringify(before)}.`);
  }

  const next = setStagingPercentage(text, percent);
  const reparsed = parse(next);
  const after = isPlainObject(reparsed) && reparsed[STAGING_KEY] !== undefined ? reparsed[STAGING_KEY] : null;
  if (after !== percent) {
    throw new Error(`${name}: after the rewrite ${STAGING_KEY} reads ${JSON.stringify(after)}, expected ${JSON.stringify(percent)}.`);
  }
  if (JSON.stringify(withoutKey(reparsed)) !== JSON.stringify(withoutKey(feed))) {
    throw new Error(`${name}: the rewrite changed more than ${STAGING_KEY}. Nothing was written.`);
  }
  return { text: next, before, after };
}

/**
 * latest.json with its `stagingPercentage` set to `percent`, or removed for
 * null. The key is the object's FIRST member (`tauriFeedText` writes it
 * there), so adding, changing or removing it is one line with its own comma,
 * and no other line changes. The text is otherwise re-serialised the way it
 * was written (two-space JSON), and `rewriteJsonFeed` refuses unless that
 * reproduces every other line exactly.
 */
export function setStagingPercentageJson(text, percent) {
  const feed = JSON.parse(text);
  const rest = { ...feed };
  delete rest[STAGING_KEY];
  const next = percent === null ? rest : { [STAGING_KEY]: percent, ...rest };
  return `${JSON.stringify(next, null, 2)}\n`;
}

const isStagingLine = (line) => new RegExp(`^\\s*"${STAGING_KEY}"\\s*:`).test(line);

function rewriteJsonFeed({ name, text, percent }) {
  let feed;
  try {
    feed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${name} does not parse as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isPlainObject(feed) || typeof feed.version !== "string" || !isPlainObject(feed.platforms) || Object.keys(feed.platforms).length === 0) {
    throw new Error(`${name} is not an update feed (no version or no platforms).`);
  }
  const before = feed[STAGING_KEY] === undefined ? null : feed[STAGING_KEY];
  if (before !== null && typeof before !== "number") {
    throw new Error(`${name} has a ${STAGING_KEY} that is not a number: ${JSON.stringify(before)}.`);
  }
  const next = setStagingPercentageJson(text, percent);
  const reparsed = JSON.parse(next);
  const after = reparsed[STAGING_KEY] === undefined ? null : reparsed[STAGING_KEY];
  if (after !== percent) {
    throw new Error(`${name}: after the rewrite ${STAGING_KEY} reads ${JSON.stringify(after)}, expected ${JSON.stringify(percent)}.`);
  }
  const others = (t) => t.split("\n").filter((line) => !isStagingLine(line));
  if (JSON.stringify(others(next)) !== JSON.stringify(others(text)) || JSON.stringify(withoutKey(reparsed)) !== JSON.stringify(withoutKey(feed))) {
    throw new Error(`${name}: the rewrite changed more than ${STAGING_KEY}. Nothing was written.`);
  }
  return { text: next, before, after };
}

/**
 * Whether a feed offers its release to the install with this `.updaterId`:
 * electron-updater 6.8.9's `isStagingMatch`, which the Tauri app ports
 * (`tyt_model::updater_model::is_staging_match`). No percentage, or one that
 * does not parse, offers it to everybody.
 */
export function offeredTo(feed, updaterId) {
  const percentage = Number.parseInt(feed?.[STAGING_KEY], 10);
  if (Number.isNaN(percentage)) return true;
  return stagingBucket(updaterId) < percentage / 100;
}

/**
 * Where an install falls in a rollout, from 0 to 1: the id's last four bytes
 * as a big-endian number over 0xffffffff (builder-util-runtime's
 * `UUID.parse(id).readUInt32BE(12)`, which reads lower-case hex only — an
 * upper-case pair is 0, here as there).
 */
export function stagingBucket(updaterId) {
  const hex = String(updaterId).replace(/-/g, "").slice(24, 32);
  let value = 0;
  for (let i = 0; i < 8; i += 2) {
    const pair = hex.slice(i, i + 2);
    value = value * 256 + (/^[0-9a-f]{2}$/.test(pair) ? Number.parseInt(pair, 16) : 0);
  }
  return value / 0xffffffff;
}

/** A release tag as the desktop workflow builds it. */
export function isReleaseTag(tag) {
  return /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag);
}

/** The update feeds among a release's asset names: the Tauri one and the Electron ones. */
export function feedAssetNames(names) {
  return names.filter((name) => /^latest.*\.yml$/.test(name) || name === "latest.json").sort();
}

/**
 * Arguments of `pnpm desktop:rollout <vX.Y.Z> <percent> [--repo owner/name] [--dry-run]`.
 * The percentage is required here, unlike in CI: a person running the command
 * means a number, and an empty argument is a mistake rather than "100".
 *
 * @returns {{ tag: string, percent: number | null, repo: string | null, dryRun: boolean }}
 */
export function parseRolloutArgs(argv) {
  const positional = [];
  let repo = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--repo") {
      repo = argv[i + 1] ?? null;
      i += 1;
      if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("--repo needs <owner>/<name>.");
    } else if (arg.startsWith("-") && !/^-?\d/.test(arg)) throw new Error(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  if (positional.length !== 2) {
    throw new Error("Usage: pnpm desktop:rollout <vX.Y.Z> <percent 0-100> [--repo owner/name] [--dry-run]");
  }
  const [tag, rawPercent] = positional;
  if (!isReleaseTag(tag)) throw new Error(`"${tag}" is not a release tag like v1.2.3.`);
  if (String(rawPercent).trim() === "") throw new Error("Give a percentage from 0 to 100.");
  return { tag, percent: parseStagingPercentage(rawPercent), repo, dryRun };
}
