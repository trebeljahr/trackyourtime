import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { performance as perf } from "node:perf_hooks";
import { markAuthenticationReady, markLoginSubmitted, resetStartupTiming, trackerDataReady } from "./startup-timing";

beforeEach(() => { vi.stubGlobal("window", { performance: perf }); resetStartupTiming(); });
afterEach(() => { resetStartupTiming(); vi.unstubAllGlobals(); });
const names = (type: "mark" | "measure") => perf.getEntriesByType(type).filter((e) => e.name.startsWith("tyt:")).map((e) => e.name);

describe("local startup milestones", () => {
  it("distinguishes login, authentication and useful empty-or-populated results", () => {
    markLoginSubmitted();
    trackerDataReady("current", true);
    trackerDataReady("entries", true);
    markAuthenticationReady();
    expect(names("mark")).not.toContain("tyt:tracker-useful-data-ready");
    trackerDataReady("projects", true);
    expect(names("mark")).toEqual(["tyt:login-submitted", "tyt:authentication-ready", "tyt:tracker-useful-data-ready"]);
    expect(names("measure")).toContain("tyt:login-to-tracker");
    for (const e of perf.getEntriesByType("measure").filter((e) => e.name.startsWith("tyt:"))) expect(e.duration).toBeGreaterThanOrEqual(0);
  });
  it("handles warm cached queries completing before auth, once per run", () => {
    for (const part of ["current", "entries", "projects"] as const) trackerDataReady(part, true);
    expect(names("mark")).toEqual([]);
    markAuthenticationReady();
    markAuthenticationReady();
    trackerDataReady("projects", true);
    expect(names("mark")).toHaveLength(2);
    expect(names("measure")).toHaveLength(3);
    expect(names("measure")).not.toContain("tyt:login-to-auth");
  });
  it("does not report useful data on error and resets between login attempts", () => {
    markLoginSubmitted();
    markAuthenticationReady();
    trackerDataReady("current", true);
    trackerDataReady("entries", true);
    trackerDataReady("projects", false);
    expect(names("mark")).not.toContain("tyt:tracker-useful-data-ready");
    markLoginSubmitted();
    markAuthenticationReady();
    trackerDataReady("projects", true);
    expect(names("mark")).not.toContain("tyt:tracker-useful-data-ready");
  });
  it("does nothing in SSR or an unsupported webview", () => {
    vi.stubGlobal("window", undefined);
    expect(() => { markLoginSubmitted(); markAuthenticationReady(); trackerDataReady("entries", true); }).not.toThrow();
    vi.stubGlobal("window", { performance: {} });
    expect(() => markLoginSubmitted()).not.toThrow();
  });
});
