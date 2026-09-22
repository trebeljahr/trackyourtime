/**
 * Turning a whole file into the rows an import would write.
 *
 * Pure: no database, no clock, no workspace. Given the same text and options
 * it returns the same rows every time, which is what lets the commit re-parse
 * the file instead of trusting a preview handed back to it.
 */
import {
  IDLE_BEHAVIORS,
  IMPORT_DAY_START_HOUR,
  MAX_IMPORT_ENTRY_SEC,
  ELECTRONIC_ADDRESS_SCHEMES,
  IDENTITY_LIMITS,
  INVOICE_FORMATS,
  TAX_CATEGORIES,
  WORKSPACE_EXPORT_VERSION,
  businessProfileProblems,
  dayKeyInZone,
  isIdentityEmpty,
  isValidBic,
  isValidElectronicAddress,
  isValidIban,
  isValidVatId,
  normalizeBusinessProfile,
  normalizeClientBilling,
  stripSpacesUpper,
  zonedWallClockToMs,
  type BusinessProfileFields,
  type BusinessProfileValues,
  type ClientBilling,
  type ElectronicAddressScheme,
  type ImportColumn,
  type ImportColumnRole,
  type ImportDateOrder,
  type ImportFormat,
  type ImportIssue,
  type ImportIssueCode,
  type ImportRow,
  type ImportShape,
  type IdleBehavior,
  type WorkspaceExport,
  type WorkspaceExportClient,
  type WorkspaceExportFavorite,
  type WorkspaceExportProject,
  type WorkspaceExportSettings,
  type WorkspaceExportTag,
  type WorkspaceExportTask,
} from "@starter/shared";
import { cell, readDelimitedFile } from "./delimited.js";
import { dateCandidateValues, detectColumns } from "./columns.js";
import {
  combine,
  detectDateOrder,
  durationUnitFromHeader,
  parseAmount,
  parseBoolean,
  parseCalendarDate,
  parseClockTime,
  parseDurationSec,
  parseInstant,
  parseTagNames,
} from "./values.js";

export type ParseOptions = {
  timeZone: string;
  /** Overrides the per-file day/month detection. */
  dateOrder?: ImportDateOrder;
  /** Column roles the user re-pointed by hand. */
  overrides?: ReadonlyMap<number, ImportColumnRole>;
};

export type ParsedFile = {
  format: ImportFormat;
  delimiter: string;
  shape: ImportShape;
  dateOrder: ImportDateOrder;
  dateOrderAmbiguous: boolean;
  columns: ImportColumn[];
  /** Rows that could be read. In-file duplicates are included and marked. */
  rows: ImportRow[];
  issues: ImportIssue[];
  /** Data rows in the file, header excluded, including unreadable ones. */
  totalRows: number;
};

const MS = 1000;

const issue = (
  row: number,
  code: ImportIssueCode,
  message: string,
): ImportIssue => ({ row, code, message });

/**
 * Duplicate key: same work, same instant, same length.
 *
 * Deliberately NOT the whole row. Re-importing an overlapping range is the
 * normal way a backfill is finished ("I imported to March, here is March to
 * today"), and the overlap must be recognised even though the second export
 * may carry different tags, a re-typed rate or a renamed client.
 */
const fingerprintOf = (row: {
  start: string;
  durationSec: number;
  description: string;
  projectName: string | null;
}): string =>
  [
    row.start,
    row.durationSec,
    row.description.trim().toLowerCase(),
    (row.projectName ?? "").trim().toLowerCase(),
  ].join(" ");

/** Public so the workspace-side duplicate check keys on the same thing. */
export const importFingerprint = fingerprintOf;

/** Read a file of either supported format. */
export function parseImportFile(
  text: string,
  options: ParseOptions,
): ParsedFile {
  const head = text.trimStart().slice(0, 1);
  if (head === "{" || head === "[") {
    const parsed = parseWorkspaceJson(text);
    if (parsed) return parsed;
  }
  return parseDelimitedImport(text, options);
}

