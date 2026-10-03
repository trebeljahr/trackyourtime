import mongoose, { Schema } from "mongoose";

export interface ApprovalPolicy {
  workspaceId: string;
  enabled: boolean;
  requireApprovedForInvoices: boolean;
  timeZone: string;
}
const policySchema = new Schema<ApprovalPolicy>({
  workspaceId: { type: String, required: true, unique: true },
  enabled: { type: Boolean, default: false },
  requireApprovedForInvoices: { type: Boolean, default: false },
  timeZone: { type: String, default: "UTC" },
});
export const TimesheetPolicy = mongoose.model<ApprovalPolicy>("TimesheetPolicy", policySchema);

export interface ApprovalRecord {
  workspaceId: string;
  authorId: string;
  weekStart: string;
  weekStartsOn: number;
  timeZone: string;
  start: Date;
  end: Date;
  status: string;
  revision: number;
  history: { action: string; actorId: string; at: Date; reason: string }[];
  createdAt: Date;
  updatedAt: Date;
}
const approvalSchema = new Schema<ApprovalRecord>({
  workspaceId: { type: String, required: true },
  authorId: { type: String, required: true },
  weekStart: { type: String, required: true },
  weekStartsOn: { type: Number, required: true },
  timeZone: { type: String, required: true },
  start: { type: Date, required: true },
  end: { type: Date, required: true },
  status: { type: String, required: true },
  revision: { type: Number, default: 1 },
  history: [{ _id: false, action: String, actorId: String, at: Date, reason: String }],
}, { timestamps: true });
approvalSchema.index({ workspaceId: 1, authorId: 1, start: 1, end: 1 }, { unique: true });
approvalSchema.index({ workspaceId: 1, status: 1, start: 1 });
export const TimesheetApproval = mongoose.model<ApprovalRecord>("TimesheetApproval", approvalSchema);

// A durable contention point, not a lease. A paused transaction cannot commit
// across a submission that acquired the same row, even after a process restart.
const fenceSchema = new Schema({ _id: String, revision: { type: Number, default: 0 } });
export const WorkspaceWriteFence = mongoose.model("WorkspaceWriteFence", fenceSchema);
