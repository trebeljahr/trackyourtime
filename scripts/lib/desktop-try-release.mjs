/*
 * Try the desktop app a release actually published: which asset a platform
 * wants, and how to hand it to `scripts/crossplat/vm-drop.mjs`.
 *
 * The CLI is `scripts/desktop-try-release.mjs` (`pnpm desktop:try-release`);
 * everything decidable without `gh` or a filesystem lives here, so it can be
 * tested. Asset names are never written out: they come from
 * `artifactPatterns()` in `desktop-release.mjs`, the same patterns
 * electron-builder packs with, so a rename reaches this command for free.
 */
import { artifactPatterns, expandArtifactName } from "./desktop-release.mjs";
import { isReleaseTag } from "./desktop-rollout.mjs";

/** The `--project` slug of every drop this repo makes (crossplat is shared). */
export const PROJECT_SLUG = "trackyourtime";

/**
 * The platforms with a published artifact a guest can start by itself: the
 * Linux AppImage and the Windows NSIS installer. The deb, rpm and tar.gz on a
 * release are installs and archives, not things `run.sh` can execute, so they
 * are not offered here — `gh release download` fetches one by hand.
 */
export const TRY_PLATFORMS = Object.freeze(["linux-x64", "linux-arm64", "windows-x64", "windows-arm64"]);

/** A UTM VM on Apple Silicon is arm64, and Linux is the VM that exists. */
export const DEFAULT_TRY_PLATFORM = "linux-arm64";

export const TRY_RELEASE_USAGE = `Usage: pnpm desktop:try-release <version> [${TRY_PLATFORMS.join("|")}] [--repo owner/name] [--note "…"] [--start-vm "<UTM VM>"]`;

/**
 * electron-builder names an AppImage with the machine's own architecture
 * string, not its own: x64 is written `x86_64`. Measured against the assets of
 * v0.1.2, and pinned in the test.
 */
const APPIMAGE_ARCH = Object.freeze({ x64: "x86_64", arm64: "arm64" });

/** `0.1.2`, `v0.1.2` and `v1.2.0-rc.1` all mean the tag the workflow built. */
export function normalizeReleaseTag(input) {
  const raw = String(input ?? "").trim();
  const tag = raw.startsWith("v") ? raw : `v${raw}`;
  if (!isReleaseTag(tag)) throw new Error(`"${raw}" is not a release version like 0.1.2 or v0.1.2.`);
  return tag;
}

/**
 * The one asset of that release a guest on that platform can double-click.
 * One NSIS installer carries both Windows architectures, so both ask for the
 * same file.
 */
export function releaseAssetFor({ platform, version }) {
  if (!TRY_PLATFORMS.includes(platform)) throw new Error(`"${platform}" is not one of ${TRY_PLATFORMS.join(", ")}.`);
  // Never the -unsigned patterns: an -unsigned file is never attached to a release.
  const names = artifactPatterns({ unsigned: false });
  const [os, arch] = platform.split("-");
  if (os === "linux") return expandArtifactName(names.linux, { version, arch: APPIMAGE_ARCH[arch], ext: "AppImage" });
  return expandArtifactName(names.nsis, { version, ext: "exe" });
}

/**
 * Why that asset is not on the release, in the words the person needs.
 *
 * Windows is the case worth naming: the desktop workflow builds Windows
 * unsigned while no certificate is configured, and never attaches an
 * `-unsigned` file to the draft release — so a release with every other
 * platform on it has no Windows download at all, and will keep having none
 * until signing lands. Saying so beats "no such asset".
 */
