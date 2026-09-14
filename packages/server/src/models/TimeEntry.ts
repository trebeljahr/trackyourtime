import mongoose, { Schema, type Document } from "mongoose";
import type {
  EntrySource,
  RunawayMark,
  TimeEntry as TimeEntryWire,
} from "@starter/shared";

export interface ITimeEntry extends Document {
  workspaceId: string;
  authorId: string;
  description: string;
  projectId: string | null;
  taskId: string | null;
  billable: boolean;
  start: Date;
  /** `null` means the timer is still running. */
  end: Date | null;
  /** 0 while running. */
  durationSec: number;
  /** Snapshot taken on stop/create so past earnings never shift. */
  hourlyRate: number | null;
  /** Snapshot of the workspace currency. */
  currency: string;
  source: EntrySource;
  timeZone: string | null;
  /** What the runaway guard did about this entry. See @starter/shared/runaway. */
  runaway: RunawayDoc | null;
  /**
   * When the scheduler emailed this person about this still-running entry.
   * Absent on every entry it never emailed about, which includes every entry
   * written before the scheduler existed. Server-only: never on the wire.
   */
  reminderSentAt?: Date | null;
  /** Ids of the Tags on this entry. Empty array = untagged. */
  tagIds: string[];
  /** The Invoice this entry was billed on, or null while still billable. */
  invoiceId: string | null;
  /** The ImportBatch that created this entry, or null when a person did. */
  importId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The stored form of {@link RunawayMark}: same fields, with the two instants
 * as Dates so Mongo can range-query them if a report ever wants to.
 */
export type RunawayDoc = {
  detectedAt: Date;
  elapsedSec: number;
  limitSec: number;
  action: RunawayMark["action"];
  resolvedAt: Date | null;
};

/**
 * Structural shape accepted by {@link toClientTimeEntry} — satisfied by both a
 * `.lean()` result and a hydrated document.
 */
export type TimeEntryDocLike = {
  _id?: unknown;
  workspaceId: string;
  authorId: string;
  description: string;
  projectId: string | null;
  taskId: string | null;
  billable: boolean;
  start: Date;
  end: Date | null;
  durationSec: number;
  hourlyRate: number | null;
  currency: string;
  source: EntrySource;
  timeZone: string | null;
  /** Absent on every entry written before the guard existed. */
  runaway?: RunawayDoc | null;
  /** Absent unless the runaway reminder job emailed about this entry. */
  reminderSentAt?: Date | null;
  tagIds: string[];
  invoiceId: string | null;
  /** Absent on every entry written before imports existed. */
  importId?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const runawaySchema = new Schema<RunawayDoc>(
  {
    detectedAt: { type: Date, required: true },
    // Together with the entry's `start` these two are what make a cap
    // reversible: `start + elapsedSec` is exactly the span the guard saw, so
    // no truncation is ever unexplainable or unrecoverable.
    elapsedSec: { type: Number, required: true, min: 0 },
    limitSec: { type: Number, required: true, min: 0 },
    action: {
      // Must stay in lockstep with RunawayAction.
      type: String,
      enum: ["flagged", "capped", "stopped"],
      required: true,
    },
    resolvedAt: { type: Date, default: null },
  },
  { _id: false },
);

const timeEntrySchema = new Schema<ITimeEntry>(
  {
    // No `index: true` on either scope field — the compound and partial-unique
    // indexes declared below already cover them, and declaring both makes
    // mongoose warn about a duplicate index.
    workspaceId: { type: String, required: true },
    authorId: { type: String, required: true },
    // NOT `required` — an entry with no description is completely normal
    // ("just start the timer, name it later"), and mongoose's String required
    // validator rejects "" because it tests for a non-empty string. Pairing
    // required:true with default:"" made every such start fail with
    // "Path `description` is required".
    description: { type: String, default: "", maxlength: 500 },
    projectId: { type: String, default: null },
    taskId: { type: String, default: null },
    billable: { type: Boolean, required: true, default: false },
    start: { type: Date, required: true },
    end: { type: Date, default: null },
    durationSec: { type: Number, required: true, default: 0, min: 0 },
    hourlyRate: { type: Number, default: null },
    currency: { type: String, required: true, default: "EUR" },
    source: {
      type: String,
      // Must stay in lockstep with EntrySource — Mongoose rejects the write
      // silently-looking (a ValidationError deep in a mutation) if it drifts.
      enum: ["web", "desktop", "mobile", "extension", "api", "import"],
      required: true,
      default: "web",
    },
    // See the note on TimeEntry.timeZone in @starter/shared.
    timeZone: { type: String, default: null },
    runaway: { type: runawaySchema, default: null },
    /**
     * The once-only key for the runaway reminder email
     * (services/scheduler/runaway-reminder.ts). Next to `runaway` because
     * it answers the same entry's "has anyone been told" question.
     *
     * No `default` and never `required`: an old row has no such field, and
     * the job claims a reminder with `{ reminderSentAt: null }`, which Mongo
     * matches for an absent field and an explicit null alike.
     */
    reminderSentAt: { type: Date },
    tagIds: { type: [String], default: [] },
    /**
     * The DENORMALIZED half of the double-billing guard.
     *
     * `Invoice.entryIds` is the source of truth for what an invoice bills.
     * This field exists so the opposite question — "which entries are still
     * billable?" — is one indexed query (`invoiceId: null`) instead of a scan
     * of every invoice's entryIds array, which is the query the invoice
     * preview runs on every keystroke of a date range.
     *
     * The two are written in the SAME place (invoice create / delete) inside
     * one code path, so they cannot drift: never set one without the other.
     */
    invoiceId: { type: String, default: null },
    /**
     * The batch a backfilled entry arrived in, so one bad import can be undone
     * as a unit. Stored on the entry rather than as a list of ids on the batch
     * because a year of history is tens of thousands of rows: "delete this
     * import" must be one indexed query, not a document that grows towards
     * Mongo's 16MB ceiling.
     */
    importId: { type: String, default: null },
  },
  { timestamps: true },
);

/** Range queries: "everything in this workspace between two instants". */
timeEntrySchema.index({ workspaceId: 1, start: -1 });
timeEntrySchema.index({ workspaceId: 1, projectId: 1, start: -1 });
/** Per-member reads: the `memberIds` report filter, and the visibility clause
 * that restricts a member without `canViewOthersTime` to their own rows. */
timeEntrySchema.index({ workspaceId: 1, authorId: 1, start: -1 });

/** "Entries carrying any of these tags" — a multikey index over the array. */
timeEntrySchema.index({ workspaceId: 1, tagIds: 1 });

/** "What is still un-invoiced here" — the double-billing guard. */
timeEntrySchema.index({ workspaceId: 1, invoiceId: 1 });

/**
 * "Everything one import wrote" — undo, and the duplicate check that runs
 * before a re-import. Partial, because every hand-tracked entry has no batch
 * and there is no question this index answers about those.
 */
timeEntrySchema.index(
  { workspaceId: 1, importId: 1 },
  { partialFilterExpression: { importId: { $type: "string" } } },
);

/**
 * At most ONE running entry (`end === null`) per PERSON, across every
 * workspace they belong to.
 *
 * Deliberately keyed on `authorId` alone and NOT compounded with
 * `workspaceId`: a human has one body and cannot be working in two workspaces
 * at once. The compound form would permit one running timer per workspace,
 * which makes `entries.current` list-shaped and leaves the extension badge and
 * the Raycast menu bar with no way to answer "what am I doing right now".
 *
 * Consequence, by design: starting a timer in one workspace stops the one
 * running in another. Callers must surface that rather than let it happen
 * silently.
 */
timeEntrySchema.index(
  { authorId: 1 },
  { unique: true, partialFilterExpression: { end: null } },
);

export const TimeEntry = mongoose.model<ITimeEntry>(
  "TimeEntry",
  timeEntrySchema,
);

/** Convert a TimeEntry document into the exact wire shape. */
export function toClientTimeEntry(doc: TimeEntryDocLike): TimeEntryWire {
  return {
    id: String(doc._id),
    workspaceId: doc.workspaceId,
    authorId: doc.authorId,
    description: doc.description,
    projectId: doc.projectId ?? null,
    taskId: doc.taskId ?? null,
    billable: doc.billable,
    start: doc.start.toISOString(),
    end: doc.end ? doc.end.toISOString() : null,
    durationSec: doc.durationSec,
    hourlyRate: doc.hourlyRate ?? null,
    currency: doc.currency,
    source: doc.source,
    timeZone: doc.timeZone ?? null,
    runaway: doc.runaway
      ? {
          detectedAt: doc.runaway.detectedAt.toISOString(),
          elapsedSec: doc.runaway.elapsedSec,
          limitSec: doc.runaway.limitSec,
          action: doc.runaway.action,
          resolvedAt: doc.runaway.resolvedAt
            ? doc.runaway.resolvedAt.toISOString()
            : null,
        }
      : null,
    // Documents written before these fields existed have neither key, so the
    // fallbacks are load-bearing, not defensive noise.
    tagIds: doc.tagIds ?? [],
    invoiceId: doc.invoiceId ?? null,
    importId: doc.importId ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
