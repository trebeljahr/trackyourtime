import { z } from "zod";
import { addDaysToKey, zonedDayStartMs } from "./timezone.js";

export const approvalWeekSchema = z.object({ workspaceId: z.string().min(1).max(64).optional(), weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
export const approvalSubmitSchema = approvalWeekSchema.extend({ confirmedOnline: z.literal(true), pendingLocalEdits: z.literal(false) });
export const approvalActionSchema = z.object({
  workspaceId: z.string().min(1).max(64).optional(), id: z.string().regex(/^[a-f0-9]{24}$/i),
  revision: z.number().int().min(1), action: z.enum(["withdraw", "approve", "reject", "reopen"]),
  reason: z.string().trim().max(2000).optional(),
});
export const approvalConfigureSchema = z.object({
  workspaceId: z.string().min(1).max(64).optional(), enabled: z.boolean(),
  requireApprovedForInvoices: z.boolean(),
  timeZone: z.string().min(1).max(100).refine((zone) => { try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true; } catch { return false; } }),
});
export type ApprovalStatus = "draft" | "submitted" | "approved" | "rejected";
export type TimesheetApprovalWire = {
  id: string; workspaceId: string; authorId: string; authorName: string;
  weekStart: string; weekStartsOn: number; timeZone: string; start: string; end: string;
  status: string; revision: number; totalSec: number;
  history: { action: string; actorId: string; at: string; reason: string }[];
};
/** Snapshot absolute bounds. DST weeks are not necessarily 168 hours. */
export function approvalWeekBounds(weekStart: string, timeZone: string): { start: Date; end: Date } {
  return { start: new Date(zonedDayStartMs(weekStart, timeZone)), end: new Date(zonedDayStartMs(addDaysToKey(weekStart, 7), timeZone)) };
}
export function intervalIntersects(start: Date, end: Date | null, from: Date, to: Date): boolean {
  return start < to && (end === null || end > from || (end.getTime() === start.getTime() && start >= from));
}