function parseDelimitedImport(
  text: string,
  options: ParseOptions,
): ParsedFile {
  const file = readDelimitedFile(text);
  const detectedOrder = detectDateOrder(
    dateCandidateValues(file.header, file.rows),
  );
  const dateOrder = options.dateOrder ?? detectedOrder.order;
  const { columns, byRole } = detectColumns(
    file.header,
    file.rows,
    dateOrder,
    options.overrides,
  );

  const shape = shapeOf(byRole);
  const durationUnit =
    byRole.duration === undefined
      ? "auto"
      : durationUnitFromHeader(file.header[byRole.duration] ?? "");

  const rows: ImportRow[] = [];
  const issues: ImportIssue[] = [];
  const seen = new Set<string>();
  /** Per-day cursor for date-only files. See IMPORT_DAY_START_HOUR. */
  const dayCursor = new Map<string, number>();

  const meta = {
    format: "delimited" as const,
    delimiter: file.delimiter,
    shape,
    dateOrder,
    dateOrderAmbiguous: options.dateOrder ? false : detectedOrder.ambiguous,
    columns,
    totalRows: file.rows.length,
  };

  // Nothing below can place a row without the columns to do it, and running
  // the loop anyway would answer "unusable file" with 5000 identical errors.
  if (shape === "unusable") return { ...meta, rows, issues };

  file.rows.forEach((raw, index) => {
    const rowNumber = index + 1;
    if (raw.every((value) => value.trim() === "")) return;

    const durationText = cell(raw, byRole.duration);
    const declaredSec =
      durationText === "" ? null : parseDurationSec(durationText, durationUnit);

    const placed = placeRow({
      raw,
      byRole,
      shape,
      timeZone: options.timeZone,
      dateOrder,
      declaredSec,
      dayCursor,
    });

    if ("code" in placed) {
      issues.push(issue(rowNumber, placed.code, placed.message));
      return;
    }

    const durationSec = Math.round((placed.endMs - placed.startMs) / MS);
    if (durationSec <= 0) {
      issues.push(
        issue(
          rowNumber,
          "nonpositive-duration",
          "Zero-length, or it ends before it starts.",
        ),
      );
      return;
    }
    if (durationSec > MAX_IMPORT_ENTRY_SEC) {
      issues.push(
        issue(
          rowNumber,
          "implausible-duration",
          `Spans ${Math.round(durationSec / 3600)} hours, which is longer than a day.`,
        ),
      );
      return;
    }

    const rateText = cell(raw, byRole.rate);
    const row: ImportRow = {
      row: rowNumber,
      description: cell(raw, byRole.description).slice(0, 500),
      clientName: nameOrNull(cell(raw, byRole.client)),
      projectName: nameOrNull(cell(raw, byRole.project)),
      taskName: nameOrNull(cell(raw, byRole.task)),
      tagNames: parseTagNames(cell(raw, byRole.tags)),
      billable: parseBoolean(cell(raw, byRole.billable)),
      start: new Date(placed.startMs).toISOString(),
      end: new Date(placed.endMs).toISOString(),
      durationSec,
      hourlyRate: rateText === "" ? null : parseAmount(rateText),
      duplicateOf: null,
    };

    const fingerprint = fingerprintOf(row);
    if (seen.has(fingerprint)) {
      row.duplicateOf = "file";
      issues.push(
        issue(
          rowNumber,
          "duplicate-in-file",
          "An identical row appeared earlier in this file.",
        ),
      );
    }
    seen.add(fingerprint);
    rows.push(row);
  });

  return { ...meta, rows, issues };
}

const nameOrNull = (value: string): string | null =>
  value.trim() === "" ? null : value.trim().slice(0, 200);

/**
 * Which layout the file uses, decided from the roles that were found rather
 * than from anything the user said — the columns present are the only honest
 * evidence of what the file can express.
 */
function shapeOf(
  byRole: Partial<Record<ImportColumnRole, number>>,
): ImportShape {
  const hasDate = byRole.date !== undefined;
  const canStart =
    byRole.start !== undefined || (hasDate && byRole.startTime !== undefined);
  const canEnd =
    byRole.end !== undefined ||
    ((hasDate || byRole.endDate !== undefined) && byRole.endTime !== undefined);
  const hasDuration = byRole.duration !== undefined;

  if (canStart && canEnd) return "start-end";
  if (canStart && hasDuration) return "start-duration";
  if (hasDate && hasDuration) return "date-duration";
  return "unusable";
}

