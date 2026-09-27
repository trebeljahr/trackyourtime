import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ANDROID_SIGNING_SECRETS,
  buildNumber,
  developmentTeamConfigured,
  IOS_SECRETS,
  isPrereleaseTag,
  parseUserFraction,
  planAndroid,
  planIos,
  PLAY_SECRETS,
  secretSetState,
} from "./mobile-release.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const all = (names, value = "x") => Object.fromEntries(names.map((n) => [n, value]));

const tag = (name = "v0.2.0") => ({ event: "push", refType: "tag", refName: name, version: name.slice(1) });
const dispatch = { event: "workflow_dispatch", refType: "branch", refName: "main", version: "0.2.0" };
const signed = all(ANDROID_SIGNING_SECRETS);
const signedAndPlay = { ...signed, ...all(PLAY_SECRETS) };

describe("secretSetState", () => {
  it("treats empty and blank values as unset", () => {
    assert.equal(secretSetState({ A: "", B: "  " }, ["A", "B"]).state, "absent");
    assert.equal(secretSetState({ A: "1" }, ["A", "B"]).state, "partial");
    assert.equal(secretSetState({ A: "1", B: "2" }, ["A", "B"]).state, "complete");
  });
});

describe("parseUserFraction", () => {
  it("reads empty and 1 as a full rollout", () => {
    assert.deepEqual(parseUserFraction(""), { fraction: null });
    assert.deepEqual(parseUserFraction(undefined), { fraction: null });
    assert.deepEqual(parseUserFraction("1"), { fraction: null });
    assert.deepEqual(parseUserFraction("1.0"), { fraction: null });
  });

  it("reads a fraction below 1", () => {
    assert.deepEqual(parseUserFraction("0.1"), { fraction: 0.1 });
    assert.deepEqual(parseUserFraction(".25"), { fraction: 0.25 });
  });

  it("refuses zero, percentages and junk", () => {
    for (const bad of ["0", "10", "10%", "1.5", "-0.1", "abc"]) {
      assert.ok("error" in parseUserFraction(bad), bad);
    }
  });
});

describe("buildNumber", () => {
  it("grows on a re-run of the same run, and stays below the next run", () => {
    const first = buildNumber({ runNumber: "12", runAttempt: "1" });
    const rerun = buildNumber({ runNumber: "12", runAttempt: "2" });
    const next = buildNumber({ runNumber: "13", runAttempt: "1" });
    assert.deepEqual(first, { buildNumber: 1201 });
    assert.ok(rerun.buildNumber > first.buildNumber);
    assert.ok(next.buildNumber > rerun.buildNumber);
  });

  it("refuses a missing or non-numeric run number or attempt", () => {
    assert.ok("error" in buildNumber({ runNumber: undefined, runAttempt: "1" }));
    assert.ok("error" in buildNumber({ runNumber: "12", runAttempt: "" }));
    assert.ok("error" in buildNumber({ runNumber: "0", runAttempt: "1" }));
    assert.ok("error" in buildNumber({ runNumber: "12", runAttempt: "abc" }));
  });
});

describe("isPrereleaseTag", () => {
  it("knows a prerelease", () => {
    assert.equal(isPrereleaseTag("v0.2.0-rc.1"), true);
    assert.equal(isPrereleaseTag("v0.2.0"), false);
  });
});

