import mongoose, { Schema, type Document } from "mongoose";
import { pickCatalogColor, TASK_COLOR_OFFSET, type Task as TaskWire } from "@starter/shared";

/** What a task written before tasks had colors reads as. */
export const DEFAULT_TASK_COLOR = pickCatalogColor(0, TASK_COLOR_OFFSET);

export interface ITask extends Document {
  workspaceId: string;
  createdBy: string;
  name: string;
  color: string;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Structural shape accepted by {@link toClientTask} — satisfied by both a
 * `.lean()` result and a hydrated document.
 */
export type TaskDocLike = {
  _id?: unknown;
  workspaceId: string;
  createdBy: string;
  name: string;
  /**
   * Absent on a `.lean()` read of a row written before tasks had colors —
   * a mongoose default fills a hydrated document, never a lean one.
   */
  color?: string;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const taskSchema = new Schema<ITask>(
  {
    workspaceId: { type: String, required: true, index: true },
    // NOT `required` — mongoose's String required validator rejects ""
    // because it tests for a non-empty string, so pairing required:true
    // with default:"" makes any write that omits `createdBy` (a migration,
    // a seed, a backfill) fail with "Path `createdBy` is required".
    // Same trap as TimeEntry.description.
    createdBy: { type: String, default: "" },
    name: { type: String, required: true, maxlength: 200, trim: true },
    color: { type: String, required: true, default: DEFAULT_TASK_COLOR },
    archived: { type: Boolean, required: true, default: false },
  },
  { timestamps: true },
);

// Tasks are workspace-wide: an entry carries a task and a project side by
// side, and the task belongs to neither the project nor the client above it.
// Documents written before that was true may still carry a stray `projectId`;
// the strict schema drops it on read, so nothing has to be backfilled.
taskSchema.index({ workspaceId: 1, name: 1 });

export const Task = mongoose.model<ITask>("Task", taskSchema);

/** Convert a Task document into the exact wire shape. */
export function toClientTask(doc: TaskDocLike): TaskWire {
  return {
    id: String(doc._id),
    workspaceId: doc.workspaceId,
    createdBy: doc.createdBy,
    name: doc.name,
    color: doc.color ?? DEFAULT_TASK_COLOR,
    archived: doc.archived,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
