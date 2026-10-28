import { TRPCError } from "@trpc/server";
import { PRIVATE_WORKSPACE_REQUIRED, signedPrivateTimerSchema } from "@starter/shared";
import { canonicalJson, privateTimerRoot } from "@starter/core";
import { PrivateTimerVersion } from "../../models/PrivateTimer.js";
import { PrivateAccount } from "../../models/PrivateData.js";
import { transactionSession } from "../business-transaction.js";
import { fencePrivateAccount } from "./account-erasure-fence.js";
import { verifyPrivateChange } from "./signatures.js";
/** Call after the account fence for a mutation. Legacy accounts have the
 * initial empty checkpoint; malformed or unsigned nonempty states refuse. */
export async function privateTimerCheckpoint(userId: string) {
  const account = await PrivateAccount.findOne({ userId }).lean();
  if (!account) {
    if (await PrivateTimerVersion.exists({ userId })) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Private timer history has no matching account identity. Existing work was kept." });
    return { account: null, revision: 0, root: null, current: null, signed: null } as const;
  }
  const revision = account.timerRevision ?? 0, root = account.timerRoot ?? null;
  const latest = await PrivateTimerVersion.findOne({ userId }).sort({ revision: -1 }).lean();
  if (revision === 0 && root === null && account.timerSigned == null && !latest) return { account, revision: 0, root: null, current: null, signed: null } as const;
  try {
    const signed = signedPrivateTimerSchema.parse(account.timerSigned);
    if (!Number.isSafeInteger(revision) || signed.header.userId !== userId || signed.header.revision !== revision || root !== await privateTimerRoot(signed)) throw new Error();
    if (!latest || latest.userId !== userId || latest.revision !== revision || latest.root !== root || latest.operationId !== signed.header.operationId) throw new Error();
    const retained = signedPrivateTimerSchema.parse(latest.signed);
    if (canonicalJson(retained.header) !== canonicalJson(signed.header)) throw new Error();
    await verifyPrivateChange(account.identity.signingPublicKey, retained.header, retained.signature);
    await verifyPrivateChange(account.identity.signingPublicKey, signed.header, signed.signature);
    return { account, revision, root, current: signed.header.current, signed };
  } catch { throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Private timer state could not be verified. Existing work was kept." }); }
}
/** All standard writes that would leave an entry running take this same
 * account fence, including model-level creates and manual reopen operations.
 * Closing/deleting ordinary time remains possible during account erasure. */
export async function assertNoPrivateRunningTimer(userId: string, read = false): Promise<void> {
  if (transactionSession()) await fencePrivateAccount(userId);
  const checkpoint = await privateTimerCheckpoint(userId);
  if (checkpoint.current) throw new TRPCError(read ? { code: "PRECONDITION_FAILED", message: PRIVATE_WORKSPACE_REQUIRED } : {
    code: "CONFLICT", message: "A timer is already running in another workspace. Stop it from a client signed in there before starting one here.",
  });
}
