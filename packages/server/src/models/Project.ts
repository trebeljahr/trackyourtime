import { installStorageQuota } from "../services/storage-quota.js";
import mongoose, { Schema, type Document } from "mongoose";
import {
  IDLE_BEHAVIORS,
  type IdleBehavior,
  type Project as ProjectWire,
} from "@starter/shared";

export const DEFAULT_PROJECT_COLOR = "#4f46e5";

export interface IProject extends Document {
  workspaceId: string;
  createdBy: string;
  name: string;
  color: string;
  clientId: string | null;
  billableDefault: boolean;
  hourlyRate: number | null;
  estimatedHours: number | null;
  budgetAmount: number | null;
  budgetCurrency: string | null;
  /** null inherits the workspace's idle behaviour. */
  idleBehavior: IdleBehavior | null;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Structural shape accepted by {@link toClientProject} — satisfied by both a
 * `.lean()` result and a hydrated document.
 */
export type ProjectDocLike = {
  _id?: unknown;
  workspaceId: string;
  createdBy: string;
  name: string;
  color: string;
  clientId: string | null;
  billableDefault: boolean;
  hourlyRate: number | null;
  estimatedHours: number | null;
  budgetAmount: number | null;
  budgetCurrency: string | null;
  idleBehavior?: IdleBehavior | null;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const projectSchema = new Schema<IProject>(
  {
    workspaceId: { type: String, required: true, index: true },
    // NOT `required` — mongoose's String required validator rejects ""
    // because it tests for a non-empty string, so pairing required:true
    // with default:"" makes any write that omits `createdBy` (a migration,
    // a seed, a backfill) fail with "Path `createdBy` is required".
    // Same trap as TimeEntry.description.
    createdBy: { type: String, default: "" },
    name: { type: String, required: true, maxlength: 120, trim: true },
    color: { type: String, required: true, default: DEFAULT_PROJECT_COLOR },
    clientId: { type: String, default: null },
    billableDefault: { type: Boolean, required: true, default: true },
    hourlyRate: { type: Number, default: null },
    // Null, not 0: "no target" and "a target of zero" are different answers,
    // and only the first may render as "no budget set".
    estimatedHours: { type: Number, default: null, min: 0 },
    budgetAmount: { type: Number, default: null, min: 0 },
    budgetCurrency: { type: String, default: null },
    // Nullable rather than defaulted to a behaviour: "inherit the workspace"
    // has to stay distinguishable from "explicitly chose what the workspace
    // happens to say today", or changing the workspace setting would skip
    // every project created before it.
    idleBehavior: {
      type: String,
      enum: [...IDLE_BEHAVIORS, null],
      default: null,
    },
    archived: { type: Boolean, required: true, default: false },
  },
  { timestamps: true },
);

projectSchema.index({ workspaceId: 1, clientId: 1 });
projectSchema.index({ workspaceId: 1, archived: 1 });

export const Project = mongoose.model<IProject>("Project", projectSchema);

/** Convert a Project document into the exact wire shape. */
export function toClientProject(doc: ProjectDocLike): ProjectWire {
  return {
    id: String(doc._id),
    workspaceId: doc.workspaceId,
    createdBy: doc.createdBy,
    name: doc.name,
    color: doc.color,
    clientId: doc.clientId ?? null,
    billableDefault: doc.billableDefault,
    hourlyRate: doc.hourlyRate ?? null,
    estimatedHours: doc.estimatedHours ?? null,
    budgetAmount: doc.budgetAmount ?? null,
    budgetCurrency: doc.budgetCurrency ?? null,
    idleBehavior: doc.idleBehavior ?? null,
    archived: doc.archived,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

installStorageQuota(Project);
