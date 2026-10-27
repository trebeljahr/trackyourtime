import { z } from "zod";
import { canSeeMoneyFor, workspaceMemberMetadataSchema, type WorkspaceMemberRow } from "@starter/shared";
import { privateViewSource, type PrivateViewOptions } from "./view-source.js";
const id = z.string().min(1).max(100);
const memberSchema = z.object({ userId: id, name: z.string().max(512).default(""), createdAt: z.iso.datetime({ offset: true }).optional() });
/** Presentation metadata never grants access or supplies roles/rates. */
export function privateMemberDisplayMetadata(options: Pick<PrivateViewOptions, "scope" | "directory" | "current">, input: unknown) {
  const source = privateViewSource({ ...options, records: [] });
  const metadata = input == null ? null : workspaceMemberMetadataSchema.parse(input);
  if (metadata && (metadata.workspaceId !== options.scope.workspaceId || metadata.userId !== options.scope.userId)) throw new Error("Member metadata belongs to another account or workspace");
  const active = new Set(options.directory.signed.directory.members.map((member) => member.userId));
  if (metadata?.members.some((row) => !active.has(row.userId))) throw new Error("Member metadata differs from the trusted directory");
  source.check(); return new Map(metadata?.members.map((row) => [row.userId, row]) ?? []);
}
/** Shared roster facts and financial counterparts remain in the private
 * replica. Live auth names/email are optional display facts only. Private
 * mutation identity always stays bound to the original encrypted row. */
export function privateMemberQuery(options: PrivateViewOptions & { input: unknown; metadata?: unknown }): WorkspaceMemberRow[] {
  const source = privateViewSource(options);
  const input = z.object({ workspaceId: id.optional() }).strict().parse(options.input ?? {});
  if (input.workspaceId !== undefined && input.workspaceId !== options.scope.workspaceId) throw new Error("Private member filter belongs to another workspace");
  const metadata = privateMemberDisplayMetadata(options, options.metadata);
  const directory = new Map(options.directory.signed.directory.members.map((member) => [member.userId, member]));
  const rows = new Map<string, WorkspaceMemberRow>();
  for (const row of source.ofKind("members")) {
    if (!row.authorId) throw new Error("Private member identity is missing");
    const trusted = directory.get(row.authorId); if (!trusted) continue;
    const member = memberSchema.parse(source.value(row));
    if (member.userId !== row.authorId || rows.has(member.userId)) throw new Error("Private member identity is ambiguous");
    const display = metadata.get(member.userId), owner = trusted.role === "owner";
    const visible = canSeeMoneyFor(source.visibility, member.userId);
    const rate = visible ? z.number().finite().nonnegative().nullish().transform((value) => value ?? null).parse(source.paired(row, "memberMoney").hourlyRate) : undefined;
    rows.set(member.userId, { memberId: row.id, userId: member.userId,
      name: display?.name.trim() || member.name.trim(), email: display?.email ?? "",
      role: trusted.role, canViewOthersTime: owner || trusted.canViewOthersTime,
      canViewOthersMoney: owner || trusted.canViewOthersMoney,
      ...(visible ? { hourlyRate: rate } : {}), joinedAt: member.createdAt ? new Date(member.createdAt).toISOString() : new Date(0).toISOString(), isSelf: member.userId === options.scope.userId });
  }
  if (rows.size !== directory.size) throw new Error("Private member roster is incomplete");
  const rank = { owner: 0, admin: 1, member: 2 };
  source.check(); return [...rows.values()].sort((a, b) => rank[a.role] - rank[b.role] || a.joinedAt.localeCompare(b.joinedAt) || a.userId.localeCompare(b.userId));
}
