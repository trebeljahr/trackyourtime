import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

import { tauriFeedText } from "./desktop-release.mjs";
import {
  describeStaging,
  feedAssetNames,
  isReleaseTag,
  offeredTo,
  parseRolloutArgs,
  parseStagingPercentage,
  rewriteFeed,
  setStagingPercentage,
  setStagingPercentageJson,
  stagingBucket,
} from "./desktop-rollout.mjs";

// js-yaml is the parser electron-updater reads its feeds with (it depends on
// js-yaml ^4.1), so the YAML cases read the feed the way Electron installs do.
// `offeredTo` is electron-updater 6.8.9's `isStagingMatch`, which the Tauri app
// ports (tyt_model::updater_model::is_staging_match); the bucket values below
// are the ones that crate's own tests pin, so the two cannot drift apart.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const offered = (feed, updaterId) => offeredTo(feed, updaterId);

/** An install id whose last four bytes are `tail` (what isStagingMatch reads). */
const idEndingIn = (tail) => `3e0b1e0e-1111-5222-8333-${tail.toString(16).padStart(12, "0")}`;

// As electron-builder 26 writes latest-mac.yml.
const FEED = `version: 0.4.0
files:
  - url: TrackYourTime-0.4.0-mac-arm64.zip
    sha512: q0e7aEVBbS3MeSk0z1g5Nf6W1n5LWsWHTR4E8L1lL3m0ZXnY0j0Uu4xvG8mZqk0Y3hQ9tQ9Jm2N3u5v6w7x8yA==
    size: 104857600
  - url: TrackYourTime-0.4.0-mac-arm64.dmg
    sha512: Zm9vYmFyYmF6
    size: 104900000
path: TrackYourTime-0.4.0-mac-arm64.zip
sha512: q0e7aEVBbS3MeSk0z1g5Nf6W1n5LWsWHTR4E8L1lL3m0ZXnY0j0Uu4xvG8mZqk0Y3hQ9tQ9Jm2N3u5v6w7x8yA==
releaseDate: '2026-09-22T10:00:00.000Z'
`;

describe("parseStagingPercentage", () => {
  it("reads empty as a full rollout", () => {
    for (const raw of [undefined, null, "", "   "]) assert.equal(parseStagingPercentage(raw), null);
  });

  it("reads whole numbers from 0 to 99, with or without %", () => {
    assert.equal(parseStagingPercentage("0"), 0);
    assert.equal(parseStagingPercentage(" 10 "), 10);
    assert.equal(parseStagingPercentage("25%"), 25);
    assert.equal(parseStagingPercentage(99), 99);
  });

  it("reads 100 as removing the key, because an explicit 100 leaves one id in 2^32 out", async () => {
    assert.equal(parseStagingPercentage("100"), null);
    const last = idEndingIn(0xffffffff);
    assert.equal(offered({ stagingPercentage: 100 }, last), false);
    assert.equal(offered({}, last), true);
  });

  it("refuses anything else", () => {
    for (const raw of ["101", "-1", "10.5", "ten", "1e2", "0x10", "10 %%", "1000"]) {
      assert.throws(() => parseStagingPercentage(raw), /0 to 100|above 100/, raw);
    }
  });
});

describe("setStagingPercentage", () => {
  it("appends the key and keeps every other byte", () => {
    const next = setStagingPercentage(FEED, 10);
    assert.equal(next, `${FEED}stagingPercentage: 10\n`);
  });

  it("replaces an existing top-level key and removes it for null", () => {
    const at10 = setStagingPercentage(FEED, 10);
    assert.equal(setStagingPercentage(at10, 50), `${FEED}stagingPercentage: 50\n`);
    assert.equal(setStagingPercentage(at10, null), FEED);
    const inMiddle = FEED.replace("path:", "stagingPercentage: 5\npath:");
    assert.equal(setStagingPercentage(inMiddle, null), FEED);
  });

  it("adds a line break to a file without a final one, and keeps CRLF", () => {
    assert.equal(setStagingPercentage("version: 1.0.0", 5), "version: 1.0.0\nstagingPercentage: 5\n");
    assert.equal(setStagingPercentage("version: 1.0.0\r\n", 5), "version: 1.0.0\r\nstagingPercentage: 5\r\n");
  });

  it("never touches an indented key of the same name", () => {
    const nested = "version: 1.0.0\nextra:\n  stagingPercentage: 3\n";
    assert.equal(setStagingPercentage(nested, null), nested);
  });
});

