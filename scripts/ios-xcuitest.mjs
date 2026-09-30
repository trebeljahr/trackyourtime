#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIOSQAApp } from "./lib/ios-qa-build.mjs";
import { createUITestProject } from "./lib/ios-ui-project.mjs";
import { startQAAPI } from "./lib/native-qa-api.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(
  process.env.IOS_UI_OUTPUT ??
    join(
      root,
      "test-results/ios-xcuitest",
      new Date().toISOString().replaceAll(":", "-"),
    ),
);
const bundle = "com.ricoslabs.trackyourtime.simulatorqa";
const deviceName = process.env.IOS_UI_DEVICE_NAME ?? "iPad mini (A17 Pro)";
const result = {
  passed: false,
  credentialStore: "fake UserDefaults; real plugin excluded",
  startedAt: new Date().toISOString(),
};
mkdirSync(output, { recursive: true });
const run = (bin, args) => {
  const value = spawnSync(bin, args, {
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 20 * 1024 * 1024,
  });
  assert(value.status === 0, `${bin}: ${value.error?.message ?? value.stderr}`);
  return value.stdout.trim();
};
const sim = (...args) => run("xcrun", ["simctl", ...args]);
let api, device, child;
let interrupted = false;
let forceKill;
const stopTest = () => {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  forceKill ??= setTimeout(() => child.kill("SIGKILL"), 10000);
};
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    interrupted = true;
    stopTest();
  });
