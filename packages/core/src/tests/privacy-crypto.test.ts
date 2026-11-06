import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createKeyPair, decryptBackup, derivePasswordKeys, deriveSecret, encodeSecret, encryptBackup, LOGIN_SECRET_PREFIX, newPasswordKdf, randomSecret, seal, sealForRecipient, unseal, unsealForRecipient } from "../privacy/crypto.js";

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

describe("account password keys", () => {
  const kdf = { v: 1, kdf: "PBKDF2-SHA256", iterations: 600000, salt: "AAECAwQFBgcICQoLDA0ODw" } as const;
  it("pins the derivation, so every client and server version agrees on the login secret", async () => {
    const keys = await derivePasswordKeys("correct horse battery staple", kdf);
    assert.equal(keys.loginSecret, "tyt1.JkPMFziAI6O74KfRtJm_UoH5AKfjj6XOHJHKv5xvBEE");
    assert.equal(encodeSecret(keys.wrappingKey), "6Kd3XMyG3acf1Px00Rf3BNT8J9ydKA-tKjHYMlnugio");
  });
  it("keeps the wrapping key out of the login secret and depends on password and salt", async () => {
    const keys = await derivePasswordKeys("correct horse battery staple", kdf);
    assert.ok(keys.loginSecret.startsWith(LOGIN_SECRET_PREFIX));
    assert.ok(!keys.loginSecret.includes(encodeSecret(keys.wrappingKey)));
    assert.equal(keys.wrappingKey.length, 32);
    assert.notEqual((await derivePasswordKeys("correct horse battery stable", kdf)).loginSecret, keys.loginSecret);
    const other = newPasswordKdf();
    assert.notEqual(other.salt, kdf.salt);
    assert.notEqual((await derivePasswordKeys("correct horse battery staple", other)).loginSecret, keys.loginSecret);
  });
  it("treats composed and decomposed Unicode passwords as the same password", async () => {
    const composed = await derivePasswordKeys("Gr\u00fc\u00dfe-Passwort", kdf), decomposed = await derivePasswordKeys("Gru\u0308\u00dfe-Passwort", kdf);
    assert.equal(composed.loginSecret, decomposed.loginSecret);
  });
  it("refuses unknown parameters and empty passwords instead of guessing", async () => {
    await assert.rejects(derivePasswordKeys("x", { ...kdf, iterations: 1000 } as never));
    await assert.rejects(derivePasswordKeys("x", { ...kdf, salt: "AAEC" }));
    await assert.rejects(derivePasswordKeys("", kdf));
  });
});

