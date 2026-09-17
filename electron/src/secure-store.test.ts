import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createSecureStore, platformBackend, sessionFileAt, type Encryption, type SessionFile } from "./secure-store.ts";

/** Reversible and visibly not the plaintext, so a test can tell the two apart. */
const fakeEncryption = (backend: string, available = true): Encryption & { broken: boolean } => {
  const enc = {
    broken: false,
    isAvailable: () => available,
    backend: () => backend,
    encrypt: (plain: string) => Buffer.from(`enc:${Buffer.from(plain).toString("base64")}`),
    decrypt: (cipher: Buffer) => {
      if (enc.broken) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      const text = cipher.toString();
      if (!text.startsWith("enc:")) throw new Error("not ours");
      return Buffer.from(text.slice(4), "base64").toString();
    },
  };
  return enc;
};

const memoryFile = (initial: Buffer | null = null): SessionFile & { data: Buffer | null } => {
  const file = {
    data: initial,
    read: () => file.data,
    write: (data: Buffer) => {
      file.data = data;
    },
    remove: () => {
      file.data = null;
    },
  };
  return file;
};

describe("createSecureStore", () => {
  it("writes ciphertext, never the token, and reads it back in a new run", () => {
    const file = memoryFile();
    const first = createSecureStore(fakeEncryption("keychain"), file);
    assert.deepEqual(first.setToken("abc.def="), { persistent: true, backend: "keychain" });
    assert.ok(file.data);
    assert.equal(file.data.toString().includes("abc.def="), false);

    const relaunch = createSecureStore(fakeEncryption("keychain"), file);
    assert.equal(relaunch.getToken(), "abc.def=");
  });

  it("refuses to persist on basic_text and keeps the token for this run only", () => {
    const file = memoryFile();
    const store = createSecureStore(fakeEncryption("basic_text"), file);
    assert.deepEqual(store.setToken("secret"), { persistent: false, backend: "basic_text" });
    assert.equal(store.getToken(), "secret");
    assert.equal(file.data, null);

    const relaunch = createSecureStore(fakeEncryption("basic_text"), file);
    assert.equal(relaunch.getToken(), null);
  });

  it("does not persist when encryption is unavailable", () => {
    const file = memoryFile();
    const store = createSecureStore(fakeEncryption("gnome_libsecret", false), file);
    assert.deepEqual(store.status(), { persistent: false, backend: "unavailable" });
    store.setToken("secret");
    assert.equal(file.data, null);
  });

  it("removes an older ciphertext when a new token cannot be written", () => {
    const file = memoryFile();
    createSecureStore(fakeEncryption("gnome_libsecret"), file).setToken("old");
    assert.ok(file.data);
    createSecureStore(fakeEncryption("basic_text"), file).setToken("new");
    assert.equal(file.data, null);
  });

  it("signs out, and deletes the file, when the ciphertext no longer decrypts", () => {
    const file = memoryFile();
    createSecureStore(fakeEncryption("keychain"), file).setToken("token");
    const encryption = fakeEncryption("keychain");
    encryption.broken = true;
    const relaunch = createSecureStore(encryption, file);
    assert.equal(relaunch.getToken(), null);
    assert.equal(file.data, null);
  });

  it("forgets on delete, in memory and on disk", () => {
    const file = memoryFile();
    const store = createSecureStore(fakeEncryption("dpapi"), file);
    store.setToken("token");
    store.deleteToken();
    assert.equal(store.getToken(), null);
    assert.equal(file.data, null);
  });

  it("ignores an empty token rather than storing it", () => {
    const file = memoryFile();
    const store = createSecureStore(fakeEncryption("keychain"), file);
    store.setToken("good");
    store.setToken("");
    assert.equal(store.getToken(), "good");
    assert.equal(createSecureStore(fakeEncryption("keychain"), file).getToken(), "good");
  });
});

describe("sessionFileAt", () => {
  it("writes an owner-only file atomically and removes it", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tyt-secure-store-"));
    const file = sessionFileAt(path.join(dir, "profile"));
    assert.equal(file.read(), null);
    file.write(Buffer.from("cipher"));
    const target = path.join(dir, "profile", "session.bin");
    assert.equal(readFileSync(target, "utf8"), "cipher");
    if (process.platform !== "win32") assert.equal(statSync(target).mode & 0o777, 0o600);
    file.remove();
    assert.equal(file.read(), null);
    file.remove();
  });
});

describe("platformBackend", () => {
  it("names the macOS and Windows backends", () => {
    assert.equal(platformBackend("darwin"), "keychain");
    assert.equal(platformBackend("win32"), "dpapi");
    assert.equal(platformBackend("linux"), "unknown");
  });
});