try {
  result.sourceCommit = run("git", ["-C", root, "rev-parse", "HEAD"]);
  result.fixtureSha256 = Object.fromEntries(
    [
      "scripts/fixtures/ipad-ui-tests.swift",
      "scripts/fixtures/ios-simulator-qa.swift",
    ].map((path) => [
      path,
      createHash("sha256")
        .update(readFileSync(join(root, path)))
        .digest("hex"),
    ]),
  );
  result.sourceDirty = Boolean(
    run("git", ["-C", root, "status", "--porcelain"]),
  );
  const available = JSON.parse(sim("list", "devices", "available", "-j"));
  assert(
    !Object.values(available.devices)
      .flat()
      .some((d) => d.state === "Booted"),
    "Another simulator is running; refusing to interfere",
  );
  const [runtime] =
    Object.entries(available.devices).find(([, list]) =>
      list.some((d) => d.name === deviceName),
    ) ?? [];
  assert(
    runtime && deviceName.startsWith("iPad"),
    "An installed iPad runtime is required",
  );
  const type = JSON.parse(sim("list", "devicetypes", "-j")).devicetypes.find(
    (d) => d.name === deviceName,
  );
  assert(type, "No matching iPad simulator device type");
  device = sim(
    "create",
    `Track Time UI QA ${randomUUID().slice(0, 8)}`,
    type.identifier,
    runtime,
  );
  result.device = device;
  result.runtime = runtime;
  // Always build the instrumented source; never silently reuse an old binary.
  const app = buildIOSQAApp(root, output, result);
  result.app = app;
  const info = run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print CFBundleIdentifier",
    join(app, "Info.plist"),
  ]);
  assert.equal(info, bundle);
  assert(
    !JSON.parse(
      readFileSync(join(app, "capacitor.config.json")),
    ).packageClassList.includes("SecureStorage"),
  );
  assert(
    !/KeychainSwift|OBJC_CLASS_\$_SecureStorage\b/.test(
      run("nm", [join(app, "App.debug.dylib")]),
    ),
  );
  result.nativeBinarySha256 = createHash("sha256")
    .update(readFileSync(join(app, "App.debug.dylib")))
    .digest("hex");
  assert(!interrupted, "Interrupted");
  console.log(`Booting ${deviceName} (${device})...`);
  sim("boot", device);
  sim("bootstatus", device, "-b");
  console.log("Installing isolated QA app...");
  sim("install", device, app);
  api = await startQAAPI(root, output);
  const stage = mkdtempSync(join(tmpdir(), "tracktime-xcuitest-"));
  result.testProject = createUITestProject(
    stage,
    join(root, "scripts/fixtures/ipad-ui-tests.swift"),
    {
      origin: api.origin,
      email: api.account.email,
      password: api.account.password,
    },
  );
  result.fixtureSha256["scripts/fixtures/ipad-ui-tests.swift"] = createHash(
    "sha256",
  )
    .update(readFileSync(join(stage, "IPadUITests.swift")))
    .digest("hex");
  const resultBundle = join(output, "UIQA.xcresult");
  result.resultBundle = resultBundle;
  const log = openSync(join(output, "xcode-test.log"), "w");
  console.log(
    `Running native iPad UI tests; log: ${join(output, "xcode-test.log")}`,
  );
  const status = await new Promise((resolve, reject) => {
    child = spawn(
      "xcodebuild",
      [
        "test",
        "-project",
        result.testProject,
        "-scheme",
        "IPadUITests",
        "-destination",
        `platform=iOS Simulator,id=${device}`,
        "-derivedDataPath",
        join(stage, "derived"),
        "-resultBundlePath",
        resultBundle,
        "-parallel-testing-enabled",
        "NO",
        "-maximum-concurrent-test-simulator-destinations",
        "1",
        "-jobs",
        "2",
        "CODE_SIGN_IDENTITY=-",
        "DEVELOPMENT_TEAM=",
      ],
      { stdio: ["ignore", log, log] },
    );
    const timer = setTimeout(() => {
      interrupted = true;
      stopTest();
    }, 12 * 60 * 1000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      resolve(code);
    });
  });
  closeSync(log);
  if (existsSync(resultBundle)) {
    result.summary = JSON.parse(
      run("xcrun", [
        "xcresulttool",
        "get",
        "test-results",
        "summary",
        "--path",
        resultBundle,
      ]),
    );
  }
  if (existsSync(resultBundle)) {
    run("xcrun", [
      "xcresulttool",
      "export",
      "attachments",
      "--path",
      resultBundle,
      "--output-path",
      join(output, "attachments"),
    ]);
  }
  result.serverCurrentEntry = await api.trpc("entries.current");
  assert.equal(
    status,
    0,
    "XCUITest failed; inspect xcode-test.log and UIQA.xcresult",
  );
  assert(!interrupted, "Test interrupted or timed out");
  assert.equal(
    result.summary?.passedTests,
    2,
    "Both required UI tests must pass",
  );
  assert.equal(
    result.summary?.skippedTests,
    0,
    "Skipped tests do not establish QA",
  );
  assert.equal(
    result.serverCurrentEntry,
    null,
    "Timer was not stopped on the server",
  );
  const history = await api.trpc("entries.list", {
    from: result.startedAt,
    to: new Date(Date.now() + 60000).toISOString(),
    limit: 20,
  });
  result.completedEntries = history.entries.map(
    ({ description, end, source }) => ({ description, end, source }),
  );
  for (const description of [
    "XCUITest landscape timer",
    "XCUITest resized timer",
  ]) {
    const entries = result.completedEntries.filter(
      (entry) => entry.description === description,
    );
    assert.equal(
      entries.length,
      1,
      `Expected exactly one server entry for ${description}`,
    );
    assert(
      entries[0].end && entries[0].source === "mobile",
      `Expected a stopped mobile entry for ${description}`,
    );
  }
  result.passed = true;
} catch (error) {
  result.error = error.stack;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  if (api) await api.stop();
  if (device) {
    try {
      const state = JSON.parse(sim("list", "devices", "-j"));
      if (
        Object.values(state.devices)
          .flat()
          .find((d) => d.udid === device)?.state === "Booted"
      )
        sim("shutdown", device);
      sim("delete", device);
      result.simulatorCleanedUp = true;
    } catch (error) {
      result.cleanupError = error.message;
      result.passed = false;
      process.exitCode = 1;
    }
  }
  result.finishedAt = new Date().toISOString();
  writeFileSync(
    join(output, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(`UI QA evidence: ${output}`);
}
