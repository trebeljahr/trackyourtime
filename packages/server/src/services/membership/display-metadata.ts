import { TRPCError } from "@trpc/server";
import { workspaceMemberMetadataSchema } from "@starter/shared";
import { getAuth } from "../../auth/auth.js";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";
import { asId } from "./store.js";
type Row = Record<string, unknown>;
type Deps = {
  authorized: (workspaceId: string, userId: string) => Promise<boolean>;
  mirrors: (workspaceId: string) => Promise<readonly Row[]>;
  authMembers: (workspaceId: string, userIds: string[]) => Promise<readonly Row[]>;
  authUsers: (userIds: string[]) => Promise<readonly Row[]>;
};
const production: Deps = {
  authorized: async (workspaceId, userId) => Boolean(await WorkspaceMember.exists({ workspaceId, userId })),
  mirrors: async (workspaceId) => { const rows = await WorkspaceMember.find({ workspaceId }).select("_id userId").limit(201).lean(); return rows.map((row) => ({ _id: row._id, userId: row.userId })); },
  authMembers: async (workspaceId, userIds) => {
    const { adapter } = await getAuth().$context;
    return adapter.findMany({ model: "member", where: [{ field: "organizationId", value: workspaceId }, { field: "userId", value: userIds, operator: "in" }], select: ["id", "organizationId", "userId"], limit: 201 });
  },
  authUsers: async (userIds) => {
    const { adapter } = await getAuth().$context;
    return adapter.findMany({ model: "user", where: [{ field: "id", value: userIds, operator: "in" }], select: ["id", "name", "email"], limit: 201 });
  },
};
/** Explicit workspace only. Authorization is checked before any team metadata;
 * no fallback creates a workspace or reads financial/business configuration. */
export async function readWorkspaceMemberMetadata(userId: string, workspaceId: string, deps: Deps = production) {
  if (!await deps.authorized(workspaceId, userId)) throw new TRPCError({ code: "NOT_FOUND" });
  const mirror = await deps.mirrors(workspaceId);
  if (mirror.length > 200) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Member metadata exceeds the private directory limit" });
  const ids = mirror.map((row) => asId(row.userId));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length || !ids.includes(userId)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Workspace member metadata changed; retry after membership is ready" });
  const userIds = ids as string[];
  const [authMembers, users] = await Promise.all([deps.authMembers(workspaceId, userIds), deps.authUsers(userIds)]);
  const members = new Map<string, string>(), accounts = new Map<string, Row>();
  for (const row of authMembers) {
    const author = asId(row.userId), id = asId(row.id);
    if (!author || !id || row.organizationId !== workspaceId || !userIds.includes(author) || members.has(author)) throw new Error("Account membership metadata is ambiguous");
    members.set(author, id);
  }
  for (const row of users) {
    const id = asId(row.id);
    if (!id || !userIds.includes(id) || accounts.has(id)) throw new Error("Account display metadata is ambiguous");
    accounts.set(id, row);
  }
  if (!await deps.authorized(workspaceId, userId)) throw new TRPCError({ code: "NOT_FOUND" });
  return workspaceMemberMetadataSchema.parse({ userId, workspaceId, members: mirror.map((row) => {
    const author = asId(row.userId)!, account = accounts.get(author);
    return { userId: author, memberId: members.get(author) ?? asId(row._id) ?? author, name: typeof account?.name === "string" ? account.name : "", email: typeof account?.email === "string" ? account.email : "" };
  }) });
}
