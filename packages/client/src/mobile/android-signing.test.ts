import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Android release signing is three files that have to agree — a gradle block,
 * a workflow that feeds it, and a .gitignore that keeps the key out — and
 * none of the three fails loudly on its own when it stops agreeing with the
 * others. A renamed environment variable, or a `signingConfig` line dropped in
 * a `cap add` re-run, yields a green build and an unsigned bundle; the first
 * symptom is Play rejecting an upload days later.
 *
 * These are structural assertions on committed files rather than a real
 * gradle invocation, which would need an Android SDK this suite cannot assume.
 */

const repoRoot = new URL("../../../../", import.meta.url);
const repoRootPath = fileURLToPath(repoRoot);
const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, repoRoot)), "utf8");

const gradle = read("android/app/build.gradle");
const workflow = read(".github/workflows/mobile-release.yml");

/** The three environment variables; the fourth input is the keystore file. */
const SIGNING_ENV = ["KEYSTORE_PASSWORD", "KEY_ALIAS", "KEY_PASSWORD"] as const;

function isIgnored(path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", path], {
      cwd: repoRootPath,
    });
    return true;
  } catch {
    return false;
  }
}

describe("android/app/build.gradle release signing", () => {
  it("declares a release signing config fed entirely by the environment", () => {
    expect(gradle).toMatch(
      /signingConfigs\s*\{\s*if \(canSignRelease\)\s*\{\s*release\s*\{/,
    );
    for (const name of SIGNING_ENV) {
      expect(gradle).toContain(`System.getenv("${name}")`);
    }
    // The keystore path the workflow decodes to. Relative to the module dir,
    // which is android/app — `file()` resolves against the project, not the
    // gradle invocation's cwd.
    expect(gradle).toContain('file("release.keystore")');
  });

  it("points the release build type at that config", () => {
    // A signingConfigs block nothing references signs nothing at all, and
    // looks entirely correct while doing it.
    expect(gradle).toMatch(
      /if \(canSignRelease\)\s*\{\s*signingConfig signingConfigs\.release\s*\}/,
    );
  });

  it("guards both halves on the same condition", () => {
    // Naming `signingConfigs.release` when the block above declined to create
    // it is a configuration-time "Could not get unknown property", which takes
    // out every gradle task in the project — `assembleDebug` included. The two
    // `if`s must therefore be the same `if`.
    expect(gradle).toMatch(
      /def canSignRelease = releaseKeystoreFile\.exists\(\) &&\s*releaseStorePassword && releaseKeyAlias && releaseKeyPassword/,
    );
    expect(gradle.match(/if \(canSignRelease\)/g)).toHaveLength(2);
  });

  it("keeps a keyless build working instead of failing", () => {
    // A fresh checkout has no keystore and no exported passwords. If that were
    // a hard error, `./gradlew bundleRelease` — and anything that configures
    // the project — would fail for every contributor who is not shipping.
    expect(gradle).not.toMatch(/throw new GradleException/);
    expect(gradle).toContain("will be UNSIGNED");
  });

  it("holds no key material of its own", () => {
    // Every value comes from outside. A literal here would be a private-key
    // password in a public repo, and it would still build.
    expect(gradle).not.toMatch(/(storePassword|keyPassword|keyAlias)\s+["']/);
  });
});

describe("the release workflow", () => {
  it("passes the gradle block exactly the names it reads", () => {
    for (const name of SIGNING_ENV) {
      expect(workflow).toMatch(
        new RegExp(`^\\s+${name}: \\$\\{\\{ secrets\\.`, "m"),
      );
    }
  });

  it("exposes them at job level, where a step's `if` can see them", () => {
    // The step guards read `steps.plan.outputs.build`, and the Plan step reads
    // the secrets' presence from the job env. Job-level env is unambiguously
    // in scope for every step; env declared on one step is invisible to the
    // next, and getting it wrong makes the plan read a set secret as unset and
    // skip the decode silently, leaving the build unsigned with nothing in
    // the log.
    const android = workflow.slice(
      workflow.indexOf("  android:"),
      workflow.indexOf("  ios:"),
    );
    const jobEnv = android.slice(
      android.indexOf("    env:"),
      android.indexOf("    steps:"),
    );
    expect(jobEnv).toContain("ANDROID_KEYSTORE_BASE64:");
    for (const name of SIGNING_ENV) expect(jobEnv).toContain(`${name}:`);
  });

  it("refuses a half-configured signing setup and proves the result is signed", () => {
    // The gradle block deliberately falls back to unsigned. CI is where that
    // must not pass quietly, so the strictness lives here instead: the Plan
    // step refuses a partial secret set (scripts/lib/mobile-release.mjs), and
    // jarsigner proves the bundle a complete set produced is really signed.
    expect(workflow).toContain("run: node scripts/mobile-release-plan.mjs android");
    expect(workflow).toContain("jarsigner -verify");
  });
});

describe("keystores cannot be committed", () => {
  it("ignores the path CI decodes to and any stray keystore", () => {
    // --no-index, so this answers for files that do not exist yet — which is
    // the only state they should ever be in inside this tree.
    expect(isIgnored("android/app/release.keystore")).toBe(true);
    expect(isIgnored("android/app/upload.jks")).toBe(true);
    expect(isIgnored("trackyourtime-upload.keystore")).toBe(true);
  });

  it("has none checked in", () => {
    const tracked = execFileSync("git", ["ls-files"], {
      cwd: repoRootPath,
      encoding: "utf8",
    })
      .split("\n")
      .filter((path) => /\.(keystore|jks|p12)$/.test(path));
    expect(tracked).toEqual([]);
  });
});
