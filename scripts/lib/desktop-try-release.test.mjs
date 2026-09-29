import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHECKSUMS_ASSET,
  DEFAULT_TRY_PLATFORM,
  PROJECT_SLUG,
  TRY_PLATFORMS,
  checksumVerdict,
  dropNoteFor,
  parseChecksums,
  missingAssetMessage,
  normalizeReleaseTag,
  parseTryReleaseArgs,
  releaseAssetFor,
  releaseDownloadArgs,
  vmDropArgs,
} from "./desktop-try-release.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The asset names of the real v0.1.2 draft release, as
 * `gh release view v0.1.2 --json assets` printed them on 2026-09-29. The point
 * of the fixture is that nothing here guesses how electron-builder spells an
 * architecture — if a pattern changes, `releaseAssetFor` must stop matching
 * this list and the test must be updated deliberately.
 */
const V012_ASSETS = Object.freeze([
  "latest-linux-arm64.yml",
  "latest-linux.yml",
  "latest-mac.yml",
  "SHA256SUMS.txt",
  "TrackYourTime-0.1.2-linux-arm64.AppImage",
  "TrackYourTime-0.1.2-linux-arm64.tar.gz",
  "TrackYourTime-0.1.2-linux-x64.tar.gz",
  "TrackYourTime-0.1.2-linux-x86_64.AppImage",
  "TrackYourTime-0.1.2-mac-arm64.dmg",
  "TrackYourTime-0.1.2-mac-arm64.zip",
  "TrackYourTime-0.1.2-mac-x64.dmg",
  "TrackYourTime-0.1.2-mac-x64.zip",
  "trackyourtime-0.1.2.aarch64.rpm",
  "trackyourtime-0.1.2.x86_64.rpm",
  "trackyourtime_0.1.2_amd64.deb",
  "trackyourtime_0.1.2_arm64.deb",
]);

describe("desktop:try-release — the asset a platform asks for", () => {
  it("names a file the real release has, for every Linux platform", () => {
    for (const platform of TRY_PLATFORMS.filter((p) => p.startsWith("linux"))) {
      const asset = releaseAssetFor({ platform, version: "0.1.2" });
      assert.ok(V012_ASSETS.includes(asset), `${platform} wants ${asset}, which v0.1.2 does not have`);
    }
  });

  it("spells the AppImage architectures the way electron-builder does", () => {
    assert.equal(releaseAssetFor({ platform: "linux-x64", version: "0.1.2" }), "TrackYourTime-0.1.2-linux-x86_64.AppImage");
    assert.equal(releaseAssetFor({ platform: "linux-arm64", version: "0.1.2" }), "TrackYourTime-0.1.2-linux-arm64.AppImage");
  });

  it("asks for the one NSIS installer on both Windows architectures", () => {
    const x64 = releaseAssetFor({ platform: "windows-x64", version: "1.2.0-rc.1" });
    assert.equal(x64, "TrackYourTime-Setup-1.2.0-rc.1.exe");
    assert.equal(releaseAssetFor({ platform: "windows-arm64", version: "1.2.0-rc.1" }), x64);
  });

  it("never asks for an -unsigned file, which a release never carries", () => {
    for (const platform of TRY_PLATFORMS) {
      assert.doesNotMatch(releaseAssetFor({ platform, version: "0.1.2" }), /-unsigned/);
    }
  });

  it("refuses a platform it has no artifact for", () => {
    assert.throws(() => releaseAssetFor({ platform: "mac-arm64", version: "0.1.2" }), /not one of/);
  });
});

describe("desktop:try-release — tags", () => {
  it("takes a bare version or a tag", () => {
    assert.equal(normalizeReleaseTag("0.1.2"), "v0.1.2");
    assert.equal(normalizeReleaseTag("v0.1.2"), "v0.1.2");
    assert.equal(normalizeReleaseTag(" v1.2.0-rc.1 "), "v1.2.0-rc.1");
  });

  it("refuses anything that is not a release tag", () => {
    for (const bad of ["", "latest", "0.1", "v0.1.2.3", "main"]) {
      assert.throws(() => normalizeReleaseTag(bad), /release version/, `accepted "${bad}"`);
    }
  });
});

