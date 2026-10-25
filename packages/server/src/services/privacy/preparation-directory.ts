import { TRPCError } from "@trpc/server";
import { canonicalJson, verifyPrivateWorkspaceDirectory } from "@starter/core";
import { PrivateAccount, PrivateDirectory } from "../../models/PrivateData.js";
import { WorkspaceMember } from "../../models/WorkspaceMember.js";
import { fenceWorkspace, supportsBusinessTransactions, withBusinessTransaction } from "../business-transaction.js";
/** Current public keys/roles only. No identity recovery wrappers leave this
 * server-internal helper. Reuse the same fenced checks before lease creation
 * and when validating complete staged ciphertext. */
export async function captureCurrentPreparationDirectory(scope: { server: string; workspaceId: string; userId: string }) {
  scope = { ...scope };
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED" });
  return withBusinessTransaction(async () => {
    const { server, workspaceId, userId } = scope; await fenceWorkspace(workspaceId);
    if (!await WorkspaceMember.exists({ workspaceId, userId, role: "owner" })) throw new TRPCError({ code: "FORBIDDEN" });
    const directory = await PrivateDirectory.findOne({ workspaceId }).sort({ revision: -1 }).lean();
    if (!directory || directory.signed.directory.server !== server || directory.signed.directory.ownerId !== userId) throw new TRPCError({ code: "CONFLICT" });
    if (Buffer.byteLength(JSON.stringify(directory.signed)) > 256 * 1024) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE" });
    try {
      const checked = await verifyPrivateWorkspaceDirectory(directory.signed, { server, workspaceId }, { ownerId: directory.signed.signerId, signingPublicKey: directory.signerPublicKey, revision: directory.revision - 1, digest: directory.signed.directory.previousDigest });
      if (checked.digest !== directory.digest) throw new Error("Stored directory digest changed");
    } catch { throw new TRPCError({ code: "CONFLICT", message: "Workspace key directory needs verification." }); }
    const members = await WorkspaceMember.find({ workspaceId }).lean();
    const permissions = (rows: readonly { userId: string; role: string; canViewOthersTime?: boolean; canViewOthersMoney?: boolean }[]) => [...rows].sort((a, b) => a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0).map((m) => ({ userId: m.userId, role: m.role, canViewOthersTime: m.role === "owner" || !!m.canViewOthersTime, canViewOthersMoney: m.role === "owner" || !!m.canViewOthersMoney }));
    if (canonicalJson(permissions(members)) !== canonicalJson(permissions(directory.signed.directory.members))) throw new TRPCError({ code: "CONFLICT", message: "Workspace sharing changed. Source data was kept." });
    await PrivateAccount.updateMany({ userId: { $in: members.map((member) => member.userId) } }, { $inc: { keySerial: 1 } });
    const accounts = await PrivateAccount.find({ userId: { $in: members.map((member) => member.userId) } }).select({ userId: 1, "identity.publicKey": 1, "identity.signingPublicKey": 1 }).lean();
    const coordinates = ({ kty, crv, x, y }: typeof directory.signed.directory.members[number]["publicKey"]) => ({ kty, crv, x, y });
    for (const member of directory.signed.directory.members) {
      const account = accounts.find((row) => row.userId === member.userId);
      if (!account?.identity?.publicKey || !account.identity.signingPublicKey || canonicalJson(coordinates(account.identity.publicKey)) !== canonicalJson(coordinates(member.publicKey)) || canonicalJson(coordinates(account.identity.signingPublicKey)) !== canonicalJson(coordinates(member.signingPublicKey))) throw new TRPCError({ code: "CONFLICT", message: "Workspace account keys changed. Verify the directory again." });
    }
    return directory;
  });
}
