import { afterEach, expect, test, vi } from "vitest";
import type { TimeEntry } from "@starter/core";
import { extensionT } from "../i18n";
import { badgeTextFor, renderBadge } from "./badge";

const start = Date.parse("2026-10-01T00:00:00Z");
const entry = { start: new Date(start).toISOString(), end: null, durationSec: 0 } as TimeEntry;
const t = extensionT("en", "background");

afterEach(async () => {
  await renderBadge(null);
  vi.useRealTimers();
});

test.each([
  [0, "0:00"], [59, "0:00"], [60, "0:01"], [3599, "0:59"],
  [3600, "1:00"], [7265, "2:01"], [36000, "10:00"], [360000, "100h"],
])("formats %i seconds without discarding minutes", (seconds, expected) => {
  expect(badgeTextFor(entry, t, start + seconds * 1000)).toBe(expected);
});

test("ticks from wall time, catches up after sleep, and stops cleanly", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(start + 3599000);
  await renderBadge(entry);
  expect(fakeChrome.badge.text).toBe("0:59");
  expect(fakeChrome.badge.title).toContain("0:59:59");
  await vi.advanceTimersByTimeAsync(1000);
  expect(fakeChrome.badge.text).toBe("1:00");
  expect(fakeChrome.badge.title).toContain("1:00:00");
  vi.setSystemTime(start + 7264000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(fakeChrome.badge.text).toBe("2:01");
  expect(fakeChrome.badge.title).toContain("2:01:05");
  await renderBadge(null);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(2000);
  expect(fakeChrome.badge.text).toBe("");
  expect(fakeChrome.badge.title).toBe("Track Your Time");
});

test("repeated paints keep a single ticker and edits replace its start", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(start + 60000);
  await renderBadge(entry);
  await renderBadge(entry);
  expect(vi.getTimerCount()).toBe(1);
  await renderBadge({ ...entry, start: new Date(start + 30000).toISOString() });
  await vi.advanceTimersByTimeAsync(1000);
  expect(fakeChrome.badge.title).toContain("0:00:31");
});
