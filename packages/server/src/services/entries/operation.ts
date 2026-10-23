import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { EntryOperation } from "../../models/EntryOperation.js";
import { TimeEntry } from "../../models/TimeEntry.js";
import { isValidObjectId } from "mongoose";
import { supportsBusinessTransactions, withBusinessTransaction } from "../business-transaction.js";
import type { WorkspaceScope } from "../scope.js";

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => [key, canonical(entry)]));
  return value;
}

/** Call only after the request's session and workspace membership are checked.
 * Receipts preserve a result; they never authorize an otherwise refused request. */
export async function withEntryOperation<T>(
  scope: Pick<WorkspaceScope, "userId" | "workspaceId">,
  operation: string,
  input: { operationId?: string },
  work: () => Promise<T>,
): Promise<T> {
  if (!input.operationId) return work(); // Legacy callers retain their existing contract.
  if (!(await supportsBusinessTransactions())) throw new TRPCError({
    code: "PRECONDITION_FAILED", message: "DURABLE_REPLAY_REQUIRES_REPLICA_SET",
  });
  const { operationId, ...payload } = input;
  const id = hash([scope.userId, scope.workspaceId, operationId]);
  const requestHash = hash([operation, canonical(payload)]);
  const read = async (): Promise<{ result: T } | null> => {
    const receipt = await EntryOperation.findById(id).lean();
    if (!receipt) return null;
    if (receipt.requestHash !== requestHash || receipt.operation !== operation) throw new TRPCError({
      code: "CONFLICT", message: "OPERATION_ID_REUSED",
    });
    return { result: receipt.result as T };
  };
  try {
    return await withBusinessTransaction(async () => {
      const prior = await read();
      if (prior) return prior.result;
      // Session clients may stop their timer while viewing another workspace.
      // Charge completion to the timer's reserved space, while keeping the
      // replay key bound to the original request scope.
      let receiptWorkspaceId = scope.workspaceId;
      const entryId = (input as { id?: unknown }).id;
      if ((operation === "entries.stop" || operation === "entries.discard") && typeof entryId === "string" && isValidObjectId(entryId)) {
        const timer = await TimeEntry.findOne({ _id: entryId, authorId: scope.userId }).select({ workspaceId: 1 }).lean();
        if (timer) receiptWorkspaceId = timer.workspaceId;
      } else if (operation === "entries.stop" && entryId === undefined) {
        const timer = await TimeEntry.findOne({ authorId: scope.userId, end: null }).select({ workspaceId: 1 }).lean();
        if (timer) receiptWorkspaceId = timer.workspaceId;
      }
      // Claim the key before any business writes. The placeholder never commits:
      // a crash or thrown error rolls back both the claim and all entry changes.
      await EntryOperation.create({ _id: id, userId: scope.userId, workspaceId: receiptWorkspaceId, requestHash, operation, result: {} });
      const result = await work();
      await EntryOperation.updateOne({ _id: id }, { $set: { result } });
      return result;
    });
  } catch (error) {
    // Concurrent identical requests can race on the first insert. Only a
    // committed matching receipt converts that duplicate-key failure to success.
    if ((error as { code?: unknown })?.code === 11000) {
      const prior = await read();
      if (prior) return prior.result;
    }
    throw error;
  }
}
