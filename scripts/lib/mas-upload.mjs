/*
 * The decidable half of `pnpm desktop:mas-upload` (scripts/mas-upload.mjs):
 * arguments, which artifact, which key, what the pkg must say about itself,
 * and the altool command. No process is started here.
 */
import { basename, dirname } from "node:path";

/** The Actions artifact the signed `mas` leg of desktop-release.yml uploads. */
export const MAS_ARTIFACT = "desktop-mas-signed";
export const DESKTOP_WORKFLOW = "desktop-release.yml";
export const APP_ID = "com.ricoslabs.trackyourtime";
/** App Store Connect's id for "Track Your Time: Timer & Bills". */
export const ASC_APP_ID = "6814737131";

const USAGE = `Usage: pnpm desktop:mas-upload [--run <id> | --pkg <file.pkg>] [--repo <owner/name>] [--dry-run]

  --run <id>   desktop-release.yml run to take ${MAS_ARTIFACT} from (default: the
               newest successful run of that workflow)
  --pkg <file> a signed Mac App Store pkg already on disk
  --dry-run    check everything, run altool --validate-app, upload nothing

The App Store Connect API key is read from APPLE_API_KEY (path to
AuthKey_<id>.p8), APPLE_API_KEY_ID and APPLE_API_ISSUER.`;

/**
 * @param {string[]} argv
 * @returns {{ run: string | null, pkg: string | null, repo: string | null, dryRun: boolean, help: boolean }}
 */
export function parseMasUploadArgs(argv) {
  const args = { run: null, pkg: null, repo: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith("--")) throw new Error(`${arg} needs a value.\n\n${USAGE}`);
      return next;
    };
    if (arg === "--run") args.run = value();
    else if (arg === "--pkg") args.pkg = value();
    else if (arg === "--repo") args.repo = value();
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument ${arg}.\n\n${USAGE}`);
  }
  if (args.run && args.pkg) throw new Error(`--run and --pkg name two different builds; pass one.\n\n${USAGE}`);
  if (args.run && !/^\d+$/.test(args.run)) throw new Error(`--run takes a numeric run id, not ${args.run}.`);
  if (args.pkg && !args.pkg.endsWith(".pkg")) throw new Error(`--pkg takes a .pkg file, not ${args.pkg}.`);
  return args;
}

export { USAGE as MAS_UPLOAD_USAGE };

/**
 * The key altool signs its App Store Connect calls with. altool finds the
 * .p8 by id in a fixed set of folders, or in API_PRIVATE_KEYS_DIR, so the
 * file must be named AuthKey_<id>.p8.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ keyId: string, issuer: string, keysDir: string }}
 */
export function apiKeyFrom(env) {
  const path = env.APPLE_API_KEY?.trim();
  const keyId = env.APPLE_API_KEY_ID?.trim();
  const issuer = env.APPLE_API_ISSUER?.trim();
  const missing = [
    !path && "APPLE_API_KEY (path to AuthKey_<id>.p8)",
    !keyId && "APPLE_API_KEY_ID",
    !issuer && "APPLE_API_ISSUER",
  ].filter(Boolean);
  if (missing.length) throw new Error(`Set ${missing.join(", ")}. docs/release-credentials.md names the key.`);
  if (basename(path) !== `AuthKey_${keyId}.p8`) {
    throw new Error(`altool finds the key by file name: ${path} must be named AuthKey_${keyId}.p8.`);
  }
  return { keyId, issuer, keysDir: dirname(path) };
}

/**
 * What the app inside the pkg must say before it goes to App Store Connect.
 * Each failure is a rejection App Store Connect would send by mail an hour
 * after the upload, or a build nobody could select.
 *
 * @param {Record<string, unknown>} info  the app's Info.plist, parsed
 * @param {{ version: string, hasAssetCatalog: boolean }} expected
 * @returns {string[]} problems, empty when the pkg may go
 */
export function masInfoProblems(info, { version, hasAssetCatalog }) {
  const problems = [];
  if (info.CFBundleIdentifier !== APP_ID) {
    problems.push(`CFBundleIdentifier is ${info.CFBundleIdentifier}, not ${APP_ID}.`);
  }
  if (info.CFBundleShortVersionString !== version) {
    problems.push(`CFBundleShortVersionString is ${info.CFBundleShortVersionString}; package.json says ${version}.`);
  }
  if (!/^\d+(\.\d+){0,2}$/.test(String(info.CFBundleVersion ?? ""))) {
    problems.push(`CFBundleVersion ${info.CFBundleVersion} is not a build number App Store Connect accepts.`);
  } else if (info.CFBundleVersion === info.CFBundleShortVersionString) {
    problems.push(
      `CFBundleVersion equals the version (${info.CFBundleVersion}): the pkg was built without DESKTOP_BUILD_NUMBER, so a second upload of ${version} would be refused.`,
    );
  }
  if (info.ITSAppUsesNonExemptEncryption !== false) problems.push("ITSAppUsesNonExemptEncryption is not false.");
  if (!info.ElectronTeamID) problems.push("ElectronTeamID is missing: the sandboxed app could not open its IPC channels.");
  if (!info.CFBundleIconName || !hasAssetCatalog) {
    problems.push("No compiled app icon (CFBundleIconName + Assets.car): App Store Connect would show a placeholder.");
  }
  return problems;
}

/**
 * @param {"validate-app" | "upload-app"} action
 * @param {string} pkg
 * @param {{ keyId: string, issuer: string }} key
 */
export function altoolArgs(action, pkg, key) {
  return ["altool", `--${action}`, "--file", pkg, "--type", "macos", "--apiKey", key.keyId, "--apiIssuer", key.issuer];
}
