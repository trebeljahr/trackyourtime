import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Encryption } from "../secure-store.ts";
import { createActivityVault } from "./vault.ts";
import { createActivityService, type ActivityService } from "./service.ts";
import { createFakeFrontmostSource } from "./source-fake.ts";
let dir: string, service: ActivityService, vault: ReturnType<typeof createActivityVault>;
const input = { key: randomBytes(32).toString("base64url"), userId: "owner", origin: "https://api.example.test" };
const scope = { userId: "owner", workspaceId: "workspace", origin: input.origin };
let reads = 0, availabilityReads = 0, denied = false;
const fakeEncryption: Encryption = {
  isAvailable: () => { availabilityReads++; return true; }, backend: () => "test-keychain",
  encrypt: (plain) => Buffer.from(Buffer.from(plain, "utf8").map((byte) => byte ^ 77)),
  decrypt: (cipher) => { reads++; if (denied) throw new Error("Denied"); return Buffer.from(cipher.map((byte) => byte ^ 77)).toString("utf8"); },
};
function open(encryption?: Encryption) {
  vault = createActivityVault({ userData: dir, encryption,
    makeService: (codec, protectionStatus) => createActivityService({ userData: dir, codec, protectionStatus, source: createFakeFrontmostSource(), titlesAvailable: true, selfPid: 1, support: { kind: "supported", mechanism: "macos-lsappinfo" } }),
    onReplace: (next) => { service = next; },
  });
}
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "tyt-activity-vault-")); reads = 0; availabilityReads = 0; denied = false; });
afterEach(async () => { await vault?.settled(); vault?.dispose(); rmSync(dir, { recursive: true, force: true }); });
describe("activity vault lifecycle", () => {
  it("keeps a protected store closed on restart, then unlocks without losing history", async () => {
    open(); await vault.setScope(scope); await service.updateSettings({ enabled: true });
    await vault.protect(input); assert.equal(vault.status().locked, false);
    const original = readFileSync(path.join(dir, "activity/state.json"), "utf8");
    await assert.rejects(vault.protect({ ...input, key: randomBytes(32).toString("base64url") }));
    assert.equal(vault.status().locked, false);
    assert.equal(readFileSync(path.join(dir, "activity/state.json"), "utf8"), original);
    vault.dispose(); open(); assert.equal(vault.status().locked, true);
    await service.updateSettings({ enabled: true }); assert.equal((await service.snapshot()).recording, false);
    await vault.protect(input); assert.equal(vault.status().locked, false);
    assert.equal((await service.snapshot()).settings.enabled, true);
  });
  it("remembers only an opted-in key, binds it to account and server, and clears it on sign-out", async () => {
    open(fakeEncryption); await vault.setScope(scope); await vault.protect({ ...input, remember: true });
    assert.equal(vault.status().trusted, true); vault.dispose(); open(fakeEncryption);
    assert.equal(reads, 0); // A status read never opens the keychain.
    await vault.setScope({ ...scope, origin: "https://other.example.test" }); assert.equal(vault.status().locked, true); assert.equal(reads, 0);
    await vault.setScope({ ...scope, userId: "other" }); assert.equal(vault.status().locked, true); assert.equal(reads, 0);
    await vault.setScope(scope); assert.equal(vault.status().locked, false); assert.equal(reads, 1);
    await vault.lock(); await vault.setScope(scope); assert.equal(vault.status().locked, true);
    await vault.protect(input); await vault.forget();
    assert.equal(existsSync(path.join(dir, "activity-device-key.bin")), false);
    assert.equal(vault.status().encrypted, true); assert.equal(vault.status().locked, true);
    assert.equal((await service.snapshot()).scoped, false);
    assert.equal(JSON.parse(readFileSync(path.join(dir, "activity/state.json"), "utf8")).v, 2);
    await service.updateSettings({ enabled: true });
    assert.equal((await service.snapshot()).recording, false);
    // Another account can set up its own key, but cannot silently resume
    // this device's history capture as plaintext after the prior sign-out.
    await vault.protect({ ...input, userId: "other" });
    assert.equal(vault.status().locked, false); assert.equal(vault.status().encrypted, true);
  });
  it("never falls back to plaintext or retries a refused OS credential request", async () => {
    open(fakeEncryption); await vault.protect({ ...input, remember: true }); vault.dispose(); denied = true; open(fakeEncryption);
    await vault.setScope(scope); await vault.setScope(scope);
    assert.equal(reads, 1); assert.equal(vault.status().locked, true);
    assert.equal((await service.snapshot()).support.supported, false);
    await vault.protect(input); assert.equal(vault.status().locked, false);
    vault.dispose(); open({ ...fakeEncryption, backend: () => "basic_text" });
    await assert.rejects(vault.protect({ ...input, remember: true }), /secure OS keychain/);
    assert.equal(vault.status().locked, true); assert.equal(vault.status().canTrust, false);
    await vault.protect(input); assert.equal(vault.status().locked, false);
  });
  it("does not query or open the OS keychain for status or an unremembered key", async () => {
    open(fakeEncryption); vault.status(); await vault.setScope(scope);
    assert.equal(availabilityReads, 0); assert.equal(reads, 0);
    await vault.protect(input); vault.dispose(); open(fakeEncryption); vault.status(); await vault.setScope(scope);
    assert.equal(vault.status().locked, true);
    assert.equal(availabilityReads, 0); assert.equal(reads, 0);
  });
  it("refuses to encrypt a different account's plaintext history under the new user's key", async () => {
    open(); await vault.setScope(scope);
    await assert.rejects(vault.protect({ ...input, userId: "other" }), /another account/);
    assert.equal(vault.status().encrypted, false);
  });
});
