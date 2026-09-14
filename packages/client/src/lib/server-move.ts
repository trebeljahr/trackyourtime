/**
 * Moving a workspace from one Track Your Time server to another.
 *
 * Built entirely out of doors that already exist and already round-trip: the
 * source's `data.exportJson` writes the lossless JSON document, and the
 * target's `data.commit` reads it back into a workspace. Nothing here is a new
 * server capability, which is what lets it work in both directions — hosted to
 * self-hosted and back — against any server new enough to import a JSON
 * export at all.
 *
 * Two limits shape it. An export may hold 200,000 entries; one import accepts
 * {@link MAX_IMPORT_ROWS} rows in at most {@link MAX_IMPORT_BYTES} of text. So a
 * large workspace moves in date-range parts, split until each part fits both,
 * and a part that is still too big for one day is refused out loud rather than
 * truncated. Every part is imported with duplicates skipped, so running the
 * move again after a failure part-way is safe: what arrived is recognised and
 * not written twice.
 *
 * Framework-free and handed its two servers as plain functions, so the part
 * planning and the arithmetic of "did everything arrive" are tested without a
 * network or React.
 */

import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  type ImportInput,
  type ImportResult,
  type WorkspaceExport,
} from "@starter/shared";

import { translate } from "@/i18n/translate";

/** An export range — both ends inclusive, by the entry's start date (UTC). */
export type MoveRange = { from?: string; to?: string };

export type MoveSource = {
  /** Finished entries the export would carry for `range`. */
  countEntries(range: MoveRange): Promise<number>;
  exportJson(range: MoveRange): Promise<WorkspaceExport>;
};

export type MoveTarget = {
  /** Finished entries already in the target workspace. */
  countEntries(): Promise<number>;
  commit(input: ImportInput): Promise<ImportResult>;
};

/**
 * Entries per part. Well under the import's row cap, so a part that also
 * carries long descriptions stays under the byte cap without a second split.
 */
export const MOVE_PART_ENTRIES = Math.min(10_000, MAX_IMPORT_ROWS);

/** The widest span a split starts from. Wider than any real history. */
export const MOVE_EPOCH = { from: "1970-01-01", to: "2100-12-31" } as const;

export class MoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoveError";
  }
}

// ── dates ────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

const toDay = (value: string): number => Date.parse(`${value}T00:00:00.000Z`);

const fromDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Two halves of an inclusive range, split at the middle day. */
export const splitRange = (range: Required<MoveRange>): [Required<MoveRange>, Required<MoveRange>] => {
  const start = toDay(range.from);
  const end = toDay(range.to);
  const middle = start + Math.floor((end - start) / DAY_MS / 2) * DAY_MS;
  return [
    { from: range.from, to: fromDay(middle) },
    { from: fromDay(middle + DAY_MS), to: range.to },
  ];
};

const isSingleDay = (range: Required<MoveRange>): boolean => range.from === range.to;

// ── planning ─────────────────────────────────────────────────────────

/**
 * The date ranges to move, oldest first, each holding at most `perPart`
 * entries. One unbounded part when everything fits.
 *
 * Ranges with nothing in them are dropped. Only a single day with more entries
 * than a part may hold is an error — a split cannot get below one day, and
 * dropping the excess would be a move that quietly left work behind.
 */
export async function planMoveParts(
  source: Pick<MoveSource, "countEntries">,
  options: { perPart?: number } = {},
): Promise<MoveRange[]> {
  const perPart = options.perPart ?? MOVE_PART_ENTRIES;
  const total = await source.countEntries({});
  if (total <= perPart) return [{}];

  const parts: MoveRange[] = [];
  const visit = async (range: Required<MoveRange>, count: number): Promise<void> => {
    if (count === 0) return;
    if (count <= perPart) {
      parts.push(range);
      return;
    }
    if (isSingleDay(range)) {
      throw new MoveError(
        `${range.from} alone holds ${count.toLocaleString("en-US")} entries, more than one import accepts. Export that day separately.`,
      );
    }
    const [early, late] = splitRange(range);
    const earlyCount = await source.countEntries(early);
    await visit(early, earlyCount);
    await visit(late, count - earlyCount);
  };

  const spanned = await source.countEntries({ ...MOVE_EPOCH });
  if (spanned !== total) {
    // Parts are carved out of a bounded span, so an entry dated outside it
    // would belong to no part at all.
    throw new MoveError(
      `${(total - spanned).toLocaleString("en-US")} entries are dated before ${MOVE_EPOCH.from} or after ${MOVE_EPOCH.to}. Fix their dates, then move again.`,
    );
  }
  await visit({ ...MOVE_EPOCH }, spanned);
  return parts;
}

// ── exporting ────────────────────────────────────────────────────────

export type MovePart = {
  range: MoveRange;
  /** The export document, serialized exactly as it will be imported. */
  text: string;
  entries: number;
};

/**
 * Export one planned range, splitting it again if its text is over the
 * import's byte cap (descriptions long enough to beat the row budget).
 */
async function exportRange(
  source: MoveSource,
  range: MoveRange,
  maxBytes: number,
): Promise<MovePart[]> {
  const doc = await source.exportJson(range);
  const text = JSON.stringify(doc);
  if (new TextEncoder().encode(text).length <= maxBytes) {
    return [{ range, text, entries: doc.entries.length }];
  }

  const bounded: Required<MoveRange> = {
    from: range.from ?? MOVE_EPOCH.from,
    to: range.to ?? MOVE_EPOCH.to,
  };
  if (isSingleDay(bounded)) {
    throw new MoveError(translate("settings")("moveServer.tooLargeDay", { day: bounded.from }));
  }
  const [early, late] = splitRange(bounded);
  return [
    ...(await exportRange(source, early, maxBytes)),
    ...(await exportRange(source, late, maxBytes)),
  ].filter((part) => part.entries > 0);
}

