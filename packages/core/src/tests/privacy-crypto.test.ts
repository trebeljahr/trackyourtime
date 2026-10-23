import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createKeyPair, decryptBackup, deriveSecret, encryptBackup, randomSecret, seal, sealForRecipient, unseal, unsealForRecipient } from "../privacy/crypto.js";

describe("private data encryption", () => {
  it("authenticates the key, content and account/record context", async () => {
    const key = randomSecret(), value = { description: "private document title", amount: 350 };
    const box = await seal(key, value, "account-A:workspace-B:record-C");
    assert.ok(!JSON.stringify(box).includes(value.description));
    assert.deepEqual(await unseal(key, box, "account-A:workspace-B:record-C"), value);
    await assert.rejects(unseal(randomSecret(), box, "account-A:workspace-B:record-C"));
    await assert.rejects(unseal(key, box, "account-X:workspace-B:record-C"));
    await assert.rejects(unseal(key, { ...box, data: (box.data[0] === "A" ? "B" : "A") + box.data.slice(1) }, "account-A:workspace-B:record-C"));
    assert.notEqual((await seal(key, value, "account-A:workspace-B:record-C")).nonce, box.nonce);
  });
  it("only the intended recipient can unwrap a shared workspace key", async () => {
    const alice = await createKeyPair(), bob = await createKeyPair();
    const box = await sealForRecipient(alice.publicKey, { workspaceKey: "synthetic-secret" }, "workspace:1:user:alice");
    assert.deepEqual(await unsealForRecipient(alice.privateKey, box, "workspace:1:user:alice"), { workspaceKey: "synthetic-secret" });
    await assert.rejects(unsealForRecipient(bob.privateKey, box, "workspace:1:user:alice"));
    await assert.rejects(unsealForRecipient(alice.privateKey, box, "workspace:2:user:alice"));
  });
  it("separates derived keys by purpose and refuses absent context or invalid root secrets", async () => {
    const master = randomSecret();
    const activity = await deriveSecret(master, "local-activity"), backup = await deriveSecret(master, "backup");
    assert.notDeepEqual(activity, backup);
    assert.deepEqual(activity, await deriveSecret(master, "local-activity"));
    await assert.rejects(deriveSecret(master, ""));
    await assert.rejects(deriveSecret(new Uint8Array(0), "backup"));
    await assert.rejects(deriveSecret(new Uint8Array(31), "backup"));
  });
  it("restores encrypted backups and refuses wrong passwords or unbounded KDF parameters", async () => {
    const password = "a separate long test-only backup password";
    const box = await encryptBackup({ entries: [{ description: "private test" }] }, password);
    assert.deepEqual(await decryptBackup(box, password), { entries: [{ description: "private test" }] });
    await assert.rejects(decryptBackup(box, "a different long test password"));
    await assert.rejects(decryptBackup({ ...box, iterations: 999999999 } as never, password));
  });
});
