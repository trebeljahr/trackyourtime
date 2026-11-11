/*
 * Apple code signing and notarization for the desktop build, with every tool
 * call injectable so `desktop-apple.test.mjs` runs on any OS and touches no
 * keychain. The pattern is the one tiao and Raptor Runner use (2026-10-29).
 *
 * Signing never uses a developer's login keychain: the channel's p12
 * (`CSC_LINK`, base64 or a path) is imported into a throwaway keychain with a
 * random password, that keychain is put in front of the search list for the
 * build, and `close()` restores the list and deletes it. The identity is read
 * OUT of that keychain rather than written down, so a build can only be signed
 * by the certificate its secrets carry. (electron-builder's own throwaway
 * keychain once handed the p12's password to `set-key-partition-list -k`, which
 * takes the keychain's; macOS 26 refused every unlock. `-k` here is the
 * keychain's own password, and a test pins that.)
 *
 * Notarization is this repo's own step, not the Tauri CLI's: it submits with
 * `notarytool --wait`, refuses anything but "Accepted" (notarytool exits 0 on
 * "Invalid"), staples, and validates the staple, retrying only the network.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

const defaultRun = (...args) => execFileSync("security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** The identity names `security find-identity` lists, in order. */
export function parseIdentities(text) {
  return [...String(text).matchAll(/^\s*\d+\)\s+[0-9A-F]{40}\s+"([^"]+)"/gm)].map((m) => m[1]);
}

/** Which identity in the p12 signs the app, and which signs a store pkg. */
export function pickIdentities(names, { mas }) {
  const app = names.find((n) => (mas ? /^(Apple Distribution|3rd Party Mac Developer Application): /.test(n) : /^Developer ID Application: /.test(n)));
  const installer = mas ? names.find((n) => /^(3rd Party Mac Developer Installer|Mac Installer Distribution): /.test(n)) : null;
  return { app: app ?? null, installer: installer ?? null };
}

/**
 * @param {Record<string, string | undefined>} env  CSC_LINK and CSC_KEY_PASSWORD
 * @param {{ mas?: boolean, platform?: string, run?: (...args: string[]) => string }} [options]
 * @returns {{ identity: string, installerIdentity: string | null, keychain: string, close: () => void }}
 */
export function appleSigning(env, { mas = false, platform = process.platform, run = defaultRun } = {}) {
  if (platform !== "darwin") throw new Error("Apple signing runs on macOS only.");
  if (!env.CSC_LINK) throw new Error("Apple signing needs CSC_LINK.");
  const root = mkdtempSync(join(tmpdir(), "trackyourtime-signing-"));
  const keychain = join(root, "build.keychain-db");
  const password = randomBytes(24).toString("hex");
  const p12 = join(root, "certificate.p12");
  const original = [...run("list-keychains", "-d", "user").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  let created = false;
  const close = () => {
    try {
      run("list-keychains", "-d", "user", "-s", ...original);
    } finally {
      try {
        if (created) run("delete-keychain", keychain);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  };
  try {
    writeFileSync(p12, existsSync(env.CSC_LINK) ? readFileSync(env.CSC_LINK) : Buffer.from(env.CSC_LINK, "base64"), { mode: 0o600 });
    run("create-keychain", "-p", password, keychain);
    created = true;
    run("set-keychain-settings", "-lut", "21600", keychain);
    run("unlock-keychain", "-p", password, keychain);
    run("import", p12, "-P", env.CSC_KEY_PASSWORD || "", "-T", "/usr/bin/codesign", "-T", "/usr/bin/productbuild", "-f", "pkcs12", "-k", keychain);
    run("list-keychains", "-d", "user", "-s", keychain, ...original);
    run("set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychain);
    const signing = pickIdentities(parseIdentities(run("find-identity", "-v", "-p", "codesigning", keychain)), { mas });
    const installer = mas ? pickIdentities(parseIdentities(run("find-identity", "-v", keychain)), { mas }).installer : null;
    if (!signing.app) throw new Error(mas ? "no Apple Distribution identity" : "no Developer ID Application identity");
    if (mas && !installer) throw new Error("no Mac Installer Distribution identity");
    return { identity: signing.app, installerIdentity: installer, keychain, close };
  } catch (err) {
    close();
    // Never the tool's own message: it can echo the command line, password included.
    const reason = err instanceof Error && /^no /.test(err.message) ? ` (${err.message} in the certificate)` : "";
    throw new Error(`Could not prepare the Apple signing keychain${reason}; check the certificate and its password.`);
  }
}

/**
 * notarytool's credentials from this repo's variable names: APPLE_API_KEY is
 * the PATH of the .p8 (as the workflow decodes it), APPLE_API_KEY_ID its id.
 * A local keychain profile also works, for a person notarizing by hand.
 */
export function notaryCredentials(env) {
  if (env.APPLE_KEYCHAIN_PROFILE) return ["--keychain-profile", env.APPLE_KEYCHAIN_PROFILE];
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) {
    return ["--key", env.APPLE_API_KEY, "--key-id", env.APPLE_API_KEY_ID, "--issuer", env.APPLE_API_ISSUER];
  }
  throw new Error("Signed macOS packages need the App Store Connect API key (APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER).");
}

/**
 * @param {{ env?: Record<string, string | undefined>, run?: (command: string, args: string[]) => string, wait?: (ms: number) => Promise<unknown> }} [options]
 * @returns {(path: string, options?: { app?: boolean }) => Promise<void>}
 */
export function createNotarizer({
  env = process.env,
  run = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
  wait = setTimeout,
} = {}) {
  const staple = async (path) => {
    for (let attempt = 0; ; attempt++) {
      try {
        run("xcrun", ["stapler", "staple", path]);
        run("xcrun", ["stapler", "validate", path]);
        return;
      } catch {
        // The ticket can take a minute to reach Apple's CDN after "Accepted".
        if (attempt === 2) throw new Error(`Could not staple and validate the notarization ticket of ${path}.`);
        await wait(20000);
      }
    }
  };
  const submit = async (path) => {
    const credentials = notaryCredentials(env);
    for (let attempt = 0; ; attempt++) {
      let text;
      try {
        text = run("xcrun", ["notarytool", "submit", path, ...credentials, "--wait", "--timeout", "30m", "--output-format", "json"]);
      } catch {
        if (attempt === 2) throw new Error(`Apple notarization of ${path} failed to reach Apple three times.`);
        await wait(20000);
        continue;
      }
      const result = JSON.parse(text);
      if (result.status !== "Accepted") {
        throw new Error(`Apple notarization rejected ${path} (${result.status}). \`xcrun notarytool log ${result.id}\` says why.`);
      }
      return;
    }
  };
  return async (path, { app = false } = {}) => {
    if (!app) {
      await submit(path);
      await staple(path);
      return;
    }
    // An app is submitted as a zip of itself; the ticket is stapled to the app.
    const root = mkdtempSync(join(tmpdir(), "trackyourtime-notary-"));
    try {
      const zip = join(root, "app.zip");
      run("ditto", ["-c", "-k", "--keepParent", path, zip]);
      await submit(zip);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    await staple(path);
  };
}
