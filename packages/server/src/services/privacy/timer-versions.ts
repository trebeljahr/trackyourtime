import { TRPCError } from "@trpc/server";
import { canonicalJson, verifyPrivateTimer } from "@starter/core";
import { privateTimerPageSchema, signedPrivateTimerSchema, type PrivateTimerPage } from "@starter/shared";
import { PrivateTimerVersion } from "../../models/PrivateTimer.js";
import { supportsBusinessTransactions, withBusinessTransaction } from "../business-transaction.js";
import { fencePrivateAccount } from "./account-erasure-fence.js";
import { privateTimerCheckpoint } from "./timer-state.js";
const broken = () => new TRPCError({ code: "PRECONDITION_FAILED", message: "Account timer history is incomplete or inconsistent. Existing work was kept." });
/** Immutable account-owned metadata only. An empty page never enrolls a
 * device. Clients advance solely from their independently trusted checkpoint. */
export async function privateTimerVersions(inputScope: { server: string; userId: string }, after: number, through?: number): Promise<PrivateTimerPage> {
  const scope = { ...inputScope };
  try {
    if (new URL(scope.server).origin !== scope.server || !/^https?:\/\//.test(scope.server) || !scope.userId || scope.userId.length > 100) throw new Error();
  } catch { throw new TRPCError({ code: "BAD_REQUEST" }); }
  const valid = (value: number) => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
  if (!valid(after) || (through !== undefined && (!valid(through) || through < after))) throw new TRPCError({ code: "BAD_REQUEST" });
  if (!await supportsBusinessTransactions()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Account timer history requires MongoDB transactions." });
  return withBusinessTransaction(async () => {
    await fencePrivateAccount(scope.userId);
    const current = await privateTimerCheckpoint(scope.userId), account = current.account;
    if (!account) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Set up the private account identity before syncing timer history." });
    if (current.signed && current.signed.header.server !== scope.server) throw broken();
    const end = through ?? current.revision;
    if (after > end || end > current.revision) throw new TRPCError({ code: "CONFLICT", message: "Account timer history moved backward. Local work was kept." });
    const at = async (revision: number) => {
      if (revision === 0) return { revision: 0, root: null, current: null } as const;
      const row = await PrivateTimerVersion.findOne({ userId: scope.userId, revision }).lean();
      if (!row) throw broken();
      try {
        const signed = signedPrivateTimerSchema.parse(row.signed), { header } = signed;
        if (row.revision !== revision || header.revision !== revision || row.operationId !== header.operationId || header.server !== scope.server || header.userId !== scope.userId) throw broken();
        const checked = await verifyPrivateTimer({ signed, scope, signingPublicKey: account.identity.signingPublicKey, previous: { revision: revision - 1, root: header.previousRoot, current: header.previous }, current: () => true });
        if (checked.root !== row.root) throw broken();
        return { revision, root: checked.root, current: header.current };
      } catch { throw broken(); }
    };
    const boundary = await at(end); let previous = await at(after);
    const rows = await PrivateTimerVersion.find({ userId: scope.userId, revision: { $gt: after, $lte: end } }).sort({ revision: 1 }).limit(16).lean();
    const versions = [];
    for (const row of rows) {
      try {
        const signed = signedPrivateTimerSchema.parse(row.signed);
        if (row.revision !== previous.revision + 1 || row.operationId !== signed.header.operationId) throw broken();
        const checked = await verifyPrivateTimer({ signed, scope, signingPublicKey: account.identity.signingPublicKey, previous, current: () => true });
        if (checked.root !== row.root) throw broken();
        versions.push(checked.signed); previous = { revision: row.revision, root: row.root, current: signed.header.current };
      } catch { throw broken(); }
    }
    if (after < end && !versions.length) throw broken();
    if (previous.revision === end && canonicalJson(previous) !== canonicalJson(boundary)) throw broken();
    return privateTimerPageSchema.parse({ through: end, root: boundary.root, next: previous.revision < end ? previous.revision : null, versions });
  });
}
