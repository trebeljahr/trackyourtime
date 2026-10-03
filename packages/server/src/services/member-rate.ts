import { resolveHourlyRate, type WorkspaceSettings } from "@starter/shared";
import { WorkspaceMember } from "../models/WorkspaceMember.js";
import { getOrCreateWorkspaceSettings } from "../models/Settings.js";

/** Billing defaults for the entry AUTHOR, never the person viewing it.
 * Does not write settings or reprice historical snapshots. Zero is deliberate. */
export async function getAuthorBillingSettings(workspaceId: string, authorId: string, departedSnapshot?: { hourlyRate: number | null; currency: string }): Promise<WorkspaceSettings> {
  const settings = await getOrCreateWorkspaceSettings(workspaceId);
  const member = await WorkspaceMember.findOne({ workspaceId, userId: authorId }).lean();
  // Membership revocation removes the mirror before closing its timer. Keep
  // that timer's own snapshot when the author's membership has already gone.
  return { ...settings, currency: !member && departedSnapshot ? departedSnapshot.currency : settings.currency, defaultHourlyRate: resolveHourlyRate({
    billable: true, projectRate: null, memberRate: member ? member.hourlyRate : departedSnapshot?.hourlyRate,
    defaultRate: settings.defaultHourlyRate,
  }) ?? 0 };
}