describe("rewriteFeed", () => {
  it("returns the new text and both values, and the reader sees the new value", () => {
    const first = rewriteFeed({ name: "latest-mac.yml", text: FEED, percent: 10, parse: yaml.load });
    assert.deepEqual([first.before, first.after], [null, 10]);
    const feed = yaml.load(first.text);
    assert.equal(feed.stagingPercentage, 10);
    assert.deepEqual(feed.files, yaml.load(FEED).files);

    const second = rewriteFeed({ name: "latest-mac.yml", text: first.text, percent: null, parse: yaml.load });
    assert.deepEqual([second.before, second.after], [10, null]);
    assert.equal(second.text, FEED);
  });

  it("refuses a file that does not parse, or is not a feed", () => {
    const bad = (text) => () => rewriteFeed({ name: "latest.yml", text, percent: 10, parse: yaml.load });
    assert.throws(bad("version: [unclosed\n"), /latest\.yml does not parse/);
    assert.throws(bad("- just\n- a list\n"), /not an update feed/);
    assert.throws(bad("version: 1.0.0\nfiles: []\n"), /not an update feed/);
    assert.throws(bad(`${FEED}stagingPercentage: lots\n`), /not a number/);
  });

  it("refuses when the rewrite would change anything else", () => {
    // A parser that also reports the line count stands in for any rewrite
    // that changes more than the one key.
    const parse = (text) => ({ ...yaml.load(text), lines: text.split("\n").length });
    assert.throws(() => rewriteFeed({ name: "latest.yml", text: FEED, percent: 10, parse }), /changed more than/);
  });
});

describe("what the updaters do with the written feed", () => {
  const ids = [0, 0x1a000000, 0x80000000, 0xe6666666, 0xfffffffe].map(idEndingIn);
  const verdicts = async (percent) => {
    const feed = yaml.load(rewriteFeed({ name: "latest.yml", text: FEED, percent, parse: yaml.load }).text);
    const json = JSON.parse(rewriteFeed({ name: "latest.json", text: JSON_FEED, percent }).text);
    const fromYaml = ids.map((id) => offered(feed, id));
    assert.deepEqual(ids.map((id) => offered(json, id)), fromYaml, "latest.json and the YAML feeds must offer the release to the same installs");
    return fromYaml;
  };

  it("offers 0 to nobody, a percentage to the ids below it, and a full rollout to everybody", async () => {
    assert.deepEqual(await verdicts(0), [false, false, false, false, false]);
    assert.deepEqual(await verdicts(10), [true, false, false, false, false]);
    assert.deepEqual(await verdicts(50), [true, true, false, false, false]);
    assert.deepEqual(await verdicts(null), [true, true, true, true, true]);
  });

  it("keeps everybody who was in when the percentage is raised", async () => {
    const at10 = await verdicts(10);
    const at50 = await verdicts(50);
    at10.forEach((inAt10, index) => {
      if (inAt10) assert.equal(at50[index], true);
    });
  });
});

describe("the staging bucket, as electron-updater and the Tauri app compute it", () => {
  it("reads the last four bytes as a big-endian number", () => {
    // The vectors of tyt_model::updater_model's hashes_an_id_to_its_last_four_bytes.
    assert.equal(stagingBucket("00000000-0000-0000-0000-000000000000"), 0);
    assert.equal(Math.round(stagingBucket("6ba7b812-9dad-51d1-80b4-00c04fd430c8") * 0xffffffff), 0x4fd430c8);
    assert.equal(stagingBucket("6ba7b812-9dad-51d1-80b4-0000ffffffff"), 1);
    // UUID.parse looks pairs up in a lower-case table, so "D4" and "C8" are 0.
    assert.equal(Math.round(stagingBucket("6BA7B812-9DAD-51D1-80B4-00C04FD430C8") * 0xffffffff), 0x00003000);
  });

  it("offers a feed without a percentage, or with one that does not parse, to everybody", () => {
    assert.equal(offered({}, idEndingIn(0xfffffffe)), true);
    assert.equal(offered({ stagingPercentage: "soon" }, idEndingIn(0xfffffffe)), true);
    assert.equal(offered({ stagingPercentage: 0 }, idEndingIn(0)), false);
  });
});

// As tauriFeedText writes latest.json for a release.
const JSON_FEED = tauriFeedText({
  version: "0.4.0",
  notes: "Track Your Time 0.4.0.",
  pubDate: "2026-11-12T10:00:00.000Z",
  platforms: {
    "darwin-aarch64-app": { url: "https://github.com/trebeljahr/trackyourtime/releases/download/v0.4.0/TrackYourTime-0.4.0-mac-arm64.app.tar.gz", signature: "c2ln" },
    "darwin-aarch64": { url: "https://github.com/trebeljahr/trackyourtime/releases/download/v0.4.0/TrackYourTime-0.4.0-mac-arm64.app.tar.gz", signature: "c2ln" },
  },
});

