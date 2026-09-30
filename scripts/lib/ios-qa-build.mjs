import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Stages an isolated simulator app; never changes the shipping Xcode project. */
export function buildIOSQAApp(root, output, result, existingApp) {
  const bundle = "com.ricoslabs.trackyourtime.simulatorqa";
  let app = existingApp;
  if (!app) {
    const exported = join(root, "ios/App/App/public/login/index.html");
    assert(
      existsSync(exported),
      "First run NEXT_PUBLIC_API_URL=<origin> pnpm build:mobile ios",
    );
    const stage = mkdtempSync(join(tmpdir(), "trackyourtime-ios-qa-"));
    result.stagingDirectory = stage;
    cpSync(join(root, "ios"), join(stage, "ios"), { recursive: true });
    symlinkSync(join(root, "node_modules"), join(stage, "node_modules"));
    const project = join(stage, "ios/App");
    const swiftPackage = join(project, "CapApp-SPM/Package.swift");
    const packageSource = readFileSync(swiftPackage, "utf8")
      .split("\n")
      .filter((line) => !line.includes("AparajitaCapacitorSecureStorage"))
      .join("\n");
    writeFileSync(swiftPackage, packageSource);
    assert(
      !packageSource.includes("SecureStorage"),
      "Real storage dependency must be absent",
    );
    const configFile = join(project, "App/capacitor.config.json");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    assert(!config.server?.url, "Live reload is not a packaged-app test");
    config.appId = bundle;
    config.loggingBehavior = "none";
    config.packageClassList = config.packageClassList.filter(
      (name) => name !== "SecureStorage",
    );
    writeFileSync(configFile, JSON.stringify(config, null, 2));
    const delegate = join(project, "App/AppDelegate.swift");
    writeFileSync(
      delegate,
      readFileSync(delegate, "utf8") +
        "\n" +
        readFileSync(
          join(root, "scripts/fixtures/ios-simulator-qa.swift"),
          "utf8",
        ),
    );
    const storyboard = join(project, "App/Base.lproj/Main.storyboard");
    writeFileSync(
      storyboard,
      readFileSync(storyboard, "utf8").replace(
        'customClass="CAPBridgeViewController" customModule="Capacitor"',
        'customClass="QABridgeViewController" customModule="App"',
      ),
    );
    console.log("Building isolated simulator app (two compiler jobs)...");
    const build = spawnSync(
      "xcodebuild",
      [
        "-project",
        join(project, "App.xcodeproj"),
        "-scheme",
        "App",
        "-configuration",
        "Debug",
        "-sdk",
        "iphonesimulator",
        "-destination",
        "generic/platform=iOS Simulator",
        "-derivedDataPath",
        join(stage, "derived"),
        "-jobs",
        "2",
        "CODE_SIGN_IDENTITY=-",
        "CODE_SIGNING_ALLOWED=YES",
        "DEVELOPMENT_TEAM=",
        `PRODUCT_BUNDLE_IDENTIFIER=${bundle}`,
        "build",
      ],
      { encoding: "utf8", maxBuffer: 80 * 1024 * 1024 },
    );
    writeFileSync(
      join(output, "build.log"),
      `${build.stdout ?? ""}\n${build.stderr ?? ""}`,
    );
    assert.equal(
      build.status,
      0,
      `Native build failed; see ${output}/build.log`,
    );
    app = join(stage, "derived/Build/Products/Debug-iphonesimulator/App.app");
  }
  return app;
}
