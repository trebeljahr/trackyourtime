#!/usr/bin/env node
/*
 * Try the desktop app a release actually published, in a VM:
 *
 *   pnpm desktop:try-release 0.1.2                 # Linux arm64 AppImage
 *   pnpm desktop:try-release v0.1.2 linux-x64
 *   pnpm desktop:try-release v0.1.2 windows-arm64  # refuses, and says why
 *   pnpm desktop:try-release 0.1.2 linux-arm64 --start-vm "Ubuntu 24.04"
 *
 * `pnpm prod:win` builds an unpacked app on this Mac; this downloads the file
 * a user downloads — a draft release counts, which is where every release of
 * this app sits until a person publishes it — and drops it into the shared
 * folder next to a launcher, through the project-agnostic
 * `scripts/crossplat/vm-drop.mjs`. docs/cross-platform-testing.md.
 *
 * A person's command, like `desktop:rollout`: it uses the `gh` CLI with the
 * caller's own login. No VM is started unless `--start-vm` (or
 * CROSSPLAT_UTM_VM) names one, because that opens UTM's window.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { UPDATE_FEED } from "./lib/desktop-release.mjs";
import {
  CHECKSUMS_ASSET,
  checksumVerdict,
  missingAssetMessage,
  parseChecksums,
  parseTryReleaseArgs,
  releaseAssetFor,
  releaseDownloadArgs,
  vmDropArgs,
} from "./lib/desktop-try-release.mjs";

/** A refusal: printed without a stack, exit 1, after the temp dir is gone. */
class Refusal extends Error {}
const fail = (message) => {
  throw new Refusal(message);
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function main() {
  let args;
  try {
    args = parseTryReleaseArgs(process.argv.slice(2));
  } catch (err) {
    fail(err.message);
  }
  const repo = args.repo ?? `${UPDATE_FEED.owner}/${UPDATE_FEED.repo}`;
  const asset = releaseAssetFor({ platform: args.platform, version: args.version });

  let release;
  try {
    const json = execFileSync("gh", ["release", "view", args.tag, "--repo", repo, "--json", "tagName,isDraft,assets"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    release = JSON.parse(json);
  } catch (err) {
    // ENOENT is execFileSync failing to start `gh` at all, not gh answering
    // "no such release".
    if (err.code === "ENOENT") fail("gh is not installed (https://cli.github.com); desktop:try-release uses your own gh login.");
    const detail = String(err.stderr ?? err.message).trim();
    fail(`No release ${args.tag} in ${repo}${detail ? ` (${detail})` : ""}.`);
  }

  const assets = (release.assets ?? []).map((entry) => entry.name).sort();
  if (!assets.includes(asset)) fail(missingAssetMessage({ platform: args.platform, asset, tag: args.tag, assets }));

  console.log(`\n  ${args.tag}${release.isDraft ? " (draft)" : ""} in ${repo}\n  Downloading ${asset}`);
  const dir = mkdtempSync(join(tmpdir(), "trackyourtime-try-release-"));
  try {
    try {
      execFileSync("gh", releaseDownloadArgs({ tag: args.tag, repo, asset, dir }), { stdio: ["ignore", "inherit", "inherit"] });
    } catch (err) {
      fail(`gh release download failed for ${asset} of ${args.tag}: ${String(err.stderr ?? err.message).trim()}`);
    }
    // gh matches --pattern as a glob, so check what actually landed.
    const downloaded = readdirSync(dir);
    if (!downloaded.includes(asset)) fail(`gh downloaded ${downloaded.join(", ") || "nothing"} rather than ${asset}.`);

    const file = join(dir, asset);
    const sumsPath = join(dir, CHECKSUMS_ASSET);
    const sums = existsSync(sumsPath) ? parseChecksums(readFileSync(sumsPath, "utf8")) : null;
    const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
    const verdict = checksumVerdict({ asset, actual, sums });
    if (verdict.state === "mismatch") {
      fail(`${asset} does not match the sha256 ${CHECKSUMS_ASSET} gives for it.\n    expected ${verdict.expected}\n    got      ${verdict.actual}\n  Nothing was dropped. Run the command again.`);
    }
    if (verdict.state === "ok") console.log(`  sha256 matches ${CHECKSUMS_ASSET}`);
    else console.log(`  ${args.tag} lists no sha256 for ${asset}; the download was not checked`);

    const drop = spawnSync(
      "node",
      [
        join(repoRoot, "scripts/crossplat/vm-drop.mjs"),
        ...vmDropArgs({ platform: args.platform, source: file, asset, note: args.note, startVm: args.startVm }),
      ],
      { cwd: repoRoot, stdio: "inherit" },
    );
    // vm-drop swaps the drop in whole, so a failure before that leaves the old
    // one; one after it (the index, --start-vm) leaves a good drop. Either way
    // its own output is the thing to read, so do not claim which happened.
    if (drop.status !== 0) fail("vm-drop failed; read its output above.");
  } finally {
    // vm-drop has copied the file into the share by now.
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  if (err instanceof Refusal) {
    console.error(`\n  desktop:try-release — ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
