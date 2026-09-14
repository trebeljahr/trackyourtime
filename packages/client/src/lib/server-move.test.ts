import { describe, expect, it, vi } from "vitest";
import type { ImportInput, ImportResult, WorkspaceExport } from "@starter/shared";

import {
  MoveError,
  moveWorkspace,
  movePartFilename,
  planMoveParts,
  splitRange,
  summarizeMove,
  type MoveRange,
  type MoveSource,
} from "./server-move";

/** A source whose entries start on the given UTC days. */
const sourceOf = (days: string[], description = "work"): MoveSource & { exports: MoveRange[] } => {
  const inRange = (range: MoveRange): string[] =>
    days.filter(
      (day) => (range.from === undefined || day >= range.from) && (range.to === undefined || day <= range.to),
    );
  const exports: MoveRange[] = [];
  return {
    exports,
    countEntries: async (range) => inRange(range).length,
    exportJson: async (range) => {
      exports.push(range);
      return {
        version: 2,
        exportedAt: "2026-09-13T00:00:00.000Z",
        workspaceId: "w",
        currency: "EUR",
        clients: [],
        projects: [],
        tasks: [],
        tags: [],
        entries: inRange(range).map((day) => ({
          description,
          start: `${day}T09:00:00.000Z`,
          end: `${day}T10:00:00.000Z`,
        })),
      } as unknown as WorkspaceExport;
    },
  };
};

const result = (overrides: Partial<ImportResult> = {}): ImportResult => ({
  batchId: "b",
  entriesCreated: 0,
  entriesSkipped: 0,
  clientsCreated: 0,
  projectsCreated: 0,
  tasksCreated: 0,
  tagsCreated: 0,
  favoritesCreated: 0,
  settingsRestored: false,
  totalSec: 0,
  firstStart: null,
  lastStart: null,
  ...overrides,
});

describe("splitRange", () => {
  it("halves an inclusive range without overlap or gap", () => {
    expect(splitRange({ from: "2026-01-01", to: "2026-01-10" })).toEqual([
      { from: "2026-01-01", to: "2026-01-05" },
      { from: "2026-01-06", to: "2026-01-10" },
    ]);
    expect(splitRange({ from: "2026-01-01", to: "2026-01-02" })).toEqual([
      { from: "2026-01-01", to: "2026-01-01" },
      { from: "2026-01-02", to: "2026-01-02" },
    ]);
  });
});

describe("planMoveParts", () => {
  it("moves a workspace that fits in one import as a single unbounded part", async () => {
    const source = sourceOf(["2026-01-01", "2026-02-01"]);
    await expect(planMoveParts(source, { perPart: 5 })).resolves.toEqual([{}]);
  });

  it("splits a large workspace into parts that together cover every entry once", async () => {
    const days = [
      ...Array.from({ length: 7 }, () => "2019-03-04"),
      ...Array.from({ length: 4 }, () => "2023-06-01"),
      ...Array.from({ length: 6 }, (_, i) => `2026-09-0${i + 1}`),
    ];
    const source = sourceOf(days);
    const parts = await planMoveParts(source, { perPart: 7 });

    expect(parts.length).toBeGreaterThan(1);
    const counts = await Promise.all(parts.map((range) => source.countEntries(range)));
    for (const count of counts) expect(count).toBeLessThanOrEqual(7);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(days.length);
    // Oldest first, no overlap.
    const sorted = [...parts].sort((a, b) => (a.from! < b.from! ? -1 : 1));
    expect(parts).toEqual(sorted);
    for (let i = 1; i < parts.length; i += 1) {
      expect(parts[i]!.from! > parts[i - 1]!.to!).toBe(true);
    }
  });

  it("refuses a single day that no split can make small enough", async () => {
    const source = sourceOf(Array.from({ length: 9 }, () => "2026-09-01"));
    await expect(planMoveParts(source, { perPart: 5 })).rejects.toThrow(
      /2026-09-01 alone holds 9 entries/,
    );
  });

  it("refuses rather than leaving out entries dated outside the span", async () => {
    const source = sourceOf(["1969-12-31", ...Array.from({ length: 5 }, () => "2026-01-01")]);
    await expect(planMoveParts(source, { perPart: 3 })).rejects.toBeInstanceOf(MoveError);
  });
});

describe("summarizeMove", () => {
  it("is complete when created plus already-there accounts for every exported entry", () => {
    const report = summarizeMove([
      { entries: 10, result: result({ entriesCreated: 8, entriesSkipped: 2, projectsCreated: 3, settingsRestored: true, totalSec: 3600 }) },
      { entries: 5, result: null },
      { entries: 4, result: result({ entriesCreated: 4, tagsCreated: 1, totalSec: 60 }) },
    ]);
    expect(report).toMatchObject({
      entriesExported: 19,
      entriesCreated: 12,
      entriesSkipped: 7,
      projectsCreated: 3,
      tagsCreated: 1,
      settingsRestored: true,
      totalSec: 3660,
      complete: true,
      parts: 3,
    });
  });

  it("is not complete when the target wrote fewer than were sent", () => {
    const report = summarizeMove([
      { entries: 10, result: result({ entriesCreated: 7, entriesSkipped: 1 }) },
    ]);
    expect(report.complete).toBe(false);
    expect(report.entriesExported - report.entriesCreated - report.entriesSkipped).toBe(2);
  });
});