type Placement = { startMs: number; endMs: number };
type PlacementError = { code: ImportIssueCode; message: string };

/** Where in absolute time this row goes, per the file's shape. */
function placeRow(args: {
  raw: string[];
  byRole: Partial<Record<ImportColumnRole, number>>;
  shape: ImportShape;
  timeZone: string;
  dateOrder: ImportDateOrder;
  declaredSec: number | null;
  dayCursor: Map<string, number>;
}): Placement | PlacementError {
  const { raw, byRole, shape, timeZone, dateOrder, declaredSec, dayCursor } =
    args;

  const startDate = parseCalendarDate(cell(raw, byRole.date), dateOrder);

  if (shape === "date-duration") {
    if (!startDate) {
      return { code: "unparsable-start", message: "No readable date." };
    }
    if (declaredSec === null) {
      return { code: "missing-duration", message: "No readable duration." };
    }
    // Stack the day's rows back-to-back from the working-day start, in file
    // order, so a date-only file produces a plausible day instead of a stack
    // of entries all beginning at midnight.
    const dayStart = zonedWallClockToMs(
      {
        year: startDate.year,
        month: startDate.month,
        day: startDate.day,
        hour: IMPORT_DAY_START_HOUR,
      },
      timeZone,
    );
    const key = dayKeyInZone(dayStart, timeZone);
    const cursor = dayCursor.get(key) ?? dayStart;
    const endMs = cursor + declaredSec * MS;
    dayCursor.set(key, endMs);
    return { startMs: cursor, endMs };
  }

  const startMs = resolveEdge({
    instant: cell(raw, byRole.start),
    date: startDate,
    clock: cell(raw, byRole.startTime),
    dateOrder,
    timeZone,
  });
  if (startMs === null) {
    return { code: "unparsable-start", message: "No readable start time." };
  }

  if (shape === "start-duration") {
    if (declaredSec === null) {
      return { code: "missing-duration", message: "No readable duration." };
    }
    return { startMs, endMs: startMs + declaredSec * MS };
  }

  const endDate =
    parseCalendarDate(cell(raw, byRole.endDate), dateOrder) ?? startDate;
  const endMs = resolveEdge({
    instant: cell(raw, byRole.end),
    date: endDate,
    clock: cell(raw, byRole.endTime),
    dateOrder,
    timeZone,
  });

  if (endMs === null) {
    // A file carrying a duration as well can still place the row; only one
    // with neither a readable end nor a duration is unreadable.
    if (declaredSec !== null) {
      return { startMs, endMs: startMs + declaredSec * MS };
    }
    return { code: "unparsable-end", message: "No readable end time." };
  }

  if (endMs <= startMs && byRole.end === undefined && byRole.endDate === undefined) {
    // An end CLOCK TIME at or before the start one, with no end-date column to
    // say otherwise, is how an overnight entry is ordinarily written down.
    //
    // Restricted to the clock-time case on purpose: a cell that carries its own
    // date has already said which day it means, so an end before the start
    // there is a broken row, not a night shift, and quietly adding a day to it
    // would invent a 23-hour entry instead of reporting the problem.
    const nextDay = endMs + 24 * 3600 * MS;
    if (nextDay - startMs <= MAX_IMPORT_ENTRY_SEC * MS) {
      return { startMs, endMs: nextDay };
    }
  }

  return { startMs, endMs };
}

/** One end of a row: a full instant, or a date plus a clock time. */
function resolveEdge(args: {
  instant: string;
  date: { year: number; month: number; day: number } | null;
  clock: string;
  dateOrder: ImportDateOrder;
  timeZone: string;
}): number | null {
  if (args.instant) {
    const parsed = parseInstant(args.instant, args.dateOrder, args.timeZone);
    if (parsed !== null) return parsed;
  }
  if (args.date && args.clock) {
    const clock = parseClockTime(args.clock);
    if (clock) return combine(args.date, clock, args.timeZone);
  }
  return null;
}

