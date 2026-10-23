// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { TagChips, splitForOverflow } from "./tag-chips";
import { canCreateTag, pickableTags, toggleTagId } from "./tag-picker";
import { removalPreview } from "./tag-manager";
import { tagsForIds, type TagRow } from "./use-tags";
import {
  toReportFilters,
  type ReportFilterState,
} from "@/components/reports/use-report-filters";

const tag = (overrides: Partial<TagRow> & { id: string }): TagRow => ({
  workspaceId: "workspace",
  createdBy: "user",
  name: overrides.id,
  color: "#8b5cf6",
  archived: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  entryCount: 0,
  totalSec: 0,
  ...overrides,
});

afterEach(() => {
  cleanup();
});

describe("toggleTagId", () => {
  it("appends an id that is not selected, keeping pick order", () => {
    expect(toggleTagId(["a"], "b")).toEqual(["a", "b"]);
  });

  it("removes an id that is already selected", () => {
    expect(toggleTagId(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("never mutates the array it was given", () => {
    const value = ["a"];
    toggleTagId(value, "b");
    expect(value).toEqual(["a"]);
  });
});

describe("canCreateTag", () => {
  const tags = [tag({ id: "1", name: "Design" })];

  it("offers nothing for an empty or whitespace query", () => {
    expect(canCreateTag("", tags)).toBe(false);
    expect(canCreateTag("   ", tags)).toBe(false);
  });

  it("offers a create row for a name nothing matches", () => {
    expect(canCreateTag("Bugfix", tags)).toBe(true);
  });

  it("suppresses the create row on an exact match, whatever the case", () => {
    // The server's unique index is case-insensitive, so offering "design"
    // next to "Design" would only ever produce a CONFLICT.
    expect(canCreateTag("Design", tags)).toBe(false);
    expect(canCreateTag("design", tags)).toBe(false);
    expect(canCreateTag("  DESIGN  ", tags)).toBe(false);
  });
});

describe("pickableTags", () => {
  const live = tag({ id: "live", name: "Live" });
  const archived = tag({ id: "old", name: "Old", archived: true });

  it("hides archived tags from a picker that is not carrying one", () => {
    expect(pickableTags([live, archived], [])).toEqual([live]);
  });

  it("keeps an archived tag the entry already carries", () => {
    // Otherwise the tag is stuck on the entry with no way to tick it off.
    expect(pickableTags([live, archived], ["old"])).toEqual([live, archived]);
  });
});

describe("splitForOverflow", () => {
  const tags = [
    { id: "1", name: "one", color: "#111111" },
    { id: "2", name: "two", color: "#222222" },
    { id: "3", name: "three", color: "#333333" },
    { id: "4", name: "four", color: "#444444" },
  ];

  it("shows everything when the cap is off", () => {
    expect(splitForOverflow(tags, 0)).toEqual({
      shown: tags,
      hidden: 0,
      hiddenNames: [],
    });
  });

  it("shows everything when it fits", () => {
    expect(splitForOverflow(tags, 4).hidden).toBe(0);
  });

  it("spends one slot on the counter itself", () => {
    // max 2 means one chip plus "+3", not two chips plus "+2" — otherwise the
    // row is one chip wider than the caller asked for.
    const result = splitForOverflow(tags, 2);
    expect(result.shown.map((entry) => entry.id)).toEqual(["1"]);
    expect(result.hidden).toBe(3);
    expect(result.hiddenNames).toEqual(["two", "three", "four"]);
  });
});

describe("TagChips", () => {
  it("renders nothing for an untagged entry", () => {
    const { container } = render(<TagChips tags={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a chip per tag, with the overflow counter", () => {
    render(
      <TagChips
        tags={[
          { id: "1", name: "one", color: "#111111" },
          { id: "2", name: "two", color: "#222222" },
          { id: "3", name: "three", color: "#333333" },
        ]}
        max={2}
      />,
    );
    expect(screen.getByTestId("tag-chips-1")).toHaveProperty(
      "textContent",
      "one",
    );
    expect(screen.queryByTestId("tag-chips-2")).toBeNull();
    expect(screen.getByTestId("tag-chips-overflow").textContent).toBe("+2");
  });
});

describe("removalPreview", () => {
  it("promises a delete only when nothing is tagged", () => {
    const preview = removalPreview(tag({ id: "1", name: "Spare" }));
    expect(preview.confirmLabel).toBe("Delete");
    expect(preview.title).toContain("Delete");
  });

  it("says archive when tracked time still carries the tag", () => {
    // The server refuses the delete in this case; promising one would be a
    // lie the user discovers the next time they open the picker.
    const preview = removalPreview(
      tag({ id: "1", name: "Busy", entryCount: 3 }),
    );
    expect(preview.confirmLabel).toBe("Archive");
    expect(preview.description).toContain("3 time entries");
  });
});

describe("toReportFilters — tags", () => {
  const state = (tagIds: string[]): ReportFilterState => ({
    range: { from: "2026-01-01", to: "2026-01-31" },
    projectIds: [],
    clientIds: [],
    taskIds: [],
    tagIds,
    billable: "all",
    search: "",
  });

  it("omits tagIds entirely when nothing is selected", () => {
    // An empty array would read as "entries carrying none of these tags" if
    // the server ever tightened the check; omission is unambiguous.
    expect(toReportFilters(state([]))).not.toHaveProperty("tagIds");
  });

  it("passes the selection through when tags are picked", () => {
    expect(toReportFilters(state(["a", "b"])).tagIds).toEqual(["a", "b"]);
  });
});


describe("automation tags", () => {
  const hidden = tag({ id: "automation", hidden: true });
  const visible = tag({ id: "normal" });
  it("never offers hidden tags, even when already selected", () => {
    expect(pickableTags([hidden, visible], [hidden.id])).toEqual([visible]);
    expect(tagsForIds([hidden, visible], [hidden.id, visible.id])).toEqual([visible]);
  });
  it("does not count hidden tags in chip overflow or tooltips", () => {
    expect(splitForOverflow([hidden, visible], 1)).toEqual({ shown: [visible], hidden: 0, hiddenNames: [] });
    render(<TagChips tags={[hidden]} />);
    expect(screen.queryByTestId("tag-chips")).toBeNull();
  });
});
