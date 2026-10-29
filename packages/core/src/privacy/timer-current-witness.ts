import { privateChainedWorkspaceChangeSchema, signedPrivateTimerSchema, type PrivateChainedWorkspaceChange, type SignedPrivateTimer } from "@starter/shared";
import { canonicalJson, decodeSecret, type PublicKey } from "./crypto.js";
import { privateRecordDigest, privateWorkspaceManifest, privateWorkspaceManifestForReader, verifyPrivateWorkspaceChange } from "./workspace-edits.js";
import { verifyPrivateTimer } from "./account-timer.js";
import { privateWorkspaceChainRoot } from "./history-chain.js";
import type { PrivateTimerTransition } from "@starter/shared";
/** A saved reader projection keeps the current clock's exact encrypted body
 * available offline after unrelated workspace history advances. Its author
 * key and head come from the independently pinned account timer, never a feed.
 * It grants no workspace membership or permission to replay the change. */
export async function verifyPrivateTimerCurrentWitness(input: unknown, signed: SignedPrivateTimer, options: { scope: { server: string; userId: string }; signingPublicKey: PublicKey; current: () => boolean }): Promise<PrivateChainedWorkspaceChange> {
  const change = structuredClone(privateChainedWorkspaceChangeSchema.parse(input)), timer = structuredClone(signedPrivateTimerSchema.parse(signed)), header = timer.header, scope = { ...options.scope }, signingPublicKey = structuredClone(options.signingPublicKey), current = options.current;
  const check = () => { if (!current()) throw new Error("Private timer witness scope changed"); }; check();
  await verifyPrivateTimer({ signed: timer, scope, signingPublicKey, previous: { revision: header.revision - 1, root: header.previousRoot, current: header.previous }, current }); check();
  const pointer = header.current, binding = header.edits.find(edit => edit.workspaceId === pointer?.workspaceId), chain = change.chain.header;
  if (!pointer || !binding || header.server !== scope.server || header.userId !== scope.userId || chain.server !== scope.server || chain.workspaceId !== pointer.workspaceId || chain.userId !== scope.userId || chain.operationId !== binding.operationId || chain.expectedRevision !== binding.expectedRevision || await privateWorkspaceChainRoot(change.chain) !== binding.head) throw new Error("Current timer witness differs from its account binding"); check();
  const { chain: history, ...projected } = change; void history;
  const verified = await verifyPrivateWorkspaceChange(projected, { workspaceId: pointer.workspaceId, userId: scope.userId, after: binding.expectedRevision }, signingPublicKey); check();
  const reader = chain.readers.find(row => row.userId === scope.userId);
  if (verified.manifest.userId !== scope.userId || !reader || reader.digest !== await privateRecordDigest(verified.manifest)) throw new Error("Current timer reader projection differs from its account binding"); check();
  const key = await crypto.subtle.importKey("jwk", signingPublicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decodeSecret(change.chain.signature, 64), new TextEncoder().encode(canonicalJson(chain)))) throw new Error("Current timer history signature did not match"); check();
  const targets = [pointer, header.previous].filter(row => row?.workspaceId === pointer.workspaceId).map(row => row!.entryId);
  if (verified.manifest.records.some(row => row.authorId !== scope.userId || !((row.kind === "imports" && row.id === `entryoperations:${header.operationId}`) || (["entries", "entryMoney"].includes(row.kind) && targets.includes(row.id)))) || verified.manifest.remove.some(row => row.authorId !== scope.userId || !["entries", "entryMoney"].includes(row.kind) || !targets.includes(row.id)) || !verified.records.some(row => row.kind === "entries" && row.id === pointer.entryId && row.authorId === scope.userId)) throw new Error("Current timer witness is missing its exact author-owned body");
  check(); return change;
}
export async function privateTimerWitnessFromPacket(packet: PrivateTimerTransition): Promise<PrivateChainedWorkspaceChange | null> {
  const { header } = packet.signed, pointer = header.current;
  if (!pointer) return null;
  const edit = packet.edits.find(edit => edit.edit.workspaceId === pointer.workspaceId), reader = edit?.readerSignatures.find(row => row.userId === header.userId);
  if (!edit || !reader) throw new Error("Current timer packet is missing its signed reader projection");
  return { revision: edit.edit.expectedRevision + 1, manifest: privateWorkspaceManifestForReader(await privateWorkspaceManifest(edit.edit), header.userId), signature: reader.signature, records: edit.edit.records.filter(row => row.grants.some(grant => grant.userId === header.userId)), chain: edit.chain };
}