/**
 * Read this app's own export back.
 *
 * The JSON path exists so a workspace can be moved or restored losslessly: the
 * delimited path can only carry what a spreadsheet column can say, and drops
 * archived catalog entries, colors, and the currency an entry was billed in.
 */
export function parseWorkspaceJson(text: string): ParsedFile | null {
  const doc = workspaceJsonCatalog(text);
  if (!doc) return null;

  const rows: ImportRow[] = [];
  const issues: ImportIssue[] = [];
  const seen = new Set<string>();

  doc.entries.forEach((entry, index) => {
    const rowNumber = index + 1;
    const startMs = Date.parse(String(entry?.start ?? ""));
    if (Number.isNaN(startMs)) {
      issues.push(issue(rowNumber, "unparsable-start", "No readable start."));
      return;
    }
    const durationSec =
      typeof entry?.durationSec === "number" && entry.durationSec > 0
        ? Math.round(entry.durationSec)
        : entry?.end
          ? Math.round((Date.parse(entry.end) - startMs) / MS)
          : 0;
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      issues.push(
        issue(
          rowNumber,
          "nonpositive-duration",
          "Zero-length. A timer still running when the file was written is not imported.",
        ),
      );
      return;
    }

    const row: ImportRow = {
      row: rowNumber,
      description: String(entry?.description ?? "").slice(0, 500),
      clientName: nameOrNull(String(entry?.clientName ?? "")),
      projectName: nameOrNull(String(entry?.projectName ?? "")),
      taskName: nameOrNull(String(entry?.taskName ?? "")),
      tagNames: Array.isArray(entry?.tagNames)
        ? entry.tagNames.map((name) => String(name).trim()).filter(Boolean)
        : [],
      billable: typeof entry?.billable === "boolean" ? entry.billable : null,
      start: new Date(startMs).toISOString(),
      end: new Date(startMs + durationSec * MS).toISOString(),
      durationSec,
      hourlyRate:
        typeof entry?.hourlyRate === "number" ? entry.hourlyRate : null,
      duplicateOf: null,
    };

    const fingerprint = fingerprintOf(row);
    if (seen.has(fingerprint)) {
      row.duplicateOf = "file";
      issues.push(
        issue(
          rowNumber,
          "duplicate-in-file",
          "An identical entry appeared earlier in this file.",
        ),
      );
    }
    seen.add(fingerprint);
    rows.push(row);
  });

  return {
    format: "workspace-json",
    delimiter: "",
    shape: "start-end",
    dateOrder: "ymd",
    dateOrderAmbiguous: false,
    // A JSON export has no columns to re-point: its shape is fixed by version.
    columns: [],
    rows,
    issues,
    totalRows: doc.entries.length,
  };
}

/**
 * The catalog half of a JSON export — the colors, archived flags and project
 * settings that the entries alone cannot carry.
 *
 * Returns null for anything that is not one of our exports, which is also how
 * {@link parseImportFile} decides a `{`-leading file is really JSON.
 */
export function workspaceJsonCatalog(text: string): WorkspaceExport | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const doc = data as Partial<WorkspaceExport>;
  if (!Array.isArray(doc.entries)) return null;

  const settings = readExportSettings(doc.settings);
  const businessProfile = readExportBusinessProfile(doc.businessProfile);

  return {
    // Whether the money in this file was blanked on the way out. Carried
    // through so the preview can say so before a restore is approved — see
    // `ImportSections.moneyRedacted`. Only `true` survives: an absent or
    // malformed stamp means "this file makes no such claim", which is what an
    // unredacted export looks like.
    ...(doc.moneyRedacted === true ? { moneyRedacted: true } : {}),
    ...readExportVersion(doc.version),
    exportedAt: String(doc.exportedAt ?? new Date().toISOString()),
    workspaceId: String(doc.workspaceId ?? ""),
    currency: String(doc.currency ?? "EUR"),
    ...(settings ? { settings } : {}),
    ...(businessProfile ? { businessProfile } : {}),
    clients: readExportClients(doc.clients),
    projects: readExportProjects(doc.projects),
    tasks: readExportTasks(doc.tasks),
    tags: readExportTags(doc.tags),
    entries: doc.entries,
    // Absent stays absent, and an empty array stays empty: the two mean
    // different things once a file can state that a workspace had no pins.
    ...(Array.isArray(doc.favorites)
      ? { favorites: readExportFavorites(doc.favorites) }
      : {}),
    ...(Array.isArray(doc.invoices) ? { invoices: doc.invoices } : {}),
  };
}

