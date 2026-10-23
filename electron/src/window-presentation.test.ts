import assert from "node:assert/strict";
import { it } from "node:test";
import { createWindowPresentation } from "./window-presentation.ts";
import type { Rect, WindowState } from "./window-state.ts";

function fixture(saved: WindowState = {}, headless = false) {
  let rect: Rect = { x: 30, y: 40, width: 1100, height: 720 };
  let top = false;
  const patches: WindowState[] = [];
  const control = createWindowPresentation({
    saved,
    headless,
    window: {
      isDestroyed: () => false,
      isVisible: () => false,
      isMaximized: () => false,
      isFullScreen: () => false,
      getNormalBounds: () => rect,
      setBounds: (next) => {
        rect = { ...rect, ...next };
      },
      setMinimumSize: () => undefined,
      setAlwaysOnTop: (next) => {
        top = next;
      },
      unmaximize: () => undefined,
      maximize: () => {
        throw new Error("Must not show/maximize a hidden window");
      },
    },
    workAreas: () => [{ x: 0, y: 0, width: 1920, height: 1080 }],
    leaveFullscreen: async () => undefined,
    save: (patch) => patches.push(patch),
    changed: () => undefined,
  });
  return {
    control,
    patches,
    rect: () => rect,
    resize: (next: Rect) => {
      rect = next;
    },
    top: () => top,
  };
}

it("keeps both normal bounds while switching without showing a window", async () => {
  const f = fixture();
  await f.control.setSignedIn(true);
  const full = f.rect();
  await f.control.setMode("compact");
  assert.equal(f.rect().width, 380);
  const compact = { x: 110, y: 120, width: 400, height: 580 };
  f.resize(compact);
  f.control.remember();
  await f.control.setMode("full");
  assert.deepEqual(f.rect(), full);
  await f.control.setMode("compact");
  assert.deepEqual(f.rect(), compact);
});

it("restores compact preference only after sign-in, and leaves auth screens unpinned", async () => {
  const f = fixture({ mode: "compact", alwaysOnTop: true });
  assert.equal(f.control.snapshot().mode, "full");
  await f.control.setSignedIn(true);
  assert.equal(f.control.snapshot().mode, "compact");
  assert.equal(f.top(), true);
  await f.control.setSignedIn(false);
  assert.equal(f.control.snapshot().mode, "full");
  assert.equal(f.top(), false);
  assert.equal(
    f.patches.at(-1)?.mode,
    "compact",
    "sign-out must preserve the person's preferred mode",
  );
  await f.control.setSignedIn(true);
  assert.equal(f.control.snapshot().mode, "compact");
});

it("pinning is off initially, applies only in compact mode, and can be cleared", async () => {
  const f = fixture();
  await f.control.setSignedIn(true);
  assert.equal(f.top(), false);
  await f.control.setAlwaysOnTop(true);
  assert.equal(f.top(), false);
  await f.control.setMode("compact");
  assert.equal(f.top(), true);
  await f.control.setAlwaysOnTop(false);
  assert.equal(f.top(), false);
});

it("headless records preferences without pinning a real window", async () => {
  const f = fixture({ mode: "compact", alwaysOnTop: true }, true);
  await f.control.setSignedIn(true);
  assert.equal(f.control.snapshot().alwaysOnTop, true);
  assert.equal(f.top(), false);
});

it("does not restore compact coordinates on a disconnected display", async () => {
  const f = fixture({
    mode: "compact",
    compactBounds: { x: 5000, y: 200, width: 390, height: 550 },
  });
  await f.control.setSignedIn(true);
  assert.equal(f.rect().x, 30);
  assert.equal(f.rect().width, 390);
});

it("serializes competing changes and lets sign-out win", async () => {
  const f = fixture();
  await f.control.setSignedIn(true);
  await Promise.all([
    f.control.setMode("compact"),
    f.control.setAlwaysOnTop(true),
    f.control.setSignedIn(false),
  ]);
  assert.equal(f.control.snapshot().mode, "full");
  assert.equal(f.top(), false);
});