describe("planAndroid", () => {
  it("skips a tag with no secrets, green, with no artifact", () => {
    const plan = planAndroid({ ...tag(), env: {} });
    assert.equal(plan.build, "skip");
    assert.equal(plan.upload, false);
    assert.deepEqual(plan.errors, []);
    assert.match(plan.notices.join("\n"), /no artifact/);
  });

  it("builds unsigned on a dispatch with no secrets, and says so", () => {
    const plan = planAndroid({ ...dispatch, env: {} });
    assert.equal(plan.build, "unsigned");
    assert.equal(plan.upload, false);
    assert.match(plan.notices.join("\n"), /UNSIGNED/);
  });

  it("refuses a partial signing set on every event", () => {
    const partial = { ANDROID_KEYSTORE_BASE64: "x" };
    for (const ref of [tag(), dispatch]) {
      const plan = planAndroid({ ...ref, env: partial });
      assert.equal(plan.build, "skip");
      assert.match(plan.errors.join("\n"), /ANDROID_KEY_ALIAS/);
    }
  });

  it("refuses a partial Play set, and Play without signing", () => {
    assert.match(planAndroid({ ...tag(), env: { ...signed, PLAY_SERVICE_ACCOUNT_JSON: "x" } }).errors.join(), /ANDROID_PACKAGE_NAME/);
    assert.match(planAndroid({ ...tag(), env: all(PLAY_SECRETS) }).errors.join(), /unsigned bundle/);
  });

  it("signs without uploading when the Play secrets are absent", () => {
    const plan = planAndroid({ ...tag(), env: signed });
    assert.equal(plan.build, "signed");
    assert.equal(plan.upload, false);
    assert.match(plan.notices.join(), /Play upload skipped/);
  });

  it("uploads a tag to the internal track by default, fully rolled out", () => {
    const plan = planAndroid({ ...tag(), env: signedAndPlay });
    assert.deepEqual(
      { build: plan.build, upload: plan.upload, track: plan.track, status: plan.status, userFraction: plan.userFraction },
      { build: "signed", upload: true, track: "internal", status: "completed", userFraction: "" },
    );
  });

  it("stages a production rollout", () => {
    const plan = planAndroid({ ...dispatch, env: signedAndPlay, track: "production", userFraction: "0.1" });
    assert.equal(plan.track, "production");
    assert.equal(plan.status, "inProgress");
    assert.equal(plan.userFraction, "0.1");
    assert.deepEqual(plan.errors, []);
  });

  it("refuses a staged rollout on the internal track", () => {
    assert.match(planAndroid({ ...dispatch, env: signedAndPlay, userFraction: "0.1" }).errors.join(), /internal track/);
  });

  it("refuses an unknown track", () => {
    assert.match(planAndroid({ ...dispatch, env: signedAndPlay, track: "prod" }).errors.join(), /not one of/);
  });

  it("moves a prerelease tag to internal, and refuses it by hand", () => {
    const onTag = planAndroid({ ...tag("v0.2.0-rc.1"), env: signedAndPlay, track: "production", userFraction: "0.1" });
    assert.deepEqual(onTag.errors, []);
    assert.equal(onTag.track, "internal");
    assert.equal(onTag.status, "completed");
    assert.match(onTag.notices.join(), /prerelease/);

    const byHand = planAndroid({
      event: "workflow_dispatch",
      refType: "tag",
      refName: "v0.2.0-rc.1",
      version: "0.2.0-rc.1",
      env: signedAndPlay,
      track: "beta",
    });
    assert.match(byHand.errors.join(), /internal track only/);
  });

  it("refuses a tag that does not match package.json", () => {
    const plan = planAndroid({ event: "push", refType: "tag", refName: "v0.3.0", version: "0.2.0", env: signedAndPlay });
    assert.equal(plan.build, "skip");
    assert.match(plan.errors.join(), /expected v0.2.0/);
  });

  it("checks the version on a tag even with nothing configured", () => {
    const plan = planAndroid({ event: "push", refType: "tag", refName: "v0.3.0", version: "0.2.0", env: {} });
    assert.match(plan.errors.join(), /expected v0.2.0/);
  });
});

describe("planIos", () => {
  const ready = { developmentTeam: true, exportOptions: true };

  it("skips a tag with no secrets, green, with no artifact", () => {
    const plan = planIos({ ...tag(), env: {}, developmentTeam: false, exportOptions: false });
    assert.equal(plan.build, "skip");
    assert.deepEqual(plan.errors, []);
    assert.match(plan.notices.join(), /no artifact/);
  });

  it("compile-checks a dispatch with no secrets", () => {
    assert.equal(planIos({ ...dispatch, env: {}, developmentTeam: false, exportOptions: false }).build, "check");
  });

  it("refuses a partial set", () => {
    assert.match(planIos({ ...tag(), env: { APPLE_API_KEY_ID: "x" }, ...ready }).errors.join(), /APPLE_CERTIFICATE_BASE64/);
  });

  it("refuses complete secrets without a team or export options", () => {
    const env = all(IOS_SECRETS);
    assert.match(planIos({ ...tag(), env, developmentTeam: false, exportOptions: true }).errors.join(), /DEVELOPMENT_TEAM/);
    assert.match(planIos({ ...tag(), env, developmentTeam: true, exportOptions: false }).errors.join(), /ExportOptions/);
  });

  it("signs and uploads a stable tag to TestFlight", () => {
    const plan = planIos({ ...tag(), env: all(IOS_SECRETS), ...ready });
    assert.equal(plan.build, "signed");
    assert.equal(plan.upload, true);
    assert.deepEqual(plan.errors, []);
  });

  it("skips a prerelease tag with a notice, secrets or not, pushed or dispatched", () => {
    // Apple refuses a CFBundleShortVersionString of 0.2.0-rc.1, and the tag
    // pins package.json (and so MARKETING_VERSION) to exactly that.
    const byHand = { event: "workflow_dispatch", refType: "tag", refName: "v0.2.0-rc.1", version: "0.2.0-rc.1" };
    for (const ref of [tag("v0.2.0-rc.1"), byHand]) {
      for (const env of [all(IOS_SECRETS), {}]) {
        const plan = planIos({ ...ref, env, ...ready });
        assert.equal(plan.build, "skip");
        assert.equal(plan.upload, false);
        assert.deepEqual(plan.errors, []);
        assert.match(plan.notices.join(), /prerelease marketing version/);
      }
    }
  });

  it("still refuses a partial set on a prerelease tag", () => {
    const plan = planIos({ ...tag("v0.2.0-rc.1"), env: { APPLE_API_KEY_ID: "x" }, ...ready });
    assert.match(plan.errors.join(), /APPLE_CERTIFICATE_BASE64/);
  });
});