/** Every part's export, in order. Also what the download fallback saves. */
export async function exportMoveParts(
  source: MoveSource,
  options: { perPart?: number; maxBytes?: number; onPart?: (done: number, total: number) => void } = {},
): Promise<MovePart[]> {
  const ranges = await planMoveParts(source, options);
  const parts: MovePart[] = [];
  for (const [index, range] of ranges.entries()) {
    parts.push(...(await exportRange(source, range, options.maxBytes ?? MAX_IMPORT_BYTES)));
    options.onPart?.(index + 1, ranges.length);
  }
  return parts;
}

/** "trackyourtime-move-2026-09-13.json", or "…-part-2-of-3.json" when split. */
export const movePartFilename = (index: number, total: number, stamp: string): string =>
  total === 1
    ? `trackyourtime-move-${stamp}.json`
    : `trackyourtime-move-${stamp}-part-${index + 1}-of-${total}.json`;

// ── importing ────────────────────────────────────────────────────────

/** What the importer answers when every row of a part is already there. */
const ALREADY_THERE = /^Nothing to import/;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export type MoveReport = {
  /** Finished entries the source exported. */
  entriesExported: number;
  /** Written to the target by this move. */
  entriesCreated: number;
  /** Already in the target, so not written again. */
  entriesSkipped: number;
  clientsCreated: number;
  projectsCreated: number;
  tasksCreated: number;
  tagsCreated: number;
  favoritesCreated: number;
  settingsRestored: boolean;
  totalSec: number;
  /** Every exported entry is now on the target, new or already there. */
  complete: boolean;
  parts: number;
};

/**
 * Add up what the parts reported.
 *
 * `complete` is the one number a person moving servers needs: created plus
 * already-there must account for every entry that left. Anything short of that
 * is reported as the difference, never rounded into "done".
 */
export const summarizeMove = (
  parts: ReadonlyArray<{ entries: number; result: ImportResult | null }>,
): MoveReport => {
  const report: MoveReport = {
    entriesExported: 0,
    entriesCreated: 0,
    entriesSkipped: 0,
    clientsCreated: 0,
    projectsCreated: 0,
    tasksCreated: 0,
    tagsCreated: 0,
    favoritesCreated: 0,
    settingsRestored: false,
    totalSec: 0,
    complete: false,
    parts: parts.length,
  };

  for (const { entries, result } of parts) {
    report.entriesExported += entries;
    if (result === null) {
      // The importer refused the part because every row was already there.
      report.entriesSkipped += entries;
      continue;
    }
    report.entriesCreated += result.entriesCreated;
    report.entriesSkipped += result.entriesSkipped;
    report.clientsCreated += result.clientsCreated;
    report.projectsCreated += result.projectsCreated;
    report.tasksCreated += result.tasksCreated;
    report.tagsCreated += result.tagsCreated;
    report.favoritesCreated += result.favoritesCreated;
    report.settingsRestored ||= result.settingsRestored;
    report.totalSec += result.totalSec;
  }

  report.complete =
    report.entriesCreated + report.entriesSkipped === report.entriesExported;
  return report;
};

export type MoveProgress =
  | { phase: "exporting"; done: number; total: number }
  | { phase: "importing"; done: number; total: number };

/**
 * Copy the source workspace into the target workspace.
 *
 * The workspace's settings (currency, rates, week start) and the person's
 * pinned quick starts are restored with the first part — and settings only
 * when the target workspace has no entries yet, because overwriting the
 * currency of a workspace already in use would relabel its history.
 */
export async function moveWorkspace(args: {
  source: MoveSource;
  target: MoveTarget;
  timeZone: string;
  onProgress?: (progress: MoveProgress) => void;
  perPart?: number;
  maxBytes?: number;
}): Promise<MoveReport> {
  const { source, target, onProgress } = args;
  const targetWasEmpty = (await target.countEntries()) === 0;

  const parts = await exportMoveParts(source, {
    perPart: args.perPart,
    maxBytes: args.maxBytes,
    onPart: (done, total) => onProgress?.({ phase: "exporting", done, total }),
  });
  if (parts.length === 1 && parts[0]?.entries === 0) {
    throw new MoveError(translate("settings")("moveServer.nothingToMove"));
  }

  const results: Array<{ entries: number; result: ImportResult | null }> = [];
  for (const [index, part] of parts.entries()) {
    onProgress?.({ phase: "importing", done: index, total: parts.length });
    try {
      const result = await target.commit({
        text: part.text,
        filename: movePartFilename(index, parts.length, new Date().toISOString().slice(0, 10)),
        timeZone: args.timeZone,
        skipDuplicates: true,
        createMissing: true,
        restoreSettings: index === 0 && targetWasEmpty,
        restoreFavorites: index === 0,
      });
      results.push({ entries: part.entries, result });
    } catch (error) {
      if (!ALREADY_THERE.test(errorMessage(error))) throw error;
      results.push({ entries: part.entries, result: null });
    }
  }
  onProgress?.({ phase: "importing", done: parts.length, total: parts.length });

  return summarizeMove(results);
}