describe("latest.json", () => {
  it("adds, changes and removes the percentage as one line, and keeps every other byte", () => {
    const at10 = setStagingPercentageJson(JSON_FEED, 10);
    const added = at10.split("\n").filter((line) => !JSON_FEED.split("\n").includes(line));
    assert.deepEqual(added, ['  "stagingPercentage": 10,']);
    assert.equal(setStagingPercentageJson(at10, null), JSON_FEED);
    assert.equal(setStagingPercentageJson(at10, 50), at10.replace("10,", "50,"));
  });

  it("is rewritten by rewriteFeed by its name, and read back by the updater's rule", () => {
    const result = rewriteFeed({ name: "latest.json", text: JSON_FEED, percent: 25, parse: () => assert.fail("not YAML") });
    assert.deepEqual([result.before, result.after], [null, 25]);
    const feed = JSON.parse(result.text);
    assert.deepEqual(feed.platforms, JSON.parse(JSON_FEED).platforms);
    assert.equal(offered(feed, idEndingIn(0x1a000000)), true);
    assert.equal(offered(feed, idEndingIn(0x80000000)), false);
  });

  it("refuses a feed that is not JSON, not a Tauri feed, or not written the way tauriFeedText writes it", () => {
    const bad = (text) => () => rewriteFeed({ name: "latest.json", text, percent: 10 });
    assert.throws(bad("{"), /does not parse as JSON/);
    assert.throws(bad('{"version":"0.4.0","platforms":{}}'), /not an update feed/);
    assert.throws(bad(`${JSON_FEED.replace('"version"', '"stagingPercentage": "x",\n  "version"')}`), /not a number/);
    // Minified: a rewrite would change every line, so it refuses instead.
    assert.throws(bad(JSON.stringify(JSON.parse(JSON_FEED))), /changed more than/);
  });
});

describe("rollout arguments", () => {
  it("reads a tag and a percentage, and the options", () => {
    assert.deepEqual(parseRolloutArgs(["v1.4.0", "25"]), { tag: "v1.4.0", percent: 25, repo: null, dryRun: false });
    assert.deepEqual(parseRolloutArgs(["--dry-run", "v1.4.0", "0", "--repo", "me/fork"]), {
      tag: "v1.4.0",
      percent: 0,
      repo: "me/fork",
      dryRun: true,
    });
    assert.equal(parseRolloutArgs(["v1.4.0-rc.1", "100"]).percent, null);
  });

  it("refuses a missing or bad tag, a missing or bad percentage, and unknown options", () => {
    assert.throws(() => parseRolloutArgs(["v1.4.0"]), /Usage/);
    assert.throws(() => parseRolloutArgs(["1.4.0", "10"]), /not a release tag/);
    assert.throws(() => parseRolloutArgs(["v1.4.0", ""]), /Give a percentage/);
    assert.throws(() => parseRolloutArgs(["v1.4.0", "-5"]), /0 to 100/);
    assert.throws(() => parseRolloutArgs(["v1.4.0", "150"]), /above 100/);
    assert.throws(() => parseRolloutArgs(["v1.4.0", "10", "--force"]), /Unknown option/);
    assert.throws(() => parseRolloutArgs(["v1.4.0", "10", "--repo"]), /--repo needs/);
  });

  it("picks the feeds out of a release's assets", () => {
    assert.deepEqual(
      feedAssetNames(["TrackYourTime-0.4.0-mac-arm64.zip", "latest.yml", "latest.json", "SHA256SUMS.txt", "latest-mac.yml", "latest-linux-arm64.yml", "updater-mac.json"]),
      ["latest-linux-arm64.yml", "latest-mac.yml", "latest.json", "latest.yml"],
    );
    assert.equal(isReleaseTag("v0.4.0"), true);
    assert.equal(isReleaseTag("v0.4"), false);
  });

  it("describes each state in words", () => {
    assert.match(describeStaging(null), /every install/);
    assert.match(describeStaging(0), /halted/);
    assert.match(describeStaging(10), /10 %/);
  });
});

