import { describe, expect, it } from "vitest";
import { Timer, Users } from "lucide-react";
import type { QuickStartItem } from "@starter/core";

import { getTranslator } from "@/i18n/translator";
import {
  buildDiscardGroups,
  buildPaletteGroups,
  scorePaletteItem,
  type PaletteInput,
} from "./palette-model";

const t = getTranslator("en", "shell");

const labels = {
  projectName: null,
  projectColor: null,
  clientName: null,
  taskName: null,
  projectMissing: false,
  projectArchived: false,
  taskMissing: false,
};

const recent: QuickStartItem = {
  kind: "recent",
  ...labels,
  description: "Design review",
  projectId: "p1",
  taskId: null,
  billable: true,
  projectName: "Website",
  projectColor: "#ff0000",
  key: "k1",
  lastStart: "2026-09-01T09:00:00.000Z",
  lastEntryId: "e1",
  count: 3,
};

const input = (overrides: Partial<PaletteInput> = {}): PaletteInput => ({
  t,
  running: null,
  quickStarts: [],
  sections: [
    { heading: null, items: [{ href: "/app/track", id: "track", icon: Timer }] },
    {
      heading: "manage",
      items: [{ href: "/app/clients", id: "clients", icon: Users }],
    },
  ],
  projects: [
    {
      id: "p1",
      name: "Website",
      color: "#ff0000",
      clientName: "Acme",
      billableDefault: true,
      archived: false,
    },
    {
      id: "p2",
      name: "Old",
      color: "#00ff00",
      clientName: null,
      billableDefault: false,
      archived: true,
    },
  ],
  clients: [{ id: "c1", name: "Acme", archived: false }],
  tasks: [{ id: "t1", name: "Invoicing", archived: false }],
  tags: [{ id: "g1", name: "deep work", archived: false, color: "#0000ff" }],
  reportRange: { from: "2026-01-01", to: "2026-12-31" },
  searching: false,
  ...overrides,
});

describe("buildPaletteGroups", () => {
  it("offers Start and Go to before anything is typed, and no catalog", () => {
    const groups = buildPaletteGroups(input());
    expect(groups.map((group) => group.id)).toEqual(["timer", "navigate"]);
    expect(groups[0]?.items.map((item) => item.id)).toEqual(["timer-start"]);
    expect(groups[1]?.items.map((item) => item.action)).toEqual([
      { kind: "navigate", href: "/app/track" },
      { kind: "navigate", href: "/app/clients" },
    ]);
  });

  it("offers Stop and Discard instead of Start while a timer runs", () => {
    const groups = buildPaletteGroups(
      input({ running: { description: "", elapsed: "0:05:00" } }),
    );
    const timer = groups[0]?.items ?? [];
    expect(timer.map((item) => item.id)).toEqual([
      "timer-stop",
      "timer-discard",
    ]);
    expect(timer[0]?.hint).toBe("No description · 0:05:00");
    // Discarding is never one key: the row opens a confirmation.
    expect(timer[1]?.action).toEqual({ kind: "discard-confirm" });
    expect(timer[1]?.destructive).toBe(true);
  });

  it("lists quick starts after the timer rows", () => {
    const groups = buildPaletteGroups(input({ quickStarts: [recent] }));
    const row = groups[0]?.items[1];
    expect(row?.id).toBe("recent-k1");
    expect(row?.label).toBe("Continue: Design review");
    expect(row?.action).toEqual({
      kind: "quick-start",
      quick: {
        description: "Design review",
        projectId: "p1",
        taskId: null,
        billable: true,
      },
    });
  });

  it("adds live catalog rows once something is typed", () => {
    const groups = buildPaletteGroups(input({ searching: true }));
    expect(groups.map((group) => group.id)).toEqual([
      "timer",
      "navigate",
      "projects",
      "clients",
      "tasks",
      "tags",
    ]);

    const projects = groups.find((group) => group.id === "projects");
    // Archived projects are not offered.
    expect(projects?.items.map((item) => item.id)).toEqual([
      "start-project-p1",
      "report-project-p1",
    ]);
    expect(projects?.items[0]?.label).toBe("Start timer on Website");
    expect(projects?.items[0]?.action).toEqual({
      kind: "start",
      fields: {
        description: "",
        projectId: "p1",
        taskId: null,
        billable: true,
        tagIds: [],
      },
    });
    expect(projects?.items[1]?.label).toBe("Open report filtered by Website");
    expect(projects?.items[1]?.action).toEqual({
      kind: "navigate",
      href: "/app/reports?from=2026-01-01&to=2026-12-31&projects=p1&view=entries",
    });
  });

  it("renders in German from the German catalog", () => {
    const de = getTranslator("de", "shell");
    const groups = buildPaletteGroups(input({ t: de, searching: true }));
    expect(groups[0]?.heading).toBe("Timer");
    expect(groups[0]?.items[0]?.label).toBe("Timer starten");
    expect(groups.find((group) => group.id === "tasks")?.heading).toBe(
      "Tätigkeiten",
    );
  });
});

describe("buildDiscardGroups", () => {
  it("puts the safe row first and names what the destructive one deletes", () => {
    const [group] = buildDiscardGroups(
      { description: "Writing", elapsed: "1:00:00" },
      t,
    );
    expect(group?.items.map((item) => item.action.kind)).toEqual([
      "back",
      "discard",
    ]);
    expect(group?.items[1]?.label).toBe("Discard 1:00:00 of Writing");
  });
});

describe("scorePaletteItem", () => {
  const score = (text: string, search: string): number =>
    text.toLowerCase().includes(search.toLowerCase()) ? 1 : 0;

  it("matches any keyword, never the id", () => {
    expect(scorePaletteItem(score, "web", ["Start timer on Website", "Website"])).toBe(1);
    expect(scorePaletteItem(score, "p1", ["Start timer on Website"])).toBe(0);
  });

  it("keeps every row for an empty search", () => {
    expect(scorePaletteItem(score, "  ", [])).toBe(1);
  });
});