describe("moveWorkspace", () => {
  const targetOf = (options: { entries: number; answer?: (input: ImportInput) => ImportResult }) => {
    const commits: ImportInput[] = [];
    return {
      commits,
      countEntries: async () => options.entries,
      commit: vi.fn(async (input: ImportInput) => {
        commits.push(input);
        if (options.answer) return options.answer(input);
        const doc = JSON.parse(input.text) as WorkspaceExport;
        return result({ entriesCreated: doc.entries.length });
      }),
    };
  };

  it("imports every part, restoring settings and pins with the first part into an empty workspace", async () => {
    const days = Array.from({ length: 12 }, (_, i) => `2026-0${(i % 9) + 1}-15`);
    const source = sourceOf(days);
    const target = targetOf({ entries: 0 });
    const progress: string[] = [];

    const report = await moveWorkspace({
      source,
      target,
      timeZone: "Europe/Berlin",
      perPart: 5,
      onProgress: (p) => progress.push(`${p.phase}:${p.done}/${p.total}`),
    });

    expect(report.entriesExported).toBe(12);
    expect(report.entriesCreated).toBe(12);
    expect(report.complete).toBe(true);
    expect(target.commits.length).toBeGreaterThan(1);
    expect(target.commits.map((c) => c.restoreSettings)).toEqual(
      target.commits.map((_, i) => i === 0),
    );
    expect(target.commits.map((c) => c.restoreFavorites)).toEqual(
      target.commits.map((_, i) => i === 0),
    );
    for (const commit of target.commits) {
      expect(commit.skipDuplicates).toBe(true);
      expect(commit.createMissing).toBe(true);
    }
    expect(progress.at(-1)).toBe(`importing:${report.parts}/${report.parts}`);
  });

  it("never overwrites the settings of a workspace that already has entries", async () => {
    const target = targetOf({ entries: 3 });
    await moveWorkspace({ source: sourceOf(["2026-01-01"]), target, timeZone: "UTC" });
    expect(target.commits[0]?.restoreSettings).toBe(false);
    expect(target.commits[0]?.restoreFavorites).toBe(true);
  });

  it("counts a part the target already holds as arrived, so a second run is complete", async () => {
    const target = targetOf({
      entries: 2,
      answer: () => {
        throw new Error("Nothing to import — every row in that file is already here.");
      },
    });
    const report = await moveWorkspace({
      source: sourceOf(["2026-01-01", "2026-01-02"]),
      target,
      timeZone: "UTC",
    });
    expect(report).toMatchObject({ entriesCreated: 0, entriesSkipped: 2, complete: true });
  });

  it("stops on any other refusal instead of reporting a partial move as done", async () => {
    const target = targetOf({
      entries: 0,
      answer: () => {
        throw new Error("UNAUTHORIZED");
      },
    });
    await expect(
      moveWorkspace({ source: sourceOf(["2026-01-01"]), target, timeZone: "UTC" }),
    ).rejects.toThrow("UNAUTHORIZED");
  });

  it("splits a part again when its text is over the import's byte cap", async () => {
    const days = ["2026-01-01", "2026-01-01", "2026-06-01", "2026-06-01"];
    const source = sourceOf(days, "x".repeat(400));
    const target = targetOf({ entries: 0 });
    const report = await moveWorkspace({
      source,
      target,
      timeZone: "UTC",
      perPart: 10,
      maxBytes: 2_000,
    });
    expect(target.commits.length).toBeGreaterThan(1);
    for (const commit of target.commits) {
      expect(new TextEncoder().encode(commit.text).length).toBeLessThanOrEqual(2_000);
    }
    expect(report).toMatchObject({ entriesExported: 4, entriesCreated: 4, complete: true });
  });

  it("refuses an empty workspace rather than reporting nothing as a success", async () => {
    await expect(
      moveWorkspace({ source: sourceOf([]), target: targetOf({ entries: 0 }), timeZone: "UTC" }),
    ).rejects.toThrow(/no finished entries/);
  });
});

describe("movePartFilename", () => {
  it("names a single file plainly and numbers parts", () => {
    expect(movePartFilename(0, 1, "2026-09-13")).toBe("tracktime-move-2026-09-13.json");
    expect(movePartFilename(1, 3, "2026-09-13")).toBe("tracktime-move-2026-09-13-part-2-of-3.json");
  });
});