/**
 * The document's version, as far as this reader can honour it.
 *
 * Read, never assumed. A literal `1` would make every v2 file claim to be v1,
 * and anything branching on the version — "were there no pins, or is this
 * file older than pins?" — would then branch wrong with no error anywhere.
 *
 * Unknown future versions cannot read as themselves in a union, so they read
 * as the newest version this reader understands: every section it knows is
 * still a section that version defines, and an absent one still means "none"
 * rather than "the file predates this". Reading a v3 file as v1 would report
 * its missing pins as a file older than pins. The declared number is kept in
 * `newerVersion` so the preview can say that sections it does not know are
 * skipped. A missing or non-numeric version is a v1 file — v1 is the only
 * format that ever omitted one.
 */
export function readExportVersion(
  value: unknown,
): Pick<WorkspaceExport, "version" | "newerVersion"> {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 2) {
    return { version: 1 };
  }
  return value > WORKSPACE_EXPORT_VERSION
    ? { version: WORKSPACE_EXPORT_VERSION, newerVersion: value }
    : { version: WORKSPACE_EXPORT_VERSION };
}

/**
 * The settings section, or nothing.
 *
 * Values are checked rather than coerced: a `defaultHourlyRate` that is not a
 * number reads as "the file does not say" and leaves the destination's own
 * rate alone, which is the only safe way to be wrong about a rate.
 */
function readExportSettings(
  value: unknown,
): WorkspaceExportSettings | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const settings = value as Partial<WorkspaceExportSettings>;
  const rate = settings.defaultHourlyRate;
  const week = settings.weekStartsOn;
  return {
    defaultHourlyRate:
      typeof rate === "number" && Number.isFinite(rate) && rate >= 0
        ? rate
        : null,
    // An unreadable week start falls back to Monday — the app's own default,
    // and the only value that is a guess rather than a misreading.
    weekStartsOn: week === 0 || week === 1 ? week : 1,
  };
}

// The catalog half of a file, read as VALUES rather than trusted as types.
//
// `JSON.parse` returns `unknown`, and the cast to `Partial<WorkspaceExport>`
// describes what a file SHOULD hold — it checks nothing. These rows are
// written straight into mongoose by `createMissingCatalog`, so an unchecked
// `budgetAmount: "lots"` reaches a Number path and kills the import with a
// CastError halfway through, after the batch and part of the catalog already
// exist. Two rules, both of which fail silently if dropped:
//
//  - A row without a usable NAME is dropped, not repaired. Everything in this
//    format is addressed by name; a nameless project matches nothing and
//    would be created as an empty-titled row nobody can find again.
//  - `budgetCurrency` only survives beside a `budgetAmount`, which is the one
//    invariant `budgetWrite` exists to hold: a currency with no amount renders
//    a budget in JPY for a target that does not exist.
const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const nonNegative = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

const flag = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

/** Rows in an array of unknown shape, each already narrowed to an object. */
const objects = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];

function readExportClients(value: unknown): WorkspaceExportClient[] {
  return objects(value).flatMap((row) => {
    const name = text(row.name, 120);
    if (name === "") return [];
    const billing = readExportBilling(row.billing);
    return [
      {
        name,
        color: text(row.color, 32),
        archived: flag(row.archived, false),
        ...(billing ? { billing } : {}),
      },
    ];
  });
}

/** Postal identity fields, each read as text and cut to the model's limit. */
const readPostalFields = (row: Record<string, unknown>) => ({
  legalName: text(row.legalName, 200),
  addressLines: Array.isArray(row.addressLines)
    ? row.addressLines.slice(0, 4).map((line) => text(line, 200))
    : [],
  postalCode: text(row.postalCode, 20),
  city: text(row.city, 120),
  // Anything but two letters is not a country code this app can print.
  country: /^[A-Za-z]{2}$/.test(text(row.country, 8)) ? text(row.country, 8) : "",
  taxId: text(row.taxId, 60),
  email: text(row.email, 254),
});

