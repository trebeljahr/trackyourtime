import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_SIZE,
  backgroundColorFor,
  initialBounds,
  parseWindowState,
} from "./window-state.ts";

const primary = { x: 0, y: 25, width: 1512, height: 920 };

describe("parseWindowState", () => {
  it("keeps well-formed fields and drops the rest", () => {
    assert.deepEqual(
      parseWindowState(
        JSON.stringify({ bounds: { x: 10, y: 20, width: 900, height: 600 }, maximized: true, extra: 1 }),
      ),
      { bounds: { x: 10, y: 20, width: 900, height: 600 }, maximized: true },
    );
    assert.deepEqual(parseWindowState(JSON.stringify({ bounds: { x: "1" }, fullscreen: "yes" })), {});
  });

  it("treats a missing or corrupt file as no state", () => {
    assert.deepEqual(parseWindowState(null), {});
    assert.deepEqual(parseWindowState("{not json"), {});
    assert.deepEqual(parseWindowState("null"), {});
  });
});

describe("initialBounds", () => {
  it("uses the default size with nothing saved", () => {
    assert.deepEqual(initialBounds(undefined, [primary]), { ...DEFAULT_SIZE });
  });

  it("restores bounds that are on a display", () => {
    assert.deepEqual(initialBounds({ x: 100, y: 80, width: 1000, height: 700 }, [primary]), {
      x: 100,
      y: 80,
      width: 1000,
      height: 700,
    });
  });

  it("keeps the size but drops the position of a window on a missing display", () => {
    assert.deepEqual(initialBounds({ x: 3000, y: 80, width: 1000, height: 700 }, [primary]), {
      width: 1000,
      height: 700,
    });
  });

  it("raises a too-small size to the minimum", () => {
    assert.deepEqual(initialBounds({ x: 100, y: 80, width: 200, height: 100 }, [primary]), {
      x: 100,
      y: 80,
      width: 800,
      height: 500,
    });
  });
});

describe("backgroundColorFor", () => {
  it("matches globals.css --background", () => {
    assert.equal(backgroundColorFor(false), "#ffffff");
    assert.equal(backgroundColorFor(true), "#0a0a0a");
  });
});