describe("desktop:try-release — arguments", () => {
  it("defaults the platform to the VM that exists", () => {
    const args = parseTryReleaseArgs(["0.1.2"]);
    assert.equal(args.tag, "v0.1.2");
    assert.equal(args.version, "0.1.2");
    assert.equal(args.platform, DEFAULT_TRY_PLATFORM);
    assert.equal(args.repo, null);
    assert.equal(args.startVm, null);
    assert.equal(args.note, "v0.1.2, from the GitHub release");
  });

  it("takes the platform positionally, and the options by name", () => {
    const args = parseTryReleaseArgs(["v0.2.0", "linux-x64", "--repo", "someone/fork", "--note", "mine", "--start-vm", "Ubuntu 24.04"]);
    assert.deepEqual(args, { tag: "v0.2.0", version: "0.2.0", platform: "linux-x64", repo: "someone/fork", note: "mine", startVm: "Ubuntu 24.04" });
  });

  it("refuses an unknown platform, an unknown option, a bad repo and too many words", () => {
    assert.throws(() => parseTryReleaseArgs(["0.1.2", "linux-riscv"]), /not one of/);
    assert.throws(() => parseTryReleaseArgs(["0.1.2", "--dry-run"]), /Unknown option/);
    assert.throws(() => parseTryReleaseArgs(["0.1.2", "--repo", "nope"]), /--repo needs <owner>/);
    assert.throws(() => parseTryReleaseArgs(["0.1.2", "--note"]), /needs a value/);
    assert.throws(() => parseTryReleaseArgs([]), /Usage/);
    assert.throws(() => parseTryReleaseArgs(["0.1.2", "linux-x64", "extra"]), /Usage/);
  });
});

describe("desktop:try-release — the refusals and the hand-off", () => {
  it("explains a missing Windows asset rather than listing files", () => {
    const message = missingAssetMessage({ platform: "windows-arm64", asset: "TrackYourTime-Setup-0.1.2.exe", tag: "v0.1.2", assets: V012_ASSETS });
    assert.match(message, /publishes no Windows asset/);
    assert.match(message, /signing is not set up/);
    assert.match(message, /-unsigned/);
    assert.match(message, /pnpm prod:win/);
    // Its whole point is not to be the generic "here is what is on the release".
    assert.doesNotMatch(message, /\.deb/);
  });

  it("lists what a release does have when a Linux asset is missing", () => {
    const message = missingAssetMessage({ platform: "linux-arm64", asset: "TrackYourTime-9.9.9-linux-arm64.AppImage", tag: "v9.9.9", assets: ["SHA256SUMS.txt"] });
    assert.match(message, /has no TrackYourTime-9\.9\.9-linux-arm64\.AppImage/);
    assert.match(message, /SHA256SUMS\.txt/);
    assert.doesNotMatch(message, /prod:win/);
  });

  it("downloads that one asset and the checksum file, in one call", () => {
    assert.deepEqual(releaseDownloadArgs({ tag: "v0.1.2", repo: "trebeljahr/trackyourtime", asset: "a.AppImage", dir: "/tmp/x" }), [
      "release",
      "download",
      "v0.1.2",
      "--repo",
      "trebeljahr/trackyourtime",
      "--pattern",
      "a.AppImage",
      "--pattern",
      CHECKSUMS_ASSET,
      "--dir",
      "/tmp/x",
    ]);
  });

  it("hands vm-drop this project's slug and starts no VM unless asked", () => {
    const args = vmDropArgs({ platform: "linux-arm64", source: "/tmp/x/a.AppImage", asset: "a.AppImage", note: "v0.1.2, from the GitHub release" });
    assert.deepEqual(args, ["--project", PROJECT_SLUG, "--platform", "linux-arm64", "--source", "/tmp/x/a.AppImage", "--launch", "a.AppImage", "--note", "v0.1.2, from the GitHub release"]);
    assert.ok(!args.includes("--start-vm"));
    assert.deepEqual(vmDropArgs({ platform: "linux-arm64", source: "/s", asset: "a", note: "n", startVm: "Ubuntu" }).slice(-2), ["--start-vm", "Ubuntu"]);
  });

  it("notes where the build came from", () => {
    assert.equal(dropNoteFor("v0.1.2"), "v0.1.2, from the GitHub release");
  });
});