/** One of `options`, or `null` — an unknown enum value reads as "not said". */
const oneOfOrNull = <T extends string>(options: readonly T[], value: unknown): T | null =>
  typeof value === "string" && (options as readonly string[]).includes(value) ? (value as T) : null;

/** A compact identifier (VAT ID, IBAN, BIC) that passes its check, or `null`. */
const checkedId = (value: unknown, max: number, valid: (compact: string) => boolean): string | null => {
  if (typeof value !== "string") return null;
  const compact = stripSpacesUpper(value);
  return compact !== "" && compact.length <= max && valid(compact) ? compact : null;
};

/**
 * The electronic address pair, both or neither: an address whose scheme is
 * unknown, or whose value its scheme rejects, cannot be sent to.
 */
const readElectronicAddress = (
  row: Record<string, unknown>,
): { electronicAddress: string | null; electronicAddressScheme: ElectronicAddressScheme | null } => {
  const scheme = oneOfOrNull(ELECTRONIC_ADDRESS_SCHEMES, row.electronicAddressScheme);
  const address = text(row.electronicAddress, IDENTITY_LIMITS.electronicAddress);
  return scheme && address !== "" && isValidElectronicAddress(scheme, address)
    ? { electronicAddress: address, electronicAddressScheme: scheme }
    : { electronicAddress: null, electronicAddressScheme: null };
};

/**
 * A client's billing subdocument, or nothing. Every field is optional, so a
 * malformed one degrades to blank rather than dropping the client — an
 * invalid VAT ID, electronic address or enum value included.
 */
export function readExportBilling(value: unknown): ClientBilling | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  return normalizeClientBilling({
    ...readPostalFields(row),
    reference: text(row.reference, 120),
    vatId: checkedId(row.vatId, IDENTITY_LIMITS.vatId, isValidVatId),
    ...readElectronicAddress(row),
    preferredFormat: oneOfOrNull(INVOICE_FORMATS, row.preferredFormat),
    defaultTaxCategory: oneOfOrNull(TAX_CATEGORIES, row.defaultTaxCategory),
  });
}

/** The e-invoice keys of a business profile, each read only when the file carries it. */
const PROFILE_EINVOICE_TEXT = {
  taxNumber: IDENTITY_LIMITS.taxNumber,
  registrationNumber: IDENTITY_LIMITS.registrationNumber,
  sellerIdentifier: IDENTITY_LIMITS.sellerIdentifier,
  contactName: IDENTITY_LIMITS.contactName,
  bankName: IDENTITY_LIMITS.bankName,
  accountHolder: IDENTITY_LIMITS.accountHolder,
  smallBusinessNote: IDENTITY_LIMITS.smallBusinessNote,
} as const;

/**
 * The business profile section, or nothing when absent or all blank.
 *
 * Main's keys are read as they always were. A key added for e-invoicing is
 * read ONLY when the file has it: the restore merges this over the stored
 * profile, so a file written before e-invoicing must leave a stored IBAN or
 * VAT ID alone rather than clear it by omission. Invalid values degrade to
 * `null`, and a default category/rate pair that contradicts itself is dropped
 * as a pair.
 */
