#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  openSync,
  closeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:net";
import { startQAAPI } from "./lib/native-qa-api.mjs";
import { runNativeScenarios } from "./lib/native-qa-scenarios.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(
  process.env.ANDROID_QA_OUTPUT ?? join(root, "test-results/android-emulator"),
);
const sdk = process.env.ANDROID_HOME ?? join(homedir(), "Library/Android/sdk");
const java =
  process.env.JAVA_HOME ??
  "/Applications/Android Studio.app/Contents/jbr/Contents/Home";
const env = {
  ...process.env,
  ANDROID_HOME: sdk,
  ANDROID_SDK_ROOT: sdk,
  JAVA_HOME: java,
  PATH: `${java}/bin:${process.env.PATH}`,
};
const bundle = "com.ricoslabs.trackyourtime.emulatorqa";
const adbPath = join(sdk, "platform-tools/adb");
const tests = [];
const result = {
  startedAt: new Date().toISOString(),
  credentialStore:
    "fake SharedPreferences; real plugin excluded from Gradle and registration",
  tests,
};
mkdirSync(output, { recursive: true });
const save = () =>
  writeFileSync(
    join(output, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
function run(bin, args, options = {}) {
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024,
    timeout: 240000,
    env,
    ...options,
  });
  if (r.error || r.status !== 0)
    throw new Error(`${bin}: ${r.error?.message ?? r.stderr ?? r.stdout}`);
  return r.stdout?.trim() ?? "";
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let serial, emulator, api;
const adb = (...args) => run(adbPath, ["-s", serial, ...args]);
let installed = false;
result.sourceCommit = run("git", ["rev-parse", "HEAD"], { cwd: root });
try {
  let apk = process.env.ANDROID_QA_APK;
  if (!apk) {
    assert(
      existsSync(
        join(root, "android/app/src/main/assets/capacitor.plugins.json"),
      ),
      "First run NEXT_PUBLIC_API_URL=<origin> pnpm build:mobile android",
    );
    assert(
      existsSync(join(root, "packages/client/out-mobile/login/index.html")),
      "Build the mobile export first",
    );
    const stage = mkdtempSync(join(tmpdir(), "trackyourtime-android-qa-"));
    result.stagingDirectory = stage;
    cpSync(join(root, "android"), join(stage, "android"), {
      recursive: true,
      filter: (path) =>
        !/(?:^|\/)(?:build|\.gradle)(?:\/|$)/.test(path) &&
        !/\.(?:keystore|jks)$/.test(path),
    });
    symlinkSync(join(root, "node_modules"), join(stage, "node_modules"));
    const project = join(stage, "android");
    cpSync(
      join(root, "packages/client/out-mobile"),
      join(project, "app/src/main/assets/public"),
      { recursive: true },
    );
    for (const name of [
      "capacitor.settings.gradle",
      "app/capacitor.build.gradle",
    ]) {
      const file = join(project, name);
      writeFileSync(
        file,
        readFileSync(file, "utf8")
          .split("\n")
          .filter(
            (line) => !line.includes("aparajita-capacitor-secure-storage"),
          )
          .join("\n"),
      );
    }
    const plugins = join(project, "app/src/main/assets/capacitor.plugins.json");
    writeFileSync(
      plugins,
      JSON.stringify(
        JSON.parse(readFileSync(plugins)).filter(
          (p) => !p.pkg.includes("secure-storage"),
        ),
        null,
        2,
      ),
    );
    const configFile = join(
      project,
      "app/src/main/assets/capacitor.config.json",
    );
    const config = JSON.parse(readFileSync(configFile));
    assert(!config.server?.url, "Live reload is not a packaged-app test");
    config.appId = bundle;
    config.loggingBehavior = "none";
    config.android = { ...config.android, allowMixedContent: true }; // Only the loopback QA API uses HTTP.
    writeFileSync(configFile, JSON.stringify(config, null, 2));
    const manifest = join(project, "app/src/main/AndroidManifest.xml");
    writeFileSync(
      manifest,
      readFileSync(manifest, "utf8").replace(
        "<application",
        '<application android:usesCleartextTraffic="true"',
      ),
    );
    const gradle = join(project, "app/build.gradle");
    writeFileSync(
      gradle,
      readFileSync(gradle, "utf8") +
        '\nandroid { buildFeatures { buildConfig true }; buildTypes { debug { applicationIdSuffix ".emulatorqa" } } }\ndependencies { implementation "androidx.webkit:webkit:$androidxWebkitVersion" }\n',
    );
    cpSync(
      join(root, "scripts/fixtures/android-qa-MainActivity.java"),
      join(
        project,
        "app/src/main/java/com/ricoslabs/trackyourtime/MainActivity.java",
      ),
    );
    writeFileSync(join(project, "local.properties"), `sdk.dir=${sdk}\n`);
    console.log("Building isolated Android QA APK (two workers)...");
    const build = spawnSync(
      join(project, "gradlew"),
      [
        "--no-daemon",
        "--max-workers=2",
        "-Dorg.gradle.jvmargs=-Xmx1024m",
        "assembleDebug",
      ],
      {
        cwd: project,
        env,
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
        timeout: 600000,
      },
    );
    writeFileSync(
      join(output, "build.log"),
      `${build.stdout ?? ""}\n${build.stderr ?? ""}`,
    );
    assert.equal(
      build.status,
      0,
      `Android build failed; see ${output}/build.log`,
    );
    apk = join(project, "app/build/outputs/apk/debug/app-debug.apk");
  }
  result.apk = resolve(apk);
  result.apkSha256 = createHash("sha256")
    .update(readFileSync(apk))
    .digest("hex");
  const info = run(join(sdk, "cmdline-tools/latest/bin/apkanalyzer"), [
    "manifest",
    "application-id",
    apk,
  ]);
  assert.equal(info, bundle);
  const dex = spawnSync("unzip", ["-p", apk, "classes*.dex"], {
    maxBuffer: 80 * 1024 * 1024,
  });
  assert.equal(dex.status, 0);
  assert(
    !dex.stdout.includes(
      Buffer.from("Lcom/aparajita/capacitor/securestorage/"),
    ),
    "Real secure-storage classes must be absent",
  );
  assert(
    dex.stdout.includes(Buffer.from("QASecureStorage")),
    "Fake credential store must be linked",
  );
  const connected = run(adbPath, ["devices"])
    .split("\n")
    .slice(1)
    .filter((line) => line.trim());
  assert.equal(
    connected.length,
    0,
    "Another Android device is connected; refusing ambiguous emulator QA",
  );
  let emulatorPort;
  for (let candidate = 5580; candidate < 5680; candidate += 2) {
    const free = async (port) =>
      new Promise((resolve) => {
        const server = createServer();
        server.once("error", () => resolve(false));
        server.listen(port, "127.0.0.1", () =>
          server.close(() => resolve(true)),
        );
      });
    if ((await free(candidate)) && (await free(candidate + 1))) {
      emulatorPort = candidate;
      break;
    }
  }
  assert(emulatorPort, "No free emulator console port");
  serial = `emulator-${emulatorPort}`;
  const fd = openSync(join(output, "emulator.log"), "w");
  emulator = spawn(
    join(sdk, "emulator/emulator"),
    [
      "-avd",
      process.env.ANDROID_QA_AVD ?? "Medium_Phone_API_35",
      "-port",
      String(emulatorPort),
      "-no-window",
      "-no-audio",
      "-no-boot-anim",
      "-no-snapshot",
      "-read-only",
      "-memory",
      "2048",
    ],
    { env, stdio: ["ignore", fd, fd] },
  );
  closeSync(fd);
  emulator.on("error", (error) => {
    emulator.qaError = error;
  });
  result.emulatorPid = emulator.pid;
  result.serial = serial;
  save();
  console.log("Booting one read-only Android emulator...");
  let booted = false;
  for (let n = 0; n < 180; n++) {
    if (emulator.qaError || emulator.exitCode !== null)
      throw emulator.qaError ?? new Error("Emulator exited; see emulator.log");
    try {
      if (adb("shell", "getprop", "sys.boot_completed") === "1") {
        booted = true;
        break;
      }
    } catch {}
    await delay(1000);
  }
  assert(booted, "Android emulator boot timed out");
  result.androidVersion = adb("shell", "getprop", "ro.build.version.release");
  result.androidApiLevel = adb("shell", "getprop", "ro.build.version.sdk");
  result.avd = process.env.ANDROID_QA_AVD ?? "Medium_Phone_API_35";
  assert(
    !adb("shell", "pm", "list", "packages", bundle).includes(bundle),
    "Refusing to replace an existing QA app",
  );
  adb("install", apk);
  installed = true;
  const launch = () =>
    adb(
      "shell",
      "am",
      "start",
      "-W",
      "-n",
      `${bundle}/com.ricoslabs.trackyourtime.MainActivity`,
    );
  launch();
  async function evaluate(script, timeout = 20000) {
    const until = Date.now() + timeout;
    const readOnly = script.startsWith("return Boolean(");
    do {
      const id = randomUUID();
      run(
        adbPath,
        [
          "-s",
          serial,
          "shell",
          `run-as ${bundle} sh -c 'cat > files/qa-command.tmp && mv files/qa-command.tmp files/qa-command.json'`,
        ],
        { input: JSON.stringify({ id, script }) },
      );
      const attemptUntil = Math.min(
        until,
        Date.now() + (readOnly ? 6000 : timeout),
      );
      while (Date.now() < attemptUntil) {
        const reply = spawnSync(
          adbPath,
          [
            "-s",
            serial,
            "exec-out",
            "run-as",
            bundle,
            "cat",
            "files/qa-result.json",
          ],
          { encoding: "utf8", timeout: 5000 },
        );
        if (reply.status === 0) {
          let response;
          try {
            response = JSON.parse(reply.stdout);
          } catch {}
          if (response?.id === id) {
            assert(!response.error, response.error);
            return response.value;
          }
        }
        await delay(150);
      }
    } while (readOnly && Date.now() < until);
    throw new Error(
      `Android WebView command timed out: ${script.slice(0, 100)}`,
    );
  }
  async function waitFor(expression, timeout = 30000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (await evaluate(`return Boolean(${expression});`)) return;
      await delay(300);
    }
    const state = await evaluate(
      "return {url:location.href,text:document.body.innerText,errors:window.__qaErrors};",
    ).catch((error) => ({ error: error.message }));
    throw new Error(
      `Condition not reached: ${expression}; state=${JSON.stringify(state)}`,
    );
  }
  async function check(name, fn) {
    console.log(`Checking ${name}...`);
    try {
      const evidence = await fn();
      tests.push({ name, passed: true, evidence });
    } catch (error) {
      tests.push({ name, passed: false, error: error.message });
      throw error;
    } finally {
      save();
    }
  }
  const screenshot = (name) => {
    const r = spawnSync(
      adbPath,
      ["-s", serial, "exec-out", "screencap", "-p"],
      { maxBuffer: 20 * 1024 * 1024 },
    );
    assert.equal(r.status, 0);
    writeFileSync(join(output, `${name}.png`), r.stdout);
  };
  const call = (plugin, method, args = {}) =>
    `window.Capacitor.nativePromise(${JSON.stringify(plugin)},${JSON.stringify(method)},${JSON.stringify(args)})`;
  await runNativeScenarios({
    platform: "android",
    appOrigin: "https://localhost",
    bundle,
    output,
    evaluate,
    waitFor,
    check,
    screenshot,
    call,
    delay,
    relaunch: async () => {
      const pending = spawnSync(adbPath, [
        "-s",
        serial,
        "shell",
        "run-as",
        bundle,
        "ls",
        "files/qa-command.json",
      ]);
      assert.notEqual(
        pending.status,
        0,
        "QA command must be consumed before relaunch",
      );
      adb("shell", "input", "keyevent", "KEYCODE_HOME");
      await delay(1500);
      adb("shell", "am", "force-stop", bundle);
      launch();
    },
    backgroundResume: async () => {
      adb("shell", "input", "keyevent", "KEYCODE_HOME");
      await delay(2000);
      launch();
    },
    appearanceCheck: async () => {
      await check("Android dark appearance and landscape", async () => {
        adb("shell", "cmd", "uimode", "night", "yes");
        await delay(700);
        screenshot("login-dark");
        await evaluate(
          `await ${call("ScreenOrientation", "lock", { orientation: "landscape" })};return true;`,
        );
        await waitFor("innerWidth > innerHeight");
        const state = await evaluate(
          "return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,errors:window.__qaErrors};",
        );
        assert(state.scrollWidth <= state.width + 1);
        assert.deepEqual(state.errors, []);
        screenshot("login-landscape");
        await evaluate(
          `await ${call("ScreenOrientation", "lock", { orientation: "portrait" })};return true;`,
        );
        await waitFor("innerHeight > innerWidth");
        return state;
      });
      await check(
        "Android software keyboard and focused-field visibility",
        async () => {
          adb(
            "shell",
            "settings",
            "put",
            "secure",
            "show_ime_with_hard_keyboard",
            "1",
          );
          const before = await evaluate("return innerHeight;");
          await evaluate(
            `document.querySelector('input[type=email]').scrollIntoView({block:'center'});return true;`,
          );
          const target = await evaluate(
            `const r=document.querySelector('input[type=email]').getBoundingClientRect();return {x:Math.round((r.left+r.width/2)*devicePixelRatio),y:Math.round((r.top+r.height/2)*devicePixelRatio)};`,
          );
          adb("shell", "input", "tap", String(target.x), String(target.y));
          await waitFor(
            `document.activeElement?.type==='email' && visualViewport.height < ${before}-100`,
          );
          const state = await evaluate(
            `const r=document.activeElement.getBoundingClientRect();return {before:${before},viewportHeight:visualViewport.height,offsetTop:visualViewport.offsetTop,inputTop:r.top,inputBottom:r.bottom};`,
          );
          assert(
            state.inputTop >= state.offsetTop - 1 &&
              state.inputBottom <= state.offsetTop + state.viewportHeight + 1,
            "Focused field obscured by keyboard",
          );
          screenshot("login-keyboard");
          adb("shell", "input", "keyevent", "KEYCODE_BACK");
          await waitFor(`visualViewport.height >= ${before}-10`);
          return state;
        },
      );
    },
    startAPI: async () => {
      api = await startQAAPI(root, output, "https://localhost");
      const port = new URL(api.origin).port;
      adb("reverse", `tcp:${port}`, `tcp:${port}`);
      return api;
    },
  });
  result.passed = true;
  result.limitations = [
    "Fake store does not validate Android Keystore.",
    "Local API requires QA-only loopback HTTP allowance.",
    "Transport errors are injected; physical radio transitions and Play-distributed APKs remain untested.",
  ];
} catch (error) {
  result.passed = false;
  result.error = error.stack;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  if (api) await api.stop();
  if (emulator?.pid) {
    try {
      if (installed) adb("uninstall", bundle);
      adb("emu", "kill");
    } catch {}
    if (emulator.exitCode === null)
      await new Promise((resolve) => {
        const t = setTimeout(() => emulator.kill("SIGKILL"), 10000);
        emulator.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
        emulator.kill("SIGTERM");
      });
    result.emulatorCleanedUp =
      emulator.exitCode !== null || emulator.signalCode !== null;
  }
  result.finishedAt = new Date().toISOString();
  save();
  console.log(`QA evidence: ${output}/result.json`);
}
