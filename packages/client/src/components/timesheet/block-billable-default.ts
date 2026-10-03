import { projectBillableByDefault, type ProjectBillingDefaults } from "@starter/shared";

/** Seed a new block from billing defaults; existing entry snapshots stay untouched. */
export const blockBillableDefault = (
  project: ProjectBillingDefaults | undefined,
  workspaceRate: number | null | undefined,
  memberRate: number | null | undefined,
): boolean => projectBillableByDefault({
  billableDefault: project?.billableDefault ?? true,
  hourlyRate: project?.hourlyRate,
}, workspaceRate, memberRate);
