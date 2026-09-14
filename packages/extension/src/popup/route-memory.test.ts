import { describe, expect, test } from "vitest";
import { loadRoute, rememberRoute } from "./route-memory";
import { defaultDraft, navigate, ROOT_STACK, viewOf } from "./route";

const KEY = "trackyourtime.popup-route";

const store = async (value: unknown): Promise<void> => {
  await chrome.storage.session.set({ [KEY]: JSON.stringify({ stack: value, at: Date.now() }) });
};

describe("activity routes", () => {
  test("suggestions and its edit form round-trip through route memory", async () => {
    const draft = defaultDraft(Date.parse("2026-09-14T10:00:00Z"));
    const stack = navigate(ROOT_STACK, { name: "suggestion-edit", day: "2026-09-12", draft });
    expect(stack.map((route) => route.name)).toEqual(["tracker", "suggestions", "suggestion-edit"]);
    expect(viewOf(stack[2] ?? ROOT_STACK[0])).toBe("suggestions");

    await rememberRoute(stack);
    expect(await loadRoute()).toEqual(stack);
  });

  test("an unreadable day opens today rather than dropping the screen", async () => {
    await store([{ name: "tracker" }, { name: "suggestions", day: "yesterday" }]);
    expect(await loadRoute()).toEqual([{ name: "tracker" }, { name: "suggestions", day: null }]);
  });

  test("an edit form without a readable draft falls back to its list, once", async () => {
    await store([
      { name: "tracker" },
      { name: "suggestions", day: "2026-09-12" },
      { name: "suggestion-edit", day: "2026-09-12", draft: { start: "nope" } },
    ]);
    expect(await loadRoute()).toEqual([
      { name: "tracker" },
      { name: "suggestions", day: "2026-09-12" },
    ]);
  });

  test("the activity settings section is remembered", async () => {
    await store([{ name: "tracker" }, { name: "settings", section: "activity" }]);
    expect(await loadRoute()).toEqual([{ name: "tracker" }, { name: "settings", section: "activity" }]);
  });
});
