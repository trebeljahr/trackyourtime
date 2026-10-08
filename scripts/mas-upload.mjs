#!/usr/bin/env node
/*
 * Send a signed Mac App Store build to App Store Connect:
 *
 *   gh workflow run desktop-release.yml --ref main     # builds desktop-mas-signed
 *   pnpm desktop:mas-upload --dry-run                  # newest successful run, validate only
 *   pnpm desktop:mas-upload                            # validate, then upload
 *   pnpm desktop:mas-upload --run 36941084893
 *   pnpm desktop:mas-upload --pkg release/mas-universal/Track-Your-Time-0.2.3-universal.pkg
 *
 * A person's command, like `desktop:rollout`: `gh` with the caller's login
 * downloads the artifact, and the App Store Connect API key comes from
 * APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER. Before anything is
 * sent it expands the pkg and checks what App Store Connect would otherwise
 * reject by mail an hour later (scripts/lib/mas-upload.mjs), then runs
 * `altool --validate-app`. The upload ends in App Store Connect → TestFlight
 * (macOS); choosing it for a version and submitting it are App Store Connect
 * steps. The desktop-release workflow never uploads on its own.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ASC_APP_ID,
  DESKTOP_WORKFLOW,
  MAS_ARTIFACT,
  MAS_UPLOAD_USAGE,
  altoolArgs,
  apiKeyFrom,
  masInfoProblems,
  parseMasUploadArgs,
} from "./lib/mas-upload.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

class Refusal extends Error {}
const fail = (message) => {
  throw new Refusal(message);
};

const walk = (dir, match) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return match(path) ? [path] : walk(path, match);
    return match(path) ? [path] : [];
  });

function newestSuccessfulRun(repo) {
  const out = execFileSync(
    "gh",
    ["run", "list", "--repo", repo, "--workflow", DESKTOP_WORKFLOW, "--status", "success", "--limit", "1", "--json", "databaseId,headBranch,displayTitle,createdAt"],
    { encoding: "utf8" },
  );
  const [run] = JSON.parse(out);
  if (!run) fail(`No successful ${DESKTOP_WORKFLOW} run. Start one: gh workflow run ${DESKTOP_WORKFLOW} --ref main`);
  console.log(`  Run ${run.databaseId} (${run.headBranch}, ${run.createdAt}): ${run.displayTitle}`);
  return String(run.databaseId);
}

function main(work) {
  let args;
  try {
    args = parseMasUploadArgs(process.argv.slice(2));
  } catch (err) {
    fail(err.message);
  }
  if (args.help) {
    console.log(MAS_UPLOAD_USAGE);
    return;
  }
  if (process.platform !== "darwin") fail("altool and pkgutil are macOS tools; run this on a Mac.");
  let key;
  try {
    key = apiKeyFrom(process.env);
  } catch (err) {
    fail(err.message);
  }
  if (!existsSync(join(key.keysDir, `AuthKey_${key.keyId}.p8`))) fail(`No key file at ${key.keysDir}/AuthKey_${key.keyId}.p8.`);

  let pkg = args.pkg ? resolve(args.pkg) : null;
  if (!pkg) {
    const repo = args.repo ?? "trebeljahr/trackyourtime";
    const run = args.run ?? newestSuccessfulRun(repo);
    const into = join(work, "artifact");
    console.log(`  Downloading ${MAS_ARTIFACT} from run ${run}…`);
    const download = spawnSync("gh", ["run", "download", run, "--repo", repo, "--name", MAS_ARTIFACT, "--dir", into], { stdio: "inherit" });
    if (download.status !== 0) {
      fail(`Run ${run} has no ${MAS_ARTIFACT} artifact. It exists only when the mas leg signed (MAS_CSC_LINK and friends set) and for 90 days.`);
    }
    const pkgs = walk(into, (p) => p.endsWith(".pkg"));
    if (pkgs.length !== 1) fail(`Expected one pkg in ${MAS_ARTIFACT}, found ${pkgs.length}.`);
    pkg = pkgs[0];
  }
  if (!existsSync(pkg)) fail(`No pkg at ${pkg}.`);
  console.log(`  ${pkg} (${(statSync(pkg).size / 1e6).toFixed(1)} MB)`);

  // The installer signature: App Store Connect takes only a pkg signed with
  // a Mac Installer Distribution ("3rd Party Mac Developer Installer") identity.
  const signature = spawnSync("pkgutil", ["--check-signature", pkg], { encoding: "utf8" });
  if (!/3rd Party Mac Developer Installer|Mac Installer Distribution/.test(signature.stdout)) {
    fail(`The pkg is not signed for the Mac App Store:\n${signature.stdout || signature.stderr}`);
  }

  const expanded = join(work, "expanded");
  const expand = spawnSync("pkgutil", ["--expand-full", pkg, expanded], { encoding: "utf8" });
  if (expand.status !== 0) fail(`pkgutil --expand-full failed:\n${expand.stderr}`);
  const [app] = walk(expanded, (p) => p.endsWith(".app") && existsSync(join(p, "Contents/Info.plist")));
  if (!app) fail("No .app inside the pkg.");
  const info = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", join(app, "Contents/Info.plist")], { encoding: "utf8" }));
  const problems = masInfoProblems(info, { version, hasAssetCatalog: existsSync(join(app, "Contents/Resources/Assets.car")) });
  if (problems.length) fail(`The pkg is not ready for App Store Connect:\n  - ${problems.join("\n  - ")}`);
  console.log(`  ${info.CFBundleIdentifier} ${info.CFBundleShortVersionString} (${info.CFBundleVersion}), icon ${info.CFBundleIconName}`);

  const env = { ...process.env, API_PRIVATE_KEYS_DIR: key.keysDir };
  console.log("  xcrun altool --validate-app…");
  const validate = spawnSync("xcrun", altoolArgs("validate-app", pkg, key), { stdio: "inherit", env });
  if (validate.status !== 0) fail("altool --validate-app refused the pkg (above). Nothing was uploaded.");
  if (args.dryRun) {
    console.log("\n  Valid. --dry-run: nothing uploaded.\n");
    return;
  }
  console.log("  xcrun altool --upload-app…");
  const upload = spawnSync("xcrun", altoolArgs("upload-app", pkg, key), { stdio: "inherit", env });
  if (upload.status !== 0) fail("altool --upload-app failed (above).");
  console.log(
    `\n  Uploaded. Processing takes 10–30 minutes; then the build appears under\n  https://appstoreconnect.apple.com/apps/${ASC_APP_ID}/testflight/macos and can be chosen\n  for the macOS version ${version}.\n`,
  );
}

const work = mkdtempSync(join(tmpdir(), "tyt-mas-upload-"));
try {
  main(work);
} catch (err) {
  if (!(err instanceof Refusal)) throw err;
  console.error(`\n  ${err.message}\n`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
