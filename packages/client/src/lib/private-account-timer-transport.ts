import { privateTimerAckSchema, privateTimerPageSchema, privateTimerTransitionSchema, privateTimerVersionsInputSchema, type PrivateTimerPage, type PrivateTimerTransition } from "@starter/shared";
import { privateBoundRpc, privateScopedRpc } from "./private-scoped-rpc";
import { capturePrivateRequestScope, checkPrivateRequestScope } from "./private-request-scope";
import { workspaceContentRoute } from "./private-content-route";
export type PrivateAccountTimerTransport = { commit: (transition: PrivateTimerTransition) => Promise<{ revision: number; root: string }>; versions: (input: { after: number; through?: number }) => Promise<PrivateTimerPage> };
/** Fixed account/origin channel. Only exact saved packets leave this adapter;
 * version uncertainty, scope changes and rollout refusals never fall back to
 * the ordinary timer API or its plaintext durable queue. */
export function privateAccountTimerTransport(userId: string): PrivateAccountTimerTransport {
  const { rpc, supported, binding } = privateScopedRpc(userId, "privacy.accountTimer", 20_000);
  const receipts = privateScopedRpc(userId, "privacy.timerIntentReceipts", 20_000);
  const standard = privateScopedRpc(userId, "privacy.standardTimerHandoff", 20_000);
  return {
    commit: async raw => {
      const input = structuredClone(privateTimerTransitionSchema.parse(raw)), original = input.signed.header.standardStart ? capturePrivateRequestScope() : null;
      let channel = input.edits.some(row => row.edit.records.some(record => record.kind === "imports")) ? receipts : input.signed.header.standardStart ? standard : { rpc, supported };
      channel.supported();
      if (input.signed.header.standardStart) {
        const route = await workspaceContentRoute(userId, input.signed.header.standardStart.workspaceId, binding.server);
        const check = () => { binding.check(); checkPrivateRequestScope(original!); route.check(); };
        check(); if (route.mode !== "standard") throw new Error("The saved standard timer target is now private. Its original packet was kept.");
        const guarded = { ...binding, check, current: () => { try { check(); return true; } catch { return false; } } };
        channel = privateBoundRpc(guarded, input.edits.some(row => row.edit.records.some(record => record.kind === "imports")) ? "privacy.timerIntentReceipts" : "privacy.standardTimerHandoff", 20_000);
      }
      const result = await channel.rpc.privacy.timerWrite.mutate(input); channel.supported(); return privateTimerAckSchema.parse(result);
    },
    versions: async raw => {
      const input = privateTimerVersionsInputSchema.parse({ ...raw }); supported();
      const result = await rpc.privacy.timerVersions.mutate(input); supported(); return privateTimerPageSchema.parse(result);
    },
  };
}