describe("desktop:try-release — the release's own checksums", () => {
  /* The first three lines of v0.1.2's SHA256SUMS.txt, verbatim. */
  const SUMS = `9cfc59c1a1334464c3d88d0353718f2662f37947ad93f8bae02a869f65fa4f42  trackyourtime_0.1.2_amd64.deb
75414e231d2801fcb9c9c9e6625f877e8056f3ba682937a008d518be2c3eb557  TrackYourTime-0.1.2-linux-arm64.AppImage
7ac278d97ea24c3f1cece0e7d0944e3d85c3ee2cd43b573aa7434cdb367439e8  TrackYourTime-0.1.2-linux-x86_64.AppImage
`;

  it("reads the file the release attaches, and the binary marker too", () => {
    const sums = parseChecksums(SUMS);
    assert.equal(sums.size, 3);
    assert.equal(sums.get("TrackYourTime-0.1.2-linux-arm64.AppImage"), "75414e231d2801fcb9c9c9e6625f877e8056f3ba682937a008d518be2c3eb557");
    assert.equal(parseChecksums(`${"0".repeat(64)} *file.exe\n\n`).get("file.exe"), "0".repeat(64));
  });

  it("passes the asset this command would download for v0.1.2", () => {
    const asset = releaseAssetFor({ platform: "linux-arm64", version: "0.1.2" });
    const verdict = checksumVerdict({ asset, actual: "75414E231D2801FCB9C9C9E6625F877E8056F3BA682937A008D518BE2C3EB557", sums: parseChecksums(SUMS) });
    assert.equal(verdict.state, "ok");
  });

  it("refuses a file whose sha256 differs", () => {
    const verdict = checksumVerdict({ asset: "TrackYourTime-0.1.2-linux-arm64.AppImage", actual: "a".repeat(64), sums: parseChecksums(SUMS) });
    assert.equal(verdict.state, "mismatch");
    assert.equal(verdict.expected, "75414e231d2801fcb9c9c9e6625f877e8056f3ba682937a008d518be2c3eb557");
  });

  it("does not call a release with no checksum for the name a bad download", () => {
    assert.equal(checksumVerdict({ asset: "other.AppImage", actual: "a".repeat(64), sums: parseChecksums(SUMS) }).state, "unlisted");
    assert.equal(checksumVerdict({ asset: "other.AppImage", actual: "a".repeat(64), sums: null }).state, "unlisted");
  });
});

describe("desktop:try-release — crossplat stays project-agnostic", () => {
  it("names no project and imports nothing from this repo", () => {
    const dir = join(repoRoot, "scripts/crossplat");
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".mjs"))) {
      const source = readFileSync(join(dir, name), "utf8");
      assert.doesNotMatch(source, /trackyourtime|Track Your Time|TrackYourTime/i, `${name} names the app`);
      assert.doesNotMatch(source, /from "\.\.\//, `${name} imports from outside scripts/crossplat`);
    }
  });
});

describe("desktop:try-release — the drop it writes", () => {
  /** Run the real vm-drop with a fake asset, into a share of our own. */
  function drop(platform, { asset = "TrackYourTime-0.1.2-linux-arm64.AppImage" } = {}) {
    const root = mkdtempSync(join(tmpdir(), "try-release-test-"));
    const source = join(root, "src", asset);
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, "not really an AppImage");
    const share = join(root, "share");
    mkdirSync(share);
    const result = spawnSync(
      "node",
      [join(repoRoot, "scripts/crossplat/vm-drop.mjs"), ...vmDropArgs({ platform, source, asset, note: dropNoteFor("v0.1.2") })],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, CROSSPLAT_SHARE: share, CROSSPLAT_UTM_VM: "" } },
    );
    return { root, share, result, target: join(share, PROJECT_SLUG, platform) };
  }

  it("writes the asset, a run.sh that launches it and a DROP.json naming the release", () => {
    const { root, share, result, target } = drop("linux-arm64");
    try {
      assert.equal(result.status, 0, result.stderr);
      const asset = "TrackYourTime-0.1.2-linux-arm64.AppImage";
      assert.ok(existsSync(join(target, "app", asset)), "the asset is not in the drop");
      const launcher = readFileSync(join(target, "run.sh"), "utf8");
      assert.match(launcher, new RegExp(`chmod \\+x "\\$DST/${asset.replaceAll(".", "\\.")}"`));
      assert.match(launcher, new RegExp(`exec "\\$DST/${asset.replaceAll(".", "\\.")}"`));
      const meta = JSON.parse(readFileSync(join(target, "DROP.json"), "utf8"));
      assert.equal(meta.project, PROJECT_SLUG);
      assert.equal(meta.platform, "linux-arm64");
      assert.equal(meta.launch, asset);
      assert.equal(meta.note, "v0.1.2, from the GitHub release");
      assert.match(readFileSync(join(share, "INDEX.txt"), "utf8"), /trackyourtime\/linux-arm64\/run\.sh/);
      // Nothing was started: no VM name was given.
      assert.doesNotMatch(result.stdout, /Starting UTM VM/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes run.cmd for a Windows drop, once there is an installer to drop", () => {
    const { root, result, target } = drop("windows-x64", { asset: "TrackYourTime-Setup-0.1.2.exe" });
    try {
      assert.equal(result.status, 0, result.stderr);
      assert.match(readFileSync(join(target, "run.cmd"), "utf8"), /start "" "%DST%\\TrackYourTime-Setup-0\.1\.2\.exe"/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
