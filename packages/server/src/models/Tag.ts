import mongoose, { Schema, type Document } from "mongoose";
import type { Tag as TagWire } from "@starter/shared";

export const DEFAULT_TAG_COLOR = "#8b5cf6";

export interface ITag extends Document {
  workspaceId: string;
  createdBy: string;
  name: string;
  color: string;
  archived: boolean;
  hidden?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Structural shape accepted by {@link toClientTag} — satisfied by both a
 * `.lean()` result and a hydrated document.
 */
export type TagDocLike = {
  _id?: unknown;
  workspaceId: string;
  createdBy: string;
  name: string;
  color: string;
  archived: boolean;
  hidden?: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const tagSchema = new Schema<ITag>(
  {
    // No `index: true` here — the compound indexes below already cover
    // workspaceId, and declaring both makes mongoose warn about a duplicate.
    workspaceId: { type: String, required: true },
    createdBy: { type: String, required: true, default: "" },
    name: { type: String, required: true, maxlength: 60, trim: true },
    color: { type: String, required: true, default: DEFAULT_TAG_COLOR },
    archived: { type: Boolean, required: true, default: false },
    hidden: { type: Boolean, required: true, default: false },
  },
  { timestamps: true },
);

tagSchema.index({ workspaceId: 1, archived: 1 });

/**
 * One label per name, per owner — CASE-INSENSITIVELY.
 *
 * A tag is a label people type from memory, so "Design", "design" and
 * "DESIGN" are the same idea and must not become three tags that each hold a
 * third of the hours. The collation does the folding inside the index, so the
 * database enforces it even when a write bypasses the router's own check.
 */
tagSchema.index(
  { workspaceId: 1, name: 1 },
  { unique: true, collation: { locale: "en", strength: 2 } },
);

export const Tag = mongoose.model<ITag>("Tag", tagSchema);

/** Convert a Tag document into the exact wire shape. */
export function toClientTag(doc: TagDocLike): TagWire {
  return {
    id: String(doc._id),
    workspaceId: doc.workspaceId,
    createdBy: doc.createdBy,
    name: doc.name,
    color: doc.color,
    archived: doc.archived,
    hidden: doc.hidden ?? false,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
