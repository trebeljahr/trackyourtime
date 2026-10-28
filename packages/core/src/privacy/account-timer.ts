import { privateTimerHeaderSchema, signedPrivateTimerSchema, signedPrivateChainedEditSchema, type PrivateTimerHeader, type PrivateTimerPointer, type SignedPrivateTimer, type SignedPrivateChainedEdit } from "@starter/shared";
import { canonicalJson, decodeSecret, signPrivateChange, type PublicKey } from "./crypto.js";
import { privateRecordDigest, privateWorkspaceManifest } from "./workspace-edits.js";
import { privateWorkspaceChainRoot } from "./history-chain.js";
export const privateTimerRoot = (signed: SignedPrivateTimer) => privateRecordDigest(signedPrivateTimerSchema.parse(signed).header);
export async function privateTimerEditBindings(edits: readonly SignedPrivateChainedEdit[]) {
  const rows = [];
  for (const signed of edits.map(row => structuredClone(signedPrivateChainedEditSchema.parse(row)))) {
    if (signed.chain.header.workspaceId !== signed.edit.workspaceId || signed.chain.header.userId !== signed.edit.userId || signed.chain.header.operationId !== signed.edit.operationId || signed.chain.header.expectedRevision !== signed.edit.expectedRevision || signed.chain.header.manifestDigest !== await privateRecordDigest(await privateWorkspaceManifest(signed.edit))) throw new Error("Private timer edit differs from its signed history binding");
    rows.push({ workspaceId: signed.edit.workspaceId, operationId: signed.edit.operationId, expectedRevision: signed.edit.expectedRevision, head: await privateWorkspaceChainRoot(signed.chain) });
  }
  return rows.sort((a, b) => a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0);
}
/** Sign only public timer coordinates and ciphertext history bindings. Work
 * descriptions, rates, tags and actual entry bodies stay inside record boxes. */
export async function signPrivateTimer(header: PrivateTimerHeader, signingPrivateKey: PublicKey, current: () => boolean): Promise<SignedPrivateTimer> {
  const captured = structuredClone(privateTimerHeaderSchema.parse(header));
  if (new URL(captured.server).origin !== captured.server) throw new Error("Private timer origin is not canonical");
  if (!current()) throw new Error("Private timer scope changed");
  const signature = await signPrivateChange(signingPrivateKey, captured);
  if (!current()) throw new Error("Private timer scope changed");
  return { header: captured, signature };
}
export async function verifyPrivateTimer(options: { signed: unknown; scope: { server: string; userId: string }; signingPublicKey: PublicKey; previous: { revision: number; root: string | null; current: PrivateTimerPointer | null }; current: () => boolean }) {
  options = { ...options, scope: { ...options.scope }, previous: structuredClone(options.previous), signingPublicKey: structuredClone(options.signingPublicKey) };
  const signed = structuredClone(signedPrivateTimerSchema.parse(options.signed)), { header } = signed;
  if (new URL(header.server).origin !== header.server) throw new Error("Private timer origin is not canonical");
  const check = () => { if (!options.current()) throw new Error("Private timer scope changed"); }; check();
  if (header.server !== options.scope.server || header.userId !== options.scope.userId || header.revision !== options.previous.revision + 1 || header.previousRoot !== options.previous.root || canonicalJson(header.previous) !== canonicalJson(options.previous.current)) throw new Error("Private timer history differs from its trusted checkpoint");
  const key = await crypto.subtle.importKey("jwk", options.signingPublicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decodeSecret(signed.signature, 64), new TextEncoder().encode(canonicalJson(header)))) throw new Error("Private timer signature did not match"); check();
  const root = await privateTimerRoot(signed); check(); return { signed, root };
}
