// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

/**
 * Every jsdom test in this package clears `window.localStorage` in a hook, so
 * when the global is missing they all fail at once with
 * `Cannot read properties of undefined (reading 'clear')` and none of them says
 * why. Node 26 is what takes it away: it defines `localStorage` and
 * `sessionStorage` itself, leaves them `undefined` without
 * `--localstorage-file`, and vitest's jsdom environment then skips publishing
 * jsdom's real Storage because the key already exists on the global. The flag
 * that undoes it is in `vitest.config.ts`; this is the test that names the
 * problem if it ever goes away again.
 */
describe("the jsdom test environment", () => {
  it("publishes a working Storage on window, not Node's empty global", () => {
    expect(window.localStorage).toBeDefined();
    expect(window.sessionStorage).toBeDefined();
    expect(globalThis.localStorage).toBe(window.localStorage);
  });

  it("stores, reads back and clears", () => {
    window.localStorage.clear();
    expect(window.localStorage.getItem("probe")).toBeNull();

    window.localStorage.setItem("probe", "value");
    expect(window.localStorage.getItem("probe")).toBe("value");
    expect(window.localStorage.length).toBe(1);

    window.localStorage.clear();
    expect(window.localStorage.getItem("probe")).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });

  it("is jsdom's own Storage, on a document with a real origin", () => {
    // An opaque origin makes jsdom refuse Storage outright, so pin the origin
    // the storage is keyed by as well as the storage itself.
    expect(window.location.origin).toMatch(/^https?:\/\//);
    expect(window.localStorage).toBeInstanceOf(window.Storage);
  });
});
