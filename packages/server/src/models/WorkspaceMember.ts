// App-owned membership: who is in a workspace, and what they may see.
//
// This is deliberately a SIBLING of better-auth's `member` collection, not a
// set of additional fields on it. The plugin owns the shape of its own
// collections across upgrades; a billing rate and a money-visibility flag are
// business data and must not depend on that.
//
// This record is what the app AUTHORIZES from — the workspace middleware, API
// tokens, webhook deliveries and the sync fan-out all read it, never
// better-auth's `member`. The two are kept in step by
// `services/membership/lifecycle.ts`, the only code that writes membership
// (the plugin's own endpoints answer 404 over HTTP): access is granted here
// LAST and revoked here FIRST, so a crash between the two writes always
// leaves the person with less access, never more.
import mongoose, { Schema, type Document } from "mongoose";
import type {
  Visibility,
  WorkspaceMember as WorkspaceMemberWire,
  WorkspaceRole,
} from "@starter/shared";

export interface IWorkspaceMember extends Document {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  name: string;
  hourlyRate: number | null;
  canViewOthersTime: boolean;
  canViewOthersMoney: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type WorkspaceMemberDocLike = {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  name: string;
  hourlyRate: number | null;
  canViewOthersTime: boolean;
  canViewOthersMoney: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const workspaceMemberSchema = new Schema<IWorkspaceMember>(
  {
    workspaceId: { type: String, required: true },
    userId: { type: String, required: true },
    role: {
      type: String,
      enum: ["owner", "admin", "member"],
      required: true,
      default: "member",
    },
    name: { type: String, required: true, default: "", maxlength: 200 },
    // Nullable and unused until Stage 7 wires per-member rates. It ships in
    // the first migration purely so there is never a second one.
    hourlyRate: { type: Number, default: null },
    // Defaults are the CLOSED position: a new member sees only their own work
    // until somebody grants more. Opening up is an action; it is never the
    // thing that happens because a field was forgotten.
    canViewOthersTime: { type: Boolean, required: true, default: false },
    canViewOthersMoney: { type: Boolean, required: true, default: false },
  },
  { timestamps: true },
);

/** One membership per person per workspace. */
workspaceMemberSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });
/** "Which workspaces am I in" — the switcher, and the sync fan-out. */
workspaceMemberSchema.index({ userId: 1 });

export const WorkspaceMember = mongoose.model<IWorkspaceMember>(
  "WorkspaceMember",
  workspaceMemberSchema,
);

export function toClientWorkspaceMember(
  doc: WorkspaceMemberDocLike,
): WorkspaceMemberWire {
  return {
    workspaceId: doc.workspaceId,
    userId: doc.userId,
    role: doc.role,
    name: doc.name,
    hourlyRate: doc.hourlyRate ?? null,
    canViewOthersTime: doc.canViewOthersTime,
    canViewOthersMoney: doc.canViewOthersMoney,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/**
 * Collapse a membership into the visibility the request runs under.
 *
 * Resolved once, in the workspace middleware, and threaded from there. A call
 * site that re-derives this is a call site that can get it wrong.
 */
export function visibilityOf(doc: WorkspaceMemberDocLike): Visibility {
  return {
    userId: doc.userId,
    canViewOthersTime: doc.canViewOthersTime,
    canViewOthersMoney: doc.canViewOthersMoney,
  };
}

/**
 * The `$match` fragment restricting entries to what `visibility` may see.
 *
 * Returns `null` when no restriction applies, so callers can skip the clause
 * entirely rather than pushing a tautology into every aggregation.
 */
export function authorScopeFilter(
  visibility: Visibility,
): { authorId: string } | null {
  return visibility.canViewOthersTime ? null : { authorId: visibility.userId };
}