export function missingAssetMessage({ platform, asset, tag, assets = [] }) {
  if (platform.startsWith("windows")) {
    return [
      `${tag} publishes no Windows asset (${asset} is not there), so there is nothing a Windows VM can install.`,
      "Windows signing is not set up: with no certificate (WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD, or Azure Trusted Signing) the",
      "workflow builds Windows as -unsigned, and it never attaches an -unsigned file to a release.",
      "Use `pnpm prod:win` instead — it cross-builds the Windows arm64 app on this Mac and drops it for the same VM.",
      "docs/cross-platform-testing.md, and docs/deploy.md → Desktop release.",
    ].join("\n  ");
  }
  const listed = assets.length ? `\n    ${assets.join("\n    ")}` : " none.";
  return `${tag} has no ${asset}. Its assets are:${listed}`;
}

/**
 * Every desktop release attaches one of these, listing the sha256 of each
 * downloadable artifact. It is the release's own answer to "did this file
 * arrive whole", which a 120 MB AppImage over a hotel connection deserves
 * before a person carries it into a VM.
 */
export const CHECKSUMS_ASSET = "SHA256SUMS.txt";

/**
 * `gh release download` for that one asset and the checksum file, into an
 * empty directory. Two `--pattern`s rather than two calls: one prompt, one
 * failure to report.
 */
export function releaseDownloadArgs({ tag, repo, asset, dir }) {
  return ["release", "download", tag, "--repo", repo, "--pattern", asset, "--pattern", CHECKSUMS_ASSET, "--dir", dir];
}

/**
 * The `<sha256>  <name>` lines of a SHA256SUMS.txt, as a map. Tolerant of
 * blank lines and of the ` *name` binary marker `sha256sum` writes, because a
 * file that cannot be parsed must not be read as "the checksum did not match".
 */
export function parseChecksums(text) {
  const sums = new Map();
  for (const line of String(text).split("\n")) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (match) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

/**
 * A verdict on one downloaded file: `ok`, `mismatch` (the one failure worth
 * refusing over) or `unlisted` — an older release with no checksum for this
 * name, which is not evidence of a bad download.
 */
export function checksumVerdict({ asset, actual, sums }) {
  const expected = sums?.get(asset);
  if (!expected) return { state: "unlisted" };
  if (expected === String(actual).toLowerCase()) return { state: "ok", expected };
  return { state: "mismatch", expected, actual: String(actual).toLowerCase() };
}

/**
 * The project-agnostic dropper's arguments. `--launch` is required even for a
 * single file, where vm-drop launches the file itself and ignores the value;
 * passing the file's own name keeps DROP.json honest either way.
 */
export function vmDropArgs({ platform, source, asset, note, startVm = null }) {
  const args = ["--project", PROJECT_SLUG, "--platform", platform, "--source", source, "--launch", asset, "--note", note];
  // Opt-in only: starting a UTM VM opens its window and takes focus.
  if (startVm) args.push("--start-vm", startVm);
  return args;
}

/** What DROP.json and INDEX.txt should say this build is. */
export function dropNoteFor(tag) {
  return `${tag}, from the GitHub release`;
}

export function parseTryReleaseArgs(argv) {
  const positional = [];
  let repo = null;
  let note = null;
  let startVm = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo" || arg === "--note" || arg === "--start-vm") {
      const value = argv[i + 1];
      i += 1;
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value.`);
      if (arg === "--repo") {
        if (!/^[\w.-]+\/[\w.-]+$/.test(value)) throw new Error("--repo needs <owner>/<name>.");
        repo = value;
      } else if (arg === "--note") note = value;
      else startVm = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option ${arg}. ${TRY_RELEASE_USAGE}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length === 0 || positional.length > 2) throw new Error(TRY_RELEASE_USAGE);
  const tag = normalizeReleaseTag(positional[0]);
  const platform = positional[1] ?? DEFAULT_TRY_PLATFORM;
  if (!TRY_PLATFORMS.includes(platform)) throw new Error(`"${platform}" is not one of ${TRY_PLATFORMS.join(", ")}. ${TRY_RELEASE_USAGE}`);
  return { tag, version: tag.slice(1), platform, repo, note: note ?? dropNoteFor(tag), startVm };
}
