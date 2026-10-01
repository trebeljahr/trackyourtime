import mongoose, { Schema, type Document } from "mongoose";
import type { Favorite as FavoriteWire } from "@starter/shared";

export interface IFavorite extends Document {
  workspaceId: string;
  userId: string;
  description: string;
  clientId?: string | null;
  projectId: string | null;
  taskId: string | null;
  billable: boolean;
  /** Position in the pinned row. Dense from 0, rewritten by `reorder`. */
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Structural shape accepted by {@link toClientFavorite} — satisfied by both a
 * `.lean()` result and a hydrated document.
 */
export type FavoriteDocLike = {
  _id?: unknown;
  workspaceId: string;
  userId: string;
  description: string;
  clientId?: string | null;
  projectId: string | null;
  taskId: string | null;
  billable: boolean;
  order: number;
  createdAt: Date;
  updatedAt: Date;
};

const favoriteSchema = new Schema<IFavorite>(
  {
    // A pin needs BOTH axes. It references a project, which is workspace
    // data, so it cannot follow the person between workspaces — the pin would
    // point at something they cannot see. And it is one person's shortcut, not
    // the workspace's, so it is not shared with colleagues either.
    //
    // No `index: true` here — the compound index below already covers these,
    // and declaring both makes mongoose warn about a duplicate.
    workspaceId: { type: String, required: true },
    userId: { type: String, required: true },
    // NOT `required`: a favorite that is only "the Acme project, billable" is
    // a perfectly good pin, and mongoose's String required validator rejects
    // "" because it tests for a non-empty string.
    description: { type: String, default: "", maxlength: 500 },
    // No default: absent marks legacy records which inherit the project client.
    clientId: { type: String },
    projectId: { type: String, default: null },
    taskId: { type: String, default: null },
    billable: { type: Boolean, required: true, default: false },
    order: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

/** The only read there is: "my pins in this workspace, in their order". */
favoriteSchema.index({ workspaceId: 1, userId: 1, order: 1 });

export const Favorite = mongoose.model<IFavorite>("Favorite", favoriteSchema);

/** Convert a Favorite document into the exact wire shape. */
export function toClientFavorite(doc: FavoriteDocLike): FavoriteWire {
  return {
    id: String(doc._id),
    workspaceId: doc.workspaceId,
    userId: doc.userId,
    description: doc.description,
    ...(doc.clientId !== undefined ? { clientId: doc.clientId } : {}),
    projectId: doc.projectId ?? null,
    taskId: doc.taskId ?? null,
    billable: doc.billable,
    order: doc.order,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
