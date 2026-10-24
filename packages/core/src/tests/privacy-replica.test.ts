import assert from "node:assert/strict";
import { it } from "node:test";
import { createPrivateWorkspaceReplica, PrivateReplicaConflictError, type PrivateReplicaTransport } from "../privacy/replica.js";
import { createKeyPair, createSigningPair, randomSecret, canonicalJson } from "../privacy/crypto.js";
import { privateWorkspaceManifest, privateWorkspaceManifestForReader, signPrivateWorkspaceEdit } from "../privacy/workspace-edits.js";
import { encryptPrivateRecord, type PlainPrivateRecord } from "../privacy/records.js";
import { PrivateStorageLockedError, PrivateStorageWriteError } from "../privacy/storage.js";
import { memoryStorage, type KeyValueStorage } from "../storage.js";
import type { PrivateWorkspaceChange, SignedPrivateWorkspaceEdit } from "@starter/shared";
const scope = { server: "https://api.example.test", userId: "owner", workspaceId: "workspace" };
const plain = (id: string, description = "Sensitive client work"): PlainPrivateRecord => ({ kind: "entries", id, authorId: "owner", value: { description, start: "2026-10-24T00:00:00.000Z" } });
async function fixture(backing = memoryStorage()) {
  const pair = await createKeyPair(), signing = await createSigningPair(), storageKey = randomSecret();
  let open = true, generation = 0, chain = Promise.resolve<unknown>(undefined);
  const recipients = [{ userId: "owner", role: "owner" as const, canViewOthersTime: true, canViewOthersMoney: true, publicKey: pair.publicKey }];
  const options = { storage: backing, scope, exclusive: <T>(task: () => Promise<T>) => { const result = chain.then(task); chain = result.catch(() => {}); return result; },
    resolveStorageKey: () => { const at = generation; return open ? { key: storageKey, current: () => open && generation === at } : null; },
    resolveIdentity: () => { const at = generation; return open ? { privateKey: pair.privateKey, signingPrivateKey: signing.privateKey, recipients, signingKey: () => signing.publicKey, current: () => open && generation === at } : null; } };
  const calls: SignedPrivateWorkspaceEdit[] = [], journal: PrivateWorkspaceChange[] = [];
  const transport: PrivateReplicaTransport = {
    commit: async (input) => {
      calls.push(structuredClone(input));
      const prior = journal.find((row) => row.manifest.operationId === input.edit.operationId);
      if (prior) return { revision: prior.revision };
      assert.equal(input.edit.expectedRevision, journal.length);
      journal.push({ revision: journal.length + 1, manifest: privateWorkspaceManifestForReader(await privateWorkspaceManifest(input.edit), scope.userId), signature: input.readerSignatures.find((row) => row.userId === scope.userId)!.signature, records: input.edit.records });
      return { revision: journal.length };
    },
    changes: async ({ after, through = journal.length }) => ({ through, next: null, changes: journal.filter((row) => row.revision > after && row.revision <= through) }),
  };
  return { replica: await createPrivateWorkspaceReplica(options), reopen: () => createPrivateWorkspaceReplica(options), backing, transport, journal, calls, pair, signing, recipients, lock: () => { open = false; generation++; }, unlock: () => { open = true; generation++; } };
}
it("keeps queued work encrypted, freezes nested inputs before waiting, and survives a lost save reply and restart", async () => {
  const f = await fixture(), input = plain("entry");
  const queued = f.replica.enqueue({ records: [input] }); input.value.description = "later mutation";
  const operationId = await queued;
  assert.equal((await f.replica.read()).records[0]!.value.description, "Sensitive client work");
  const raw = (await f.backing.getItem(`${f.replica.namespace}${encodeURIComponent("segments:replica:manifest")}`))!;
  assert.doesNotMatch(raw, /Sensitive client work|2026-10-24|owner|entries/);
  const lost = { ...f.transport, commit: async (value: SignedPrivateWorkspaceEdit) => { await f.transport.commit(value); throw new Error("Reply lost"); } };
  await assert.rejects(f.replica.flushOne(lost), /Reply lost/);
  assert.equal((await f.replica.read()).pending, 1);
  const reopened = await f.reopen();
  assert.deepEqual(await reopened.flushOne(f.transport), { revision: 1, pending: 0 });
  assert.equal(f.journal.length, 1); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0]!.edit.operationId, operationId);
  assert.equal(canonicalJson(f.calls[0]), canonicalJson(f.calls[1]));
  assert.equal((await reopened.read()).records[0]!.value.description, "Sensitive client work");
});
it("never sends an edit whose local durable write could not be confirmed", async () => {
  const backing = memoryStorage(); let drops = false;
  const faulty: KeyValueStorage = { ...backing, setItem: async (key, value) => { if (!drops) await backing.setItem(key, value); } };
  const f = await fixture(faulty); await f.replica.enqueue({ records: [plain("entry")] }); drops = true;
  await assert.rejects(f.replica.flushOne(f.transport), PrivateStorageWriteError);
  assert.equal(f.calls.length, 0); drops = false;
  assert.equal((await f.replica.read()).pending, 1);
});
it("keeps conflicting offline edits and refuses silent rebasing onto another device's work", async () => {
  const f = await fixture(); await f.replica.enqueue({ records: [plain("local")] });
  const record = await encryptPrivateRecord(scope.workspaceId, plain("remote"), f.recipients, 1);
  const remote = await signPrivateWorkspaceEdit({ v: 1, workspaceId: scope.workspaceId, userId: scope.userId, operationId: crypto.randomUUID(), expectedRevision: 0, records: [record], remove: [] }, f.signing.privateKey, ["owner"]);
  await f.transport.commit(remote); await f.replica.pull(f.transport);
  const view = await f.replica.read(); assert.equal(view.conflict, true); assert.equal(view.pending, 1); assert.equal(view.records.length, 2);
  await assert.rejects(f.replica.flushOne(f.transport), PrivateReplicaConflictError);
  assert.equal(f.calls.length, 1);
});
it("refuses omitted or corrupt feed data without advancing its checkpoint or losing the pending edit", async () => {
  const f = await fixture(); await f.replica.enqueue({ records: [plain("entry")] });
  const omitted = { ...f.transport, changes: async () => ({ through: 1, next: null, changes: [] }) };
  await assert.rejects(f.replica.flushOne(omitted), /omitted revisions/);
  assert.equal((await f.replica.read()).revision, 0); assert.equal((await f.replica.read()).pending, 1);
  const corrupt = structuredClone(f.journal[0]!); corrupt.records[0]!.box.nonce = "AAAAAAAAAAAAAAAA";
  await assert.rejects(f.replica.pull({ ...f.transport, changes: async () => ({ through: 1, next: null, changes: [corrupt] }) }), /did not match/);
  assert.equal((await f.replica.read()).revision, 0);
  await f.replica.pull(f.transport); assert.equal((await f.replica.read()).pending, 0);
});
it("applies signed deletions and does not expose cached views after locking", async () => {
  const f = await fixture(); await f.replica.enqueue({ records: [plain("entry")] }); await f.replica.flushOne(f.transport);
  await f.replica.enqueue({ records: [], remove: [{ kind: "entries", id: "entry", authorId: "owner" }] });
  assert.equal((await f.replica.read()).records.length, 0);
  await f.replica.flushOne(f.transport); assert.equal((await f.replica.read()).revision, 2);
  f.lock();
  await assert.rejects(f.replica.read(), PrivateStorageLockedError);
  await assert.rejects(f.replica.enqueue({ records: [plain("locked")] }), PrivateStorageLockedError);
  f.unlock(); assert.equal((await f.replica.read()).records.length, 0);
});
it("a lock during the network save retains the exact durable request for the next unlock", async () => {
  const f = await fixture(); await f.replica.enqueue({ records: [plain("entry")] });
  await assert.rejects(f.replica.flushOne({ ...f.transport, commit: async (input) => { const result = await f.transport.commit(input); f.lock(); return result; } }), PrivateStorageLockedError);
  f.unlock(); assert.equal((await f.replica.read()).pending, 1);
  await f.replica.flushOne(f.transport); assert.equal((await f.replica.read()).pending, 0);
});

it("does not accept a receipt unless the journal proves that exact outbox operation", async () => {
  const f = await fixture(); await f.replica.enqueue({ records: [plain("local")] });
  const record = await encryptPrivateRecord(scope.workspaceId, plain("remote"), f.recipients, 1);
  const remote = await signPrivateWorkspaceEdit({ v: 1, workspaceId: scope.workspaceId, userId: scope.userId, operationId: crypto.randomUUID(), expectedRevision: 0, records: [record], remove: [] }, f.signing.privateKey, ["owner"]);
  await f.transport.commit(remote);
  await assert.rejects(f.replica.flushOne({ ...f.transport, commit: async () => ({ revision: 1 }) }), /no verified journal record/);
  assert.equal((await f.replica.read()).pending, 1);
});
