import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_RANGE_MS,
  MAX_TRACKED_INTERVALS,
  parseCheckAcceptInput,
  parseInterval,
  parseRuleId,
  parseRuleInput,
  parseScope,
  parseSettingsPatch,
  parseSuggestionsInput,
} from "./ipc-parse.ts";

describe("activity IPC parsers", () => {
  it("narrows a settings patch and ignores unknown keys", () => {
    assert.deepEqual(
      parseSettingsPatch({ enabled: true, retentionDays: 900, excludedApps: ["Com.Example.Chat", "", 3], extra: 1 }),
      { enabled: true, retentionDays: 90, excludedApps: ["com.example.chat"] },
    );
    assert.deepEqual(parseSettingsPatch({ enabled: "yes" }), {});
    for (const bad of [null, [], "x", 5, new Date()]) assert.equal(parseSettingsPatch(bad), null);
  });

  it("shapes typed patterns like keys, so a name with spaces still matches", () => {
    assert.deepEqual(parseSettingsPatch({ excludedApps: ["Track Your Time.exe", "C:\\Tools\\x.exe"] }), {
      excludedApps: ["track-your-time.exe", "c-tools-x.exe"],
    });
    assert.equal(parseRuleInput({ pattern: "My Editor" })?.pattern, "my-editor");
  });

  it("refuses empty, long or colon-carrying scope ids", () => {
    assert.deepEqual(parseScope({ userId: "u1", workspaceId: "w1" }), { userId: "u1", workspaceId: "w1" });
    for (const bad of [
      null,
      { userId: "", workspaceId: "w" },
      { userId: "u", workspaceId: "" },
      { userId: "x".repeat(65), workspaceId: "w" },
      { userId: "u:1", workspaceId: "w" },
      { userId: 1, workspaceId: "w" },
    ]) {
      assert.equal(parseScope(bad), null, JSON.stringify(bad));
    }
  });

  it("needs finite, forward intervals", () => {
    assert.deepEqual(parseInterval({ start: 1, end: 2 }), { start: 1, end: 2 });
    for (const bad of [{ start: 2, end: 2 }, { start: Number.NaN, end: 2 }, { start: 1, end: Infinity }, { start: "1", end: 2 }]) {
      assert.equal(parseInterval(bad), null);
    }
  });

  it("bounds the suggestion range and the tracked list", () => {
    assert.ok(parseSuggestionsInput({ from: 0, to: 10, tracked: [{ start: 1, end: 2 }] }));
    assert.equal(parseSuggestionsInput({ from: 0, to: MAX_RANGE_MS + 1, tracked: [] }), null);
    assert.equal(parseSuggestionsInput({ from: 10, to: 0, tracked: [] }), null);
    assert.equal(parseSuggestionsInput({ from: 0, to: 10, tracked: [{ start: 2, end: 1 }] }), null);
    const many = Array.from({ length: MAX_TRACKED_INTERVALS + 1 }, (_, i) => ({ start: i, end: i + 1 }));
    assert.equal(parseSuggestionsInput({ from: 0, to: 10, tracked: many }), null);
    assert.equal(parseSuggestionsInput({ from: 0, to: 10 }), null);
  });

  it("needs edited to be a boolean on an accept check", () => {
    assert.ok(parseCheckAcceptInput({ start: 1, end: 2, edited: false, tracked: [] }));
    assert.equal(parseCheckAcceptInput({ start: 1, end: 2, tracked: [] }), null);
  });

  it("normalises rule patterns and bounds every field", () => {
    assert.deepEqual(parseRuleInput({ pattern: " COM.Example.* ", projectId: null, tagIds: ["t", "t"], billable: true }), {
      pattern: "com.example.*",
      projectId: null,
      tagIds: ["t"],
      billable: true,
    });
    for (const bad of [
      { pattern: "" },
      { pattern: "   " },
      { pattern: "x".repeat(201) },
      { pattern: "a", description: "x".repeat(501) },
      { pattern: "a", projectId: "" },
      { pattern: "a", tagIds: Array.from({ length: 21 }, (_, i) => `t${i}`) },
      { pattern: "a", billable: "yes" },
    ]) {
      assert.equal(parseRuleInput(bad), null, JSON.stringify(bad).slice(0, 60));
    }
    assert.equal(parseRuleId("r1"), "r1");
    assert.equal(parseRuleId(""), null);
  });
});
