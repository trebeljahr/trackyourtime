import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { spawnSync } from "node:child_process";
import ts from "typescript";

// Run both shipped Node adapters against one isolated home. No personal files,
// actual tray, credentials, network or running Raycast instance is touched.
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
      const candidate = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
      try { readFileSync(candidate); return { url: candidate.href, shortCircuit: true }; } catch {}
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith(".ts")) return {
      format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    };
    return next(url, context);
  },
});
after(() => hook.deregister());
const { publishMenuPresence, desktopHasYielded } = await import("../src/lib/menu-ownership.ts");
const { hasRaycastMenu, publishDesktopMenu, watchRaycastMenu } = await import("../../../electron/src/raycast-menu.ts");
const { RAYCAST_MENU_LEASE_PARTS, DESKTOP_MENU_LEASE_PARTS } = await import("../src/vendor/index.ts");

const home = mkdtempSync(path.join(tmpdir(), "timer-menu-test-"));
after(() => rmSync(home, { recursive: true, force: true }));

test("Raycast claims first and waits until desktop has removed its item", async () => {
  publishDesktopMenu(true, home);
  assert.equal(desktopHasYielded(home), false);
  assert.equal(publishMenuPresence(true, home, process.pid), true);
  assert.equal(hasRaycastMenu("darwin", home), true);
  assert.equal(hasRaycastMenu("win32", home), false);
  assert.equal(hasRaycastMenu("linux", home), false);
  assert.equal(desktopHasYielded(home), false, "claim alone cannot show the second item");
  const changes = [];
  const stop = watchRaycastMenu("darwin", (visible) => {
    if (visible) assert.equal(desktopHasYielded(home), false, "desktop hides its item before acknowledging");
    changes.push(visible);
  }, home);
  try {
    assert.deepEqual(changes, [true]);
    assert.equal(desktopHasYielded(home), true);
    // A command unloading is not proof the native item disappeared.
    assert.equal(hasRaycastMenu("darwin", home), true);
    publishMenuPresence(false, home, process.pid);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(changes, [true, false], "desktop returns when Raycast hides its item");
  } finally { stop(); }
});

test("dead hosts and malformed files cannot keep desktop hidden", () => {
  const child = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(child.status, 0);
  publishMenuPresence(true, home, child.pid);
  assert.equal(hasRaycastMenu("darwin", home), false);
  const file = path.join(home, ...RAYCAST_MENU_LEASE_PARTS);
  for (const value of ["broken", "null", '{"version":1,"visible":true,"ownerPid":-1}']) {
    writeFileSync(file, value);
    assert.equal(hasRaycastMenu("darwin", home), false);
  }
  writeFileSync(path.join(home, ...DESKTOP_MENU_LEASE_PARTS), JSON.stringify({ version: 1, visible: true, ownerPid: child.pid }));
  assert.equal(desktopHasYielded(home), true, "an exited desktop cannot block Raycast");
  rmSync(file);
  assert.equal(hasRaycastMenu("darwin", home), false);
});

test("read-only ownership storage fails without showing another item", () => {
  const blocked = path.join(home, "file-instead-of-home");
  writeFileSync(blocked, "");
  assert.equal(publishMenuPresence(true, blocked, process.pid), false);
});


test("missing desktop allows Raycast, but unreadable status never assumes a handoff", () => {
  const file = path.join(home, ...DESKTOP_MENU_LEASE_PARTS);
  for (const value of ["broken", "null", '{"version":9,"visible":false,"ownerPid":1}']) {
    writeFileSync(file, value);
    assert.equal(desktopHasYielded(home), false);
  }
  rmSync(file);
  assert.equal(desktopHasYielded(home), true);
});