describe("desktop-release-draft.mjs --staging-percentage", () => {
  const script = join(repoRoot, "scripts/desktop-release-draft.mjs");

  // The draft is built for the checkout's own version, as on a tag run.
  const v = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "draft-staging-"));
    const leg = join(dir, "artifacts", "desktop-mac-signed");
    mkdirSync(leg, { recursive: true });
    const zip = Buffer.from("not really a zip");
    writeFileSync(join(leg, `TrackYourTime-${v}-mac-arm64.zip`), zip);
    writeFileSync(join(leg, `TrackYourTime-${v}-mac-arm64.app.tar.gz`), Buffer.from("not really a tarball"));
    const sha512 = createHash("sha512").update(zip).digest("base64");
    writeFileSync(
      join(leg, "latest-mac.yml"),
      `version: ${v}\nfiles:\n  - url: TrackYourTime-${v}-mac-arm64.zip\n    sha512: ${sha512}\n    size: ${zip.length}\npath: TrackYourTime-${v}-mac-arm64.zip\nsha512: ${sha512}\nreleaseDate: '2026-09-22T10:00:00.000Z'\n`,
    );
    const file = `TrackYourTime-${v}-mac-arm64.app.tar.gz`;
    writeFileSync(
      join(leg, "updater-mac.json"),
      JSON.stringify({ version: v, platforms: { "darwin-aarch64-app": { file, signature: "c2ln" }, "darwin-aarch64": { file, signature: "c2ln" } } }),
    );
    return dir;
  }
  const run = (dir, extra) =>
    spawnSync(process.execPath, [script, "--artifacts", join(dir, "artifacts"), "--out", join(dir, "out"), "--repo", "trebeljahr/trackyourtime", ...extra], {
      encoding: "utf8",
    });

  it("writes the percentage into the attached feed and keeps its checks", () => {
    const dir = fixture();
    try {
      const result = run(dir, ["--staging-percentage", "10"]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /10 % of installs/);
      const original = readFileSync(join(dir, "artifacts/desktop-mac-signed/latest-mac.yml"), "utf8");
      assert.equal(readFileSync(join(dir, "out/latest-mac.yml"), "utf8"), `${original}stagingPercentage: 10\n`);
      const tauri = JSON.parse(readFileSync(join(dir, "out/latest.json"), "utf8"));
      assert.equal(tauri.stagingPercentage, 10);
      assert.equal(tauri.version, v);
      assert.equal(
        tauri.platforms["darwin-aarch64-app"].url,
        `https://github.com/trebeljahr/trackyourtime/releases/download/v${v}/TrackYourTime-${v}-mac-arm64.app.tar.gz`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the feed byte-identical when the value is empty", () => {
    const dir = fixture();
    try {
      const result = run(dir, ["--staging-percentage", ""]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(
        readFileSync(join(dir, "out/latest-mac.yml"), "utf8"),
        readFileSync(join(dir, "artifacts/desktop-mac-signed/latest-mac.yml"), "utf8"),
      );
      assert.equal(JSON.parse(readFileSync(join(dir, "out/latest.json"), "utf8")).stagingPercentage, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a bad value before copying anything", () => {
    const dir = fixture();
    try {
      const result = run(dir, ["--staging-percentage", "150"]);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /::error::Staging percentage 150 is above 100/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("desktop-rollout.mjs --check", () => {
  const script = join(repoRoot, "scripts/desktop-rollout.mjs");

  it("writes the normalised value to GITHUB_OUTPUT, empty for a full rollout", () => {
    const dir = mkdtempSync(join(tmpdir(), "rollout-check-"));
    try {
      const output = join(dir, "out");
      writeFileSync(output, "");
      for (const [raw, expected] of [["10", "10"], ["", ""], ["100", ""], ["0", "0"]]) {
        const stdout = execFileSync(process.execPath, [script, "--check", raw], {
          encoding: "utf8",
          env: { ...process.env, GITHUB_OUTPUT: output },
        });
        assert.match(stdout, /::notice::/);
        assert.equal(readFileSync(output, "utf8").trim().split("\n").pop(), `percentage=${expected}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails on a typo", () => {
    const result = spawnSync(process.execPath, [script, "--check", "1O"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /::error::/);
  });
});

describe("desktop-rollout.mjs against a fake gh", () => {
  const script = join(repoRoot, "scripts/desktop-rollout.mjs");

  // A `gh` on PATH that answers from a folder: release.json for `release
  // view`, the feeds for `release download`, and a log of every call. Upload
  // copies the files back, so a second run sees the first one's result.
  function fakeGh({ feeds, release = {} }) {
    const dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
    const assets = join(dir, "assets");
    mkdirSync(assets);
    for (const [name, text] of Object.entries(feeds)) writeFileSync(join(assets, name), text);
    const names = [...Object.keys(feeds), "TrackYourTime-0.4.0-mac-arm64.zip"];
    writeFileSync(
      join(dir, "release.json"),
      JSON.stringify({
        tagName: "v0.4.0",
        isDraft: false,
        isPrerelease: false,
        url: "https://example.test/r",
        assets: names.map((name) => ({ name })),
        ...release,
      }),
    );
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      `#!${process.execPath}
const fs = require("fs"), path = require("path");
const root = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, "calls.log"), JSON.stringify(args) + "\\n");
const opt = (n) => args[args.indexOf(n) + 1];
if (args[0] === "release" && args[1] === "view") {
  if (args[2] !== "v0.4.0") { process.stderr.write("release not found\\n"); process.exit(1); }
  process.stdout.write(fs.readFileSync(path.join(root, "release.json")));
} else if (args[0] === "release" && args[1] === "download") {
  args.forEach((a, i) => { if (a === "--pattern") fs.copyFileSync(path.join(root, "assets", args[i + 1]), path.join(opt("--dir"), args[i + 1])); });
} else if (args[0] === "release" && args[1] === "upload") {
  args.slice(3).filter((a) => a.endsWith(".yml") || a.endsWith(".json")).forEach((f) => fs.copyFileSync(f, path.join(root, "assets", path.basename(f))));
} else if (args[0] === "api") {
  process.stdout.write("v0.4.0\\n");
} else { process.exit(2); }
`,
      { mode: 0o755 },
    );
    const run = (...argv) =>
      spawnSync(process.execPath, [script, ...argv], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
    const read = (name) => readFileSync(join(assets, name), "utf8");
    const calls = () =>
      readFileSync(join(dir, "calls.log"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    return { dir, run, read, calls };
  }

  it("rewrites every feed, Tauri's and Electron's, and uploads them with --clobber", () => {
    const gh = fakeGh({ feeds: { "latest-mac.yml": FEED, "latest.yml": FEED, "latest.json": JSON_FEED } });
    try {
      const result = gh.run("v0.4.0", "10");
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(gh.read("latest-mac.yml"), `${FEED}stagingPercentage: 10\n`);
      assert.equal(gh.read("latest.yml"), `${FEED}stagingPercentage: 10\n`);
      assert.equal(gh.read("latest.json"), setStagingPercentageJson(JSON_FEED, 10));
      const upload = gh.calls().find((args) => args[1] === "upload");
      assert.ok(upload.includes("--clobber"));

      assert.equal(gh.run("v0.4.0", "0").status, 0);
      assert.equal(gh.read("latest.yml"), `${FEED}stagingPercentage: 0\n`);
      assert.equal(gh.run("v0.4.0", "100").status, 0);
      assert.equal(gh.read("latest.yml"), FEED);
    } finally {
      rmSync(gh.dir, { recursive: true, force: true });
    }
  });

  it("uploads nothing on --dry-run", () => {
    const gh = fakeGh({ feeds: { "latest.yml": FEED } });
    try {
      const result = gh.run("v0.4.0", "25", "--dry-run");
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /absent → 25/);
      assert.equal(gh.read("latest.yml"), FEED);
      assert.equal(
        gh.calls().some((args) => args[1] === "upload"),
        false,
      );
    } finally {
      rmSync(gh.dir, { recursive: true, force: true });
    }
  });

  it("refuses a missing release, and uploads nothing when any feed fails to parse", () => {
    const gh = fakeGh({ feeds: { "latest-mac.yml": FEED, "latest.yml": "version: [broken\n" } });
    try {
      const missing = gh.run("v0.5.0", "10");
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /No release v0\.5\.0/);

      const broken = gh.run("v0.4.0", "10");
      assert.equal(broken.status, 1);
      assert.match(broken.stderr, /latest\.yml does not parse.*Nothing was uploaded/s);
      assert.equal(gh.read("latest-mac.yml"), FEED);
      assert.equal(
        gh.calls().some((args) => args[1] === "upload"),
        false,
      );
    } finally {
      rmSync(gh.dir, { recursive: true, force: true });
    }
  });

  it("says gh is missing rather than reporting no release", () => {
    // An empty dir on PATH alone: nothing named gh resolves, so execFileSync
    // throws ENOENT before any release lookup.
    const bin = mkdtempSync(join(tmpdir(), "no-gh-"));
    try {
      const result = spawnSync(process.execPath, [script, "v0.4.0", "10"], {
        encoding: "utf8",
        env: { ...process.env, PATH: bin },
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /gh is not installed/);
      assert.doesNotMatch(result.stderr, /No release/);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("refuses a release with no feeds", () => {
    const gh = fakeGh({ feeds: {} });
    try {
      const result = gh.run("v0.4.0", "10");
      assert.equal(result.status, 1);
      assert.match(result.stderr, /no update feeds/);
    } finally {
      rmSync(gh.dir, { recursive: true, force: true });
    }
  });
});