describe("developmentTeamConfigured", () => {
  it("wants a team on every configuration that signs", () => {
    const two = "CODE_SIGN_STYLE = Automatic;\nCODE_SIGN_STYLE = Automatic;\n";
    assert.equal(developmentTeamConfigured(two), false);
    assert.equal(developmentTeamConfigured(`${two}DEVELOPMENT_TEAM = ABCDE12345;\n`), false);
    assert.equal(developmentTeamConfigured(`${two}DEVELOPMENT_TEAM = ABCDE12345;\nDEVELOPMENT_TEAM = ABCDE12345;\n`), true);
    assert.equal(developmentTeamConfigured(`${two}DEVELOPMENT_TEAM = "";\nDEVELOPMENT_TEAM = "";\n`), false);
  });

  it("accepts the committed project, which names the team on both configurations", () => {
    const pbxproj = readFileSync(resolve(repoRoot, "ios/App/App.xcodeproj/project.pbxproj"), "utf8");
    assert.equal(developmentTeamConfigured(pbxproj), true);
    assert.ok(existsSync(resolve(repoRoot, "ios/App/ExportOptions.plist.template")));
  });
});

describe("ios/App/ExportOptions.plist.template", () => {
  const template = readFileSync(resolve(repoRoot, "ios/App/ExportOptions.plist.template"), "utf8");

  it("exports to the App Store with MANUAL signing and the distribution identity", () => {
    // Automatic here would ask App Store Connect for a profile, which is the
    // path that failed the v0.1.0 tag. See the header of mobile-release.yml.
    assert.match(template, /<key>method<\/key>\s*\n\s*<string>app-store-connect<\/string>/);
    assert.match(template, /<key>signingStyle<\/key>\s*\n\s*<string>manual<\/string>/);
    assert.match(template, /<key>signingCertificate<\/key>\s*\n\s*<string>Apple Distribution<\/string>/);
  });

  it("maps the real bundle id to the placeholder the workflow substitutes", () => {
    // A renamed key, or a placeholder spelled differently here and in the
    // workflow, exports an unsigned-then-refused IPA rather than failing.
    assert.match(
      template,
      /<key>com\.ricoslabs\.trackyourtime<\/key>\s*\n\s*<string>__APPLE_PROVISIONING_PROFILE_NAME__<\/string>/,
    );
  });

  it("is not a usable plist, so nothing can export with it by accident", () => {
    assert.ok(!existsSync(resolve(repoRoot, "ios/App/ExportOptions.plist")));
    assert.match(template, /__APPLE_PROVISIONING_PROFILE_NAME__/);
  });
});

