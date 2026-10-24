import { readersForPrivateRecord } from "@starter/core";
import { TRPCError } from "@trpc/server";
import { canWritePrivateRecord, PRIVATE_WORKSPACE_REQUIRED, type PrivateKind } from "@starter/shared";
import { PrivateWorkspace } from "../../models/PrivateData.js";
import type { WorkspaceMemberDocLike } from "../../models/WorkspaceMember.js";
import { discardPrivatePreparation } from "./preparation.js";
export async function assertStandardWorkspace(workspaceId: string): Promise<void> {
  const mode = await PrivateWorkspace.findOne({ workspaceId }).lean();
  if (!mode) return;
  if (mode.state === "migrating" && mode.leaseUntil.getTime() <= Date.now() && await discardPrivatePreparation(workspaceId, mode.migrationId, true)) return;
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: PRIVATE_WORKSPACE_REQUIRED });
}
export function privateReaders(kind: PrivateKind, authorId: string | null, members: readonly WorkspaceMemberDocLike[]): string[] {
  return readersForPrivateRecord(kind, authorId, members.map((m) => ({ ...m, publicKey: {} as never }))).map((m) => m.userId).sort();
}
export function canWritePrivate(kind: PrivateKind, authorId: string | null, actor: WorkspaceMemberDocLike): boolean {
  return canWritePrivateRecord(kind, authorId, actor);
}
