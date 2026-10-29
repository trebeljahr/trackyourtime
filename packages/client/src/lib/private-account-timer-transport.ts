import { privateTimerAckSchema, privateTimerPageSchema, privateTimerTransitionSchema, privateTimerVersionsInputSchema, type PrivateTimerPage, type PrivateTimerTransition } from "@starter/shared";
import { privateScopedRpc } from "./private-scoped-rpc";
export type PrivateAccountTimerTransport = { commit: (transition: PrivateTimerTransition) => Promise<{ revision: number; root: string }>; versions: (input: { after: number; through?: number }) => Promise<PrivateTimerPage> };
/** Fixed account/origin channel. Only exact saved packets leave this adapter;
 * version uncertainty, scope changes and rollout refusals never fall back to
 * the ordinary timer API or its plaintext durable queue. */
export function privateAccountTimerTransport(userId: string): PrivateAccountTimerTransport {
  const { rpc, supported } = privateScopedRpc(userId, "privacy.accountTimer", 20_000);
  const standard = privateScopedRpc(userId, "privacy.standardTimerHandoff", 20_000);
  return {
    commit: async raw => {
      const input = structuredClone(privateTimerTransitionSchema.parse(raw)), channel = input.signed.header.standardStart ? standard : { rpc, supported }; channel.supported();
      const result = await channel.rpc.privacy.timerWrite.mutate(input); channel.supported(); return privateTimerAckSchema.parse(result);
    },
    versions: async raw => {
      const input = privateTimerVersionsInputSchema.parse({ ...raw }); supported();
      const result = await rpc.privacy.timerVersions.mutate(input); supported(); return privateTimerPageSchema.parse(result);
    },
  };
}
