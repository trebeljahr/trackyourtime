#!/usr/bin/env node
/** Native WKWebView smoke checks. Never links the real secure-storage plugin. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { startQAAPI } from "./lib/native-qa-api.mjs";
import { runNativeScenarios } from "./lib/native-qa-scenarios.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(
  process.env.IOS_QA_OUTPUT ?? join(root, "test-results/ios-simulator"),
);
const bundle = "com.ricoslabs.trackyourtime.simulatorqa";
const deviceName = process.env.IOS_QA_DEVICE_NAME ?? "iPhone 17";
const isTablet = deviceName.startsWith("iPad");
const tests = [];
const result = {
  sourceCommit: "",
  credentialStore: "fake UserDefaults; real plugin excluded from linking",
  tests,
};
mkdirSync(output, { recursive: true });
function run(bin, args, options = {}) {
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024,
    timeout: 240000,
    ...options,
  });
  if (r.error || r.status !== 0)
    throw new Error(
      `${bin} ${args.join(" ")}: ${r.error?.message ?? r.stderr ?? r.stdout}`,
    );
  return r.stdout?.trim() ?? "";
}
const sim = (...args) => run("xcrun", ["simctl", ...args]);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const writeResult = () =>
  writeFileSync(
    join(output, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
result.sourceCommit = run("git", ["rev-parse", "HEAD"], { cwd: root });
let device;
let installed = false;
let reusedDevice = false;
let api;
const runStartedAt = new Date().toISOString();
result.startedAt = runStartedAt;
try {
  let app = process.env.IOS_QA_APP;
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
  result.app = resolve(app);
  result.nativeBinarySha256 = createHash("sha256")
    .update(readFileSync(join(app, "App.debug.dylib")))
    .digest("hex");
  // Refuse arbitrary shipping binaries when resuming a build.
  assert.equal(
    run("/usr/libexec/PlistBuddy", [
      "-c",
      "Print CFBundleIdentifier",
      join(app, "Info.plist"),
    ]),
    bundle,
  );
  assert(
    !JSON.parse(
      readFileSync(join(app, "capacitor.config.json")),
    ).packageClassList.includes("SecureStorage"),
  );
  const symbols = run("nm", [join(app, "App.debug.dylib")]);
  assert(
    !/KeychainSwift|OBJC_CLASS_\$_SecureStorage\b/.test(symbols),
    "Real keychain plugin must not be linked",
  );
  const available = JSON.parse(sim("list", "devices", "available", "-j"));
  const [runtime, devices] =
    Object.entries(available.devices).find(([, devices]) =>
      devices.some((d) => d.name === deviceName),
    ) ?? [];
  assert(runtime, `An available ${deviceName} simulator runtime is required`);
  const type = JSON.parse(sim("list", "devicetypes", "-j")).devicetypes.find(
    (type) => type.name === deviceName,
  );
  assert(type, `No simulator device type for ${deviceName}`);
  assert(
    !Object.values(available.devices)
      .flat()
      .some((d) => d.state === "Booted"),
    "Another simulator is already running; stop or use it explicitly before this isolated run",
  );
  if (process.env.IOS_QA_DEVICE) {
    const existing = Object.values(available.devices)
      .flat()
      .find((d) => d.udid === process.env.IOS_QA_DEVICE);
    assert(
      existing?.state === "Shutdown" && existing.name === deviceName,
      "Reuse requires the selected simulator to be stopped",
    );
    device = existing.udid;
    reusedDevice = true;
  } else {
    device = sim(
      "create",
      `Track Your Time QA ${randomUUID().slice(0, 8)}`,
      type.identifier,
      runtime,
    );
  }
  result.device = device;
  result.deviceName = deviceName;
  result.runtime = runtime;
  writeResult();
  console.log(
    reusedDevice
      ? `Booting the selected stopped ${deviceName} simulator...`
      : `Booting one disposable ${deviceName} simulator...`,
  );
  sim("boot", device);
  sim("bootstatus", device, "-b");
  if (reusedDevice) {
    const existingApp = spawnSync(
      "xcrun",
      ["simctl", "get_app_container", device, bundle, "app"],
      { encoding: "utf8" },
    );
    assert(
      existingApp.status !== 0 ||
        !existsSync(join(existingApp.stdout.trim(), "App")),
      "Refusing to replace an existing QA app container",
    );
  }
  sim("install", device, app);
  installed = true;
  const container = sim("get_app_container", device, bundle, "data");
  const documents = join(container, "Documents");
  mkdirSync(documents, { recursive: true });
  async function evaluate(script, timeout = 20000) {
    const id = randomUUID();
    const file = join(documents, "qa-command.json");
    writeFileSync(
      file + ".tmp",
      JSON.stringify({
        id,
        script: `try { ${script} } catch (error) { return {__qaException:String(error),stack:error?.stack}; }`,
      }),
    );
    renameSync(file + ".tmp", file);
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      try {
        const answer = JSON.parse(
          readFileSync(join(documents, "qa-result.json"), "utf8"),
        );
        if (answer.id === id) {
          assert(!answer.error, `${answer.error}: ${script}`);
          assert(!answer.value?.__qaException, JSON.stringify(answer.value));
          return answer.value;
        }
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
          throw error;
      }
      await delay(150);
    }
    throw new Error(`WKWebView command timed out: ${script.slice(0, 100)}`);
  }
  async function waitFor(expression, timeout = 30000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (await evaluate(`return Boolean(${expression});`)) return;
      await delay(300);
    }
    throw new Error(`Condition not reached: ${expression}`);
  }
  async function check(name, fn, continueOnFailure = false) {
    console.log(`Checking ${name}...`);
    try {
      const evidence = await fn();
      tests.push({ name, passed: true, evidence });
    } catch (error) {
      tests.push({
        name,
        passed: false,
        blocked: isTablet && error.message.includes("current windowing mode"),
        error: error.message,
      });
      if (!continueOnFailure) throw error;
    } finally {
      writeResult();
    }
  }
  const screenshot = (name) =>
    sim("io", device, "screenshot", join(output, `${name}.png`));
  const call = (plugin, method, args = {}) =>
    `window.Capacitor.nativePromise(${JSON.stringify(plugin)}, ${JSON.stringify(method)}, ${JSON.stringify(args)})`;
  sim("launch", device, bundle);
  await runNativeScenarios({
    platform: "ios",
    appOrigin: "capacitor://localhost",
    bundle,
    output,
    evaluate,
    waitFor,
    check,
    screenshot,
    call,
    delay,
    relaunch: async () => {
      assert(
        !existsSync(join(documents, "qa-command.json")),
        "QA command must be consumed before relaunch",
      );
      sim("terminate", device, bundle);
      sim("launch", device, bundle);
    },
    backgroundResume: async () => {
      sim("launch", device, "com.apple.Preferences");
      await delay(2000);
      sim("launch", device, bundle);
    },
    appearanceCheck: async () => {
      await check(
        isTablet
          ? "iPad dark appearance and landscape"
          : "dark appearance and iPhone portrait policy",
        async () => {
          sim("ui", device, "appearance", "dark");
          await delay(700);
          screenshot("login-dark");
          const rotation = await evaluate(
            `try { await ${call("ScreenOrientation", "lock", { orientation: "landscape" })}; return {rejected:false}; } catch(error) { return {rejected:true,message:String(error)}; }`,
          );
          // iPhone supports portrait; iPad declares landscape as well.
          if (isTablet) {
            if (rotation.rejected) {
              // Restore the plugin's requested mask even when iPad windowing
              // also rejects the portrait request. Do not change app policy.
              await evaluate(
                `try { await ${call("ScreenOrientation", "lock", { orientation: "portrait" })}; } catch {} return true;`,
              );
            }
            assert(!rotation.rejected, JSON.stringify(rotation));
            await waitFor("innerWidth > innerHeight");
            screenshot("login-landscape");
          } else {
            assert(
              rotation.rejected,
              "iPhone landscape should be rejected by its declared orientation policy",
            );
          }
          await evaluate(
            `await ${call("ScreenOrientation", "lock", { orientation: "portrait" })}; return true;`,
          );
          await waitFor(`innerHeight > innerWidth`);
          const state = await evaluate(
            `return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,errors:window.__qaErrors};`,
          );
          assert(state.scrollWidth <= state.width + 1);
          assert.deepEqual(state.errors, []);
          return { rotation, state };
        },
        isTablet,
      );
    },
    startAPI: async () => {
      api = await startQAAPI(root, output);
      return api;
    },
  });
  result.passed = tests.every((test) => test.passed);
  result.blocked = tests.some((test) => test.blocked);
  if (!result.passed) process.exitCode = 1;
  result.limitations = [
    "Fake credential persistence does not validate OS Keychain.",
    "Offline tests inject transport failures; physical radio changes and soft keyboard behavior remain unverified.",
    "Simulator results do not establish physical-device QA.",
  ];
} catch (error) {
  result.passed = false;
  result.error = error.stack;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  if (api) await api.stop();
  if (device) {
    try {
      if (reusedDevice && installed) sim("uninstall", device, bundle);
      sim("shutdown", device);
      if (!reusedDevice) sim("delete", device);
      result.simulatorCleanedUp = true;
    } catch (error) {
      result.cleanupError = error.message;
      process.exitCode = 1;
    }
  }
  result.finishedAt = new Date().toISOString();
  writeResult();
  console.log(`QA evidence: ${output}/result.json`);
}