export function readExportBusinessProfile(
  value: unknown,
): BusinessProfileValues | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(row, key);
  const terms = row.paymentTermsDays;
  const fields: BusinessProfileFields = {
    ...readPostalFields(row),
    phone: text(row.phone, 40),
    website: text(row.website, 200),
    paymentDetails: text(row.paymentDetails, 1_000),
    paymentTermsDays:
      typeof terms === "number" && Number.isInteger(terms) && terms >= 0 && terms <= 365
        ? terms
        : null,
    invoiceFooter: text(row.invoiceFooter, 500),
  };
  for (const [key, max] of Object.entries(PROFILE_EINVOICE_TEXT)) {
    if (has(key)) (fields as Record<string, unknown>)[key] = text(row[key], max);
  }
  if (has("vatId")) fields.vatId = checkedId(row.vatId, IDENTITY_LIMITS.vatId, isValidVatId);
  if (has("iban")) fields.iban = checkedId(row.iban, IDENTITY_LIMITS.iban, isValidIban);
  if (has("bic")) fields.bic = checkedId(row.bic, IDENTITY_LIMITS.bic, isValidBic);
  if (has("electronicAddress") || has("electronicAddressScheme")) {
    Object.assign(fields, readElectronicAddress(row));
  }
  if (has("smallBusiness")) fields.smallBusiness = row.smallBusiness === true;
  if (has("defaultTaxCategory") || has("defaultTaxRate")) {
    const rate = row.defaultTaxRate;
    const pair = {
      defaultTaxCategory: oneOfOrNull(TAX_CATEGORIES, row.defaultTaxCategory),
      defaultTaxRate:
        typeof rate === "number" && Number.isFinite(rate) && rate >= 0 && rate <= 100
          ? Math.round(rate * 100) / 100
          : null,
    };
    const contradicts = businessProfileProblems(pair, false).length > 0;
    Object.assign(
      fields,
      contradicts ? { defaultTaxCategory: null, defaultTaxRate: null } : pair,
    );
  }

  if (isIdentityEmpty(normalizeBusinessProfile(fields))) return undefined;
  // The keys left out above must stay OUT, not become null — see the comment
  // on this function. Typed as the full profile because that is what an
  // export writes; `saveBusinessProfile` merges it key by key.
  const present = Object.fromEntries(
    Object.entries(normalizeBusinessProfile(fields)).filter(
      ([key]) => key in fields,
    ),
  );
  return present as BusinessProfileValues;
}

function readExportProjects(value: unknown): WorkspaceExportProject[] {
  return objects(value).flatMap((row) => {
    const name = text(row.name, 120);
    if (name === "") return [];
    const budgetAmount = nonNegative(row.budgetAmount);
    const clientName = text(row.clientName, 120);
    const idle = row.idleBehavior;
    return [
      {
        name,
        color: text(row.color, 32),
        clientName: clientName === "" ? null : clientName,
        billableDefault: flag(row.billableDefault, true),
        hourlyRate: nonNegative(row.hourlyRate),
        estimatedHours: nonNegative(row.estimatedHours),
        budgetAmount,
        budgetCurrency:
          budgetAmount === null ? null : text(row.budgetCurrency, 8) || null,
        idleBehavior: IDLE_BEHAVIORS.includes(idle as IdleBehavior)
          ? (idle as IdleBehavior)
          : null,
        archived: flag(row.archived, false),
      },
    ];
  });
}

// Tasks are workspace-wide and unique by name. This used to require a
// `projectName` beside the name, from when a task belonged to a project —
// and the exporter never wrote one, so every task in every file was dropped
// here and its color and archived flag with it. `color` is "" in a file
// older than task colors; the import then picks one.
function readExportTasks(value: unknown): WorkspaceExportTask[] {
  return objects(value).flatMap((row) => {
    const name = text(row.name, 200);
    if (name === "") return [];
    return [
      { name, color: text(row.color, 32), archived: flag(row.archived, false) },
    ];
  });
}

function readExportTags(value: unknown): WorkspaceExportTag[] {
  return objects(value).flatMap((row) => {
    const name = text(row.name, 60);
    if (name === "") return [];
    return [
      { name, color: text(row.color, 32), archived: flag(row.archived, false) },
    ];
  });
}

/**
 * Pins, same treatment. `planFavoriteRestore` sorts on `order` and trims
 * `description`, so a file whose pin carries a number where a string belongs
 * would throw inside the commit rather than be refused by it.
 */
function readExportFavorites(value: unknown): WorkspaceExportFavorite[] {
  return objects(value).map((row, index) => {
    const projectName = text(row.projectName, 120);
    const clientName = text(row.clientName, 120);
    const taskName = text(row.taskName, 120);
    const order = row.order;
    return {
      description: text(row.description, 500),
      clientName: clientName === "" ? null : clientName,
      projectName: projectName === "" ? null : projectName,
      taskName: taskName === "" ? null : taskName,
      billable: flag(row.billable, false),
      // File order is the fallback, which is what the restore honours anyway:
      // the numbers are relative to a workspace this one knows nothing about.
      order: typeof order === "number" && Number.isFinite(order) ? order : index,
    };
  });
}