describe("mobile-release.yml", () => {
  const workflow = readFileSync(resolve(repoRoot, ".github/workflows/mobile-release.yml"), "utf8");

  it("runs on v* tags", () => {
    assert.match(workflow, /push:\s*\n\s*tags:\s*\n\s*- "v\*"/);
  });

  it("uploads artifacts only from a build the plan allowed", () => {
    // One block per step; an upload-artifact step with no plan guard is how a
    // tag run with no secrets would attach something that looks like a release.
    const steps = workflow.split(/\n\s{6}- /).filter((step) => step.includes("actions/upload-artifact@"));
    assert.equal(steps.length, 2);
    for (const step of steps) {
      assert.match(step, /if: steps\.plan\.outputs\.build == '(signed|unsigned)'/);
      assert.doesNotMatch(step, /build != 'skip'/);
    }
  });

  it("takes both store build numbers from the plan, never the bare run number", () => {
    // github.run_number does not grow on "Re-run all jobs", so a re-run after
    // a successful upload would hand the store a number it already holds.
    assert.match(workflow, /ANDROID_VERSION_CODE: \$\{\{ steps\.plan\.outputs\.build_number \}\}/);
    assert.match(workflow, /CURRENT_PROJECT_VERSION=\$\{\{ steps\.plan\.outputs\.build_number \}\}/);
    // The expression, not a mention: the header comment explains the rule.
    assert.doesNotMatch(workflow, /\$\{\{[^}]*github\.run_number/);
  });

  it("archives and exports with MANUAL signing, and asks Apple for nothing", () => {
    // The whole point of the change. `xcodebuild archive` with automatic signing
    // resolves an *iOS App Development* profile; -allowProvisioningUpdates then
    // asks Apple to create one, and Apple refuses a team with no registered
    // devices — which is how the v0.1.0 tag failed with a valid distribution
    // certificate in the keychain. Measured table in the workflow header.
    const archive = workflow.split(/\n\s{6}- name: /).find((step) => step.startsWith("Archive\n"));
    assert.ok(archive, "no Archive step");
    assert.match(archive, /CODE_SIGN_STYLE=Manual/);
    assert.match(archive, /PROVISIONING_PROFILE_SPECIFIER="\$APPLE_PROVISIONING_PROFILE_NAME"/);
    assert.match(archive, /CODE_SIGN_IDENTITY="Apple Distribution"/);

    // Neither step may reach App Store Connect: with manual signing there is
    // nothing to fetch, and the flag is precisely the regression.
    const exportStep = workflow.split(/\n\s{6}- name: /).find((step) => step.startsWith("Export IPA\n"));
    assert.ok(exportStep, "no Export IPA step");
    for (const step of [archive, exportStep]) {
      assert.doesNotMatch(step, /-allowProvisioningUpdates/);
      assert.doesNotMatch(step, /-authenticationKey/);
    }

    // The API key survives for the TestFlight upload alone.
    const upload = workflow.split(/\n\s{6}- name: /).find((step) => step.startsWith("Upload to TestFlight\n"));
    assert.match(upload ?? "", /--apiKey "\$APPLE_API_KEY_ID"/);
  });

  it("exports with the RENDERED plist, never the committed template", () => {
    // Exporting with the template would name a profile called
    // __APPLE_PROVISIONING_PROFILE_NAME__ and fail at the last step.
    assert.match(workflow, /-exportOptionsPlist "\$RUNNER_TEMP\/ExportOptions\.plist"/);
    assert.doesNotMatch(workflow, /-exportOptionsPlist ExportOptions\.plist/);
    assert.match(workflow, /cp ios\/App\/ExportOptions\.plist\.template "\$RENDERED"/);
    // PlistBuddy, never sed: `&` in a sed replacement means the matched text,
    // and a profile name is a string somebody typed.
    assert.match(workflow, /PlistBuddy -c \\\n\s*"Set :provisioningProfiles:com\.ricoslabs\.trackyourtime /);
    assert.doesNotMatch(workflow, /sed .*__APPLE_PROVISIONING_PROFILE_NAME__/);
  });

  it("refuses a profile that is not this app's App Store profile before building", () => {
    // A Development or Ad Hoc profile signs a build and is then refused by App
    // Store Connect, twenty minutes later. Devices are the tell: an App Store
    // profile has none.
    const check = workflow.split(/\n\s{6}- name: /).find((step) => step.startsWith("Check the provisioning profile\n"));
    assert.ok(check, "no profile check step");
    assert.match(check, /ProvisionedDevices/);
    assert.match(check, /4BHY8H2J25\.com\.ricoslabs\.trackyourtime/);
    assert.match(check, /\$APPLE_PROVISIONING_PROFILE_NAME/);
  });

  it("names the same team and bundle id as the Xcode project", () => {
    // The archive passes DEVELOPMENT_TEAM explicitly, because manual signing
    // matches a profile on team AND name, and the profile check hard-codes the
    // app id. Both are permanent contracts (CLAUDE.md), but a copy that can
    // drift from the project is still a copy — so pin them together.
    const pbxproj = readFileSync(resolve(repoRoot, "ios/App/App.xcodeproj/project.pbxproj"), "utf8");
    const teams = new Set([...pbxproj.matchAll(/DEVELOPMENT_TEAM = ([^;]+);/g)].map((m) => m[1].trim()));
    assert.equal(teams.size, 1, "the project names more than one team");
    const [team] = teams;
    const bundleIds = new Set(
      [...pbxproj.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((m) => m[1].trim()),
    );
    assert.equal(bundleIds.size, 1, "the project names more than one bundle id");
    const [bundleId] = bundleIds;
    assert.match(workflow, new RegExp(`DEVELOPMENT_TEAM=${team}\\b`));
    assert.match(workflow, new RegExp(`${team}\\.${bundleId.replace(/\./g, "\\.")}`));
  });

  it("reads every secret the plan checks", () => {
    for (const name of [...ANDROID_SIGNING_SECRETS, ...PLAY_SECRETS, ...IOS_SECRETS]) {
      assert.match(workflow, new RegExp(`\\$\\{\\{ secrets\\.${name} \\}\\}`), name);
    }
  });
});
