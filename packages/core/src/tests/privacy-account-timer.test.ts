import assert from "node:assert/strict";
import { it } from "node:test";
import { privateTimerTransitionSchema, type PrivateTimerHeader } from "@starter/shared";
import { canonicalJson, createSigningPair, encodeSecret, randomSecret } from "../privacy/crypto.js";
import { privateTimerRoot, signPrivateTimer, verifyPrivateTimer } from "../privacy/account-timer.js";
const scope = { server: "https://api.example.test", userId: "owner" }, pointer = { workspaceId: "workspace", entryId: crypto.randomUUID() };
const header = (): PrivateTimerHeader => ({ v: 1, protocol: "trackyourtime-private-account-timer-v1", ...scope, operationId: crypto.randomUUID(), revision: 1, previousRoot: null, previous: null, current: pointer, standardStop: null, edits: [{ workspaceId: pointer.workspaceId, operationId: crypto.randomUUID(), expectedRevision: 1, head: encodeSecret(randomSecret()) }] });
it("authenticates account timer coordinates and consecutive history without signing work content", async () => {
  const pair = await createSigningPair(), initial = header(), signed = await signPrivateTimer(initial, pair.privateKey, () => true);
  const verify = (value: unknown, previous = { revision: 0, root: null as string | null, current: null as typeof pointer | null }) => verifyPrivateTimer({ scope, signed: value, signingPublicKey: pair.publicKey, previous, current: () => true });
  const first = await verify(signed); assert.equal(first.root, await privateTimerRoot(signed));
  const resigned = await signPrivateTimer(initial, pair.privateKey, () => true); assert.equal(await privateTimerRoot(resigned), first.root);
  const close = await signPrivateTimer({ ...initial, operationId: crypto.randomUUID(), revision: 2, previousRoot: first.root, previous: pointer, current: null }, pair.privateKey, () => true);
  assert.equal((await verify(close, { revision: 1, root: first.root, current: pointer })).signed.header.current, null);
  await assert.rejects(verify(close)); await assert.rejects(verify(close, { revision: 1, root: first.root, current: { ...pointer, entryId: crypto.randomUUID() } }));
  assert.doesNotMatch(canonicalJson(signed), /description|hourlyRate|start|duration/);
});
it("rejects forged signatures, origins, authors, checkpoint roots and content-bearing metadata", async () => {
  const pair = await createSigningPair(), signed = await signPrivateTimer(header(), pair.privateKey, () => true);
  const verify = (value: unknown) => verifyPrivateTimer({ scope, signed: value, signingPublicKey: pair.publicKey, previous: { revision: 0, root: null, current: null }, current: () => true });
  for (const value of [{ ...signed, signature: "A".repeat(86) }, { ...signed, header: { ...signed.header, userId: "other" } }, { ...signed, header: { ...signed.header, server: "https://other.test" } }, { ...signed, header: { ...signed.header, description: "Private work" } }]) await assert.rejects(verify(value));
  await assert.rejects(signPrivateTimer({ ...header(), server: "https://user:password@api.example.test" }, pair.privateKey, () => true));
  await assert.rejects(signPrivateTimer({ ...header(), previous: pointer }, pair.privateKey, () => true));
});
it("does not revive a signing or verification operation after keys lock during crypto", async () => {
  const pair = await createSigningPair(); let active = true; const pending = signPrivateTimer(header(), pair.privateKey, () => active); active = false; await assert.rejects(pending, /scope changed/);
  const signed = await signPrivateTimer(header(), pair.privateKey, () => true); active = true;
  const check = verifyPrivateTimer({ scope, signed, signingPublicKey: pair.publicKey, previous: { revision: 0, root: null, current: null }, current: () => active }); active = false; await assert.rejects(check, /scope changed/);
});
it("keeps standard stop timing outside retained signed account metadata and refuses undeclared bodies", async () => {
  const pair = await createSigningPair(), signed = await signPrivateTimer(header(), pair.privateKey, () => true);
  assert.equal(privateTimerTransitionSchema.safeParse({ signed, edits: [], standardStopEnd: "2026-10-01T12:00:00.000Z" }).success, false);
  await assert.rejects(signPrivateTimer({ ...header(), standardStop: { workspaceId: "standard", entryId: "1".repeat(24), end: "2026-10-01T12:00:00.000Z" } } as PrivateTimerHeader, pair.privateKey, () => true));
  await assert.rejects(signPrivateTimer({ ...header(), edits: [{ ...header().edits[0]!, workspaceId: "foreign" }] }, pair.privateKey, () => true));
});

it("captures the verifier's original guard before waiting for crypto", async () => {
  const pair = await createSigningPair(), signed = await signPrivateTimer(header(), pair.privateKey, () => true); let active = true;
  const options = { scope: { ...scope }, signed, signingPublicKey: pair.publicKey, previous: { revision: 0, root: null, current: null }, current: () => active };
  const pending = verifyPrivateTimer(options); active = false; options.current = () => true; options.scope.userId = "later-user"; await assert.rejects(pending, /scope changed/);
});

it("binds standard-start coordinates without signing its plaintext body and rejects undeclared handoffs", async () => {
  const pair = await createSigningPair(), original = header(), initial = await signPrivateTimer(original, pair.privateKey, () => true);
  const next: PrivateTimerHeader = { ...original, operationId: crypto.randomUUID(), revision: 2, previousRoot: await privateTimerRoot(initial), previous: pointer, current: null, standardStart: { workspaceId: "standard", entryId: "a".repeat(24) } };
  const signed = await signPrivateTimer(next, pair.privateKey, () => true); assert.doesNotMatch(canonicalJson(signed), /description|startTime|hourlyRate/);
  await assert.rejects(signPrivateTimer({ ...next, current: pointer }, pair.privateKey, () => true));
  await assert.rejects(signPrivateTimer({ ...next, standardStart: { ...next.standardStart!, workspaceId: pointer.workspaceId } }, pair.privateKey, () => true));
  await assert.rejects(signPrivateTimer({ ...next, standardStart: { ...next.standardStart!, description: "Must stay outside metadata" } } as PrivateTimerHeader, pair.privateKey, () => true));
  assert.equal(privateTimerTransitionSchema.safeParse({ signed, edits: [], standardStartInput: { description: "Missing captured start" } }).success, false);
});
