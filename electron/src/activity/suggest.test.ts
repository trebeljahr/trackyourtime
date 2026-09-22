import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { StoredSegment } from "./model.ts";
import {
  ACCEPTED_HOLD_MS,
  checkAccept,
  composeSuggestions,
  liveAccepted,
  namesOf,
  recentApps,
  withOpenSegment,
} from "./suggest.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 22, 9, 0, 0);

const seg = (key: string, start: number, end: number, extra: Partial<StoredSegment> = {}): StoredSegment => ({
  scope: "u1:w1",
  source: "desktop",
  start,
  end,
  key,
  name: key.toUpperCase(),
  afk: false,
  ...extra,
});

const compose = (segments: StoredSegment[], holes: { start: number; end: number }[] = []) =>
  composeSuggestions({
    segments,
    names: namesOf(segments),
    from: T0 - 60 * MIN,
    to: T0 + 240 * MIN,
    holes,
    rules: [{ id: "r1", pattern: "com.example.*", description: "Editing" }],
  });

describe("withOpenSegment", () => {
  it("counts the open segment up to now, or to lastSeen when stale, for its scope only", () => {
    const open = { scope: "u1:w1", key: "a", name: "A", start: T0, lastSeen: T0 + MIN };
    assert.equal(withOpenSegment([], open, "u1:w1", T0 + 2 * MIN)[0]?.end, T0 + 2 * MIN);
    assert.equal(withOpenSegment([], open, "u1:w1", T0 + 30 * MIN)[0]?.end, T0 + MIN);
    assert.deepEqual(withOpenSegment([], open, "u2:w1", T0 + 2 * MIN), []);
  });
});

describe("composeSuggestions", () => {
  it("names apps, applies rules and clips to the range", () => {
    const [suggestion, ...rest] = compose([
      seg("com.example.editor", T0, T0 + 25 * MIN),
      seg("chat", T0 + 25 * MIN, T0 + 27 * MIN),
    ]);
    assert.equal(rest.length, 0);
    assert.equal(suggestion?.start, T0);
    assert.equal(suggestion?.end, T0 + 27 * MIN);
    assert.deepEqual(
      suggestion?.topApps.map((app) => [app.name, app.seconds]),
      [
        ["COM.EXAMPLE.EDITOR", 1500],
        ["CHAT", 120],
      ],
    );
    assert.equal(suggestion?.ruleId, "r1");
    assert.deepEqual(suggestion?.proposed, { description: "Editing" });
    assert.deepEqual(suggestion?.titles, []);
  });

  it("subtracts tracked time, dismissals and accepted spans alike", () => {
    const segments = [seg("a", T0, T0 + 60 * MIN)];
    const holes = [
      { start: T0, end: T0 + 20 * MIN },
      { start: T0 + 40 * MIN, end: T0 + 60 * MIN },
    ];
    const suggestions = compose(segments, holes);
    assert.deepEqual(
      suggestions.map((s) => [s.start, s.end]),
      [[T0 + 20 * MIN, T0 + 40 * MIN]],
    );
  });

  it("offers up to three titles of the dominant app, most time first", () => {
    const suggestions = compose([
      seg("a", T0, T0 + 10 * MIN, { label: "one" }),
      seg("a", T0 + 10 * MIN, T0 + 30 * MIN, { label: "two" }),
      seg("a", T0 + 30 * MIN, T0 + 31 * MIN, { label: "three" }),
      seg("a", T0 + 31 * MIN, T0 + 33 * MIN, { label: "four" }),
      seg("b", T0 + 33 * MIN, T0 + 34 * MIN, { label: "other app" }),
    ]);
    assert.deepEqual(suggestions[0]?.titles, ["two", "one", "four"]);
  });
});

describe("recentApps and names", () => {
  it("lists apps newest first, once each, under their newest name", () => {
    const segments = [
      seg("a", T0, T0 + MIN, { name: "Old A" }),
      seg("b", T0 + MIN, T0 + 2 * MIN),
      seg("a", T0 + 2 * MIN, T0 + 3 * MIN, { name: "New A" }),
    ];
    assert.deepEqual(recentApps(segments), [
      { key: "a", name: "New A" },
      { key: "b", name: "B" },
    ]);
    assert.equal(namesOf(segments).get("a"), "New A");
  });
});

describe("checkAccept", () => {
  const rebuilt = compose([seg("a", T0, T0 + 30 * MIN), seg("b", T0 + 90 * MIN, T0 + 100 * MIN)]);

  it("clips a plain accept to the block it overlaps most", () => {
    assert.deepEqual(checkAccept({ start: T0 - 5 * MIN, end: T0 + 20 * MIN, edited: false }, rebuilt), {
      ok: true,
      start: T0,
      end: T0 + 20 * MIN,
    });
  });

  it("keeps an edited accept's own times", () => {
    assert.deepEqual(checkAccept({ start: T0 - 5 * MIN, end: T0 + 20 * MIN, edited: true }, rebuilt), {
      ok: true,
      start: T0 - 5 * MIN,
      end: T0 + 20 * MIN,
    });
  });

  it("refuses what is already tracked and a backwards range", () => {
    assert.deepEqual(checkAccept({ start: T0 + 40 * MIN, end: T0 + 80 * MIN, edited: true }, rebuilt), {
      ok: false,
      reason: "already-tracked",
    });
    assert.deepEqual(checkAccept({ start: T0, end: T0, edited: false }, rebuilt), { ok: false, reason: "bad-range" });
  });
});

describe("liveAccepted", () => {
  it("forgets an accepted span after the hold", () => {
    const spans = [{ start: 0, end: 1, at: T0 }];
    assert.equal(liveAccepted(spans, T0 + ACCEPTED_HOLD_MS - 1).length, 1);
    assert.equal(liveAccepted(spans, T0 + ACCEPTED_HOLD_MS).length, 0);
  });
});
