import { z } from "zod";
import { asWorkspaceKind, permissionsFor, type WorkspaceSummary } from "@starter/shared";
import { assertPrivateSupplementRecord } from "./recovery-supplement.js";
import { privateValue } from "./records.js";
import { privateViewSource, type PrivateViewOptions } from "./view-source.js";
/** Original encrypted identity plus the current signed directory. Server list
 * metadata never supplies the private name, role, count or permission flags. */
export function privateWorkspaceSummary(options: PrivateViewOptions & { isDefault: boolean }): WorkspaceSummary {
  const source = privateViewSource(options), rows = source.ofKind("workspaceIdentity");
  if (rows.length !== 1) throw new Error("Private workspace needs its original organization identity");
  const row = rows[0]!;
  assertPrivateSupplementRecord(options.scope.workspaceId, row);
  const decoded = z.object({ organization: z.object({ name: z.string().max(512).default(""), kind: z.enum(["personal", "team"]).optional() }) }).parse(privateValue(row.value));
  const actor = source.actor;
  const result: WorkspaceSummary = { id: options.scope.workspaceId, name: decoded.organization.name,
    kind: asWorkspaceKind(decoded.organization.kind), role: actor.role,
    memberCount: options.directory.signed.directory.members.length, isDefault: options.isDefault === true,
    permissions: permissionsFor(actor.role, { canViewOthersTime: actor.canViewOthersTime, canViewOthersMoney: actor.canViewOthersMoney }) };
  source.check(); return result;
}
