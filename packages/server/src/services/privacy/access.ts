import { readersForPrivateRecord } from "@starter/core";
import { TRPCError } from "@trpc/server";
import { PRIVATE_WORKSPACE_REQUIRED, type PrivateKind } from "@starter/shared";
import { PrivateWorkspace } from "../../models/PrivateData.js";
import type { WorkspaceMemberDocLike } from "../../models/WorkspaceMember.js";
export async function assertStandardWorkspace(workspaceId: string): Promise<void> {
  if (await PrivateWorkspace.exists({ workspaceId })) throw new TRPCError({ code: "PRECONDITION_FAILED", message: PRIVATE_WORKSPACE_REQUIRED });
}
export function privateReaders(kind: PrivateKind, authorId: string | null, members: readonly WorkspaceMemberDocLike[]): string[] {
  return readersForPrivateRecord(kind, authorId, members.map((m) => ({ ...m, publicKey: {} as never }))).map((m) => m.userId).sort();
}
export function canWritePrivate(kind: PrivateKind, authorId: string | null, actor: WorkspaceMemberDocLike): boolean {
  if (["entries", "entryMoney", "favorites", "imports"].includes(kind)) return authorId === actor.userId;
  return actor.role === "owner" || actor.role === "admin";
}
